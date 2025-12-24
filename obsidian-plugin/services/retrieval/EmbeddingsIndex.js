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
        // Fallback tracking: if MiniLM fails too many times, we should switch to hash
        this.fallbackNotified = false; // Track if we've already notified about fallback
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
        // Also check if MiniLM is fundamentally broken and needs fallback
        if (this.backend === 'minilm') {
            const loadAttempts = this.model.getLoadAttempts();
            const lastError = this.model.getLastLoadError();
            // If MiniLM has failed >50 times and we haven't notified yet, suggest fallback
            if (loadAttempts > 50 && lastError && !this.fallbackNotified) {
                const shouldFallback = await this.checkAndSuggestFallback(loadAttempts, lastError);
                if (shouldFallback) {
                    // Fallback was accepted - this will recreate the index, so return early
                    return;
                }
            }
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
    /**
     * Check if MiniLM is fundamentally broken and suggest fallback to hash backend.
     * Returns true if fallback was applied (which will cause the index to be recreated).
     */
    async checkAndSuggestFallback(loadAttempts, lastError) {
        // Only suggest fallback once per session
        if (this.fallbackNotified) {
            return false;
        }
        // Check if the error is the ONNX Runtime initialization error
        const isOnnxError = lastError.message.includes("Cannot read properties of undefined (reading 'create')") ||
            lastError.message.includes('constructSession') ||
            lastError.location === 'ensureLoaded' ||
            lastError.location === 'ensureLoaded.createPipeline';
        if (!isOnnxError) {
            // Not the expected error - don't suggest fallback
            return false;
        }
        console.warn(`[EmbeddingsIndex] MiniLM embedding model is failing repeatedly (${loadAttempts} attempts)`);
        console.warn(`[EmbeddingsIndex] Last error: ${lastError.message} at ${lastError.location}`);
        console.warn(`[EmbeddingsIndex] This appears to be an ONNX Runtime initialization issue that cannot be automatically resolved.`);
        console.warn(`[EmbeddingsIndex] Suggesting automatic fallback to hash-based embeddings...`);
        // Mark as notified to avoid repeated notifications
        this.fallbackNotified = true;
        // Notify the plugin to switch backend
        try {
            await this.plugin.handleEmbeddingBackendFallback();
            console.log(`[EmbeddingsIndex] Backend automatically switched to 'hash'`);
            return true;
        }
        catch (err) {
            console.error(`[EmbeddingsIndex] Failed to switch backend:`, err);
            return false;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMs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JztcclxuaW1wb3J0IHsgVEZpbGUgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xyXG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xyXG5pbXBvcnQgeyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIH0gZnJvbSAnLi9Mb2NhbEVtYmVkZGluZ01vZGVsJztcclxuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xyXG5cdGtleTogc3RyaW5nO1xyXG5cdHBhdGg6IHN0cmluZztcclxuXHRjaHVua0luZGV4OiBudW1iZXI7XHJcblx0c3RhcnRXb3JkOiBudW1iZXI7XHJcblx0ZW5kV29yZDogbnVtYmVyO1xyXG5cdHRleHRIYXNoOiBzdHJpbmc7XHJcblx0dmVjdG9yOiBudW1iZXJbXTtcclxuXHRleGNlcnB0OiBzdHJpbmc7XHJcbn1cclxuXHJcbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcclxuXHR2ZXJzaW9uOiAxO1xyXG5cdGRpbTogbnVtYmVyO1xyXG5cdGJhY2tlbmQ6ICdoYXNoJyB8ICdtaW5pbG0nO1xyXG5cdGNodW5raW5nPzogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfTtcclxuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xyXG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcclxuXHRyZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIE1hdGguZmxvb3IodmFsdWUpKSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHRva2VuaXplKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XHJcblx0cmV0dXJuIHZhbHVlXHJcblx0XHQudG9Mb3dlckNhc2UoKVxyXG5cdFx0LnNwbGl0KC9bXmEtejAtOV0rL2cpXHJcblx0XHQubWFwKCh0KSA9PiB0LnRyaW0oKSlcclxuXHRcdC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZFZlY3Rvcih0ZXh0OiBzdHJpbmcsIGRpbTogbnVtYmVyKTogbnVtYmVyW10ge1xyXG5cdGNvbnN0IHZlYyA9IG5ldyBBcnJheTxudW1iZXI+KGRpbSkuZmlsbCgwKTtcclxuXHRjb25zdCB0b2tlbnMgPSB0b2tlbml6ZSh0ZXh0KTtcclxuXHRmb3IgKGNvbnN0IHRvayBvZiB0b2tlbnMpIHtcclxuXHRcdGNvbnN0IGggPSBwYXJzZUludChmbnYxYTMyKHRvayksIDE2KTtcclxuXHRcdGNvbnN0IGlkeCA9IGggJSBkaW07XHJcblx0XHQvLyBTaWduZWQgaGFzaGluZyBoZWxwcyByZWR1Y2UgY29sbGlzaW9ucyBiaWFzXHJcblx0XHRjb25zdCBzaWduID0gKGggJiAxKSA9PT0gMCA/IDEgOiAtMTtcclxuXHRcdHZlY1tpZHhdICs9IHNpZ247XHJcblx0fVxyXG5cdC8vIEwyIG5vcm1hbGl6ZVxyXG5cdGxldCBzdW1TcSA9IDA7XHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgc3VtU3EgKz0gdmVjW2ldICogdmVjW2ldO1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgdmVjW2ldID0gdmVjW2ldIC8gbm9ybTtcclxuXHRyZXR1cm4gdmVjO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcclxuXHRyZXR1cm4ge1xyXG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcclxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXHJcblx0XHRvdmVybGFwV29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkcyA/PyAxMDAsIDAsIDUwMClcclxuXHR9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcclxuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xyXG5cdGlmICh0cmltbWVkLmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRyaW1tZWQ7XHJcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XHJcbn1cclxuXHJcbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcclxuXHR0aW1lc3RhbXA6IHN0cmluZztcclxuXHRsb2NhdGlvbjogc3RyaW5nOyAvLyBXaGVyZSB0aGUgZXJyb3Igb2NjdXJyZWQgKG1ldGhvZC9mdW5jdGlvbiBuYW1lKVxyXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnaGFzaCcgfCAnbWluaWxtJztcclxuXHRwcml2YXRlIHJlYWRvbmx5IG1vZGVsOiBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsO1xyXG5cclxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xyXG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xyXG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xyXG5cclxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XHJcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgc2V0dGluZ3NTYXZlVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xyXG5cclxuXHQvLyBFcnJvciB0cmFja2luZ1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xyXG5cdFxyXG5cdC8vIEZhbGxiYWNrIHRyYWNraW5nOiBpZiBNaW5pTE0gZmFpbHMgdG9vIG1hbnkgdGltZXMsIHdlIHNob3VsZCBzd2l0Y2ggdG8gaGFzaFxyXG5cdHByaXZhdGUgZmFsbGJhY2tOb3RpZmllZCA9IGZhbHNlOyAvLyBUcmFjayBpZiB3ZSd2ZSBhbHJlYWR5IG5vdGlmaWVkIGFib3V0IGZhbGxiYWNrXHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luLCBkaW06IG51bWJlciA9IDI1Nikge1xyXG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0XHRjb25zdCBiYWNrZW5kID0gcGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEVtYmVkZGluZ0JhY2tlbmQ7XHJcblx0XHR0aGlzLmJhY2tlbmQgPSBiYWNrZW5kID09PSAnaGFzaCcgPyAnaGFzaCcgOiAnbWluaWxtJztcclxuXHRcdHRoaXMuZGltID0gdGhpcy5iYWNrZW5kID09PSAnbWluaWxtJyA/IDM4NCA6IGRpbTtcclxuXHRcdHRoaXMubW9kZWwgPSBuZXcgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCh2YXVsdCwgcGx1Z2luKTtcclxuXHR9XHJcblxyXG5cdGdldEluZGV4RmlsZVBhdGgoKTogc3RyaW5nIHtcclxuXHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvaW5kZXguanNvbmA7XHJcblx0fVxyXG5cclxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5sb2FkZWQpIHJldHVybjtcclxuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcclxuXHJcblx0XHR0cnkge1xyXG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XHJcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XHJcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xyXG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcclxuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xyXG5cdFx0XHRpZiAocGFyc2VkLmJhY2tlbmQgJiYgcGFyc2VkLmJhY2tlbmQgIT09IHRoaXMuYmFja2VuZCkge1xyXG5cdFx0XHRcdC8vIEJhY2tlbmQgbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXHJcblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xyXG5cdFx0XHRcdHJldHVybjtcclxuXHRcdFx0fVxyXG5cdFx0XHRpZiAodHlwZW9mIHBhcnNlZC5kaW0gPT09ICdudW1iZXInICYmIHBhcnNlZC5kaW0gIT09IHRoaXMuZGltKSB7XHJcblx0XHRcdFx0Ly8gRGltZW5zaW9uIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxyXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcclxuXHRcdFx0XHRyZXR1cm47XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZXhwZWN0ZWRDaHVua2luZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcclxuXHRcdFx0aWYgKFxyXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxyXG5cdFx0XHRcdChwYXJzZWQuY2h1bmtpbmcuaGVhZGluZ0xldmVsICE9PSBleHBlY3RlZENodW5raW5nLmhlYWRpbmdMZXZlbCB8fFxyXG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XHJcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3JkcylcclxuXHRcdFx0KSB7XHJcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXHJcblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xyXG5cdFx0XHRcdHJldHVybjtcclxuXHRcdFx0fVxyXG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcclxuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xyXG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cclxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xyXG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcclxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxyXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxyXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xyXG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcclxuXHR9XHJcblxyXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xyXG5cdFx0Y29uc3QgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xyXG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xyXG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcclxuXHRcdH1cclxuXHRcdHJldHVybiB7XHJcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcclxuXHRcdFx0YnlMb2NhdGlvbixcclxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcclxuXHRcdH07XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcclxuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQWxzbyBsb2cgdG8gY29uc29sZSBmb3IgZGVidWdnaW5nXHJcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XHJcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcclxuXHRcdGZvciAoY29uc3QgZiBvZiBmaWxlcykgdGhpcy5xdWV1ZS5hZGQoZi5wYXRoKTtcclxuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcclxuXHR9XHJcblxyXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xyXG5cdFx0dGhpcy5xdWV1ZS5hZGQocGF0aCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XHJcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcclxuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XHJcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcclxuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMud29ya2VyUnVubmluZykgcmV0dXJuO1xyXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcclxuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cclxuXHRcdHZvaWQgdGhpcy5fcnVuV29ya2VyKCkuY2F0Y2goKCkgPT4ge1xyXG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHJcblx0XHRsZXQgcHJvY2Vzc2VkQ291bnQgPSAwO1xyXG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XHJcblx0XHRsZXQgc2tpcHBlZE5vdE1hcmtkb3duID0gMDtcclxuXHRcdGxldCBza2lwcGVkSGFzaE1hdGNoID0gMDtcclxuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xyXG5cdFx0XHJcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCkge1xyXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpIGJyZWFrO1xyXG5cdFx0XHRjb25zdCBuZXh0ID0gdGhpcy5xdWV1ZS52YWx1ZXMoKS5uZXh0KCkudmFsdWUgYXMgc3RyaW5nO1xyXG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcclxuXHRcdFx0cHJvY2Vzc2VkQ291bnQrKztcclxuXHJcblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cclxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChuZXh0KSkge1xyXG5cdFx0XHRcdHNraXBwZWRFeGNsdWRlZCsrO1xyXG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcclxuXHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xyXG5cdFx0XHQvLyBPbmx5IGluZGV4IG1hcmtkb3duIGZpbGVzLlxyXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSB7XHJcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XHJcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XHJcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBmbnYxYTMyKGNvbnRlbnQpO1xyXG5cdFx0XHRcdGNvbnN0IHByZXYgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bbmV4dF07XHJcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIFNraXAgb25seSBpZjogaGFzaCBtYXRjaGVzIEFORCBmaWxlIGlzIGFscmVhZHkgaW5kZXhlZFxyXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxyXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcclxuXHRcdFx0XHRcdHNraXBwZWRIYXNoTWF0Y2grKztcclxuXHRcdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XHJcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XHJcblx0XHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IHtcclxuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcclxuXHRcdFx0XHRcdFtuZXh0XToge1xyXG5cdFx0XHRcdFx0XHRoYXNoOiBmaWxlSGFzaCxcclxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXHJcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcclxuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xyXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19ydW5Xb3JrZXInLCBgUHJvY2Vzc2luZyBmaWxlOiAke25leHR9YCwgZXJyKTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0Ly8gWWllbGQgdG8ga2VlcCBVSSByZXNwb25zaXZlLlxyXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIExvZyBpbmRleGluZyBzdGF0cyBmb3IgZGVidWdnaW5nXHJcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzZWQgJHtwcm9jZXNzZWRDb3VudH0gZmlsZXM6ICR7aW5kZXhlZENvdW50fSBpbmRleGVkLCAke3NraXBwZWRFeGNsdWRlZH0gZXhjbHVkZWQsICR7c2tpcHBlZE5vdE1hcmtkb3dufSBub3QgbWFya2Rvd24sICR7c2tpcHBlZEhhc2hNYXRjaH0gaGFzaCBtYXRjaCAoYWxyZWFkeSBpbmRleGVkKWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBfcmVpbmRleEZpbGUocGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XHJcblxyXG5cdFx0Ly8gU2tpcCBlbXB0eSBmaWxlc1xyXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IGNmZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzaW5nIGZpbGU6ICR7cGF0aH1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQmFja2VuZDogJHt0aGlzLmJhY2tlbmR9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgICAtIENvbnRlbnQgbGVuZ3RoOiAke2NvbnRlbnQubGVuZ3RofSBjaGFycywgJHtjb250ZW50LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3Jkc2ApO1xyXG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua2luZyBjb25maWc6IGhlYWRpbmdMZXZlbD0ke2NmZy5oZWFkaW5nTGV2ZWx9LCB0YXJnZXRXb3Jkcz0ke2NmZy50YXJnZXRXb3Jkc30sIG92ZXJsYXBXb3Jkcz0ke2NmZy5vdmVybGFwV29yZHN9YCk7XHJcblx0XHRcclxuXHRcdGNvbnN0IGNodW5rcyA9IGJ1aWxkSW5kZXhDaHVua3Moe1xyXG5cdFx0XHR0ZXh0OiBjb250ZW50LFxyXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGNmZy5oZWFkaW5nTGV2ZWwsXHJcblx0XHRcdHRhcmdldFdvcmRzOiBjZmcudGFyZ2V0V29yZHMsXHJcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtzIGNyZWF0ZWQ6ICR7Y2h1bmtzLmxlbmd0aH1gKTtcclxuXHRcdGlmIChjaHVua3MubGVuZ3RoID4gMCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgICAtIEZpcnN0IGNodW5rIHByZXZpZXc6ICR7Y2h1bmtzWzBdLnRleHQuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIElmIG5vIGNodW5rcyBjcmVhdGVkLCBza2lwIHRoaXMgZmlsZSAobWlnaHQgYmUgdG9vIHNob3J0IG9yIGhhdmUgbm8gaGVhZGluZ3MpXHJcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE5vIGNodW5rcyBjcmVhdGVkIGZvciAke3BhdGh9IC0gZmlsZSB0b28gc2hvcnQgb3Igbm8gaGVhZGluZ3MgbWF0Y2ggY2h1bmtpbmcgY29uZmlnYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBDaGVjayBpZiBtb2RlbCBpcyByZWFkeSAoZm9yIG1pbmlsbSBiYWNrZW5kKVxyXG5cdFx0Ly8gQWxzbyBjaGVjayBpZiBNaW5pTE0gaXMgZnVuZGFtZW50YWxseSBicm9rZW4gYW5kIG5lZWRzIGZhbGxiYWNrXHJcblx0XHRpZiAodGhpcy5iYWNrZW5kID09PSAnbWluaWxtJykge1xyXG5cdFx0XHRjb25zdCBsb2FkQXR0ZW1wdHMgPSB0aGlzLm1vZGVsLmdldExvYWRBdHRlbXB0cygpO1xyXG5cdFx0XHRjb25zdCBsYXN0RXJyb3IgPSB0aGlzLm1vZGVsLmdldExhc3RMb2FkRXJyb3IoKTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIElmIE1pbmlMTSBoYXMgZmFpbGVkID41MCB0aW1lcyBhbmQgd2UgaGF2ZW4ndCBub3RpZmllZCB5ZXQsIHN1Z2dlc3QgZmFsbGJhY2tcclxuXHRcdFx0aWYgKGxvYWRBdHRlbXB0cyA+IDUwICYmIGxhc3RFcnJvciAmJiAhdGhpcy5mYWxsYmFja05vdGlmaWVkKSB7XHJcblx0XHRcdFx0Y29uc3Qgc2hvdWxkRmFsbGJhY2sgPSBhd2FpdCB0aGlzLmNoZWNrQW5kU3VnZ2VzdEZhbGxiYWNrKGxvYWRBdHRlbXB0cywgbGFzdEVycm9yKTtcclxuXHRcdFx0XHRpZiAoc2hvdWxkRmFsbGJhY2spIHtcclxuXHRcdFx0XHRcdC8vIEZhbGxiYWNrIHdhcyBhY2NlcHRlZCAtIHRoaXMgd2lsbCByZWNyZWF0ZSB0aGUgaW5kZXgsIHNvIHJldHVybiBlYXJseVxyXG5cdFx0XHRcdFx0cmV0dXJuO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCBpc1JlYWR5ID0gYXdhaXQgdGhpcy5tb2RlbC5pc1JlYWR5KCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSBNb2RlbCByZWFkeTogJHtpc1JlYWR5fWApO1xyXG5cdFx0XHRcdGlmICghaXNSZWFkeSkge1xyXG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGAgIC0gTW9kZWwgbm90IHJlYWR5LCBhdHRlbXB0aW5nIHRvIGxvYWQuLi5gKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gY2F0Y2ggKG1vZGVsQ2hlY2tFcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0gTW9kZWwgcmVhZGluZXNzIGNoZWNrIGZhaWxlZDpgLCBtb2RlbENoZWNrRXJyKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHRsZXQgc3VjY2Vzc2Z1bENodW5rcyA9IDA7XHJcblx0XHRsZXQgZmlyc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcclxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRcdGNvbnN0IGNoID0gY2h1bmtzW2ldO1xyXG5cdFx0XHRjb25zdCB0ZXh0SGFzaCA9IGZudjFhMzIoY2gudGV4dCk7XHJcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xyXG5cdFx0XHRsZXQgdmVjdG9yOiBudW1iZXJbXTtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xyXG5cdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdGlmICh0aGlzLmJhY2tlbmQgPT09ICdtaW5pbG0nKSB7XHJcblx0XHRcdFx0XHQvLyBNaW5pbG0gcmVxdWlyZXMgYXN5bmMgbW9kZWwgbG9hZGluZyAtIHRoaXMgbWlnaHQgZmFpbCBzaWxlbnRseVxyXG5cdFx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChjaC50ZXh0KTtcclxuXHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgaW4gJHtlbWJlZER1cmF0aW9ufW1zOiAke3ZlY3Rvci5sZW5ndGh9IGRpbWVuc2lvbnNgKTtcclxuXHRcdFx0XHRcdC8vIFZlcmlmeSB2ZWN0b3IgaXMgdmFsaWRcclxuXHRcdFx0XHRcdGlmICghdmVjdG9yIHx8IHZlY3Rvci5sZW5ndGggIT09IHRoaXMuZGltKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgSW52YWxpZCB2ZWN0b3IgZGltZW5zaW9uczogZXhwZWN0ZWQgJHt0aGlzLmRpbX0sIGdvdCAke3ZlY3Rvcj8ubGVuZ3RoIHx8IDB9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHQvLyBDaGVjayBpZiB2ZWN0b3IgaXMgYWxsIHplcm9zIChpbmRpY2F0ZXMgZmFpbHVyZSlcclxuXHRcdFx0XHRcdGNvbnN0IHN1bSA9IHZlY3Rvci5yZWR1Y2UoKGEsIGIpID0+IGEgKyBNYXRoLmFicyhiKSwgMCk7XHJcblx0XHRcdFx0XHRpZiAoc3VtIDwgMC4wMDEpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGAgIC0g4pqgIFdhcm5pbmc6IFZlY3RvciBhcHBlYXJzIHRvIGJlIGFsbCB6ZXJvcyAoc3VtPSR7c3VtfSlgKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0dmVjdG9yID0gYnVpbGRWZWN0b3IoY2gudGV4dCwgdGhpcy5kaW0pO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSDinJMgSGFzaC1iYXNlZCB2ZWN0b3IgZ2VuZXJhdGVkOiAke3ZlY3Rvci5sZW5ndGh9IGRpbWVuc2lvbnNgKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zdCBjb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIENodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMsICR7Y2gudGV4dC5sZW5ndGh9IGNoYXJzKWA7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmVtYmVkQ2h1bmsnLCBjb250ZXh0LCBlcnIpO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9OmAsIGVycm9yTXNnKTtcclxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIFN0YWNrOiAke2Vycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbiAgICAnKX1gKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgRXJyb3IgdHlwZTogJHtlcnIuY29uc3RydWN0b3IubmFtZX1gKTtcclxuXHRcdFx0XHRcdGlmICgnY2F1c2UnIGluIGVycikge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxyXG5cdFx0XHRcdC8vIFRoaXMgaXMgYSBjcml0aWNhbCBmYWlsdXJlIHRoYXQgc2hvdWxkIGJlIGxvZ2dlZFxyXG5cdFx0XHRcdGlmIChpID09PSAwKSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0gQ1JJVElDQUw6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgd2lsbCBub3QgYmUgaW5kZXhlZGApO1xyXG5cdFx0XHRcdFx0Zmlyc3RFcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0Ly8gU2tpcCB0aGlzIGNodW5rIGlmIGVtYmVkZGluZyBmYWlscywgYnV0IGNvbnRpbnVlIHdpdGggb3RoZXJzXHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGV4Y2VycHRPZihjaC50ZXh0LCAyNTAwKTtcclxuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xyXG5cdFx0XHRcdGtleSxcclxuXHRcdFx0XHRwYXRoLFxyXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXHJcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydFdvcmQsXHJcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcclxuXHRcdFx0XHR0ZXh0SGFzaCxcclxuXHRcdFx0XHR2ZWN0b3IsXHJcblx0XHRcdFx0ZXhjZXJwdFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0c3VjY2Vzc2Z1bENodW5rcysrO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHRpZiAoc3VjY2Vzc2Z1bENodW5rcyA9PT0gMCAmJiBjaHVua3MubGVuZ3RoID4gMCkge1xyXG5cdFx0XHRjb25zdCBjcml0aWNhbENvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZGA7XHJcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgZmlyc3RFcnJvcik7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIG5vdCBpbmRleGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICBSb290IGNhdXNlOiAke2ZpcnN0RXJyb3IubWVzc2FnZX1gKTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBuZXcgRXJyb3IoJ0FsbCBjaHVua3MgZmFpbGVkIGJ1dCBubyBmaXJzdCBlcnJvciBjYXB0dXJlZCcpKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XHJcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcclxuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcclxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XHJcblx0XHRpZiAoa2V5cykge1xyXG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XHJcblx0XHR9XHJcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XHJcblxyXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xyXG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcclxuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XHJcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcclxuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xyXG5cdH1cclxuXHJcblx0Z2V0SW5kZXhlZFBhdGhzKCk6IHN0cmluZ1tdIHtcclxuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxyXG5cdCAqL1xyXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XHJcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRnZXRWZWN0b3JGb3JLZXkoa2V5OiBzdHJpbmcpOiBudW1iZXJbXSB8IG51bGwge1xyXG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xyXG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcclxuXHR9XHJcblxyXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XHJcblx0XHRpZiAodGhpcy5iYWNrZW5kICE9PSAnbWluaWxtJykgcmV0dXJuIGJ1aWxkVmVjdG9yKHF1ZXJ5VGV4dCwgdGhpcy5kaW0pO1xyXG5cdFx0Ly8gTm90ZTogcXVlcnkgZW1iZWRkaW5nIGlzIGFzeW5jOyBwcm92aWRlcnMgc2hvdWxkIGNhbGwgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLlxyXG5cdFx0cmV0dXJuIGJ1aWxkVmVjdG9yKHF1ZXJ5VGV4dCwgdGhpcy5kaW0pO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgZW1iZWRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGlmICh0aGlzLmJhY2tlbmQgIT09ICdtaW5pbG0nKSByZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XHJcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChxdWVyeVRleHQpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMucGVyc2lzdFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucGVyc2lzdFRpbWVyKTtcclxuXHRcdHRoaXMucGVyc2lzdFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XHJcblx0XHRcdHZvaWQgdGhpcy5fcGVyc2lzdE5vdygpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0XHQvLyBpZ25vcmVcclxuXHRcdFx0fSk7XHJcblx0XHR9LCAxMDAwKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgX3BlcnNpc3ROb3coKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRjb25zdCBkaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhkaXIpKSkge1xyXG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihkaXIpO1xyXG5cdFx0XHR9XHJcblx0XHR9IGNhdGNoIHtcclxuXHRcdFx0Ly8gaWdub3JlIG1rZGlyIGZhaWx1cmVzXHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc3QgcGF5bG9hZDogUGVyc2lzdGVkSW5kZXhWMSA9IHtcclxuXHRcdFx0dmVyc2lvbjogMSxcclxuXHRcdFx0ZGltOiB0aGlzLmRpbSxcclxuXHRcdFx0YmFja2VuZDogdGhpcy5iYWNrZW5kLFxyXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxyXG5cdFx0XHRjaHVua3M6IHRoaXMuZ2V0QWxsQ2h1bmtzKClcclxuXHRcdH07XHJcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xyXG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XHJcblx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcclxuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdFx0Ly8gaWdub3JlXHJcblx0XHRcdH0pO1xyXG5cdFx0fSwgMTAwMCk7XHJcblx0fVxyXG5cdFxyXG5cdC8qKlxyXG5cdCAqIENoZWNrIGlmIE1pbmlMTSBpcyBmdW5kYW1lbnRhbGx5IGJyb2tlbiBhbmQgc3VnZ2VzdCBmYWxsYmFjayB0byBoYXNoIGJhY2tlbmQuXHJcblx0ICogUmV0dXJucyB0cnVlIGlmIGZhbGxiYWNrIHdhcyBhcHBsaWVkICh3aGljaCB3aWxsIGNhdXNlIHRoZSBpbmRleCB0byBiZSByZWNyZWF0ZWQpLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgYXN5bmMgY2hlY2tBbmRTdWdnZXN0RmFsbGJhY2sobG9hZEF0dGVtcHRzOiBudW1iZXIsIGxhc3RFcnJvcjogeyBtZXNzYWdlOiBzdHJpbmc7IGxvY2F0aW9uOiBzdHJpbmc7IGNvbnRleHQ6IHN0cmluZyB9KTogUHJvbWlzZTxib29sZWFuPiB7XHJcblx0XHQvLyBPbmx5IHN1Z2dlc3QgZmFsbGJhY2sgb25jZSBwZXIgc2Vzc2lvblxyXG5cdFx0aWYgKHRoaXMuZmFsbGJhY2tOb3RpZmllZCkge1xyXG5cdFx0XHRyZXR1cm4gZmFsc2U7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIENoZWNrIGlmIHRoZSBlcnJvciBpcyB0aGUgT05OWCBSdW50aW1lIGluaXRpYWxpemF0aW9uIGVycm9yXHJcblx0XHRjb25zdCBpc09ubnhFcnJvciA9IGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKFwiQ2Fubm90IHJlYWQgcHJvcGVydGllcyBvZiB1bmRlZmluZWQgKHJlYWRpbmcgJ2NyZWF0ZScpXCIpIHx8XHJcblx0XHRcdGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdjb25zdHJ1Y3RTZXNzaW9uJykgfHxcclxuXHRcdFx0bGFzdEVycm9yLmxvY2F0aW9uID09PSAnZW5zdXJlTG9hZGVkJyB8fFxyXG5cdFx0XHRsYXN0RXJyb3IubG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnO1xyXG5cdFx0XHJcblx0XHRpZiAoIWlzT25ueEVycm9yKSB7XHJcblx0XHRcdC8vIE5vdCB0aGUgZXhwZWN0ZWQgZXJyb3IgLSBkb24ndCBzdWdnZXN0IGZhbGxiYWNrXHJcblx0XHRcdHJldHVybiBmYWxzZTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBNaW5pTE0gZW1iZWRkaW5nIG1vZGVsIGlzIGZhaWxpbmcgcmVwZWF0ZWRseSAoJHtsb2FkQXR0ZW1wdHN9IGF0dGVtcHRzKWApO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBMYXN0IGVycm9yOiAke2xhc3RFcnJvci5tZXNzYWdlfSBhdCAke2xhc3RFcnJvci5sb2NhdGlvbn1gKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gVGhpcyBhcHBlYXJzIHRvIGJlIGFuIE9OTlggUnVudGltZSBpbml0aWFsaXphdGlvbiBpc3N1ZSB0aGF0IGNhbm5vdCBiZSBhdXRvbWF0aWNhbGx5IHJlc29sdmVkLmApO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTdWdnZXN0aW5nIGF1dG9tYXRpYyBmYWxsYmFjayB0byBoYXNoLWJhc2VkIGVtYmVkZGluZ3MuLi5gKTtcclxuXHRcdFxyXG5cdFx0Ly8gTWFyayBhcyBub3RpZmllZCB0byBhdm9pZCByZXBlYXRlZCBub3RpZmljYXRpb25zXHJcblx0XHR0aGlzLmZhbGxiYWNrTm90aWZpZWQgPSB0cnVlO1xyXG5cdFx0XHJcblx0XHQvLyBOb3RpZnkgdGhlIHBsdWdpbiB0byBzd2l0Y2ggYmFja2VuZFxyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgdGhpcy5wbHVnaW4uaGFuZGxlRW1iZWRkaW5nQmFja2VuZEZhbGxiYWNrKCk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBCYWNrZW5kIGF1dG9tYXRpY2FsbHkgc3dpdGNoZWQgdG8gJ2hhc2gnYCk7XHJcblx0XHRcdHJldHVybiB0cnVlO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIEZhaWxlZCB0byBzd2l0Y2ggYmFja2VuZDpgLCBlcnIpO1xyXG5cdFx0XHRyZXR1cm4gZmFsc2U7XHJcblx0XHR9XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19