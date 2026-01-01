import { TFile } from 'obsidian';
import { buildIndexChunks } from './Chunking';
import { sha256 } from '../ContentHash';
import { CO_AUTHORING_POLICY } from '../policy';
/**
 * Stable normalization for bit-perfect hash continuity.
 */
export function normalizeChunkText(text) {
    return text
        .trim()
        .replace(/\r\n/g, '\n') // Normalize newlines
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' '); // Normalize spaces/tabs
}
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function chunkingKey(plugin) {
    return {
        headingLevel: plugin.settings.retrievalChunkHeadingLevel ?? 'h1',
        targetWords: clampInt(plugin.settings.retrievalChunkWords ?? 500, 200, 2000),
        overlapWords: clampInt(plugin.settings.retrievalChunkOverlapWords ?? 100, 0, 500)
    };
}
function excerptOf(text, maxChars) {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= maxChars)
        return trimmed;
    return `${trimmed.slice(0, maxChars)}…`;
}
export class EmbeddingsIndex {
    constructor(vault, plugin, embeddingProvider) {
        this.loaded = false;
        this.chunksByKey = new Map();
        this.chunkKeysByPath = new Map();
        this.queue = new Set();
        this.workerRunning = false;
        this.rebuildTimer = null;
        this.persistTimer = null;
        this.settingsSaveTimer = null;
        // Error tracking
        this.errorLog = [];
        this.maxStoredErrors = 100;
        this.vault = vault;
        this.plugin = plugin;
        this.backend = 'ollama';
        this.embeddingProvider = embeddingProvider;
        this.dim = 0;
    }
    getIndexFilePath() {
        return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/index.json`;
    }
    async clearIndex() {
        this.chunksByKey.clear();
        this.chunkKeysByPath.clear();
        this.plugin.settings.retrievalIndexState = {};
        await this.plugin.saveSettings();
        const path = this.getIndexFilePath();
        if (await this.vault.adapter.exists(path)) {
            await this.vault.adapter.remove(path);
        }
    }
    async ensureLoaded() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const path = this.getIndexFilePath();
            if (!(await this.vault.adapter.exists(path)))
                return;
            const raw = await this.vault.adapter.read(path);
            const parsed = JSON.parse(raw);
            if (parsed?.version !== 1 || !Array.isArray(parsed.chunks))
                return;
            if (parsed.backend && parsed.backend !== this.backend) {
                // Backend mismatch: ignore persisted index and rebuild.
                this.enqueueFullRescan();
                return;
            }
            if (typeof parsed.dim === 'number') {
                this.dim = parsed.dim;
            }
            const expectedChunking = chunkingKey(this.plugin);
            if (parsed.chunking &&
                (parsed.chunking.headingLevel !== expectedChunking.headingLevel ||
                    parsed.chunking.targetWords !== expectedChunking.targetWords ||
                    parsed.chunking.overlapWords !== expectedChunking.overlapWords)) {
                // Chunking config changed; rebuild index.
                this.enqueueFullRescan();
                return;
            }
            for (const chunk of parsed.chunks) {
                if (!chunk?.key || !chunk?.path || !Array.isArray(chunk.vector))
                    continue;
                this._setChunk(chunk);
            }
        }
        catch {
            // Corrupt index should not break the plugin. We'll rebuild lazily.
            this.chunksByKey.clear();
            this.chunkKeysByPath.clear();
        }
    }
    getStatus() {
        return {
            indexedFiles: this.chunkKeysByPath.size,
            indexedChunks: this.chunksByKey.size,
            paused: Boolean(this.plugin.settings.retrievalIndexPaused),
            queued: this.queue.size
        };
    }
    getRecentErrors(limit = 20) {
        return this.errorLog.slice(-limit);
    }
    getErrorSummary() {
        const byLocation = {};
        for (const err of this.errorLog) {
            byLocation[err.location] = (byLocation[err.location] || 0) + 1;
        }
        return {
            total: this.errorLog.length,
            byLocation,
            recent: this.errorLog.slice(-10)
        };
    }
    logError(location, context, error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        const errorType = error instanceof Error ? error.constructor.name : typeof error;
        const entry = {
            timestamp: new Date().toISOString(),
            location,
            context,
            message: errorMsg,
            stack: errorStack,
            errorType
        };
        this.errorLog.push(entry);
        if (this.errorLog.length > this.maxStoredErrors) {
            this.errorLog.shift();
        }
        // Also log to console for debugging
        console.error(`[EmbeddingsIndex] ERROR [${location}] ${context}:`, errorMsg);
        if (errorStack) {
            console.error(`[EmbeddingsIndex] Stack:`, errorStack.split('\n').slice(0, 3).join('\n'));
        }
    }
    enqueueFullRescan() {
        const files = this.plugin.vaultService.getIncludedMarkdownFiles();
        for (const f of files)
            this.queue.add(f.path);
        this._kickWorker();
    }
    queueUpdateFile(path) {
        if (!path)
            return;
        this.queue.add(path);
        this._scheduleRebuild();
    }
    _scheduleRebuild() {
        const policy = CO_AUTHORING_POLICY.PERFORMANCE;
        if (this.rebuildTimer)
            window.clearTimeout(this.rebuildTimer);
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            this._kickWorker();
        }, policy.REBUILD_QUEUE_DEBOUNCE_MS);
    }
    queueRemoveFile(path) {
        if (!path)
            return;
        this._removePath(path);
        this._schedulePersist();
        this._scheduleSettingsSave();
    }
    _kickWorker() {
        if (this.workerRunning)
            return;
        this.workerRunning = true;
        // Fire and forget, but ensure errors are swallowed.
        void this._runWorker().catch(() => {
            this.workerRunning = false;
        });
    }
    async _runWorker() {
        await this.ensureLoaded();
        // If Ollama is not available, skip semantic indexing to avoid failures.
        if (!(await this.embeddingProvider.isAvailable())) {
            console.warn('[EmbeddingsIndex] Ollama not available; skipping semantic indexing');
            this.workerRunning = false;
            return;
        }
        const policy = CO_AUTHORING_POLICY.PERFORMANCE;
        let processedCount = 0;
        let skippedExcluded = 0;
        let skippedNotMarkdown = 0;
        let skippedHashMatch = 0;
        let indexedCount = 0;
        while (this.queue.size > 0 && indexedCount < policy.MAX_REBUILDS_PER_BATCH) {
            if (this.plugin.settings.retrievalIndexPaused)
                break;
            const next = this.queue.values().next().value;
            this.queue.delete(next);
            processedCount++;
            // Exclusions can change at any time; honor them during processing.
            if (this.plugin.vaultService.isExcludedPath(next)) {
                skippedExcluded++;
                this._removePath(next);
                this._schedulePersist();
                this._scheduleSettingsSave();
                continue;
            }
            const file = this.vault.getAbstractFileByPath(next);
            // Only index markdown files.
            if (!(file instanceof TFile) || file.extension !== 'md') {
                skippedNotMarkdown++;
                this._removePath(next);
                this._schedulePersist();
                this._scheduleSettingsSave();
                continue;
            }
            try {
                const content = await this.vault.read(file);
                const normalizedContent = normalizeChunkText(content);
                const fileHash = await sha256(normalizedContent);
                const prev = this.plugin.settings.retrievalIndexState?.[next];
                const isCurrentlyIndexed = this.chunkKeysByPath.has(next);
                // Skip only if: hash matches AND file is already indexed
                // If hash matches but file is NOT indexed, re-index it (might have been removed)
                if (prev?.hash === fileHash && isCurrentlyIndexed) {
                    skippedHashMatch++;
                    continue;
                }
                await this._reindexFile(next, content);
                indexedCount++;
                this.plugin.settings.retrievalIndexState = {
                    ...(this.plugin.settings.retrievalIndexState || {}),
                    [next]: {
                        hash: fileHash,
                        chunkCount: this.chunkKeysByPath.get(next)?.size ?? 0,
                        updatedAt: new Date().toISOString()
                    }
                };
                this._schedulePersist();
                this._scheduleSettingsSave();
            }
            catch (err) {
                // Skip unreadable files, but log for debugging
                this.logError('_runWorker', `Processing file: ${next}`, err);
            }
            // Yield to keep UI responsive.
            await new Promise((r) => setTimeout(r, 10));
        }
        // Log indexing stats for debugging
        if (processedCount > 0) {
            console.log(`[EmbeddingsIndex] Processed ${processedCount} files: ${indexedCount} indexed, ${skippedExcluded} excluded, ${skippedNotMarkdown} not markdown, ${skippedHashMatch} hash match (already indexed)`);
        }
        this.workerRunning = false;
    }
    async _reindexFile(path, content) {
        this._removePath(path);
        // If Ollama is not available, skip semantic indexing for this file.
        if (!(await this.embeddingProvider.isAvailable())) {
            console.warn(`[EmbeddingsIndex] Ollama not available; skipping file: ${path}`);
            return;
        }
        // Skip empty files
        if (!content || content.trim().length === 0) {
            console.warn(`[EmbeddingsIndex] Skipping empty file: ${path}`);
            return;
        }
        const cfg = chunkingKey(this.plugin);
        console.log(`[EmbeddingsIndex] Processing file: ${path}`);
        console.log(`  - Backend: ${this.backend}`);
        console.log(`  - Content length: ${content.length} chars, ${content.split(/\s+/).length} words`);
        console.log(`  - Chunking config: headingLevel=${cfg.headingLevel}, targetWords=${cfg.targetWords}, overlapWords=${cfg.overlapWords}`);
        const chunks = buildIndexChunks({
            text: content,
            headingLevel: cfg.headingLevel,
            targetWords: cfg.targetWords,
            overlapWords: cfg.overlapWords
        });
        console.log(`  - Chunks created: ${chunks.length}`);
        if (chunks.length > 0) {
            console.log(`  - First chunk preview: ${chunks[0].text.substring(0, 100)}...`);
        }
        // If no chunks created, skip this file (might be too short or have no headings)
        if (chunks.length === 0) {
            console.warn(`[EmbeddingsIndex] No chunks created for ${path} - file too short or no headings match chunking config`);
            return;
        }
        let successfulChunks = 0;
        let firstError = null;
        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            const normalizedText = normalizeChunkText(ch.text);
            const textHash = await sha256(normalizedText);
            const key = `chunk:${path}:${i}`;
            let vector;
            try {
                console.log(`  - Generating embedding for chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words)...`);
                const embedStart = Date.now();
                vector = await this.embeddingProvider.getEmbedding(normalizedText);
                if (!Array.isArray(vector) || vector.length === 0) {
                    throw new Error('Empty embedding returned from Ollama');
                }
                if (this.dim === 0) {
                    this.dim = vector.length;
                }
                const embedDuration = Date.now() - embedStart;
                console.log(`  - ✓ Ollama embedding generated in ${embedDuration}ms: ${vector.length} dimensions`);
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                const errorStack = err instanceof Error ? err.stack : undefined;
                const context = `File: ${path}, Chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words, ${ch.text.length} chars)`;
                this.logError('_reindexFile.embedChunk', context, err);
                console.error(`  - ✗ Embedding generation failed for chunk ${i + 1}/${chunks.length}:`, errorMsg);
                if (errorStack) {
                    console.error(`    Stack: ${errorStack.split('\n').slice(0, 3).join('\n    ')}`);
                }
                if (err instanceof Error) {
                    console.error(`    Error type: ${err.constructor.name}`);
                    if ('cause' in err) {
                        console.error(`    Cause: ${err.cause}`);
                    }
                }
                // If ALL chunks fail for a file, the file won't be indexed
                // This is a critical failure that should be logged
                if (i === 0) {
                    console.warn(`  - Warning: First chunk failed for ${path}. Attempting subsequent chunks.`);
                    firstError = err instanceof Error ? err : new Error(String(err));
                }
                // Skip this chunk if embedding fails, but continue with others
                continue;
            }
            const excerpt = excerptOf(ch.text, 2500);
            this._setChunk({
                key,
                path,
                chunkIndex: i,
                startWord: ch.startWord,
                endWord: ch.endWord,
                textHash,
                vector,
                excerpt
            });
            successfulChunks++;
        }
        if (successfulChunks === 0 && chunks.length > 0) {
            const criticalContext = `File: ${path}, All ${chunks.length} chunks failed`;
            if (firstError) {
                this.logError('_reindexFile.allChunksFailed', criticalContext, firstError);
                console.error(`[EmbeddingsIndex] CRITICAL: All ${chunks.length} chunks failed for ${path} - file not indexed`);
                console.error(`  Root cause: ${firstError.message}`);
            }
            else {
                this.logError('_reindexFile.allChunksFailed', criticalContext, new Error('All chunks failed but no first error captured'));
            }
        }
        else if (successfulChunks < chunks.length) {
            console.warn(`[EmbeddingsIndex] Partial success for ${path}: ${successfulChunks}/${chunks.length} chunks indexed`);
        }
        else {
            console.log(`[EmbeddingsIndex] ✓ Successfully indexed ${path}: ${successfulChunks} chunks`);
        }
    }
    _setChunk(chunk) {
        this.chunksByKey.set(chunk.key, chunk);
        const set = this.chunkKeysByPath.get(chunk.path) ?? new Set();
        set.add(chunk.key);
        this.chunkKeysByPath.set(chunk.path, set);
    }
    _removePath(path) {
        const keys = this.chunkKeysByPath.get(path);
        if (keys) {
            for (const k of keys)
                this.chunksByKey.delete(k);
        }
        this.chunkKeysByPath.delete(path);
        if (this.plugin.settings.retrievalIndexState?.[path]) {
            const next = { ...(this.plugin.settings.retrievalIndexState || {}) };
            delete next[path];
            this.plugin.settings.retrievalIndexState = next;
        }
    }
    getAllChunks() {
        return Array.from(this.chunksByKey.values());
    }
    /**
     * Computes a bit-perfect corpus hash for strict replay.
     * sha256(join(sort(chunk_id + ":" + content_hash), "\n"))
     */
    async getCorpusHash() {
        const chunks = this.getAllChunks();
        const lines = chunks.map(c => `${c.key}:${c.textHash}`);
        lines.sort();
        const joined = lines.join('\n');
        return await sha256(joined);
    }
    getIndexedPaths() {
        return Array.from(this.chunkKeysByPath.keys());
    }
    /**
     * Checks if a path is currently marked as stale in the index state.
     */
    isStale(path) {
        const state = this.plugin.settings.retrievalIndexState?.[path];
        if (!state)
            return false;
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile))
            return true; // Missing file is effectively stale
        // If updatedAt is not set, we can't be sure, assume not stale for now
        if (!state.updatedAt)
            return false;
        const fileMtime = file.stat.mtime;
        const indexTime = new Date(state.updatedAt).getTime();
        return fileMtime > indexTime;
    }
    /**
     * Queue all currently indexed paths for re-checking. This is useful when exclusions/profiles change.
     */
    queueRecheckAllIndexed() {
        for (const p of this.getIndexedPaths())
            this.queue.add(p);
        this._kickWorker();
    }
    getVectorForKey(key) {
        const ch = this.chunksByKey.get(key);
        return ch?.vector ?? null;
    }
    buildQueryVector(queryText) {
        console.warn('[EmbeddingsIndex] buildQueryVector called; returning empty vector. Use embedQueryVector instead.');
        return [];
    }
    async embedQueryVector(queryText) {
        const vec = await this.embeddingProvider.getEmbedding(queryText);
        if (!Array.isArray(vec) || vec.length === 0) {
            throw new Error('Empty embedding returned from Ollama');
        }
        return vec;
    }
    _schedulePersist() {
        if (this.persistTimer)
            window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            void this._persistNow().catch(() => {
                // ignore
            });
        }, 1000);
    }
    async _persistNow() {
        const dir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
        try {
            if (!(await this.vault.adapter.exists(dir))) {
                await this.vault.adapter.mkdir(dir);
            }
        }
        catch {
            // ignore mkdir failures
        }
        const payload = {
            version: 1,
            dim: this.dim,
            backend: this.backend,
            chunking: chunkingKey(this.plugin),
            chunks: this.getAllChunks()
        };
        await this.vault.adapter.write(this.getIndexFilePath(), JSON.stringify(payload));
    }
    _scheduleSettingsSave() {
        if (this.settingsSaveTimer)
            window.clearTimeout(this.settingsSaveTimer);
        this.settingsSaveTimer = window.setTimeout(() => {
            this.settingsSaveTimer = null;
            void this.plugin.saveSettings().catch(() => {
                // ignore
            });
        }, 1000);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBVyxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFhaEQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEdBQUcsRUFBRSxH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Q3JCLFFBQVEsRUFBRSxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztZQUNsQyxNQUFNLEVBQUUsSUFBSSxDQUFDLFlBQVksRUFBRTtTQUMzQixDQUFDO1FBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixFQUFFLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7SUFFTyxxQkFBcUI7UUFDNUIsSUFBSSxJQUFJLENBQUMsaUJBQWlCO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUN4RSxJQUFJLENBQUMsaUJBQWlCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDL0MsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDMUMsU0FBUztZQUNWLENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1YsQ0FBQztDQUVEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5pbXBvcnQgeyBmbnYxYTMyLCBzaGEyNTYgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XG5pbXBvcnQgeyBPbGxhbWFFbWJlZGRpbmdQcm92aWRlciB9IGZyb20gJy4vT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXInO1xuaW1wb3J0IHsgQ09fQVVUSE9SSU5HX1BPTElDWSB9IGZyb20gJy4uL3BvbGljeSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhlZENodW5rIHtcblx0a2V5OiBzdHJpbmc7XG5cdHBhdGg6IHN0cmluZztcblx0Y2h1bmtJbmRleDogbnVtYmVyO1xuXHRzdGFydFdvcmQ6IG51bWJlcjtcblx0ZW5kV29yZDogbnVtYmVyO1xuXHR0ZXh0SGFzaDogc3RyaW5nOyAvLyBTSEEtMjU2XG5cdHZlY3RvcjogbnVtYmVyW107XG5cdGV4Y2VycHQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBTdGFibGUgbm9ybWFsaXphdGlvbiBmb3IgYml0LXBlcmZlY3QgaGFzaCBjb250aW51aXR5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2h1bmtUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0XG5cdFx0LnRyaW0oKVxuXHRcdC5yZXBsYWNlKC9cXHJcXG4vZywgJ1xcbicpIC8vIE5vcm1hbGl6ZSBuZXdsaW5lc1xuXHRcdC5yZXBsYWNlKC9cXHIvZywgJ1xcbicpXG5cdFx0LnJlcGxhY2UoL1sgXFx0XSsvZywgJyAnKTsgLy8gTm9ybWFsaXplIHNwYWNlcy90YWJzXG59XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcblx0dmVyc2lvbjogMTtcblx0ZGltOiBudW1iZXI7XG5cdGJhY2tlbmQ6ICdvbGxhbWEnO1xuXHRjaHVua2luZz86IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH07XG5cdGNodW5rczogSW5kZXhlZENodW5rW107XG59XG5cbmZ1bmN0aW9uIGNsYW1wSW50KHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xufVxuXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXG5cdFx0b3ZlcmxhcFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwLCAwLCA1MDApXG5cdH07XG59XG5cbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuXHRpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkO1xuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcbn1cblxuaW50ZXJmYWNlIEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZzsgLy8gV2hlcmUgdGhlIGVycm9yIG9jY3VycmVkIChtZXRob2QvZnVuY3Rpb24gbmFtZSlcblx0Y29udGV4dDogc3RyaW5nOyAvLyBXaGF0IHdhcyBoYXBwZW5pbmcgKGZpbGUgcGF0aCwgY2h1bmsgaW5kZXgsIGV0Yy4pXG5cdG1lc3NhZ2U6IHN0cmluZztcblx0c3RhY2s/OiBzdHJpbmc7XG5cdGVycm9yVHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSBkaW06IG51bWJlcjtcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnb2xsYW1hJztcblx0cHJpdmF0ZSByZWFkb25seSBlbWJlZGRpbmdQcm92aWRlcjogT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXI7XG5cblx0cHJpdmF0ZSBsb2FkZWQgPSBmYWxzZTtcblx0cHJpdmF0ZSBjaHVua3NCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBJbmRleGVkQ2h1bms+KCk7XG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgcXVldWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgcmVidWlsZFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHNldHRpbmdzU2F2ZVRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBFcnJvciB0cmFja2luZ1xuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSAxMDA7XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sIGVtYmVkZGluZ1Byb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHR0aGlzLmJhY2tlbmQgPSAnb2xsYW1hJztcblx0XHR0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyID0gZW1iZWRkaW5nUHJvdmlkZXI7XG5cdFx0dGhpcy5kaW0gPSAwO1xuXHR9XG5cblx0Z2V0SW5kZXhGaWxlUGF0aCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvaW5kZXguanNvbmA7XG5cdH1cblxuXHRhc3luYyBjbGVhckluZGV4KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7fTtcblx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcblx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpIHtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUocGF0aCk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQocGF0aCk7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcblx0XHRcdGlmIChwYXJzZWQ/LnZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocGFyc2VkLmNodW5rcykpIHJldHVybjtcblx0XHRcdGlmIChwYXJzZWQuYmFja2VuZCAmJiBwYXJzZWQuYmFja2VuZCAhPT0gdGhpcy5iYWNrZW5kKSB7XG5cdFx0XHRcdC8vIEJhY2tlbmQgbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJykge1xuXHRcdFx0XHR0aGlzLmRpbSA9IHBhcnNlZC5kaW07XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHBlY3RlZENodW5raW5nID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcblx0XHRcdFx0KHBhcnNlZC5jaHVua2luZy5oZWFkaW5nTGV2ZWwgIT09IGV4cGVjdGVkQ2h1bmtpbmcuaGVhZGluZ0xldmVsIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXG5cdFx0XHQpIHtcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XG5cdFx0XHRcdGlmICghY2h1bms/LmtleSB8fCAhY2h1bms/LnBhdGggfHwgIUFycmF5LmlzQXJyYXkoY2h1bmsudmVjdG9yKSkgY29udGludWU7XG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cblx0XHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0fVxuXHR9XG5cblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0aW5kZXhlZEZpbGVzOiB0aGlzLmNodW5rS2V5c0J5UGF0aC5zaXplLFxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxuXHRcdFx0cGF1c2VkOiBCb29sZWFuKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSxcblx0XHRcdHF1ZXVlZDogdGhpcy5xdWV1ZS5zaXplXG5cdFx0fTtcblx0fVxuXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRFcnJvclN1bW1hcnkoKTogeyB0b3RhbDogbnVtYmVyOyBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+OyByZWNlbnQ6IEVycm9yTG9nRW50cnlbXSB9IHtcblx0XHRjb25zdCBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xuXHRcdFx0YnlMb2NhdGlvbltlcnIubG9jYXRpb25dID0gKGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSB8fCAwKSArIDE7XG5cdFx0fVxuXHRcdHJldHVybiB7XG5cdFx0XHR0b3RhbDogdGhpcy5lcnJvckxvZy5sZW5ndGgsXG5cdFx0XHRieUxvY2F0aW9uLFxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bG9jYXRpb24sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcblx0XHRcdGVycm9yVHlwZVxuXHRcdH07XG5cdFx0XG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblx0XHRcblx0XHQvLyBBbHNvIGxvZyB0byBjb25zb2xlIGZvciBkZWJ1Z2dpbmdcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XG5cdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB0aGlzLnF1ZXVlLmFkZChmLnBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLnF1ZXVlLmFkZChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVJlYnVpbGQoKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlUmVidWlsZCgpOiB2b2lkIHtcblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGlmICh0aGlzLnJlYnVpbGRUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnJlYnVpbGRUaW1lcik7XG5cdFx0dGhpcy5yZWJ1aWxkVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IG51bGw7XG5cdFx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdFx0fSwgcG9saWN5LlJFQlVJTERfUVVFVUVfREVCT1VOQ0VfTVMpO1xuXHR9XG5cblx0cXVldWVSZW1vdmVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0fVxuXG5cdHByaXZhdGUgX2tpY2tXb3JrZXIoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMud29ya2VyUnVubmluZykgcmV0dXJuO1xuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IHRydWU7XG5cdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0LCBidXQgZW5zdXJlIGVycm9ycyBhcmUgc3dhbGxvd2VkLlxuXHRcdHZvaWQgdGhpcy5fcnVuV29ya2VyKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9ydW5Xb3JrZXIoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyB0byBhdm9pZCBmYWlsdXJlcy5cblx0XHRpZiAoIShhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmlzQXZhaWxhYmxlKCkpKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBzZW1hbnRpYyBpbmRleGluZycpO1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgcG9saWN5ID0gQ09fQVVUSE9SSU5HX1BPTElDWS5QRVJGT1JNQU5DRTtcblx0XHRsZXQgcHJvY2Vzc2VkQ291bnQgPSAwO1xuXHRcdGxldCBza2lwcGVkRXhjbHVkZWQgPSAwO1xuXHRcdGxldCBza2lwcGVkTm90TWFya2Rvd24gPSAwO1xuXHRcdGxldCBza2lwcGVkSGFzaE1hdGNoID0gMDtcblx0XHRsZXQgaW5kZXhlZENvdW50ID0gMDtcblx0XHRcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCAmJiBpbmRleGVkQ291bnQgPCBwb2xpY3kuTUFYX1JFQlVJTERTX1BFUl9CQVRDSCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBub3JtYWxpemVDaHVua1RleHQoY29udGVudCk7XG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRDb250ZW50KTtcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcblx0XHRcdFx0XHRbbmV4dF06IHtcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3J1bldvcmtlcicsIGBQcm9jZXNzaW5nIGZpbGU6ICR7bmV4dH1gLCBlcnIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBZaWVsZCB0byBrZWVwIFVJIHJlc3BvbnNpdmUuXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXHRcdH1cblxuXHRcdC8vIExvZyBpbmRleGluZyBzdGF0cyBmb3IgZGVidWdnaW5nXG5cdFx0aWYgKHByb2Nlc3NlZENvdW50ID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NlZCAke3Byb2Nlc3NlZENvdW50fSBmaWxlczogJHtpbmRleGVkQ291bnR9IGluZGV4ZWQsICR7c2tpcHBlZEV4Y2x1ZGVkfSBleGNsdWRlZCwgJHtza2lwcGVkTm90TWFya2Rvd259IG5vdCBtYXJrZG93biwgJHtza2lwcGVkSGFzaE1hdGNofSBoYXNoIG1hdGNoIChhbHJlYWR5IGluZGV4ZWQpYCk7XG5cdFx0fVxuXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyBmb3IgdGhpcyBmaWxlLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIEJhY2tlbmQ6ICR7dGhpcy5iYWNrZW5kfWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ29udGVudCBsZW5ndGg6ICR7Y29udGVudC5sZW5ndGh9IGNoYXJzLCAke2NvbnRlbnQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzYCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua2luZyBjb25maWc6IGhlYWRpbmdMZXZlbD0ke2NmZy5oZWFkaW5nTGV2ZWx9LCB0YXJnZXRXb3Jkcz0ke2NmZy50YXJnZXRXb3Jkc30sIG92ZXJsYXBXb3Jkcz0ke2NmZy5vdmVybGFwV29yZHN9YCk7XG5cdFx0XG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XG5cdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3Jkcyxcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xuXHRcdH0pO1xuXHRcdFxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtzIGNyZWF0ZWQ6ICR7Y2h1bmtzLmxlbmd0aH1gKTtcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGAgIC0gRmlyc3QgY2h1bmsgcHJldmlldzogJHtjaHVua3NbMF0udGV4dC5zdWJzdHJpbmcoMCwgMTAwKX0uLi5gKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gSWYgbm8gY2h1bmtzIGNyZWF0ZWQsIHNraXAgdGhpcyBmaWxlIChtaWdodCBiZSB0b28gc2hvcnQgb3IgaGF2ZSBubyBoZWFkaW5ncylcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBObyBjaHVua3MgY3JlYXRlZCBmb3IgJHtwYXRofSAtIGZpbGUgdG9vIHNob3J0IG9yIG5vIGhlYWRpbmdzIG1hdGNoIGNodW5raW5nIGNvbmZpZ2ApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGxldCBzdWNjZXNzZnVsQ2h1bmtzID0gMDtcblx0XHRsZXQgZmlyc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgY2ggPSBjaHVua3NbaV07XG5cdFx0XHRjb25zdCBub3JtYWxpemVkVGV4dCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjaC50ZXh0KTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRUZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjdG9yKSB8fCB2ZWN0b3IubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAodGhpcy5kaW0gPT09IDApIHtcblx0XHRcdFx0XHR0aGlzLmRpbSA9IHZlY3Rvci5sZW5ndGg7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBPbGxhbWEgZW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnN0IGNvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQ2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcywgJHtjaC50ZXh0Lmxlbmd0aH0gY2hhcnMpYDtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmVtYmVkQ2h1bmsnLCBjb250ZXh0LCBlcnIpO1xuXHRcdFx0XHRcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIOKclyBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH06YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XG5cdFx0XHRcdFx0aWYgKCdjYXVzZScgaW4gZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcblx0XHRcdFx0aWYgKGkgPT09IDApIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYCAgLSBXYXJuaW5nOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0uIEF0dGVtcHRpbmcgc3Vic2VxdWVudCBjaHVua3MuYCk7XG5cdFx0XHRcdFx0Zmlyc3RFcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBTa2lwIHRoaXMgY2h1bmsgaWYgZW1iZWRkaW5nIGZhaWxzLCBidXQgY29udGludWUgd2l0aCBvdGhlcnNcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleGNlcnB0ID0gZXhjZXJwdE9mKGNoLnRleHQsIDI1MDApO1xuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xuXHRcdFx0XHRrZXksXG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXG5cdFx0XHRcdHN0YXJ0V29yZDogY2guc3RhcnRXb3JkLFxuXHRcdFx0XHRlbmRXb3JkOiBjaC5lbmRXb3JkLFxuXHRcdFx0XHR0ZXh0SGFzaCxcblx0XHRcdFx0dmVjdG9yLFxuXHRcdFx0XHRleGNlcnB0XG5cdFx0XHR9KTtcblx0XHRcdHN1Y2Nlc3NmdWxDaHVua3MrKztcblx0XHR9XG5cdFx0XG5cdFx0aWYgKHN1Y2Nlc3NmdWxDaHVua3MgPT09IDAgJiYgY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IGNyaXRpY2FsQ29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkYDtcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIGZpcnN0RXJyb3IpO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBDUklUSUNBTDogQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgbm90IGluZGV4ZWRgKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICBSb290IGNhdXNlOiAke2ZpcnN0RXJyb3IubWVzc2FnZX1gKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIG5ldyBFcnJvcignQWxsIGNodW5rcyBmYWlsZWQgYnV0IG5vIGZpcnN0IGVycm9yIGNhcHR1cmVkJykpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoc3VjY2Vzc2Z1bENodW5rcyA8IGNodW5rcy5sZW5ndGgpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gUGFydGlhbCBzdWNjZXNzIGZvciAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9LyR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGluZGV4ZWRgKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIOKckyBTdWNjZXNzZnVsbHkgaW5kZXhlZCAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9IGNodW5rc2ApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX3NldENodW5rKGNodW5rOiBJbmRleGVkQ2h1bmspOiB2b2lkIHtcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcblx0XHRjb25zdCBzZXQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQoY2h1bmsucGF0aCkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0c2V0LmFkZChjaHVuay5rZXkpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrZXlzID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KHBhdGgpO1xuXHRcdGlmIChrZXlzKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XG5cdFx0fVxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmRlbGV0ZShwYXRoKTtcblxuXHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF0pIHtcblx0XHRcdGNvbnN0IG5leHQgPSB7IC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSB9O1xuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XG5cdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0gbmV4dDtcblx0XHR9XG5cdH1cblxuXHRnZXRBbGxDaHVua3MoKTogSW5kZXhlZENodW5rW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbXB1dGVzIGEgYml0LXBlcmZlY3QgY29ycHVzIGhhc2ggZm9yIHN0cmljdCByZXBsYXkuXG5cdCAqIHNoYTI1Nihqb2luKHNvcnQoY2h1bmtfaWQgKyBcIjpcIiArIGNvbnRlbnRfaGFzaCksIFwiXFxuXCIpKVxuXHQgKi9cblx0YXN5bmMgZ2V0Q29ycHVzSGFzaCgpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGNodW5rcyA9IHRoaXMuZ2V0QWxsQ2h1bmtzKCk7XG5cdFx0Y29uc3QgbGluZXMgPSBjaHVua3MubWFwKGMgPT4gYCR7Yy5rZXl9OiR7Yy50ZXh0SGFzaH1gKTtcblx0XHRsaW5lcy5zb3J0KCk7XG5cdFx0Y29uc3Qgam9pbmVkID0gbGluZXMuam9pbignXFxuJyk7XG5cdFx0cmV0dXJuIGF3YWl0IHNoYTI1Nihqb2luZWQpO1xuXHR9XG5cblx0Z2V0SW5kZXhlZFBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rS2V5c0J5UGF0aC5rZXlzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrcyBpZiBhIHBhdGggaXMgY3VycmVudGx5IG1hcmtlZCBhcyBzdGFsZSBpbiB0aGUgaW5kZXggc3RhdGUuXG5cdCAqL1xuXHRpc1N0YWxlKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IHN0YXRlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdO1xuXHRcdGlmICghc3RhdGUpIHJldHVybiBmYWxzZTtcblx0XHRcblx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG5cdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgcmV0dXJuIHRydWU7IC8vIE1pc3NpbmcgZmlsZSBpcyBlZmZlY3RpdmVseSBzdGFsZVxuXHRcdFxuXHRcdC8vIElmIHVwZGF0ZWRBdCBpcyBub3Qgc2V0LCB3ZSBjYW4ndCBiZSBzdXJlLCBhc3N1bWUgbm90IHN0YWxlIGZvciBub3dcblx0XHRpZiAoIXN0YXRlLnVwZGF0ZWRBdCkgcmV0dXJuIGZhbHNlO1xuXHRcdFxuXHRcdGNvbnN0IGZpbGVNdGltZSA9IGZpbGUuc3RhdC5tdGltZTtcblx0XHRjb25zdCBpbmRleFRpbWUgPSBuZXcgRGF0ZShzdGF0ZS51cGRhdGVkQXQpLmdldFRpbWUoKTtcblx0XHRcblx0XHRyZXR1cm4gZmlsZU10aW1lID4gaW5kZXhUaW1lO1xuXHR9XG5cblx0LyoqXG5cdCAqIFF1ZXVlIGFsbCBjdXJyZW50bHkgaW5kZXhlZCBwYXRocyBmb3IgcmUtY2hlY2tpbmcuIFRoaXMgaXMgdXNlZnVsIHdoZW4gZXhjbHVzaW9ucy9wcm9maWxlcyBjaGFuZ2UuXG5cdCAqL1xuXHRxdWV1ZVJlY2hlY2tBbGxJbmRleGVkKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgcCBvZiB0aGlzLmdldEluZGV4ZWRQYXRocygpKSB0aGlzLnF1ZXVlLmFkZChwKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRnZXRWZWN0b3JGb3JLZXkoa2V5OiBzdHJpbmcpOiBudW1iZXJbXSB8IG51bGwge1xuXHRcdGNvbnN0IGNoID0gdGhpcy5jaHVua3NCeUtleS5nZXQoa2V5KTtcblx0XHRyZXR1cm4gY2g/LnZlY3RvciA/PyBudWxsO1xuXHR9XG5cblx0YnVpbGRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IG51bWJlcltdIHtcblx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIGJ1aWxkUXVlcnlWZWN0b3IgY2FsbGVkOyByZXR1cm5pbmcgZW1wdHkgdmVjdG9yLiBVc2UgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLicpO1xuXHRcdHJldHVybiBbXTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgdmVjID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcocXVlcnlUZXh0KTtcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjKSB8fCB2ZWMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xuXHRcdH1cblx0XHRyZXR1cm4gdmVjO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGRpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGRpcik7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG5cdFxufVxuXG5cbiJdfQ==