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
    /**
     * Hot-swaps the embedding provider (e.g. when user changes models).
     */
    updateProvider(provider) {
        this.embeddingProvider = provider;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBVyxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFhaEQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEdBQUcsRUFBRSxH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Q2pDLE9BQU8sRUFBRSxDQUFDO1lBQ1YsR0FBRyxFQUFFLElBQUksQ0FBQyxHQUFHO1lBQ2IsT0FBTyxFQUFFLElBQUksQ0FBQyxPQUFPO1lBQ3JCLFFBQVEsRUFBRSxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQztZQUNsQyxNQUFNLEVBQUUsSUFBSSxDQUFDLFlBQVksRUFBRTtTQUMzQixDQUFDO1FBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixFQUFFLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7SUFFTyxxQkFBcUI7UUFDNUIsSUFBSSxJQUFJLENBQUMsaUJBQWlCO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUN4RSxJQUFJLENBQUMsaUJBQWlCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDL0MsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDMUMsU0FBUztZQUNWLENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1YsQ0FBQztDQUVEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5pbXBvcnQgeyBmbnYxYTMyLCBzaGEyNTYgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XG5pbXBvcnQgeyBPbGxhbWFFbWJlZGRpbmdQcm92aWRlciB9IGZyb20gJy4vT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXInO1xuaW1wb3J0IHsgQ09fQVVUSE9SSU5HX1BPTElDWSB9IGZyb20gJy4uL3BvbGljeSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhlZENodW5rIHtcblx0a2V5OiBzdHJpbmc7XG5cdHBhdGg6IHN0cmluZztcblx0Y2h1bmtJbmRleDogbnVtYmVyO1xuXHRzdGFydFdvcmQ6IG51bWJlcjtcblx0ZW5kV29yZDogbnVtYmVyO1xuXHR0ZXh0SGFzaDogc3RyaW5nOyAvLyBTSEEtMjU2XG5cdHZlY3RvcjogbnVtYmVyW107XG5cdGV4Y2VycHQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBTdGFibGUgbm9ybWFsaXphdGlvbiBmb3IgYml0LXBlcmZlY3QgaGFzaCBjb250aW51aXR5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplQ2h1bmtUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiB0ZXh0XG5cdFx0LnRyaW0oKVxuXHRcdC5yZXBsYWNlKC9cXHJcXG4vZywgJ1xcbicpIC8vIE5vcm1hbGl6ZSBuZXdsaW5lc1xuXHRcdC5yZXBsYWNlKC9cXHIvZywgJ1xcbicpXG5cdFx0LnJlcGxhY2UoL1sgXFx0XSsvZywgJyAnKTsgLy8gTm9ybWFsaXplIHNwYWNlcy90YWJzXG59XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcblx0dmVyc2lvbjogMTtcblx0ZGltOiBudW1iZXI7XG5cdGJhY2tlbmQ6ICdvbGxhbWEnO1xuXHRjaHVua2luZz86IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH07XG5cdGNodW5rczogSW5kZXhlZENodW5rW107XG59XG5cbmZ1bmN0aW9uIGNsYW1wSW50KHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xufVxuXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXG5cdFx0b3ZlcmxhcFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwLCAwLCA1MDApXG5cdH07XG59XG5cbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuXHRpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkO1xuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcbn1cblxuaW50ZXJmYWNlIEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZzsgLy8gV2hlcmUgdGhlIGVycm9yIG9jY3VycmVkIChtZXRob2QvZnVuY3Rpb24gbmFtZSlcblx0Y29udGV4dDogc3RyaW5nOyAvLyBXaGF0IHdhcyBoYXBwZW5pbmcgKGZpbGUgcGF0aCwgY2h1bmsgaW5kZXgsIGV0Yy4pXG5cdG1lc3NhZ2U6IHN0cmluZztcblx0c3RhY2s/OiBzdHJpbmc7XG5cdGVycm9yVHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSBkaW06IG51bWJlcjtcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnb2xsYW1hJztcblx0cHJpdmF0ZSBlbWJlZGRpbmdQcm92aWRlcjogT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXI7XG5cblx0cHJpdmF0ZSBsb2FkZWQgPSBmYWxzZTtcblx0cHJpdmF0ZSBjaHVua3NCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBJbmRleGVkQ2h1bms+KCk7XG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgcXVldWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgcmVidWlsZFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHNldHRpbmdzU2F2ZVRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBFcnJvciB0cmFja2luZ1xuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSAxMDA7XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sIGVtYmVkZGluZ1Byb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHR0aGlzLmJhY2tlbmQgPSAnb2xsYW1hJztcblx0XHR0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyID0gZW1iZWRkaW5nUHJvdmlkZXI7XG5cdFx0dGhpcy5kaW0gPSAwO1xuXHR9XG5cblx0LyoqXG5cdCAqIEhvdC1zd2FwcyB0aGUgZW1iZWRkaW5nIHByb3ZpZGVyIChlLmcuIHdoZW4gdXNlciBjaGFuZ2VzIG1vZGVscykuXG5cdCAqL1xuXHR1cGRhdGVQcm92aWRlcihwcm92aWRlcjogT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXIpIHtcblx0XHR0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyID0gcHJvdmlkZXI7XG5cdH1cblxuXHRnZXRJbmRleEZpbGVQYXRoKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9pbmRleC5qc29uYDtcblx0fVxuXG5cdGFzeW5jIGNsZWFySW5kZXgoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IHt9O1xuXHRcdGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuXHRcdGNvbnN0IHBhdGggPSB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkge1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShwYXRoKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMubG9hZGVkKSByZXR1cm47XG5cdFx0dGhpcy5sb2FkZWQgPSB0cnVlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHBhdGggPSB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChwYXRoKTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRJbmRleFYxO1xuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xuXHRcdFx0aWYgKHBhcnNlZC5iYWNrZW5kICYmIHBhcnNlZC5iYWNrZW5kICE9PSB0aGlzLmJhY2tlbmQpIHtcblx0XHRcdFx0Ly8gQmFja2VuZCBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAodHlwZW9mIHBhcnNlZC5kaW0gPT09ICdudW1iZXInKSB7XG5cdFx0XHRcdHRoaXMuZGltID0gcGFyc2VkLmRpbTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4cGVjdGVkQ2h1bmtpbmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0XHRpZiAoXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxuXHRcdFx0XHQocGFyc2VkLmNodW5raW5nLmhlYWRpbmdMZXZlbCAhPT0gZXhwZWN0ZWRDaHVua2luZy5oZWFkaW5nTGV2ZWwgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcudGFyZ2V0V29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcudGFyZ2V0V29yZHMgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3Jkcylcblx0XHRcdCkge1xuXHRcdFx0XHQvLyBDaHVua2luZyBjb25maWcgY2hhbmdlZDsgcmVidWlsZCBpbmRleC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcblx0XHRcdFx0aWYgKCFjaHVuaz8ua2V5IHx8ICFjaHVuaz8ucGF0aCB8fCAhQXJyYXkuaXNBcnJheShjaHVuay52ZWN0b3IpKSBjb250aW51ZTtcblx0XHRcdFx0dGhpcy5fc2V0Q2h1bmsoY2h1bmspO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gQ29ycnVwdCBpbmRleCBzaG91bGQgbm90IGJyZWFrIHRoZSBwbHVnaW4uIFdlJ2xsIHJlYnVpbGQgbGF6aWx5LlxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcblx0XHR9XG5cdH1cblxuXHRnZXRTdGF0dXMoKTogeyBpbmRleGVkRmlsZXM6IG51bWJlcjsgaW5kZXhlZENodW5rczogbnVtYmVyOyBwYXVzZWQ6IGJvb2xlYW47IHF1ZXVlZDogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXG5cdFx0XHRpbmRleGVkQ2h1bmtzOiB0aGlzLmNodW5rc0J5S2V5LnNpemUsXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcblx0XHR9O1xuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IEVycm9yTG9nRW50cnlbXSB7XG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcblx0fVxuXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xuXHRcdGNvbnN0IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcblx0XHRmb3IgKGNvbnN0IGVyciBvZiB0aGlzLmVycm9yTG9nKSB7XG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcblx0XHRcdGJ5TG9jYXRpb24sXG5cdFx0XHRyZWNlbnQ6IHRoaXMuZXJyb3JMb2cuc2xpY2UoLTEwKVxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXHRcdFxuXHRcdGNvbnN0IGVudHJ5OiBFcnJvckxvZ0VudHJ5ID0ge1xuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRsb2NhdGlvbixcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxuXHRcdFx0ZXJyb3JUeXBlXG5cdFx0fTtcblx0XHRcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIEFsc28gbG9nIHRvIGNvbnNvbGUgZm9yIGRlYnVnZ2luZ1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcblx0XHR9XG5cdH1cblxuXHRlbnF1ZXVlRnVsbFJlc2NhbigpOiB2b2lkIHtcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0cXVldWVVcGRhdGVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUmVidWlsZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVSZWJ1aWxkKCk6IHZvaWQge1xuXHRcdGNvbnN0IHBvbGljeSA9IENPX0FVVEhPUklOR19QT0xJQ1kuUEVSRk9STUFOQ0U7XG5cdFx0aWYgKHRoaXMucmVidWlsZFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucmVidWlsZFRpbWVyKTtcblx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucmVidWlsZFRpbWVyID0gbnVsbDtcblx0XHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0XHR9LCBwb2xpY3kuUkVCVUlMRF9RVUVVRV9ERUJPVU5DRV9NUyk7XG5cdH1cblxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy53b3JrZXJSdW5uaW5nKSByZXR1cm47XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXG5cdFx0dm9pZCB0aGlzLl9ydW5Xb3JrZXIoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIHRvIGF2b2lkIGZhaWx1cmVzLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIHNlbWFudGljIGluZGV4aW5nJyk7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xuXHRcdFxuXHRcdHdoaWxlICh0aGlzLnF1ZXVlLnNpemUgPiAwICYmIGluZGV4ZWRDb3VudCA8IHBvbGljeS5NQVhfUkVCVUlMRFNfUEVSX0JBVENIKSB7XG5cdFx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpIGJyZWFrO1xuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcblx0XHRcdHRoaXMucXVldWUuZGVsZXRlKG5leHQpO1xuXHRcdFx0cHJvY2Vzc2VkQ291bnQrKztcblxuXHRcdFx0Ly8gRXhjbHVzaW9ucyBjYW4gY2hhbmdlIGF0IGFueSB0aW1lOyBob25vciB0aGVtIGR1cmluZyBwcm9jZXNzaW5nLlxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChuZXh0KSkge1xuXHRcdFx0XHRza2lwcGVkRXhjbHVkZWQrKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobmV4dCk7XG5cdFx0XHQvLyBPbmx5IGluZGV4IG1hcmtkb3duIGZpbGVzLlxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCBmaWxlLmV4dGVuc2lvbiAhPT0gJ21kJykge1xuXHRcdFx0XHRza2lwcGVkTm90TWFya2Rvd24rKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xuXHRcdFx0XHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjb250ZW50KTtcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZENvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHR9XG5cblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIGZvciB0aGlzIGZpbGUuXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBPbGxhbWEgbm90IGF2YWlsYWJsZTsgc2tpcHBpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQmFja2VuZDogJHt0aGlzLmJhY2tlbmR9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDb250ZW50IGxlbmd0aDogJHtjb250ZW50Lmxlbmd0aH0gY2hhcnMsICR7Y29udGVudC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHNgKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5raW5nIGNvbmZpZzogaGVhZGluZ0xldmVsPSR7Y2ZnLmhlYWRpbmdMZXZlbH0sIHRhcmdldFdvcmRzPSR7Y2ZnLnRhcmdldFdvcmRzfSwgb3ZlcmxhcFdvcmRzPSR7Y2ZnLm92ZXJsYXBXb3Jkc31gKTtcblx0XHRcblx0XHRjb25zdCBjaHVua3MgPSBidWlsZEluZGV4Q2h1bmtzKHtcblx0XHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGNmZy5oZWFkaW5nTGV2ZWwsXG5cdFx0XHR0YXJnZXRXb3JkczogY2ZnLnRhcmdldFdvcmRzLFxuXHRcdFx0b3ZlcmxhcFdvcmRzOiBjZmcub3ZlcmxhcFdvcmRzXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua3MgY3JlYXRlZDogJHtjaHVua3MubGVuZ3RofWApO1xuXHRcdGlmIChjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYCAgLSBGaXJzdCBjaHVuayBwcmV2aWV3OiAke2NodW5rc1swXS50ZXh0LnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuXHRcdH1cblx0XHRcblx0XHQvLyBJZiBubyBjaHVua3MgY3JlYXRlZCwgc2tpcCB0aGlzIGZpbGUgKG1pZ2h0IGJlIHRvbyBzaG9ydCBvciBoYXZlIG5vIGhlYWRpbmdzKVxuXHRcdGlmIChjaHVua3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE5vIGNodW5rcyBjcmVhdGVkIGZvciAke3BhdGh9IC0gZmlsZSB0b28gc2hvcnQgb3Igbm8gaGVhZGluZ3MgbWF0Y2ggY2h1bmtpbmcgY29uZmlnYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRUZXh0ID0gbm9ybWFsaXplQ2h1bmtUZXh0KGNoLnRleHQpO1xuXHRcdFx0Y29uc3QgdGV4dEhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0Y29uc3Qga2V5ID0gYGNodW5rOiR7cGF0aH06JHtpfWA7XG5cdFx0XHRsZXQgdmVjdG9yOiBudW1iZXJbXTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XG5cdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhub3JtYWxpemVkVGV4dCk7XG5cdFx0XHRcdGlmICghQXJyYXkuaXNBcnJheSh2ZWN0b3IpIHx8IHZlY3Rvci5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICh0aGlzLmRpbSA9PT0gMCkge1xuXHRcdFx0XHRcdHRoaXMuZGltID0gdmVjdG9yLmxlbmd0aDtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIE9sbGFtYSBlbWJlZGRpbmcgZ2VuZXJhdGVkIGluICR7ZW1iZWREdXJhdGlvbn1tczogJHt2ZWN0b3IubGVuZ3RofSBkaW1lbnNpb25zYCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgY29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBDaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzLCAke2NoLnRleHQubGVuZ3RofSBjaGFycylgO1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuZW1iZWRDaHVuaycsIGNvbnRleHQsIGVycik7XG5cdFx0XHRcdFxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofTpgLCBlcnJvck1zZyk7XG5cdFx0XHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIFN0YWNrOiAke2Vycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbiAgICAnKX1gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgRXJyb3IgdHlwZTogJHtlcnIuY29uc3RydWN0b3IubmFtZX1gKTtcblx0XHRcdFx0XHRpZiAoJ2NhdXNlJyBpbiBlcnIpIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBDYXVzZTogJHtlcnIuY2F1c2V9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIElmIEFMTCBjaHVua3MgZmFpbCBmb3IgYSBmaWxlLCB0aGUgZmlsZSB3b24ndCBiZSBpbmRleGVkXG5cdFx0XHRcdC8vIFRoaXMgaXMgYSBjcml0aWNhbCBmYWlsdXJlIHRoYXQgc2hvdWxkIGJlIGxvZ2dlZFxuXHRcdFx0XHRpZiAoaSA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgICAtIFdhcm5pbmc6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofS4gQXR0ZW1wdGluZyBzdWJzZXF1ZW50IGNodW5rcy5gKTtcblx0XHRcdFx0XHRmaXJzdEVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgMjUwMCk7XG5cdFx0XHR0aGlzLl9zZXRDaHVuayh7XG5cdFx0XHRcdGtleSxcblx0XHRcdFx0cGF0aCxcblx0XHRcdFx0Y2h1bmtJbmRleDogaSxcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydFdvcmQsXG5cdFx0XHRcdGVuZFdvcmQ6IGNoLmVuZFdvcmQsXG5cdFx0XHRcdHRleHRIYXNoLFxuXHRcdFx0XHR2ZWN0b3IsXG5cdFx0XHRcdGV4Y2VycHRcblx0XHRcdH0pO1xuXHRcdFx0c3VjY2Vzc2Z1bENodW5rcysrO1xuXHRcdH1cblx0XHRcblx0XHRpZiAoc3VjY2Vzc2Z1bENodW5rcyA9PT0gMCAmJiBjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgY3JpdGljYWxDb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWRgO1xuXHRcdFx0aWYgKGZpcnN0RXJyb3IpIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgZmlyc3RFcnJvcik7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIENSSVRJQ0FMOiBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkIGZvciAke3BhdGh9IC0gZmlsZSBub3QgaW5kZXhlZGApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIFJvb3QgY2F1c2U6ICR7Zmlyc3RFcnJvci5tZXNzYWdlfWApO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgbmV3IEVycm9yKCdBbGwgY2h1bmtzIGZhaWxlZCBidXQgbm8gZmlyc3QgZXJyb3IgY2FwdHVyZWQnKSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBQYXJ0aWFsIHN1Y2Nlc3MgZm9yICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30vJHtjaHVua3MubGVuZ3RofSBjaHVua3MgaW5kZXhlZGApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ29tcHV0ZXMgYSBiaXQtcGVyZmVjdCBjb3JwdXMgaGFzaCBmb3Igc3RyaWN0IHJlcGxheS5cblx0ICogc2hhMjU2KGpvaW4oc29ydChjaHVua19pZCArIFwiOlwiICsgY29udGVudF9oYXNoKSwgXCJcXG5cIikpXG5cdCAqL1xuXHRhc3luYyBnZXRDb3JwdXNIYXNoKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgY2h1bmtzID0gdGhpcy5nZXRBbGxDaHVua3MoKTtcblx0XHRjb25zdCBsaW5lcyA9IGNodW5rcy5tYXAoYyA9PiBgJHtjLmtleX06JHtjLnRleHRIYXNofWApO1xuXHRcdGxpbmVzLnNvcnQoKTtcblx0XHRjb25zdCBqb2luZWQgPSBsaW5lcy5qb2luKCdcXG4nKTtcblx0XHRyZXR1cm4gYXdhaXQgc2hhMjU2KGpvaW5lZCk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2tzIGlmIGEgcGF0aCBpcyBjdXJyZW50bHkgbWFya2VkIGFzIHN0YWxlIGluIHRoZSBpbmRleCBzdGF0ZS5cblx0ICovXG5cdGlzU3RhbGUocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0Y29uc3Qgc3RhdGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF07XG5cdFx0aWYgKCFzdGF0ZSkgcmV0dXJuIGZhbHNlO1xuXHRcdFxuXHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcblx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSByZXR1cm4gdHJ1ZTsgLy8gTWlzc2luZyBmaWxlIGlzIGVmZmVjdGl2ZWx5IHN0YWxlXG5cdFx0XG5cdFx0Ly8gSWYgdXBkYXRlZEF0IGlzIG5vdCBzZXQsIHdlIGNhbid0IGJlIHN1cmUsIGFzc3VtZSBub3Qgc3RhbGUgZm9yIG5vd1xuXHRcdGlmICghc3RhdGUudXBkYXRlZEF0KSByZXR1cm4gZmFsc2U7XG5cdFx0XG5cdFx0Y29uc3QgZmlsZU10aW1lID0gZmlsZS5zdGF0Lm10aW1lO1xuXHRcdGNvbnN0IGluZGV4VGltZSA9IG5ldyBEYXRlKHN0YXRlLnVwZGF0ZWRBdCkuZ2V0VGltZSgpO1xuXHRcdFxuXHRcdHJldHVybiBmaWxlTXRpbWUgPiBpbmRleFRpbWU7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cblx0ICovXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdGdldFZlY3RvckZvcktleShrZXk6IHN0cmluZyk6IG51bWJlcltdIHwgbnVsbCB7XG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XG5cdH1cblxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xuXHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gYnVpbGRRdWVyeVZlY3RvciBjYWxsZWQ7IHJldHVybmluZyBlbXB0eSB2ZWN0b3IuIFVzZSBlbWJlZFF1ZXJ5VmVjdG9yIGluc3RlYWQuJyk7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0YXN5bmMgZW1iZWRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRjb25zdCB2ZWMgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhxdWVyeVRleHQpO1xuXHRcdGlmICghQXJyYXkuaXNBcnJheSh2ZWMpIHx8IHZlYy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignRW1wdHkgZW1iZWRkaW5nIHJldHVybmVkIGZyb20gT2xsYW1hJyk7XG5cdFx0fVxuXHRcdHJldHVybiB2ZWM7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVBlcnNpc3QoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMucGVyc2lzdFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucGVyc2lzdFRpbWVyKTtcblx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucGVyc2lzdFRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5fcGVyc2lzdE5vdygpLmNhdGNoKCgpID0+IHtcblx0XHRcdFx0Ly8gaWdub3JlXG5cdFx0XHR9KTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3BlcnNpc3ROb3coKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgZGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR0cnkge1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhkaXIpKSkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoZGlyKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIGlnbm9yZSBta2RpciBmYWlsdXJlc1xuXHRcdH1cblxuXHRcdGNvbnN0IHBheWxvYWQ6IFBlcnNpc3RlZEluZGV4VjEgPSB7XG5cdFx0XHR2ZXJzaW9uOiAxLFxuXHRcdFx0ZGltOiB0aGlzLmRpbSxcblx0XHRcdGJhY2tlbmQ6IHRoaXMuYmFja2VuZCxcblx0XHRcdGNodW5raW5nOiBjaHVua2luZ0tleSh0aGlzLnBsdWdpbiksXG5cdFx0XHRjaHVua3M6IHRoaXMuZ2V0QWxsQ2h1bmtzKClcblx0XHR9O1xuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZSh0aGlzLmdldEluZGV4RmlsZVBhdGgoKSwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XG5cdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblx0XG59XG5cblxuIl19