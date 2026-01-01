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
                    console.error(`  - CRITICAL: First chunk failed for ${path} - file will not be indexed`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBVyxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFhaEQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEdBQUcsRUFBRSxHQUFHLEVBQUUsSUFBSSxDQUFDO1FBQzVFLFlBQVksRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQywwQkFBMEIsSUFBSSxHQUFHLEVBQUUsQ0FBQyxFQUFFLEdBQUcsQ0FBQztLQUNqRixDQUFDO0FBQ0gsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLElBQVksRUFBRSxRQUFnQjtJQUNoRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNqRCxJQUFJLE9BQU8sQ0FBQyxNQUFNLElBQUksUUFBUTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQy9DLE9BQU8sR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDO0FBQ3pDLENBQUM7QUFXRCxNQUFNLE9BQU8sZUFBZTtJQXFCM0IsWUFBWSxLQUFZLEVBQUUsTUFBOEIsRUFBRSxpQkFBMEM7UUFkNUYsV0FBTSxHQUFHLEtBQUssQ0FBQztRQUNmLGdCQUFXLEdBQUcsSUFBSSxHQUFHLEVBQXdCLENBQUM7UUFDOUMsb0JBQWUsR0FBRyxJQUFJLEdBQUcsRUFBdUIsQ0FBQztRQUV4QyxVQUFLLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUNuQyxrQkFBYSxHQUFHLEtBQUssQ0FBQztRQUN0QixpQkFBWSxHQUFrQixJQUFJLENBQUM7UUFDbkMsaUJBQVksR0FBa0IsSUFBSSxDQUFDO1FBQ25DLHNCQUFpQixHQUFrQixJQUFJLENBQUM7UUFFaEQsaUJBQWlCO1FBQ0EsYUFBUSxHQUFvQixFQUFFLENBQUM7UUFDL0Isb0JBQWUsR0FBRyxHQUFHLENBQUM7UUFHdEMsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFDckIsSUFBSSxDQUFDLE9BQU8sR0FBRyxRQUFRLENBQUM7UUFDeEIsSUFBSSxDQUFDLGlCQUFpQixHQUFHLGlCQUFpQixDQUFDO1FBQzNDLElBQUksQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsQ0FBQztJQUVELGdCQUFnQjtRQUNmLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLHVCQUF1QixDQUFDO0lBQzFGLENBQUM7SUFFRCxLQUFLLENBQUMsWUFBWTtRQUNqQixJQUFJLElBQUksQ0FBQyxNQUFNO1lBQUUsT0FBTztRQUN4QixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUVuQixJQUFJLENBQUM7WUFDSixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUNyQyxJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFBRSxPQUFPO1lBQ3JELE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2hELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFxQixDQUFDO1lBQ25ELElBQUksTUFBTSxFQUFFLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUM7Z0JBQUUsT0FBTztZQUNuRSxJQUFJLE1BQU0sQ0FBQyxPQUFPLElBQUksTUFBTSxDQUFDLE9BQU8sS0FBSyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7Z0JBQ3ZELHdEQUF3RDtnQkFDeEQsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7Z0JBQ3pCLE9BQU87WUFDUixDQUFDO1lBQ0QsSUFBSSxPQUFPLE1BQU0sQ0FBQyxHQUFHLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ3BDLElBQUksQ0FBQyxHQUFHLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQztZQUN2QixDQUFDO1lBQ0QsTUFBTSxnQkFBZ0IsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQ2xELElBQ0MsTUFBTSxDQUFDLFFBQVE7Z0JBQ2YsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFlBQVksS0FBSyxnQkFBZ0IsQ0FBQyxZQUFZO29CQUM5RCxNQUFNLENBQUMsUUFBUSxDQUFDLFdBQVcsS0FBSyxnQkFBZ0IsQ0FBQyxXQUFXO29CQUM1RCxNQUFNLENBQUMsUUFBUSxDQUFDLFlBQVksS0FBSyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsRUFDL0QsQ0FBQztnQkFDRiwwQ0FBMEM7Z0JBQzFDLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO2dCQUN6QixPQUFPO1lBQ1IsQ0FBQztZQUNELEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO2dCQUNuQyxJQUFJLENBQUMsS0FBSyxFQUFFLEdBQUcsSUFBSSxDQUFDLEtBQUssRUFBRSxJQUFJLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUM7b0JBQUUsU0FBUztnQkFDMUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztZQUN2QixDQUFDO1FBQ0YsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNSLG1FQUFtRTtZQUNuRSxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ3pCLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDOUIsQ0FBQztJQUNGLENBQUM7SUFFRCxTQUFTO1FBQ1IsT0FBTztZQUNOLFlBQVksRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUk7WUFDdkMsYUFBYSxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSTtZQUNwQyxNQUFNLEVBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG9CQUFvQixDQUFDO1lBQzFELE1BQU0sRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUk7U0FDdkIsQ0FBQztJQUNILENBQUM7SUFFRCxlQUFlLENBQUMsUUFBZ0IsRUFBRTtRQUNqQyxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEMsQ0FBQztJQUVELGVBQWU7UUFDZCxNQUFNLFVBQVUsR0FBMkIsRUFBRSxDQUFDO1FBQzlDLEtBQUssTUFBTSxHQUFHLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2pDLFVBQVUsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNoRSxDQUFDO1FBQ0QsT0FBTztZQUNOLEtBQUssRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU07WUFDM0IsVUFBVTtZQUNWLE1BQU0sRUFBRSxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQztTQUNoQyxDQUFDO0lBQ0gsQ0FBQztJQUVPLFFBQVEsQ0FBQyxRQUFnQixFQUFFLE9BQWUsRUFBRSxLQUFjO1FBQ2pFLE1BQU0sUUFBUSxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN4RSxNQUFNLFVBQVUsR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7UUFDcEUsTUFBTSxTQUFTLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sS0FBSyxDQUFDO1FBRWpGLE1BQU0sS0FBSyxHQUFrQjtZQUM1QixTQUFTLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7WUFDbkMsUUFBUTtZQUNSLE9BQU87WUFDUCxPQUFPLEVBQUUsUUFBUTtZQUNqQixLQUFLLEVBQUUsVUFBVTtZQUNqQixTQUFTO1NBQ1QsQ0FBQztRQUVGLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ2pELElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDdkIsQ0FBQztRQUVELG9DQUFvQztRQUNwQyxPQUFPLENBQUMsS0FBSyxDQUFDLDRCQUE0QixRQUFRLEtBQUssT0FBTyxHQUFHLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDN0UsSUFBSSxVQUFVLEVBQUUsQ0FBQztZQUNoQixPQUFPLENBQUMsS0FBSyxDQUFDLDBCQUEwQixFQUFFLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztRQUMxRixDQUFDO0lBQ0YsQ0FBQztJQUVELGlCQUFpQjtRQUNoQixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyx3QkFBd0IsRUFBRSxDQUFDO1FBQ2xFLEtBQUssTUFBTSxDQUFDLElBQUksS0FBSztZQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM5QyxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDcEIsQ0FBQztJQUVELGVBQWUsQ0FBQyxJQUFZO1FBQzNCLElBQUksQ0FBQyxJQUFJO1lBQUUsT0FBTztRQUNsQixJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNyQixJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztJQUN6QixDQUFDO0lBRU8sZ0JBQWdCO1FBQ3ZCLE1BQU0sTUFBTSxHQUFHLG1CQUFtQixDQUFDLFdBQVcsQ0FBQztRQUMvQyxJQUFJLElBQUksQ0FBQyxZQUFZO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDOUQsSUFBSSxDQUFDLFlBQVksR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMxQyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQztZQUN6QixJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7UUFDcEIsQ0FBQyxFQUFFLE1BQU0sQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQ3RDLENBQUM7SUFFRCxlQUFlLENBQUMsSUFBWTtRQUMzQixJQUFJLENBQUMsSUFBSTtZQUFFLE9BQU87UUFDbEIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN2QixJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztJQUM5QixDQUFDO0lBRU8sV0FBVztRQUNsQixJQUFJLElBQUksQ0FBQyxhQUFhO1lBQUUsT0FBTztRQUMvQixJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztRQUMxQixvREFBb0Q7UUFDcEQsS0FBSyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtZQUNqQyxJQUFJLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQztRQUM1QixDQUFDLENBQUMsQ0FBQztJQUNKLENBQUM7SUFFTyxLQUFLLENBQUMsVUFBVTtRQUN2QixNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUMxQix3RUFBd0U7UUFDeEUsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsaUJBQWlCLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQ25ELE9BQU8sQ0FBQyxJQUFJLENBQUMsb0VBQW9FLENBQUMsQ0FBQztZQUNuRixJQUFJLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQztZQUMzQixPQUFPO1FBQ1IsQ0FBQztRQUVELE1BQU0sTUFBTSxHQUFHLG1CQUFtQixDQUFDLFdBQVcsQ0FBQztRQUMvQyxJQUFJLGNBQWMsR0FBRyxDQUFDLENBQUM7UUFDdkIsSUFBSSxlQUFlLEdBQUcsQ0FBQyxDQUFDO1FBQ3hCLElBQUksa0JBQWtCLEdBQUcsQ0FBQyxDQUFDO1FBQzNCLElBQUksZ0JBQWdCLEdBQUcsQ0FBQyxDQUFDO1FBQ3pCLElBQUksWUFBWSxHQUFHLENBQUMsQ0FBQztRQUVyQixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxHQUFHLENBQUMsSUFBSSxZQUFZLEdBQUcsTUFBTSxDQUFDLHNCQUFzQixFQUFFLENBQUM7WUFDNUUsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxvQkFBb0I7Z0JBQUUsTUFBTTtZQUNyRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDLElBQUksRUFBRSxDQUFDLEtBQWUsQ0FBQztZQUN4RCxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN4QixjQUFjLEVBQUUsQ0FBQztZQUVqQixtRUFBbUU7WUFDbkUsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDbkQsZUFBZSxFQUFFLENBQUM7Z0JBQ2xCLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3ZCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2dCQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztnQkFDN0IsU0FBUztZQUNWLENBQUM7WUFFRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLHFCQUFxQixDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3BELDZCQUE2QjtZQUM3QixJQUFJLENBQUMsQ0FBQyxJQUFJLFlBQVksS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLFNBQVMsS0FBSyxJQUFJLEVBQUUsQ0FBQztnQkFDekQsa0JBQWtCLEVBQUUsQ0FBQztnQkFDckIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDdkIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7Z0JBQ3hCLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxDQUFDO2dCQUM3QixTQUFTO1lBQ1YsQ0FBQztZQUVELElBQUksQ0FBQztnQkFDSixNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUM1QyxNQUFNLGlCQUFpQixHQUFHLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxDQUFDO2dCQUN0RCxNQUFNLFFBQVEsR0FBRyxNQUFNLE1BQU0sQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO2dCQUNqRCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUM5RCxNQUFNLGtCQUFrQixHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUUxRCx5REFBeUQ7Z0JBQ3pELGlGQUFpRjtnQkFDakYsSUFBSSxJQUFJLEVBQUUsSUFBSSxLQUFLLFFBQVEsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO29CQUNuRCxnQkFBZ0IsRUFBRSxDQUFDO29CQUNuQixTQUFTO2dCQUNWLENBQUM7Z0JBRUQsTUFBTSxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxPQUFPLENBQUMsQ0FBQztnQkFDdkMsWUFBWSxFQUFFLENBQUM7Z0JBQ2YsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLEdBQUc7b0JBQzFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsSUFBSSxFQUFFLENBQUM7b0JBQ25ELENBQUMsSUFBSSxDQUFDLEVBQUU7d0JBQ1AsSUFBSSxFQUFFLFFBQVE7d0JBQ2QsVUFBVSxFQUFFLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksSUFBSSxDQUFDO3dCQUNyRCxTQUFTLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7cUJBQ25DO2lCQUNELENBQUM7Z0JBQ0YsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7Z0JBQ3hCLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxDQUFDO1lBQzlCLENBQUM7WUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO2dCQUNkLCtDQUErQztnQkFDL0MsSUFBSSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEVBQUUsb0JBQW9CLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQzlELENBQUM7WUFFRCwrQkFBK0I7WUFDL0IsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzdDLENBQUM7UUFFRCxtQ0FBbUM7UUFDbkMsSUFBSSxjQUFjLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDeEIsT0FBTyxDQUFDLEdBQUcsQ0FBQywrQkFBK0IsY0FBYyxXQUFXLFlBQVksYUFBYSxlQUFlLGNBQWMsa0JBQWtCLGtCQUFrQixnQkFBZ0IsK0JBQStCLENBQUMsQ0FBQztRQUNoTixDQUFDO1FBRUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUM7SUFDNUIsQ0FBQztJQUVPLEtBQUssQ0FBQyxZQUFZLENBQUMsSUFBWSxFQUFFLE9BQWU7UUFDdkQsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUV2QixvRUFBb0U7UUFDcEUsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsaUJBQWlCLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQ25ELE9BQU8sQ0FBQyxJQUFJLENBQUMsMERBQTBELElBQUksRUFBRSxDQUFDLENBQUM7WUFDL0UsT0FBTztRQUNSLENBQUM7UUFFRCxtQkFBbUI7UUFDbkIsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzdDLE9BQU8sQ0FBQyxJQUFJLENBQUMsMENBQTBDLElBQUksRUFBRSxDQUFDLENBQUM7WUFDL0QsT0FBTztRQUNSLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3JDLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0NBQXNDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDMUQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDNUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyx1QkFBdUIsT0FBTyxDQUFDLE1BQU0sV0FBVyxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sUUFBUSxDQUFDLENBQUM7UUFDakcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQ0FBcUMsR0FBRyxDQUFDLFlBQVksaUJBQWlCLEdBQUcsQ0FBQyxXQUFXLGtCQUFrQixHQUFHLENBQUMsWUFBWSxFQUFFLENBQUMsQ0FBQztRQUV2SSxNQUFNLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQztZQUMvQixJQUFJLEVBQUUsT0FBTztZQUNiLFlBQVksRUFBRSxHQUFHLENBQUMsWUFBWTtZQUM5QixXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVc7WUFDNUIsWUFBWSxFQUFFLEdBQUcsQ0FBQyxZQUFZO1NBQzlCLENBQUMsQ0FBQztRQUVILE9BQU8sQ0FBQyxHQUFHLENBQUMsdUJBQXVCLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ3BELElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2hGLENBQUM7UUFFRCxnRkFBZ0Y7UUFDaEYsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3pCLE9BQU8sQ0FBQyxJQUFJLENBQUMsMkNBQTJDLElBQUksd0RBQXdELENBQUMsQ0FBQztZQUN0SCxPQUFPO1FBQ1IsQ0FBQztRQUVELElBQUksZ0JBQWdCLEdBQUcsQ0FBQyxDQUFDO1FBQ3pCLElBQUksVUFBVSxHQUFpQixJQUFJLENBQUM7UUFDcEMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztZQUN4QyxNQUFNLEVBQUUsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDckIsTUFBTSxjQUFjLEdBQUcsa0JBQWtCLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ25ELE1BQU0sUUFBUSxHQUFHLE1BQU0sTUFBTSxDQUFDLGNBQWMsQ0FBQyxDQUFDO1lBQzlDLE1BQU0sR0FBRyxHQUFHLFNBQVMsSUFBSSxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ2pDLElBQUksTUFBZ0IsQ0FBQztZQUNyQixJQUFJLENBQUM7Z0JBQ0osT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQ0FBc0MsQ0FBQyxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUM7Z0JBQ3RILE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDOUIsTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxjQUFjLENBQUMsQ0FBQztnQkFDbkUsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztvQkFDbkQsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQ0FBc0MsQ0FBQyxDQUFDO2dCQUN6RCxDQUFDO2dCQUNELElBQUksSUFBSSxDQUFDLEdBQUcsS0FBSyxDQUFDLEVBQUUsQ0FBQztvQkFDcEIsSUFBSSxDQUFDLEdBQUcsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO2dCQUMxQixDQUFDO2dCQUNELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxVQUFVLENBQUM7Z0JBQzlDLE9BQU8sQ0FBQyxHQUFHLENBQUMsdUNBQXVDLGFBQWEsT0FBTyxNQUFNLENBQUMsTUFBTSxhQUFhLENBQUMsQ0FBQztZQUNwRyxDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDZCxNQUFNLFFBQVEsR0FBRyxHQUFHLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ2xFLE1BQU0sVUFBVSxHQUFHLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztnQkFDaEUsTUFBTSxPQUFPLEdBQUcsU0FBUyxJQUFJLFdBQVcsQ0FBQyxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sV0FBVyxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sU0FBUyxDQUFDO2dCQUNqSSxJQUFJLENBQUMsUUFBUSxDQUFDLHlCQUF5QixFQUFFLE9BQU8sRUFBRSxHQUFHLENBQUMsQ0FBQztnQkFFdkQsT0FBTyxDQUFDLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQyxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLEVBQUUsUUFBUSxDQUFDLENBQUM7Z0JBQ2xHLElBQUksVUFBVSxFQUFFLENBQUM7b0JBQ2hCLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDbEYsQ0FBQztnQkFDRCxJQUFJLEdBQUcsWUFBWSxLQUFLLEVBQUUsQ0FBQztvQkFDMUIsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQkFBbUIsR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO29CQUN6RCxJQUFJLE9BQU8sSUFBSSxHQUFHLEVBQUUsQ0FBQzt3QkFDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxjQUFjLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO29CQUMxQyxDQUFDO2dCQUNGLENBQUM7Z0JBQ0QsMkRBQTJEO2dCQUMzRCxtREFBbUQ7Z0JBQ25ELElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO29CQUNiLE9BQU8sQ0FBQyxLQUFLLENBQUMsd0NBQXdDLElBQUksNkJBQTZCLENBQUMsQ0FBQztvQkFDekYsVUFBVSxHQUFHLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7Z0JBQ2xFLENBQUM7Z0JBQ0QsK0RBQStEO2dCQUMvRCxTQUFTO1lBQ1YsQ0FBQztZQUNELE1BQU0sT0FBTyxHQUFHLFNBQVMsQ0FBQyxFQUFFLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDO1lBQ3pDLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ2QsR0FBRztnQkFDSCxJQUFJO2dCQUNKLFVBQVUsRUFBRSxDQUFDO2dCQUNiLFNBQVMsRUFBRSxFQUFFLENBQUMsU0FBUztnQkFDdkIsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPO2dCQUNuQixRQUFRO2dCQUNSLE1BQU07Z0JBQ04sT0FBTzthQUNQLENBQUMsQ0FBQztZQUNILGdCQUFnQixFQUFFLENBQUM7UUFDcEIsQ0FBQztRQUVELElBQUksZ0JBQWdCLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDakQsTUFBTSxlQUFlLEdBQUcsU0FBUyxJQUFJLFNBQVMsTUFBTSxDQUFDLE1BQU0sZ0JBQWdCLENBQUM7WUFDNUUsSUFBSSxVQUFVLEVBQUUsQ0FBQztnQkFDaEIsSUFBSSxDQUFDLFFBQVEsQ0FBQyw4QkFBOEIsRUFBRSxlQUFlLEVBQUUsVUFBVSxDQUFDLENBQUM7Z0JBQzNFLE9BQU8sQ0FBQyxLQUFLLENBQUMsbUNBQW1DLE1BQU0sQ0FBQyxNQUFNLHNCQUFzQixJQUFJLHFCQUFxQixDQUFDLENBQUM7Z0JBQy9HLE9BQU8sQ0FBQyxLQUFLLENBQUMsaUJBQWlCLFVBQVUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxDQUFDO1lBQ3RELENBQUM7aUJBQU0sQ0FBQztnQkFDUCxJQUFJLENBQUMsUUFBUSxDQUFDLDhCQUE4QixFQUFFLGVBQWUsRUFBRSxJQUFJLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQyxDQUFDLENBQUM7WUFDNUgsQ0FBQztRQUNGLENBQUM7YUFBTSxJQUFJLGdCQUFnQixHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUM3QyxPQUFPLENBQUMsSUFBSSxDQUFDLHlDQUF5QyxJQUFJLEtBQUssZ0JBQWdCLElBQUksTUFBTSxDQUFDLE1BQU0saUJBQWlCLENBQUMsQ0FBQztRQUNwSCxDQUFDO2FBQU0sQ0FBQztZQUNQLE9BQU8sQ0FBQyxHQUFHLENBQUMsNENBQTRDLElBQUksS0FBSyxnQkFBZ0IsU0FBUyxDQUFDLENBQUM7UUFDN0YsQ0FBQztJQUNGLENBQUM7SUFFTyxTQUFTLENBQUMsS0FBbUI7UUFDcEMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN2QyxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUN0RSxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQixJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFFTyxXQUFXLENBQUMsSUFBWTtRQUMvQixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUM1QyxJQUFJLElBQUksRUFBRSxDQUFDO1lBQ1YsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJO2dCQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2xELENBQUM7UUFDRCxJQUFJLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUVsQyxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUN0RCxNQUFNLElBQUksR0FBRyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsSUFBSSxFQUFFLENBQUMsRUFBRSxDQUFDO1lBQ3JFLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2xCLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixHQUFHLElBQUksQ0FBQztRQUNqRCxDQUFDO0lBQ0YsQ0FBQztJQUVELFlBQVk7UUFDWCxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO0lBQzlDLENBQUM7SUFFRDs7O09BR0c7SUFDSCxLQUFLLENBQUMsYUFBYTtRQUNsQixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDbkMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztRQUN4RCxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDYixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2hDLE9BQU8sTUFBTSxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVELGVBQWU7UUFDZCxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFFRDs7T0FFRztJQUNILE9BQU8sQ0FBQyxJQUFZO1FBQ25CLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixFQUFFLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDL0QsSUFBSSxDQUFDLEtBQUs7WUFBRSxPQUFPLEtBQUssQ0FBQztRQUV6QixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLHFCQUFxQixDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3BELElBQUksQ0FBQyxDQUFDLElBQUksWUFBWSxLQUFLLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQyxDQUFDLG9DQUFvQztRQUUvRSxzRUFBc0U7UUFDdEUsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTO1lBQUUsT0FBTyxLQUFLLENBQUM7UUFFbkMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUM7UUFDbEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBRXRELE9BQU8sU0FBUyxHQUFHLFNBQVMsQ0FBQztJQUM5QixDQUFDO0lBRUQ7O09BRUc7SUFDSCxzQkFBc0I7UUFDckIsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsZUFBZSxFQUFFO1lBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDMUQsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3BCLENBQUM7SUFFRCxlQUFlLENBQUMsR0FBVztRQUMxQixNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNyQyxPQUFPLEVBQUUsRUFBRSxNQUFNLElBQUksSUFBSSxDQUFDO0lBQzNCLENBQUM7SUFFRCxnQkFBZ0IsQ0FBQyxTQUFpQjtRQUNqQyxPQUFPLENBQUMsSUFBSSxDQUFDLGtHQUFrRyxDQUFDLENBQUM7UUFDakgsT0FBTyxFQUFFLENBQUM7SUFDWCxDQUFDO0lBRUQsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFNBQWlCO1FBQ3ZDLE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNqRSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxHQUFHLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzdDLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLENBQUMsQ0FBQztRQUN6RCxDQUFDO1FBQ0QsT0FBTyxHQUFHLENBQUM7SUFDWixDQUFDO0lBRU8sZ0JBQWdCO1FBQ3ZCLElBQUksSUFBSSxDQUFDLFlBQVk7WUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUM5RCxJQUFJLENBQUMsWUFBWSxHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQzFDLElBQUksQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDO1lBQ3pCLEtBQUssSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQ2xDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7SUFFTyxLQUFLLENBQUMsV0FBVztRQUN4QixNQUFNLEdBQUcsR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsWUFBWSxDQUFDO1FBQ25GLElBQUksQ0FBQztZQUNKLElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDN0MsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDckMsQ0FBQztRQUNGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUix3QkFBd0I7UUFDekIsQ0FBQztRQUVELE1BQU0sT0FBTyxHQUFxQjtZQUNqQyxPQUFPLEVBQUUsQ0FBQztZQUNWLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztZQUNyQixRQUFRLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7WUFDbEMsTUFBTSxFQUFFLElBQUksQ0FBQyxZQUFZLEVBQUU7U0FDM0IsQ0FBQztRQUNGLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUNsRixDQUFDO0lBRU8scUJBQXFCO1FBQzVCLElBQUksSUFBSSxDQUFDLGlCQUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xuaW1wb3J0IHsgZm52MWEzMiwgc2hhMjU2IH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuaW1wb3J0IHsgT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXIgfSBmcm9tICcuL09sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyJztcbmltcG9ydCB7IENPX0FVVEhPUklOR19QT0xJQ1kgfSBmcm9tICcuLi9wb2xpY3knO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XG5cdGtleTogc3RyaW5nO1xuXHRwYXRoOiBzdHJpbmc7XG5cdGNodW5rSW5kZXg6IG51bWJlcjtcblx0c3RhcnRXb3JkOiBudW1iZXI7XG5cdGVuZFdvcmQ6IG51bWJlcjtcblx0dGV4dEhhc2g6IHN0cmluZzsgLy8gU0hBLTI1NlxuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RhYmxlIG5vcm1hbGl6YXRpb24gZm9yIGJpdC1wZXJmZWN0IGhhc2ggY29udGludWl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNodW5rVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC50cmltKClcblx0XHQucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKSAvLyBOb3JtYWxpemUgbmV3bGluZXNcblx0XHQucmVwbGFjZSgvXFxyL2csICdcXG4nKVxuXHRcdC5yZXBsYWNlKC9bIFxcdF0rL2csICcgJyk7IC8vIE5vcm1hbGl6ZSBzcGFjZXMvdGFic1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkSW5kZXhWMSB7XG5cdHZlcnNpb246IDE7XG5cdGRpbTogbnVtYmVyO1xuXHRiYWNrZW5kOiAnb2xsYW1hJztcblx0Y2h1bmtpbmc/OiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9O1xuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xufVxuXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XG5cdHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgTWF0aC5mbG9vcih2YWx1ZSkpKTtcbn1cblxuZnVuY3Rpb24gY2h1bmtpbmdLZXkocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfSB7XG5cdHJldHVybiB7XG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcblx0XHR0YXJnZXRXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rV29yZHMgPz8gNTAwLCAyMDAsIDIwMDApLFxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxuXHR9O1xufVxuXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XG59XG5cbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgZGltOiBudW1iZXI7XG5cdHByaXZhdGUgcmVhZG9ubHkgYmFja2VuZDogJ29sbGFtYSc7XG5cdHByaXZhdGUgcmVhZG9ubHkgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyO1xuXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xuXHRwcml2YXRlIGNodW5rS2V5c0J5UGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdHByaXZhdGUgd29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHJlYnVpbGRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcGVyc2lzdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gRXJyb3IgdHJhY2tpbmdcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xuXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luLCBlbWJlZGRpbmdQcm92aWRlcjogT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXIpIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdFx0dGhpcy5iYWNrZW5kID0gJ29sbGFtYSc7XG5cdFx0dGhpcy5lbWJlZGRpbmdQcm92aWRlciA9IGVtYmVkZGluZ1Byb3ZpZGVyO1xuXHRcdHRoaXMuZGltID0gMDtcblx0fVxuXG5cdGdldEluZGV4RmlsZVBhdGgoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L2luZGV4Lmpzb25gO1xuXHR9XG5cblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQocGF0aCk7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcblx0XHRcdGlmIChwYXJzZWQ/LnZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocGFyc2VkLmNodW5rcykpIHJldHVybjtcblx0XHRcdGlmIChwYXJzZWQuYmFja2VuZCAmJiBwYXJzZWQuYmFja2VuZCAhPT0gdGhpcy5iYWNrZW5kKSB7XG5cdFx0XHRcdC8vIEJhY2tlbmQgbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJykge1xuXHRcdFx0XHR0aGlzLmRpbSA9IHBhcnNlZC5kaW07XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHBlY3RlZENodW5raW5nID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcblx0XHRcdFx0KHBhcnNlZC5jaHVua2luZy5oZWFkaW5nTGV2ZWwgIT09IGV4cGVjdGVkQ2h1bmtpbmcuaGVhZGluZ0xldmVsIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXG5cdFx0XHQpIHtcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XG5cdFx0XHRcdGlmICghY2h1bms/LmtleSB8fCAhY2h1bms/LnBhdGggfHwgIUFycmF5LmlzQXJyYXkoY2h1bmsudmVjdG9yKSkgY29udGludWU7XG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cblx0XHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0fVxuXHR9XG5cblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0aW5kZXhlZEZpbGVzOiB0aGlzLmNodW5rS2V5c0J5UGF0aC5zaXplLFxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxuXHRcdFx0cGF1c2VkOiBCb29sZWFuKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSxcblx0XHRcdHF1ZXVlZDogdGhpcy5xdWV1ZS5zaXplXG5cdFx0fTtcblx0fVxuXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRFcnJvclN1bW1hcnkoKTogeyB0b3RhbDogbnVtYmVyOyBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+OyByZWNlbnQ6IEVycm9yTG9nRW50cnlbXSB9IHtcblx0XHRjb25zdCBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xuXHRcdFx0YnlMb2NhdGlvbltlcnIubG9jYXRpb25dID0gKGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSB8fCAwKSArIDE7XG5cdFx0fVxuXHRcdHJldHVybiB7XG5cdFx0XHR0b3RhbDogdGhpcy5lcnJvckxvZy5sZW5ndGgsXG5cdFx0XHRieUxvY2F0aW9uLFxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bG9jYXRpb24sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcblx0XHRcdGVycm9yVHlwZVxuXHRcdH07XG5cdFx0XG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblx0XHRcblx0XHQvLyBBbHNvIGxvZyB0byBjb25zb2xlIGZvciBkZWJ1Z2dpbmdcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XG5cdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB0aGlzLnF1ZXVlLmFkZChmLnBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLnF1ZXVlLmFkZChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVJlYnVpbGQoKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlUmVidWlsZCgpOiB2b2lkIHtcblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGlmICh0aGlzLnJlYnVpbGRUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnJlYnVpbGRUaW1lcik7XG5cdFx0dGhpcy5yZWJ1aWxkVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IG51bGw7XG5cdFx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdFx0fSwgcG9saWN5LlJFQlVJTERfUVVFVUVfREVCT1VOQ0VfTVMpO1xuXHR9XG5cblx0cXVldWVSZW1vdmVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0fVxuXG5cdHByaXZhdGUgX2tpY2tXb3JrZXIoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMud29ya2VyUnVubmluZykgcmV0dXJuO1xuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IHRydWU7XG5cdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0LCBidXQgZW5zdXJlIGVycm9ycyBhcmUgc3dhbGxvd2VkLlxuXHRcdHZvaWQgdGhpcy5fcnVuV29ya2VyKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9ydW5Xb3JrZXIoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyB0byBhdm9pZCBmYWlsdXJlcy5cblx0XHRpZiAoIShhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmlzQXZhaWxhYmxlKCkpKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBzZW1hbnRpYyBpbmRleGluZycpO1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgcG9saWN5ID0gQ09fQVVUSE9SSU5HX1BPTElDWS5QRVJGT1JNQU5DRTtcblx0XHRsZXQgcHJvY2Vzc2VkQ291bnQgPSAwO1xuXHRcdGxldCBza2lwcGVkRXhjbHVkZWQgPSAwO1xuXHRcdGxldCBza2lwcGVkTm90TWFya2Rvd24gPSAwO1xuXHRcdGxldCBza2lwcGVkSGFzaE1hdGNoID0gMDtcblx0XHRsZXQgaW5kZXhlZENvdW50ID0gMDtcblx0XHRcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCAmJiBpbmRleGVkQ291bnQgPCBwb2xpY3kuTUFYX1JFQlVJTERTX1BFUl9CQVRDSCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBub3JtYWxpemVDaHVua1RleHQoY29udGVudCk7XG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRDb250ZW50KTtcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcblx0XHRcdFx0XHRbbmV4dF06IHtcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3J1bldvcmtlcicsIGBQcm9jZXNzaW5nIGZpbGU6ICR7bmV4dH1gLCBlcnIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBZaWVsZCB0byBrZWVwIFVJIHJlc3BvbnNpdmUuXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXHRcdH1cblxuXHRcdC8vIExvZyBpbmRleGluZyBzdGF0cyBmb3IgZGVidWdnaW5nXG5cdFx0aWYgKHByb2Nlc3NlZENvdW50ID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NlZCAke3Byb2Nlc3NlZENvdW50fSBmaWxlczogJHtpbmRleGVkQ291bnR9IGluZGV4ZWQsICR7c2tpcHBlZEV4Y2x1ZGVkfSBleGNsdWRlZCwgJHtza2lwcGVkTm90TWFya2Rvd259IG5vdCBtYXJrZG93biwgJHtza2lwcGVkSGFzaE1hdGNofSBoYXNoIG1hdGNoIChhbHJlYWR5IGluZGV4ZWQpYCk7XG5cdFx0fVxuXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyBmb3IgdGhpcyBmaWxlLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIEJhY2tlbmQ6ICR7dGhpcy5iYWNrZW5kfWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ29udGVudCBsZW5ndGg6ICR7Y29udGVudC5sZW5ndGh9IGNoYXJzLCAke2NvbnRlbnQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzYCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua2luZyBjb25maWc6IGhlYWRpbmdMZXZlbD0ke2NmZy5oZWFkaW5nTGV2ZWx9LCB0YXJnZXRXb3Jkcz0ke2NmZy50YXJnZXRXb3Jkc30sIG92ZXJsYXBXb3Jkcz0ke2NmZy5vdmVybGFwV29yZHN9YCk7XG5cdFx0XG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XG5cdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3Jkcyxcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xuXHRcdH0pO1xuXHRcdFxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtzIGNyZWF0ZWQ6ICR7Y2h1bmtzLmxlbmd0aH1gKTtcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGAgIC0gRmlyc3QgY2h1bmsgcHJldmlldzogJHtjaHVua3NbMF0udGV4dC5zdWJzdHJpbmcoMCwgMTAwKX0uLi5gKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gSWYgbm8gY2h1bmtzIGNyZWF0ZWQsIHNraXAgdGhpcyBmaWxlIChtaWdodCBiZSB0b28gc2hvcnQgb3IgaGF2ZSBubyBoZWFkaW5ncylcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBObyBjaHVua3MgY3JlYXRlZCBmb3IgJHtwYXRofSAtIGZpbGUgdG9vIHNob3J0IG9yIG5vIGhlYWRpbmdzIG1hdGNoIGNodW5raW5nIGNvbmZpZ2ApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGxldCBzdWNjZXNzZnVsQ2h1bmtzID0gMDtcblx0XHRsZXQgZmlyc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgY2ggPSBjaHVua3NbaV07XG5cdFx0XHRjb25zdCBub3JtYWxpemVkVGV4dCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjaC50ZXh0KTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRUZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjdG9yKSB8fCB2ZWN0b3IubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAodGhpcy5kaW0gPT09IDApIHtcblx0XHRcdFx0XHR0aGlzLmRpbSA9IHZlY3Rvci5sZW5ndGg7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBPbGxhbWEgZW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnN0IGNvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQ2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcywgJHtjaC50ZXh0Lmxlbmd0aH0gY2hhcnMpYDtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmVtYmVkQ2h1bmsnLCBjb250ZXh0LCBlcnIpO1xuXHRcdFx0XHRcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIOKclyBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH06YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XG5cdFx0XHRcdFx0aWYgKCdjYXVzZScgaW4gZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcblx0XHRcdFx0aWYgKGkgPT09IDApIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0gQ1JJVElDQUw6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgd2lsbCBub3QgYmUgaW5kZXhlZGApO1xuXHRcdFx0XHRcdGZpcnN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gU2tpcCB0aGlzIGNodW5rIGlmIGVtYmVkZGluZyBmYWlscywgYnV0IGNvbnRpbnVlIHdpdGggb3RoZXJzXG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGV4Y2VycHRPZihjaC50ZXh0LCAyNTAwKTtcblx0XHRcdHRoaXMuX3NldENodW5rKHtcblx0XHRcdFx0a2V5LFxuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxuXHRcdFx0XHRzdGFydFdvcmQ6IGNoLnN0YXJ0V29yZCxcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcblx0XHRcdFx0dGV4dEhhc2gsXG5cdFx0XHRcdHZlY3Rvcixcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0XHRzdWNjZXNzZnVsQ2h1bmtzKys7XG5cdFx0fVxuXHRcdFxuXHRcdGlmIChzdWNjZXNzZnVsQ2h1bmtzID09PSAwICYmIGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBjcml0aWNhbENvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZGA7XG5cdFx0XHRpZiAoZmlyc3RFcnJvcikge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBmaXJzdEVycm9yKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIG5vdCBpbmRleGVkYCk7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgUm9vdCBjYXVzZTogJHtmaXJzdEVycm9yLm1lc3NhZ2V9YCk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBuZXcgRXJyb3IoJ0FsbCBjaHVua3MgZmFpbGVkIGJ1dCBubyBmaXJzdCBlcnJvciBjYXB0dXJlZCcpKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKHN1Y2Nlc3NmdWxDaHVua3MgPCBjaHVua3MubGVuZ3RoKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSDinJMgU3VjY2Vzc2Z1bGx5IGluZGV4ZWQgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfSBjaHVua3NgKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5zZXQoY2h1bmsua2V5LCBjaHVuayk7XG5cdFx0Y29uc3Qgc2V0ID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KGNodW5rLnBhdGgpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5zZXQoY2h1bmsucGF0aCwgc2V0KTtcblx0fVxuXG5cdHByaXZhdGUgX3JlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2V5cyA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChwYXRoKTtcblx0XHRpZiAoa2V5cykge1xuXHRcdFx0Zm9yIChjb25zdCBrIG9mIGtleXMpIHRoaXMuY2h1bmtzQnlLZXkuZGVsZXRlKGspO1xuXHRcdH1cblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XG5cblx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdKSB7XG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcblx0XHRcdGRlbGV0ZSBuZXh0W3BhdGhdO1xuXHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IG5leHQ7XG5cdFx0fVxuXHR9XG5cblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rc0J5S2V5LnZhbHVlcygpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb21wdXRlcyBhIGJpdC1wZXJmZWN0IGNvcnB1cyBoYXNoIGZvciBzdHJpY3QgcmVwbGF5LlxuXHQgKiBzaGEyNTYoam9pbihzb3J0KGNodW5rX2lkICsgXCI6XCIgKyBjb250ZW50X2hhc2gpLCBcIlxcblwiKSlcblx0ICovXG5cdGFzeW5jIGdldENvcnB1c0hhc2goKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBjaHVua3MgPSB0aGlzLmdldEFsbENodW5rcygpO1xuXHRcdGNvbnN0IGxpbmVzID0gY2h1bmtzLm1hcChjID0+IGAke2Mua2V5fToke2MudGV4dEhhc2h9YCk7XG5cdFx0bGluZXMuc29ydCgpO1xuXHRcdGNvbnN0IGpvaW5lZCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xuXHRcdHJldHVybiBhd2FpdCBzaGEyNTYoam9pbmVkKTtcblx0fVxuXG5cdGdldEluZGV4ZWRQYXRocygpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua0tleXNCeVBhdGgua2V5cygpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVja3MgaWYgYSBwYXRoIGlzIGN1cnJlbnRseSBtYXJrZWQgYXMgc3RhbGUgaW4gdGhlIGluZGV4IHN0YXRlLlxuXHQgKi9cblx0aXNTdGFsZShwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRjb25zdCBzdGF0ZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXTtcblx0XHRpZiAoIXN0YXRlKSByZXR1cm4gZmFsc2U7XG5cdFx0XG5cdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuXHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybiB0cnVlOyAvLyBNaXNzaW5nIGZpbGUgaXMgZWZmZWN0aXZlbHkgc3RhbGVcblx0XHRcblx0XHQvLyBJZiB1cGRhdGVkQXQgaXMgbm90IHNldCwgd2UgY2FuJ3QgYmUgc3VyZSwgYXNzdW1lIG5vdCBzdGFsZSBmb3Igbm93XG5cdFx0aWYgKCFzdGF0ZS51cGRhdGVkQXQpIHJldHVybiBmYWxzZTtcblx0XHRcblx0XHRjb25zdCBmaWxlTXRpbWUgPSBmaWxlLnN0YXQubXRpbWU7XG5cdFx0Y29uc3QgaW5kZXhUaW1lID0gbmV3IERhdGUoc3RhdGUudXBkYXRlZEF0KS5nZXRUaW1lKCk7XG5cdFx0XG5cdFx0cmV0dXJuIGZpbGVNdGltZSA+IGluZGV4VGltZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxuXHQgKi9cblx0cXVldWVSZWNoZWNrQWxsSW5kZXhlZCgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0Z2V0VmVjdG9yRm9yS2V5KGtleTogc3RyaW5nKTogbnVtYmVyW10gfCBudWxsIHtcblx0XHRjb25zdCBjaCA9IHRoaXMuY2h1bmtzQnlLZXkuZ2V0KGtleSk7XG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcblx0fVxuXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XG5cdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBidWlsZFF1ZXJ5VmVjdG9yIGNhbGxlZDsgcmV0dXJuaW5nIGVtcHR5IHZlY3Rvci4gVXNlIGVtYmVkUXVlcnlWZWN0b3IgaW5zdGVhZC4nKTtcblx0XHRyZXR1cm4gW107XG5cdH1cblxuXHRhc3luYyBlbWJlZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuXHRcdGNvbnN0IHZlYyA9IGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuZ2V0RW1iZWRkaW5nKHF1ZXJ5VGV4dCk7XG5cdFx0aWYgKCFBcnJheS5pc0FycmF5KHZlYykgfHwgdmVjLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHR9XG5cdFx0cmV0dXJuIHZlYztcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlUGVyc2lzdCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5wZXJzaXN0VGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5wZXJzaXN0VGltZXIpO1xuXHRcdHRoaXMucGVyc2lzdFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5wZXJzaXN0VGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLl9wZXJzaXN0Tm93KCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcGVyc2lzdE5vdygpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBkaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGRpcikpKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihkaXIpO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlIG1rZGlyIGZhaWx1cmVzXG5cdFx0fVxuXG5cdFx0Y29uc3QgcGF5bG9hZDogUGVyc2lzdGVkSW5kZXhWMSA9IHtcblx0XHRcdHZlcnNpb246IDEsXG5cdFx0XHRkaW06IHRoaXMuZGltLFxuXHRcdFx0YmFja2VuZDogdGhpcy5iYWNrZW5kLFxuXHRcdFx0Y2h1bmtpbmc6IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKSxcblx0XHRcdGNodW5rczogdGhpcy5nZXRBbGxDaHVua3MoKVxuXHRcdH07XG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpLCBKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5zZXR0aW5nc1NhdmVUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKTtcblx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpLmNhdGNoKCgpID0+IHtcblx0XHRcdFx0Ly8gaWdub3JlXG5cdFx0XHR9KTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXHRcbn1cblxuXG4iXX0=