import { TFile } from 'obsidian';
import { fnv1a32 } from '../ContentHash';
import { MiniLmLocalEmbeddingModel } from './LocalEmbeddingModel';
import { buildIndexChunks } from './Chunking';
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function tokenize(value) {
    return value
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2);
}
function buildVector(text, dim) {
    const vec = new Array(dim).fill(0);
    const tokens = tokenize(text);
    for (const tok of tokens) {
        const h = parseInt(fnv1a32(tok), 16);
        const idx = h % dim;
        // Signed hashing helps reduce collisions bias
        const sign = (h & 1) === 0 ? 1 : -1;
        vec[idx] += sign;
    }
    // L2 normalize
    let sumSq = 0;
    for (let i = 0; i < dim; i++)
        sumSq += vec[i] * vec[i];
    const norm = Math.sqrt(sumSq) || 1;
    for (let i = 0; i < dim; i++)
        vec[i] = vec[i] / norm;
    return vec;
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
    constructor(vault, plugin, dim = 256) {
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
        const backend = plugin.settings.retrievalEmbeddingBackend;
        this.backend = backend === 'hash' ? 'hash' : 'minilm';
        this.dim = this.backend === 'minilm' ? 384 : dim;
        this.model = new MiniLmLocalEmbeddingModel(vault, plugin);
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
            if (typeof parsed.dim === 'number' && parsed.dim !== this.dim) {
                // Dimension mismatch: ignore persisted index and rebuild.
                this.enqueueFullRescan();
                return;
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
        // Check if model is ready (for minilm backend)
        if (this.backend === 'minilm') {
            try {
                const isReady = await this.model.isReady();
                console.log(`  - Model ready: ${isReady}`);
                if (!isReady) {
                    console.warn(`  - Model not ready, attempting to load...`);
                }
            }
            catch (modelCheckErr) {
                console.error(`  - Model readiness check failed:`, modelCheckErr);
            }
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
                if (this.backend === 'minilm') {
                    // Minilm requires async model loading - this might fail silently
                    vector = await this.model.embed(ch.text);
                    const embedDuration = Date.now() - embedStart;
                    console.log(`  - ✓ Embedding generated in ${embedDuration}ms: ${vector.length} dimensions`);
                    // Verify vector is valid
                    if (!vector || vector.length !== this.dim) {
                        throw new Error(`Invalid vector dimensions: expected ${this.dim}, got ${vector?.length || 0}`);
                    }
                    // Check if vector is all zeros (indicates failure)
                    const sum = vector.reduce((a, b) => a + Math.abs(b), 0);
                    if (sum < 0.001) {
                        console.warn(`  - ⚠ Warning: Vector appears to be all zeros (sum=${sum})`);
                    }
                }
                else {
                    vector = buildVector(ch.text, this.dim);
                    console.log(`  - ✓ Hash-based vector generated: ${vector.length} dimensions`);
                }
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
            const excerpt = excerptOf(ch.text, 500);
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
        if (this.backend !== 'minilm')
            return buildVector(queryText, this.dim);
        // Note: query embedding is async; providers should call embedQueryVector instead.
        return buildVector(queryText, this.dim);
    }
    async embedQueryVector(queryText) {
        if (this.backend !== 'minilm')
            return buildVector(queryText, this.dim);
        return await this.model.embed(queryText);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMs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QUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7SUFFTyxxQkFBcUI7UUFDNUIsSUFBSSxJQUFJLENBQUMsaUJBQWlCO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUN4RSxJQUFJLENBQUMsaUJBQWlCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDL0MsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDMUMsU0FBUztZQUNWLENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IHsgVEZpbGUgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xyXG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xyXG5pbXBvcnQgeyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIH0gZnJvbSAnLi9Mb2NhbEVtYmVkZGluZ01vZGVsJztcclxuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xyXG5cdGtleTogc3RyaW5nO1xyXG5cdHBhdGg6IHN0cmluZztcclxuXHRjaHVua0luZGV4OiBudW1iZXI7XHJcblx0c3RhcnRXb3JkOiBudW1iZXI7XHJcblx0ZW5kV29yZDogbnVtYmVyO1xyXG5cdHRleHRIYXNoOiBzdHJpbmc7XHJcblx0dmVjdG9yOiBudW1iZXJbXTtcclxuXHRleGNlcnB0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcclxuXHR2ZXJzaW9uOiAxO1xyXG5cdGRpbTogbnVtYmVyO1xyXG5cdGJhY2tlbmQ6ICdoYXNoJyB8ICdtaW5pbG0nO1xyXG5cdGNodW5raW5nPzogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfTtcclxuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xyXG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcclxuXHRyZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIE1hdGguZmxvb3IodmFsdWUpKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRva2VuaXplKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcblx0cmV0dXJuIHZhbHVlXHJcblx0XHQudG9Mb3dlckNhc2UoKVxyXG5cdFx0LnNwbGl0KC9bXmEtejAtOV0rL2cpXHJcblx0XHQubWFwKCh0KSA9PiB0LnRyaW0oKSlcclxuXHRcdC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZFZlY3Rvcih0ZXh0OiBzdHJpbmcsIGRpbTogbnVtYmVyKTogbnVtYmVyW10ge1xyXG5cdGNvbnN0IHZlYyA9IG5ldyBBcnJheTxudW1iZXI+KGRpbSkuZmlsbCgwKTtcclxuXHRjb25zdCB0b2tlbnMgPSB0b2tlbml6ZSh0ZXh0KTtcclxuXHRmb3IgKGNvbnN0IHRvayBvZiB0b2tlbnMpIHtcclxuXHRcdGNvbnN0IGggPSBwYXJzZUludChmbnYxYTMyKHRvayksIDE2KTtcclxuXHRcdGNvbnN0IGlkeCA9IGggJSBkaW07XHJcblx0XHQvLyBTaWduZWQgaGFzaGluZyBoZWxwcyByZWR1Y2UgY29sbGlzaW9ucyBiaWFzXHJcblx0XHRjb25zdCBzaWduID0gKGggJiAxKSA9PT0gMCA/IDEgOiAtMTtcclxuXHRcdHZlY1tpZHhdICs9IHNpZ247XHJcblx0fVxyXG5cdC8vIEwyIG5vcm1hbGl6ZVxyXG5cdGxldCBzdW1TcSA9IDA7XHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgc3VtU3EgKz0gdmVjW2ldICogdmVjW2ldO1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgdmVjW2ldID0gdmVjW2ldIC8gbm9ybTtcclxuXHRyZXR1cm4gdmVjO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcclxuXHRyZXR1cm4ge1xyXG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcclxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXHJcblx0XHRvdmVybGFwV29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkcyA/PyAxMDAsIDAsIDUwMClcclxuXHR9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcclxuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xyXG5cdGlmICh0cmltbWVkLmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRyaW1tZWQ7XHJcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XHJcbn1cclxuXHJcbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcclxuXHR0aW1lc3RhbXA6IHN0cmluZztcclxuXHRsb2NhdGlvbjogc3RyaW5nOyAvLyBXaGVyZSB0aGUgZXJyb3Igb2NjdXJyZWQgKG1ldGhvZC9mdW5jdGlvbiBuYW1lKVxyXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnaGFzaCcgfCAnbWluaWxtJztcclxuXHRwcml2YXRlIHJlYWRvbmx5IG1vZGVsOiBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsO1xyXG5cclxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xyXG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xyXG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xyXG5cclxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgc2V0dGluZ3NTYXZlVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cclxuXHQvLyBFcnJvciB0cmFja2luZ1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xyXG5cclxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZGltOiBudW1iZXIgPSAyNTYpIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdFx0Y29uc3QgYmFja2VuZCA9IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxFbWJlZGRpbmdCYWNrZW5kO1xyXG5cdFx0dGhpcy5iYWNrZW5kID0gYmFja2VuZCA9PT0gJ2hhc2gnID8gJ2hhc2gnIDogJ21pbmlsbSc7XHJcblx0XHR0aGlzLmRpbSA9IHRoaXMuYmFja2VuZCA9PT0gJ21pbmlsbScgPyAzODQgOiBkaW07XHJcblx0XHR0aGlzLm1vZGVsID0gbmV3IE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwodmF1bHQsIHBsdWdpbik7XHJcblx0fVxyXG5cclxuXHRnZXRJbmRleEZpbGVQYXRoKCk6IHN0cmluZyB7XHJcblx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L2luZGV4Lmpzb25gO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMubG9hZGVkKSByZXR1cm47XHJcblx0XHR0aGlzLmxvYWRlZCA9IHRydWU7XHJcblxyXG5cdFx0dHJ5IHtcclxuXHRcdFx0Y29uc3QgcGF0aCA9IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xyXG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSkgcmV0dXJuO1xyXG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChwYXRoKTtcclxuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIFBlcnNpc3RlZEluZGV4VjE7XHJcblx0XHRcdGlmIChwYXJzZWQ/LnZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocGFyc2VkLmNodW5rcykpIHJldHVybjtcclxuXHRcdFx0aWYgKHBhcnNlZC5iYWNrZW5kICYmIHBhcnNlZC5iYWNrZW5kICE9PSB0aGlzLmJhY2tlbmQpIHtcclxuXHRcdFx0XHQvLyBCYWNrZW5kIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxyXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcclxuXHRcdFx0XHRyZXR1cm47XHJcblx0XHRcdH1cclxuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJyAmJiBwYXJzZWQuZGltICE9PSB0aGlzLmRpbSkge1xyXG5cdFx0XHRcdC8vIERpbWVuc2lvbiBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cclxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XHJcblx0XHRcdFx0cmV0dXJuO1xyXG5cdFx0XHR9XHJcblx0XHRcdGNvbnN0IGV4cGVjdGVkQ2h1bmtpbmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XHJcblx0XHRcdGlmIChcclxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcclxuXHRcdFx0XHQocGFyc2VkLmNodW5raW5nLmhlYWRpbmdMZXZlbCAhPT0gZXhwZWN0ZWRDaHVua2luZy5oZWFkaW5nTGV2ZWwgfHxcclxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy50YXJnZXRXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy50YXJnZXRXb3JkcyB8fFxyXG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXHJcblx0XHRcdCkge1xyXG5cdFx0XHRcdC8vIENodW5raW5nIGNvbmZpZyBjaGFuZ2VkOyByZWJ1aWxkIGluZGV4LlxyXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcclxuXHRcdFx0XHRyZXR1cm47XHJcblx0XHRcdH1cclxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XHJcblx0XHRcdFx0aWYgKCFjaHVuaz8ua2V5IHx8ICFjaHVuaz8ucGF0aCB8fCAhQXJyYXkuaXNBcnJheShjaHVuay52ZWN0b3IpKSBjb250aW51ZTtcclxuXHRcdFx0XHR0aGlzLl9zZXRDaHVuayhjaHVuayk7XHJcblx0XHRcdH1cclxuXHRcdH0gY2F0Y2gge1xyXG5cdFx0XHQvLyBDb3JydXB0IGluZGV4IHNob3VsZCBub3QgYnJlYWsgdGhlIHBsdWdpbi4gV2UnbGwgcmVidWlsZCBsYXppbHkuXHJcblx0XHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcclxuXHRcdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGdldFN0YXR1cygpOiB7IGluZGV4ZWRGaWxlczogbnVtYmVyOyBpbmRleGVkQ2h1bmtzOiBudW1iZXI7IHBhdXNlZDogYm9vbGVhbjsgcXVldWVkOiBudW1iZXIgfSB7XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXHJcblx0XHRcdGluZGV4ZWRDaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSxcclxuXHRcdFx0cGF1c2VkOiBCb29sZWFuKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSxcclxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcclxuXHRcdH07XHJcblx0fVxyXG5cclxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogRXJyb3JMb2dFbnRyeVtdIHtcclxuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XHJcblx0fVxyXG5cclxuXHRnZXRFcnJvclN1bW1hcnkoKTogeyB0b3RhbDogbnVtYmVyOyBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+OyByZWNlbnQ6IEVycm9yTG9nRW50cnlbXSB9IHtcclxuXHRcdGNvbnN0IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcclxuXHRcdGZvciAoY29uc3QgZXJyIG9mIHRoaXMuZXJyb3JMb2cpIHtcclxuXHRcdFx0YnlMb2NhdGlvbltlcnIubG9jYXRpb25dID0gKGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSB8fCAwKSArIDE7XHJcblx0XHR9XHJcblx0XHRyZXR1cm4ge1xyXG5cdFx0XHR0b3RhbDogdGhpcy5lcnJvckxvZy5sZW5ndGgsXHJcblx0XHRcdGJ5TG9jYXRpb24sXHJcblx0XHRcdHJlY2VudDogdGhpcy5lcnJvckxvZy5zbGljZSgtMTApXHJcblx0XHR9O1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XHJcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcclxuXHRcdFxyXG5cdFx0Y29uc3QgZW50cnk6IEVycm9yTG9nRW50cnkgPSB7XHJcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG5cdFx0XHRsb2NhdGlvbixcclxuXHRcdFx0Y29udGV4dCxcclxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXHJcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxyXG5cdFx0XHRlcnJvclR5cGVcclxuXHRcdH07XHJcblx0XHRcclxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XHJcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xyXG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIEFsc28gbG9nIHRvIGNvbnNvbGUgZm9yIGRlYnVnZ2luZ1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gRVJST1IgWyR7bG9jYXRpb259XSAke2NvbnRleHR9OmAsIGVycm9yTXNnKTtcclxuXHRcdGlmIChlcnJvclN0YWNrKSB7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGVucXVldWVGdWxsUmVzY2FuKCk6IHZvaWQge1xyXG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XHJcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRxdWV1ZVVwZGF0ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XHJcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcclxuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xyXG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xyXG5cdH1cclxuXHJcblx0cXVldWVSZW1vdmVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xyXG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XHJcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xyXG5cdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcclxuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcclxuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IHRydWU7XHJcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXHJcblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblxyXG5cdFx0bGV0IHByb2Nlc3NlZENvdW50ID0gMDtcclxuXHRcdGxldCBza2lwcGVkRXhjbHVkZWQgPSAwO1xyXG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XHJcblx0XHRsZXQgc2tpcHBlZEhhc2hNYXRjaCA9IDA7XHJcblx0XHRsZXQgaW5kZXhlZENvdW50ID0gMDtcclxuXHRcdFxyXG5cdFx0d2hpbGUgKHRoaXMucXVldWUuc2l6ZSA+IDApIHtcclxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcclxuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcclxuXHRcdFx0dGhpcy5xdWV1ZS5kZWxldGUobmV4dCk7XHJcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XHJcblxyXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXHJcblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcclxuXHRcdFx0XHRza2lwcGVkRXhjbHVkZWQrKztcclxuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcclxuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cclxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCBmaWxlLmV4dGVuc2lvbiAhPT0gJ21kJykge1xyXG5cdFx0XHRcdHNraXBwZWROb3RNYXJrZG93bisrO1xyXG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcclxuXHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xyXG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gZm52MWEzMihjb250ZW50KTtcclxuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xyXG5cdFx0XHRcdGNvbnN0IGlzQ3VycmVudGx5SW5kZXhlZCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmhhcyhuZXh0KTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcclxuXHRcdFx0XHQvLyBJZiBoYXNoIG1hdGNoZXMgYnV0IGZpbGUgaXMgTk9UIGluZGV4ZWQsIHJlLWluZGV4IGl0IChtaWdodCBoYXZlIGJlZW4gcmVtb3ZlZClcclxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XHJcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XHJcblx0XHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdGF3YWl0IHRoaXMuX3JlaW5kZXhGaWxlKG5leHQsIGNvbnRlbnQpO1xyXG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xyXG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XHJcblx0XHRcdFx0XHQuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSksXHJcblx0XHRcdFx0XHRbbmV4dF06IHtcclxuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXHJcblx0XHRcdFx0XHRcdGNodW5rQ291bnQ6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChuZXh0KT8uc2l6ZSA/PyAwLFxyXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH07XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcclxuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cclxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBMb2cgaW5kZXhpbmcgc3RhdHMgZm9yIGRlYnVnZ2luZ1xyXG5cdFx0aWYgKHByb2Nlc3NlZENvdW50ID4gMCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcclxuXHRcdH1cclxuXHJcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xyXG5cclxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcclxuXHRcdGlmICghY29udGVudCB8fCBjb250ZW50LnRyaW0oKS5sZW5ndGggPT09IDApIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHJcblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XHJcblx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2luZyBmaWxlOiAke3BhdGh9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgICAtIEJhY2tlbmQ6ICR7dGhpcy5iYWNrZW5kfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYCAgLSBDb250ZW50IGxlbmd0aDogJHtjb250ZW50Lmxlbmd0aH0gY2hhcnMsICR7Y29udGVudC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHNgKTtcclxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtpbmcgY29uZmlnOiBoZWFkaW5nTGV2ZWw9JHtjZmcuaGVhZGluZ0xldmVsfSwgdGFyZ2V0V29yZHM9JHtjZmcudGFyZ2V0V29yZHN9LCBvdmVybGFwV29yZHM9JHtjZmcub3ZlcmxhcFdvcmRzfWApO1xyXG5cdFx0XHJcblx0XHRjb25zdCBjaHVua3MgPSBidWlsZEluZGV4Q2h1bmtzKHtcclxuXHRcdFx0dGV4dDogY29udGVudCxcclxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxyXG5cdFx0XHR0YXJnZXRXb3JkczogY2ZnLnRhcmdldFdvcmRzLFxyXG5cdFx0XHRvdmVybGFwV29yZHM6IGNmZy5vdmVybGFwV29yZHNcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5rcyBjcmVhdGVkOiAke2NodW5rcy5sZW5ndGh9YCk7XHJcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA+IDApIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYCAgLSBGaXJzdCBjaHVuayBwcmV2aWV3OiAke2NodW5rc1swXS50ZXh0LnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBJZiBubyBjaHVua3MgY3JlYXRlZCwgc2tpcCB0aGlzIGZpbGUgKG1pZ2h0IGJlIHRvbyBzaG9ydCBvciBoYXZlIG5vIGhlYWRpbmdzKVxyXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBObyBjaHVua3MgY3JlYXRlZCBmb3IgJHtwYXRofSAtIGZpbGUgdG9vIHNob3J0IG9yIG5vIGhlYWRpbmdzIG1hdGNoIGNodW5raW5nIGNvbmZpZ2ApO1xyXG5cdFx0XHRyZXR1cm47XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gQ2hlY2sgaWYgbW9kZWwgaXMgcmVhZHkgKGZvciBtaW5pbG0gYmFja2VuZClcclxuXHRcdGlmICh0aGlzLmJhY2tlbmQgPT09ICdtaW5pbG0nKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgaXNSZWFkeSA9IGF3YWl0IHRoaXMubW9kZWwuaXNSZWFkeSgpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gTW9kZWwgcmVhZHk6ICR7aXNSZWFkeX1gKTtcclxuXHRcdFx0XHRpZiAoIWlzUmVhZHkpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgICAtIE1vZGVsIG5vdCByZWFkeSwgYXR0ZW1wdGluZyB0byBsb2FkLi4uYCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChtb2RlbENoZWNrRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIE1vZGVsIHJlYWRpbmVzcyBjaGVjayBmYWlsZWQ6YCwgbW9kZWxDaGVja0Vycik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xyXG5cdFx0bGV0IGZpcnN0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XHJcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xyXG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcclxuXHRcdFx0Y29uc3QgdGV4dEhhc2ggPSBmbnYxYTMyKGNoLnRleHQpO1xyXG5cdFx0XHRjb25zdCBrZXkgPSBgY2h1bms6JHtwYXRofToke2l9YDtcclxuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSBHZW5lcmF0aW5nIGVtYmVkZGluZyBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcykuLi5gKTtcclxuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0XHRpZiAodGhpcy5iYWNrZW5kID09PSAnbWluaWxtJykge1xyXG5cdFx0XHRcdFx0Ly8gTWluaWxtIHJlcXVpcmVzIGFzeW5jIG1vZGVsIGxvYWRpbmcgLSB0aGlzIG1pZ2h0IGZhaWwgc2lsZW50bHlcclxuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMubW9kZWwuZW1iZWQoY2gudGV4dCk7XHJcblx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBFbWJlZGRpbmcgZ2VuZXJhdGVkIGluICR7ZW1iZWREdXJhdGlvbn1tczogJHt2ZWN0b3IubGVuZ3RofSBkaW1lbnNpb25zYCk7XHJcblx0XHRcdFx0XHQvLyBWZXJpZnkgdmVjdG9yIGlzIHZhbGlkXHJcblx0XHRcdFx0XHRpZiAoIXZlY3RvciB8fCB2ZWN0b3IubGVuZ3RoICE9PSB0aGlzLmRpbSkge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgdmVjdG9yIGRpbWVuc2lvbnM6IGV4cGVjdGVkICR7dGhpcy5kaW19LCBnb3QgJHt2ZWN0b3I/Lmxlbmd0aCB8fCAwfWApO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgdmVjdG9yIGlzIGFsbCB6ZXJvcyAoaW5kaWNhdGVzIGZhaWx1cmUpXHJcblx0XHRcdFx0XHRjb25zdCBzdW0gPSB2ZWN0b3IucmVkdWNlKChhLCBiKSA9PiBhICsgTWF0aC5hYnMoYiksIDApO1xyXG5cdFx0XHRcdFx0aWYgKHN1bSA8IDAuMDAxKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgICAtIOKaoCBXYXJuaW5nOiBWZWN0b3IgYXBwZWFycyB0byBiZSBhbGwgemVyb3MgKHN1bT0ke3N1bX0pYCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdHZlY3RvciA9IGJ1aWxkVmVjdG9yKGNoLnRleHQsIHRoaXMuZGltKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIEhhc2gtYmFzZWQgdmVjdG9yIGdlbmVyYXRlZDogJHt2ZWN0b3IubGVuZ3RofSBkaW1lbnNpb25zYCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRcdFx0Y29uc3QgY29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBDaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzLCAke2NoLnRleHQubGVuZ3RofSBjaGFycylgO1xyXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5lbWJlZENodW5rJywgY29udGV4dCwgZXJyKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofTpgLCBlcnJvck1zZyk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGlmIChlcnIgaW5zdGFuY2VvZiBFcnJvcikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XHJcblx0XHRcdFx0XHRpZiAoJ2NhdXNlJyBpbiBlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIENhdXNlOiAke2Vyci5jYXVzZX1gKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0Ly8gSWYgQUxMIGNodW5rcyBmYWlsIGZvciBhIGZpbGUsIHRoZSBmaWxlIHdvbid0IGJlIGluZGV4ZWRcclxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcclxuXHRcdFx0XHRpZiAoaSA9PT0gMCkge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIENSSVRJQ0FMOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIHdpbGwgbm90IGJlIGluZGV4ZWRgKTtcclxuXHRcdFx0XHRcdGZpcnN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgNTAwKTtcclxuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xyXG5cdFx0XHRcdGtleSxcclxuXHRcdFx0XHRwYXRoLFxyXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXHJcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydFdvcmQsXHJcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcclxuXHRcdFx0XHR0ZXh0SGFzaCxcclxuXHRcdFx0XHR2ZWN0b3IsXHJcblx0XHRcdFx0ZXhjZXJwdFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0c3VjY2Vzc2Z1bENodW5rcysrO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHRpZiAoc3VjY2Vzc2Z1bENodW5rcyA9PT0gMCAmJiBjaHVua3MubGVuZ3RoID4gMCkge1xyXG5cdFx0XHRjb25zdCBjcml0aWNhbENvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZGA7XHJcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgZmlyc3RFcnJvcik7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIG5vdCBpbmRleGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICBSb290IGNhdXNlOiAke2ZpcnN0RXJyb3IubWVzc2FnZX1gKTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBuZXcgRXJyb3IoJ0FsbCBjaHVua3MgZmFpbGVkIGJ1dCBubyBmaXJzdCBlcnJvciBjYXB0dXJlZCcpKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XHJcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcclxuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcclxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XHJcblx0XHRpZiAoa2V5cykge1xyXG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XHJcblx0XHR9XHJcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XHJcblxyXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xyXG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcclxuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XHJcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcclxuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xyXG5cdH1cclxuXHJcblx0Z2V0SW5kZXhlZFBhdGhzKCk6IHN0cmluZ1tdIHtcclxuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxyXG5cdCAqL1xyXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XHJcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRnZXRWZWN0b3JGb3JLZXkoa2V5OiBzdHJpbmcpOiBudW1iZXJbXSB8IG51bGwge1xyXG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xyXG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcclxuXHR9XHJcblxyXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XHJcblx0XHRpZiAodGhpcy5iYWNrZW5kICE9PSAnbWluaWxtJykgcmV0dXJuIGJ1aWxkVmVjdG9yKHF1ZXJ5VGV4dCwgdGhpcy5kaW0pO1xyXG5cdFx0Ly8gTm90ZTogcXVlcnkgZW1iZWRkaW5nIGlzIGFzeW5jOyBwcm92aWRlcnMgc2hvdWxkIGNhbGwgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLlxyXG5cdFx0cmV0dXJuIGJ1aWxkVmVjdG9yKHF1ZXJ5VGV4dCwgdGhpcy5kaW0pO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgZW1iZWRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGlmICh0aGlzLmJhY2tlbmQgIT09ICdtaW5pbG0nKSByZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XHJcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChxdWVyeVRleHQpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMucGVyc2lzdFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucGVyc2lzdFRpbWVyKTtcclxuXHRcdHRoaXMucGVyc2lzdFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XHJcblx0XHRcdHZvaWQgdGhpcy5fcGVyc2lzdE5vdygpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0XHQvLyBpZ25vcmVcclxuXHRcdFx0fSk7XHJcblx0XHR9LCAxMDAwKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgX3BlcnNpc3ROb3coKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRjb25zdCBkaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhkaXIpKSkge1xyXG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihkaXIpO1xyXG5cdFx0XHR9XHJcblx0XHR9IGNhdGNoIHtcclxuXHRcdFx0Ly8gaWdub3JlIG1rZGlyIGZhaWx1cmVzXHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc3QgcGF5bG9hZDogUGVyc2lzdGVkSW5kZXhWMSA9IHtcclxuXHRcdFx0dmVyc2lvbjogMSxcclxuXHRcdFx0ZGltOiB0aGlzLmRpbSxcclxuXHRcdFx0YmFja2VuZDogdGhpcy5iYWNrZW5kLFxyXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxyXG5cdFx0XHRjaHVua3M6IHRoaXMuZ2V0QWxsQ2h1bmtzKClcclxuXHRcdH07XHJcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XHJcblx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcclxuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdFx0Ly8gaWdub3JlXHJcblx0XHRcdH0pO1xyXG5cdFx0fSwgMTAwMCk7XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19