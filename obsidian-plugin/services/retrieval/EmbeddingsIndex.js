import { TFile } from 'obsidian';
import { buildIndexChunks } from './Chunking';
import { fnv1a32 } from '../ContentHash';
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
        this._kickWorker();
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
        let processedCount = 0;
        let skippedExcluded = 0;
        let skippedNotMarkdown = 0;
        let skippedHashMatch = 0;
        let indexedCount = 0;
        while (this.queue.size > 0) {
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
                const fileHash = fnv1a32(content);
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
            const textHash = fnv1a32(ch.text);
            const key = `chunk:${path}:${i}`;
            let vector;
            try {
                console.log(`  - Generating embedding for chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words)...`);
                const embedStart = Date.now();
                vector = await this.embeddingProvider.getEmbedding(ch.text);
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
    getIndexedPaths() {
        return Array.from(this.chunkKeysByPath.keys());
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQXNCekMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLE1BQThCO0lBQ2xELE9BQU87UUFDTixZQUFZLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQywwQkFBMEIsSUFBSSxJQUFJO1FBQ2hFLFdBQVcsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsSUFBSSxHQUFHLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQztRQUM1RSxZQUFZLEVBQUUsUUFBUSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsMEJBQTBCLElBQUksR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLENBQUM7S0FDakYsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxJQUFZLEVBQUUsUUFBZ0I7SUFDaEQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDakQsSUFBSSxPQUFPLENB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QUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xyXG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xyXG5pbXBvcnQgeyBPbGxhbWFFbWJlZGRpbmdQcm92aWRlciB9IGZyb20gJy4vT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXInO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xyXG5cdGtleTogc3RyaW5nO1xyXG5cdHBhdGg6IHN0cmluZztcclxuXHRjaHVua0luZGV4OiBudW1iZXI7XHJcblx0c3RhcnRXb3JkOiBudW1iZXI7XHJcblx0ZW5kV29yZDogbnVtYmVyO1xyXG5cdHRleHRIYXNoOiBzdHJpbmc7XHJcblx0dmVjdG9yOiBudW1iZXJbXTtcclxuXHRleGNlcnB0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcclxuXHR2ZXJzaW9uOiAxO1xyXG5cdGRpbTogbnVtYmVyO1xyXG5cdGJhY2tlbmQ6ICdvbGxhbWEnO1xyXG5cdGNodW5raW5nPzogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfTtcclxuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xyXG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcclxuXHRyZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIE1hdGguZmxvb3IodmFsdWUpKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNodW5raW5nS2V5KHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH0ge1xyXG5cdHJldHVybiB7XHJcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxyXG5cdFx0dGFyZ2V0V29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua1dvcmRzID8/IDUwMCwgMjAwLCAyMDAwKSxcclxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxyXG5cdH07XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xyXG5cdGNvbnN0IHRyaW1tZWQgPSB0ZXh0LnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csICcgJyk7XHJcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcclxuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcclxufVxyXG5cclxuaW50ZXJmYWNlIEVycm9yTG9nRW50cnkge1xyXG5cdHRpbWVzdGFtcDogc3RyaW5nO1xyXG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXHJcblx0Y29udGV4dDogc3RyaW5nOyAvLyBXaGF0IHdhcyBoYXBwZW5pbmcgKGZpbGUgcGF0aCwgY2h1bmsgaW5kZXgsIGV0Yy4pXHJcblx0bWVzc2FnZTogc3RyaW5nO1xyXG5cdHN0YWNrPzogc3RyaW5nO1xyXG5cdGVycm9yVHlwZT86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSBkaW06IG51bWJlcjtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGJhY2tlbmQ6ICdvbGxhbWEnO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyO1xyXG5cclxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xyXG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xyXG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xyXG5cclxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgc2V0dGluZ3NTYXZlVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cclxuXHQvLyBFcnJvciB0cmFja2luZ1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xyXG5cclxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHRcdHRoaXMuYmFja2VuZCA9ICdvbGxhbWEnO1xyXG5cdFx0dGhpcy5lbWJlZGRpbmdQcm92aWRlciA9IGVtYmVkZGluZ1Byb3ZpZGVyO1xyXG5cdFx0dGhpcy5kaW0gPSAwO1xyXG5cdH1cclxuXHJcblx0Z2V0SW5kZXhGaWxlUGF0aCgpOiBzdHJpbmcge1xyXG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9pbmRleC5qc29uYDtcclxuXHR9XHJcblxyXG5cdGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xyXG5cdFx0dGhpcy5sb2FkZWQgPSB0cnVlO1xyXG5cclxuXHRcdHRyeSB7XHJcblx0XHRcdGNvbnN0IHBhdGggPSB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcclxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkpIHJldHVybjtcclxuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQocGF0aCk7XHJcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRJbmRleFYxO1xyXG5cdFx0XHRpZiAocGFyc2VkPy52ZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5jaHVua3MpKSByZXR1cm47XHJcblx0XHRcdGlmIChwYXJzZWQuYmFja2VuZCAmJiBwYXJzZWQuYmFja2VuZCAhPT0gdGhpcy5iYWNrZW5kKSB7XHJcblx0XHRcdFx0Ly8gQmFja2VuZCBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cclxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XHJcblx0XHRcdFx0cmV0dXJuO1xyXG5cdFx0XHR9XHJcblx0XHRcdGlmICh0eXBlb2YgcGFyc2VkLmRpbSA9PT0gJ251bWJlcicpIHtcclxuXHRcdFx0XHR0aGlzLmRpbSA9IHBhcnNlZC5kaW07XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZXhwZWN0ZWRDaHVua2luZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcclxuXHRcdFx0aWYgKFxyXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxyXG5cdFx0XHRcdChwYXJzZWQuY2h1bmtpbmcuaGVhZGluZ0xldmVsICE9PSBleHBlY3RlZENodW5raW5nLmhlYWRpbmdMZXZlbCB8fFxyXG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XHJcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3JkcylcclxuXHRcdFx0KSB7XHJcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXHJcblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xyXG5cdFx0XHRcdHJldHVybjtcclxuXHRcdFx0fVxyXG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcclxuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xyXG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cclxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xyXG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcclxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxyXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxyXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xyXG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcclxuXHR9XHJcblxyXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xyXG5cdFx0Y29uc3QgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xyXG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xyXG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcclxuXHRcdH1cclxuXHRcdHJldHVybiB7XHJcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcclxuXHRcdFx0YnlMb2NhdGlvbixcclxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcclxuXHRcdH07XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcclxuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQWxzbyBsb2cgdG8gY29uc29sZSBmb3IgZGVidWdnaW5nXHJcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XHJcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcclxuXHRcdGZvciAoY29uc3QgZiBvZiBmaWxlcykgdGhpcy5xdWV1ZS5hZGQoZi5wYXRoKTtcclxuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcclxuXHR9XHJcblxyXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xyXG5cdFx0dGhpcy5xdWV1ZS5hZGQocGF0aCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XHJcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcclxuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XHJcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcclxuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMud29ya2VyUnVubmluZykgcmV0dXJuO1xyXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcclxuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cclxuXHRcdHZvaWQgdGhpcy5fcnVuV29ya2VyKCkuY2F0Y2goKCkgPT4ge1xyXG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIHRvIGF2b2lkIGZhaWx1cmVzLlxyXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBzZW1hbnRpYyBpbmRleGluZycpO1xyXG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cclxuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XHJcblx0XHRsZXQgc2tpcHBlZEV4Y2x1ZGVkID0gMDtcclxuXHRcdGxldCBza2lwcGVkTm90TWFya2Rvd24gPSAwO1xyXG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xyXG5cdFx0bGV0IGluZGV4ZWRDb3VudCA9IDA7XHJcblx0XHRcclxuXHRcdHdoaWxlICh0aGlzLnF1ZXVlLnNpemUgPiAwKSB7XHJcblx0XHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCkgYnJlYWs7XHJcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XHJcblx0XHRcdHRoaXMucXVldWUuZGVsZXRlKG5leHQpO1xyXG5cdFx0XHRwcm9jZXNzZWRDb3VudCsrO1xyXG5cclxuXHRcdFx0Ly8gRXhjbHVzaW9ucyBjYW4gY2hhbmdlIGF0IGFueSB0aW1lOyBob25vciB0aGVtIGR1cmluZyBwcm9jZXNzaW5nLlxyXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKG5leHQpKSB7XHJcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XHJcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobmV4dCk7XHJcblx0XHRcdC8vIE9ubHkgaW5kZXggbWFya2Rvd24gZmlsZXMuXHJcblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcclxuXHRcdFx0XHRza2lwcGVkTm90TWFya2Rvd24rKztcclxuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcclxuXHRcdFx0XHRjb25zdCBmaWxlSGFzaCA9IGZudjFhMzIoY29udGVudCk7XHJcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcclxuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXHJcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXHJcblx0XHRcdFx0aWYgKHByZXY/Lmhhc2ggPT09IGZpbGVIYXNoICYmIGlzQ3VycmVudGx5SW5kZXhlZCkge1xyXG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xyXG5cdFx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcclxuXHRcdFx0XHRpbmRleGVkQ291bnQrKztcclxuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xyXG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxyXG5cdFx0XHRcdFx0W25leHRdOiB7XHJcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxyXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcclxuXHRcdFx0XHRcdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0XHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRcdC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlcywgYnV0IGxvZyBmb3IgZGVidWdnaW5nXHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3J1bldvcmtlcicsIGBQcm9jZXNzaW5nIGZpbGU6ICR7bmV4dH1gLCBlcnIpO1xyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHQvLyBZaWVsZCB0byBrZWVwIFVJIHJlc3BvbnNpdmUuXHJcblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcclxuXHRcdGlmIChwcm9jZXNzZWRDb3VudCA+IDApIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NlZCAke3Byb2Nlc3NlZENvdW50fSBmaWxlczogJHtpbmRleGVkQ291bnR9IGluZGV4ZWQsICR7c2tpcHBlZEV4Y2x1ZGVkfSBleGNsdWRlZCwgJHtza2lwcGVkTm90TWFya2Rvd259IG5vdCBtYXJrZG93biwgJHtza2lwcGVkSGFzaE1hdGNofSBoYXNoIG1hdGNoIChhbHJlYWR5IGluZGV4ZWQpYCk7XHJcblx0XHR9XHJcblxyXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcclxuXHJcblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyBmb3IgdGhpcyBmaWxlLlxyXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBmaWxlOiAke3BhdGh9YCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXHJcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gU2tpcHBpbmcgZW1wdHkgZmlsZTogJHtwYXRofWApO1xyXG5cdFx0XHRyZXR1cm47XHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xyXG5cdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NpbmcgZmlsZTogJHtwYXRofWApO1xyXG5cdFx0Y29uc29sZS5sb2coYCAgLSBCYWNrZW5kOiAke3RoaXMuYmFja2VuZH1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ29udGVudCBsZW5ndGg6ICR7Y29udGVudC5sZW5ndGh9IGNoYXJzLCAke2NvbnRlbnQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzYCk7XHJcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5raW5nIGNvbmZpZzogaGVhZGluZ0xldmVsPSR7Y2ZnLmhlYWRpbmdMZXZlbH0sIHRhcmdldFdvcmRzPSR7Y2ZnLnRhcmdldFdvcmRzfSwgb3ZlcmxhcFdvcmRzPSR7Y2ZnLm92ZXJsYXBXb3Jkc31gKTtcclxuXHRcdFxyXG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XHJcblx0XHRcdHRleHQ6IGNvbnRlbnQsXHJcblx0XHRcdGhlYWRpbmdMZXZlbDogY2ZnLmhlYWRpbmdMZXZlbCxcclxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3JkcyxcclxuXHRcdFx0b3ZlcmxhcFdvcmRzOiBjZmcub3ZlcmxhcFdvcmRzXHJcblx0XHR9KTtcclxuXHRcdFxyXG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua3MgY3JlYXRlZDogJHtjaHVua3MubGVuZ3RofWApO1xyXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPiAwKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGAgIC0gRmlyc3QgY2h1bmsgcHJldmlldzogJHtjaHVua3NbMF0udGV4dC5zdWJzdHJpbmcoMCwgMTAwKX0uLi5gKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gSWYgbm8gY2h1bmtzIGNyZWF0ZWQsIHNraXAgdGhpcyBmaWxlIChtaWdodCBiZSB0b28gc2hvcnQgb3IgaGF2ZSBubyBoZWFkaW5ncylcclxuXHRcdGlmIChjaHVua3MubGVuZ3RoID09PSAwKSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gTm8gY2h1bmtzIGNyZWF0ZWQgZm9yICR7cGF0aH0gLSBmaWxlIHRvbyBzaG9ydCBvciBubyBoZWFkaW5ncyBtYXRjaCBjaHVua2luZyBjb25maWdgKTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cclxuXHRcdGxldCBzdWNjZXNzZnVsQ2h1bmtzID0gMDtcclxuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xyXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBjaHVua3MubGVuZ3RoOyBpKyspIHtcclxuXHRcdFx0Y29uc3QgY2ggPSBjaHVua3NbaV07XHJcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gZm52MWEzMihjaC50ZXh0KTtcclxuXHRcdFx0Y29uc3Qga2V5ID0gYGNodW5rOiR7cGF0aH06JHtpfWA7XHJcblx0XHRcdGxldCB2ZWN0b3I6IG51bWJlcltdO1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XHJcblx0XHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcoY2gudGV4dCk7XHJcblx0XHRcdFx0aWYgKCFBcnJheS5pc0FycmF5KHZlY3RvcikgfHwgdmVjdG9yLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0aWYgKHRoaXMuZGltID09PSAwKSB7XHJcblx0XHRcdFx0XHR0aGlzLmRpbSA9IHZlY3Rvci5sZW5ndGg7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBPbGxhbWEgZW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRcdFx0Y29uc3QgY29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBDaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzLCAke2NoLnRleHQubGVuZ3RofSBjaGFycylgO1xyXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5lbWJlZENodW5rJywgY29udGV4dCwgZXJyKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofTpgLCBlcnJvck1zZyk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGlmIChlcnIgaW5zdGFuY2VvZiBFcnJvcikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XHJcblx0XHRcdFx0XHRpZiAoJ2NhdXNlJyBpbiBlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIENhdXNlOiAke2Vyci5jYXVzZX1gKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0Ly8gSWYgQUxMIGNodW5rcyBmYWlsIGZvciBhIGZpbGUsIHRoZSBmaWxlIHdvbid0IGJlIGluZGV4ZWRcclxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcclxuXHRcdFx0XHRpZiAoaSA9PT0gMCkge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIENSSVRJQ0FMOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIHdpbGwgbm90IGJlIGluZGV4ZWRgKTtcclxuXHRcdFx0XHRcdGZpcnN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgMjUwMCk7XHJcblx0XHRcdHRoaXMuX3NldENodW5rKHtcclxuXHRcdFx0XHRrZXksXHJcblx0XHRcdFx0cGF0aCxcclxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxyXG5cdFx0XHRcdHN0YXJ0V29yZDogY2guc3RhcnRXb3JkLFxyXG5cdFx0XHRcdGVuZFdvcmQ6IGNoLmVuZFdvcmQsXHJcblx0XHRcdFx0dGV4dEhhc2gsXHJcblx0XHRcdFx0dmVjdG9yLFxyXG5cdFx0XHRcdGV4Y2VycHRcclxuXHRcdFx0fSk7XHJcblx0XHRcdHN1Y2Nlc3NmdWxDaHVua3MrKztcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0aWYgKHN1Y2Nlc3NmdWxDaHVua3MgPT09IDAgJiYgY2h1bmtzLmxlbmd0aCA+IDApIHtcclxuXHRcdFx0Y29uc3QgY3JpdGljYWxDb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWRgO1xyXG5cdFx0XHRpZiAoZmlyc3RFcnJvcikge1xyXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIGZpcnN0RXJyb3IpO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIENSSVRJQ0FMOiBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkIGZvciAke3BhdGh9IC0gZmlsZSBub3QgaW5kZXhlZGApO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgUm9vdCBjYXVzZTogJHtmaXJzdEVycm9yLm1lc3NhZ2V9YCk7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgbmV3IEVycm9yKCdBbGwgY2h1bmtzIGZhaWxlZCBidXQgbm8gZmlyc3QgZXJyb3IgY2FwdHVyZWQnKSk7XHJcblx0XHRcdH1cclxuXHRcdH0gZWxzZSBpZiAoc3VjY2Vzc2Z1bENodW5rcyA8IGNodW5rcy5sZW5ndGgpIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBQYXJ0aWFsIHN1Y2Nlc3MgZm9yICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30vJHtjaHVua3MubGVuZ3RofSBjaHVua3MgaW5kZXhlZGApO1xyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIOKckyBTdWNjZXNzZnVsbHkgaW5kZXhlZCAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9IGNodW5rc2ApO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xyXG5cdFx0dGhpcy5jaHVua3NCeUtleS5zZXQoY2h1bmsua2V5LCBjaHVuayk7XHJcblx0XHRjb25zdCBzZXQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQoY2h1bmsucGF0aCkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XHJcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XHJcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5zZXQoY2h1bmsucGF0aCwgc2V0KTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgX3JlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogdm9pZCB7XHJcblx0XHRjb25zdCBrZXlzID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KHBhdGgpO1xyXG5cdFx0aWYgKGtleXMpIHtcclxuXHRcdFx0Zm9yIChjb25zdCBrIG9mIGtleXMpIHRoaXMuY2h1bmtzQnlLZXkuZGVsZXRlKGspO1xyXG5cdFx0fVxyXG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xyXG5cclxuXHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF0pIHtcclxuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XHJcblx0XHRcdGRlbGV0ZSBuZXh0W3BhdGhdO1xyXG5cdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0gbmV4dDtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XHJcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rc0J5S2V5LnZhbHVlcygpKTtcclxuXHR9XHJcblxyXG5cdGdldEluZGV4ZWRQYXRocygpOiBzdHJpbmdbXSB7XHJcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rS2V5c0J5UGF0aC5rZXlzKCkpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cclxuXHQgKi9cclxuXHRxdWV1ZVJlY2hlY2tBbGxJbmRleGVkKCk6IHZvaWQge1xyXG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xyXG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xyXG5cdH1cclxuXHJcblx0Z2V0VmVjdG9yRm9yS2V5KGtleTogc3RyaW5nKTogbnVtYmVyW10gfCBudWxsIHtcclxuXHRcdGNvbnN0IGNoID0gdGhpcy5jaHVua3NCeUtleS5nZXQoa2V5KTtcclxuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XHJcblx0fVxyXG5cclxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xyXG5cdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBidWlsZFF1ZXJ5VmVjdG9yIGNhbGxlZDsgcmV0dXJuaW5nIGVtcHR5IHZlY3Rvci4gVXNlIGVtYmVkUXVlcnlWZWN0b3IgaW5zdGVhZC4nKTtcclxuXHRcdHJldHVybiBbXTtcclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCB2ZWMgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhxdWVyeVRleHQpO1xyXG5cdFx0aWYgKCFBcnJheS5pc0FycmF5KHZlYykgfHwgdmVjLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xyXG5cdFx0fVxyXG5cdFx0cmV0dXJuIHZlYztcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgX3NjaGVkdWxlUGVyc2lzdCgpOiB2b2lkIHtcclxuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XHJcblx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcclxuXHRcdFx0dGhpcy5wZXJzaXN0VGltZXIgPSBudWxsO1xyXG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdFx0Ly8gaWdub3JlXHJcblx0XHRcdH0pO1xyXG5cdFx0fSwgMTAwMCk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0Y29uc3QgZGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcclxuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoZGlyKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdC8vIGlnbm9yZSBta2RpciBmYWlsdXJlc1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IHBheWxvYWQ6IFBlcnNpc3RlZEluZGV4VjEgPSB7XHJcblx0XHRcdHZlcnNpb246IDEsXHJcblx0XHRcdGRpbTogdGhpcy5kaW0sXHJcblx0XHRcdGJhY2tlbmQ6IHRoaXMuYmFja2VuZCxcclxuXHRcdFx0Y2h1bmtpbmc6IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKSxcclxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXHJcblx0XHR9O1xyXG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpLCBKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpOiB2b2lkIHtcclxuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xyXG5cdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcclxuXHRcdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IG51bGw7XHJcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xyXG5cdFx0XHRcdC8vIGlnbm9yZVxyXG5cdFx0XHR9KTtcclxuXHRcdH0sIDEwMDApO1xyXG5cdH1cclxuXHRcclxufVxyXG5cclxuXHJcbiJdfQ==