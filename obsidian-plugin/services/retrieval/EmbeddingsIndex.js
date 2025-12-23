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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMs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QUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0lBQ2xGLENBQUM7SUFFTyxxQkFBcUI7UUFDNUIsSUFBSSxJQUFJLENBQUMsaUJBQWlCO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsaUJBQWlCLENBQUMsQ0FBQztRQUN4RSxJQUFJLENBQUMsaUJBQWlCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDL0MsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDMUMsU0FBUztZQUNWLENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuaW1wb3J0IHsgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCB9IGZyb20gJy4vTG9jYWxFbWJlZGRpbmdNb2RlbCc7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhlZENodW5rIHtcblx0a2V5OiBzdHJpbmc7XG5cdHBhdGg6IHN0cmluZztcblx0Y2h1bmtJbmRleDogbnVtYmVyO1xuXHRzdGFydFdvcmQ6IG51bWJlcjtcblx0ZW5kV29yZDogbnVtYmVyO1xuXHR0ZXh0SGFzaDogc3RyaW5nO1xuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcblx0dmVyc2lvbjogMTtcblx0ZGltOiBudW1iZXI7XG5cdGJhY2tlbmQ6ICdoYXNoJyB8ICdtaW5pbG0nO1xuXHRjaHVua2luZz86IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH07XG5cdGNodW5rczogSW5kZXhlZENodW5rW107XG59XG5cbmZ1bmN0aW9uIGNsYW1wSW50KHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xufVxuXG5mdW5jdGlvbiB0b2tlbml6ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRyZXR1cm4gdmFsdWVcblx0XHQudG9Mb3dlckNhc2UoKVxuXHRcdC5zcGxpdCgvW15hLXowLTldKy9nKVxuXHRcdC5tYXAoKHQpID0+IHQudHJpbSgpKVxuXHRcdC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpO1xufVxuXG5mdW5jdGlvbiBidWlsZFZlY3Rvcih0ZXh0OiBzdHJpbmcsIGRpbTogbnVtYmVyKTogbnVtYmVyW10ge1xuXHRjb25zdCB2ZWMgPSBuZXcgQXJyYXk8bnVtYmVyPihkaW0pLmZpbGwoMCk7XG5cdGNvbnN0IHRva2VucyA9IHRva2VuaXplKHRleHQpO1xuXHRmb3IgKGNvbnN0IHRvayBvZiB0b2tlbnMpIHtcblx0XHRjb25zdCBoID0gcGFyc2VJbnQoZm52MWEzMih0b2spLCAxNik7XG5cdFx0Y29uc3QgaWR4ID0gaCAlIGRpbTtcblx0XHQvLyBTaWduZWQgaGFzaGluZyBoZWxwcyByZWR1Y2UgY29sbGlzaW9ucyBiaWFzXG5cdFx0Y29uc3Qgc2lnbiA9IChoICYgMSkgPT09IDAgPyAxIDogLTE7XG5cdFx0dmVjW2lkeF0gKz0gc2lnbjtcblx0fVxuXHQvLyBMMiBub3JtYWxpemVcblx0bGV0IHN1bVNxID0gMDtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgc3VtU3EgKz0gdmVjW2ldICogdmVjW2ldO1xuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGRpbTsgaSsrKSB2ZWNbaV0gPSB2ZWNbaV0gLyBub3JtO1xuXHRyZXR1cm4gdmVjO1xufVxuXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXG5cdFx0b3ZlcmxhcFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwLCAwLCA1MDApXG5cdH07XG59XG5cbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuXHRpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkO1xuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcbn1cblxuaW50ZXJmYWNlIEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZzsgLy8gV2hlcmUgdGhlIGVycm9yIG9jY3VycmVkIChtZXRob2QvZnVuY3Rpb24gbmFtZSlcblx0Y29udGV4dDogc3RyaW5nOyAvLyBXaGF0IHdhcyBoYXBwZW5pbmcgKGZpbGUgcGF0aCwgY2h1bmsgaW5kZXgsIGV0Yy4pXG5cdG1lc3NhZ2U6IHN0cmluZztcblx0c3RhY2s/OiBzdHJpbmc7XG5cdGVycm9yVHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSByZWFkb25seSBkaW06IG51bWJlcjtcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnaGFzaCcgfCAnbWluaWxtJztcblx0cHJpdmF0ZSByZWFkb25seSBtb2RlbDogTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbDtcblxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xuXHRwcml2YXRlIGNodW5rc0J5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIEluZGV4ZWRDaHVuaz4oKTtcblx0cHJpdmF0ZSBjaHVua0tleXNCeVBhdGggPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XG5cblx0cHJpdmF0ZSByZWFkb25seSBxdWV1ZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRwcml2YXRlIHdvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHNldHRpbmdzU2F2ZVRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBFcnJvciB0cmFja2luZ1xuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSAxMDA7XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sIGRpbTogbnVtYmVyID0gMjU2KSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHRcdGNvbnN0IGJhY2tlbmQgPSBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsRW1iZWRkaW5nQmFja2VuZDtcblx0XHR0aGlzLmJhY2tlbmQgPSBiYWNrZW5kID09PSAnaGFzaCcgPyAnaGFzaCcgOiAnbWluaWxtJztcblx0XHR0aGlzLmRpbSA9IHRoaXMuYmFja2VuZCA9PT0gJ21pbmlsbScgPyAzODQgOiBkaW07XG5cdFx0dGhpcy5tb2RlbCA9IG5ldyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsKHZhdWx0LCBwbHVnaW4pO1xuXHR9XG5cblx0Z2V0SW5kZXhGaWxlUGF0aCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvaW5kZXguanNvbmA7XG5cdH1cblxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMubG9hZGVkKSByZXR1cm47XG5cdFx0dGhpcy5sb2FkZWQgPSB0cnVlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHBhdGggPSB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChwYXRoKTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRJbmRleFYxO1xuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xuXHRcdFx0aWYgKHBhcnNlZC5iYWNrZW5kICYmIHBhcnNlZC5iYWNrZW5kICE9PSB0aGlzLmJhY2tlbmQpIHtcblx0XHRcdFx0Ly8gQmFja2VuZCBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAodHlwZW9mIHBhcnNlZC5kaW0gPT09ICdudW1iZXInICYmIHBhcnNlZC5kaW0gIT09IHRoaXMuZGltKSB7XG5cdFx0XHRcdC8vIERpbWVuc2lvbiBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHBlY3RlZENodW5raW5nID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcblx0XHRcdFx0KHBhcnNlZC5jaHVua2luZy5oZWFkaW5nTGV2ZWwgIT09IGV4cGVjdGVkQ2h1bmtpbmcuaGVhZGluZ0xldmVsIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXG5cdFx0XHQpIHtcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XG5cdFx0XHRcdGlmICghY2h1bms/LmtleSB8fCAhY2h1bms/LnBhdGggfHwgIUFycmF5LmlzQXJyYXkoY2h1bmsudmVjdG9yKSkgY29udGludWU7XG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cblx0XHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0fVxuXHR9XG5cblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0aW5kZXhlZEZpbGVzOiB0aGlzLmNodW5rS2V5c0J5UGF0aC5zaXplLFxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxuXHRcdFx0cGF1c2VkOiBCb29sZWFuKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSxcblx0XHRcdHF1ZXVlZDogdGhpcy5xdWV1ZS5zaXplXG5cdFx0fTtcblx0fVxuXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRFcnJvclN1bW1hcnkoKTogeyB0b3RhbDogbnVtYmVyOyBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+OyByZWNlbnQ6IEVycm9yTG9nRW50cnlbXSB9IHtcblx0XHRjb25zdCBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xuXHRcdFx0YnlMb2NhdGlvbltlcnIubG9jYXRpb25dID0gKGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSB8fCAwKSArIDE7XG5cdFx0fVxuXHRcdHJldHVybiB7XG5cdFx0XHR0b3RhbDogdGhpcy5lcnJvckxvZy5sZW5ndGgsXG5cdFx0XHRieUxvY2F0aW9uLFxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bG9jYXRpb24sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcblx0XHRcdGVycm9yVHlwZVxuXHRcdH07XG5cdFx0XG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblx0XHRcblx0XHQvLyBBbHNvIGxvZyB0byBjb25zb2xlIGZvciBkZWJ1Z2dpbmdcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XG5cdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB0aGlzLnF1ZXVlLmFkZChmLnBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLnF1ZXVlLmFkZChwYXRoKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy53b3JrZXJSdW5uaW5nKSByZXR1cm47XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXG5cdFx0dm9pZCB0aGlzLl9ydW5Xb3JrZXIoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXG5cdFx0bGV0IHByb2Nlc3NlZENvdW50ID0gMDtcblx0XHRsZXQgc2tpcHBlZEV4Y2x1ZGVkID0gMDtcblx0XHRsZXQgc2tpcHBlZE5vdE1hcmtkb3duID0gMDtcblx0XHRsZXQgc2tpcHBlZEhhc2hNYXRjaCA9IDA7XG5cdFx0bGV0IGluZGV4ZWRDb3VudCA9IDA7XG5cdFx0XG5cdFx0d2hpbGUgKHRoaXMucXVldWUuc2l6ZSA+IDApIHtcblx0XHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCkgYnJlYWs7XG5cdFx0XHRjb25zdCBuZXh0ID0gdGhpcy5xdWV1ZS52YWx1ZXMoKS5uZXh0KCkudmFsdWUgYXMgc3RyaW5nO1xuXHRcdFx0dGhpcy5xdWV1ZS5kZWxldGUobmV4dCk7XG5cdFx0XHRwcm9jZXNzZWRDb3VudCsrO1xuXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKG5leHQpKSB7XG5cdFx0XHRcdHNraXBwZWRFeGNsdWRlZCsrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcblx0XHRcdC8vIE9ubHkgaW5kZXggbWFya2Rvd24gZmlsZXMuXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSB7XG5cdFx0XHRcdHNraXBwZWROb3RNYXJrZG93bisrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gZm52MWEzMihjb250ZW50KTtcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcblx0XHRcdFx0XHRbbmV4dF06IHtcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3J1bldvcmtlcicsIGBQcm9jZXNzaW5nIGZpbGU6ICR7bmV4dH1gLCBlcnIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBZaWVsZCB0byBrZWVwIFVJIHJlc3BvbnNpdmUuXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXHRcdH1cblxuXHRcdC8vIExvZyBpbmRleGluZyBzdGF0cyBmb3IgZGVidWdnaW5nXG5cdFx0aWYgKHByb2Nlc3NlZENvdW50ID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NlZCAke3Byb2Nlc3NlZENvdW50fSBmaWxlczogJHtpbmRleGVkQ291bnR9IGluZGV4ZWQsICR7c2tpcHBlZEV4Y2x1ZGVkfSBleGNsdWRlZCwgJHtza2lwcGVkTm90TWFya2Rvd259IG5vdCBtYXJrZG93biwgJHtza2lwcGVkSGFzaE1hdGNofSBoYXNoIG1hdGNoIChhbHJlYWR5IGluZGV4ZWQpYCk7XG5cdFx0fVxuXG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIEJhY2tlbmQ6ICR7dGhpcy5iYWNrZW5kfWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ29udGVudCBsZW5ndGg6ICR7Y29udGVudC5sZW5ndGh9IGNoYXJzLCAke2NvbnRlbnQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzYCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua2luZyBjb25maWc6IGhlYWRpbmdMZXZlbD0ke2NmZy5oZWFkaW5nTGV2ZWx9LCB0YXJnZXRXb3Jkcz0ke2NmZy50YXJnZXRXb3Jkc30sIG92ZXJsYXBXb3Jkcz0ke2NmZy5vdmVybGFwV29yZHN9YCk7XG5cdFx0XG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XG5cdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3Jkcyxcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xuXHRcdH0pO1xuXHRcdFxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtzIGNyZWF0ZWQ6ICR7Y2h1bmtzLmxlbmd0aH1gKTtcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGAgIC0gRmlyc3QgY2h1bmsgcHJldmlldzogJHtjaHVua3NbMF0udGV4dC5zdWJzdHJpbmcoMCwgMTAwKX0uLi5gKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gSWYgbm8gY2h1bmtzIGNyZWF0ZWQsIHNraXAgdGhpcyBmaWxlIChtaWdodCBiZSB0b28gc2hvcnQgb3IgaGF2ZSBubyBoZWFkaW5ncylcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBObyBjaHVua3MgY3JlYXRlZCBmb3IgJHtwYXRofSAtIGZpbGUgdG9vIHNob3J0IG9yIG5vIGhlYWRpbmdzIG1hdGNoIGNodW5raW5nIGNvbmZpZ2ApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIENoZWNrIGlmIG1vZGVsIGlzIHJlYWR5IChmb3IgbWluaWxtIGJhY2tlbmQpXG5cdFx0aWYgKHRoaXMuYmFja2VuZCA9PT0gJ21pbmlsbScpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGlzUmVhZHkgPSBhd2FpdCB0aGlzLm1vZGVsLmlzUmVhZHkoKTtcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSBNb2RlbCByZWFkeTogJHtpc1JlYWR5fWApO1xuXHRcdFx0XHRpZiAoIWlzUmVhZHkpIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYCAgLSBNb2RlbCBub3QgcmVhZHksIGF0dGVtcHRpbmcgdG8gbG9hZC4uLmApO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChtb2RlbENoZWNrRXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSBNb2RlbCByZWFkaW5lc3MgY2hlY2sgZmFpbGVkOmAsIG1vZGVsQ2hlY2tFcnIpO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRcblx0XHRsZXQgc3VjY2Vzc2Z1bENodW5rcyA9IDA7XG5cdFx0bGV0IGZpcnN0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBjaHVua3MubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IGNoID0gY2h1bmtzW2ldO1xuXHRcdFx0Y29uc3QgdGV4dEhhc2ggPSBmbnYxYTMyKGNoLnRleHQpO1xuXHRcdFx0Y29uc3Qga2V5ID0gYGNodW5rOiR7cGF0aH06JHtpfWA7XG5cdFx0XHRsZXQgdmVjdG9yOiBudW1iZXJbXTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XG5cdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHRpZiAodGhpcy5iYWNrZW5kID09PSAnbWluaWxtJykge1xuXHRcdFx0XHRcdC8vIE1pbmlsbSByZXF1aXJlcyBhc3luYyBtb2RlbCBsb2FkaW5nIC0gdGhpcyBtaWdodCBmYWlsIHNpbGVudGx5XG5cdFx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChjaC50ZXh0KTtcblx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSDinJMgRW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0XHRcdC8vIFZlcmlmeSB2ZWN0b3IgaXMgdmFsaWRcblx0XHRcdFx0XHRpZiAoIXZlY3RvciB8fCB2ZWN0b3IubGVuZ3RoICE9PSB0aGlzLmRpbSkge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHZlY3RvciBkaW1lbnNpb25zOiBleHBlY3RlZCAke3RoaXMuZGltfSwgZ290ICR7dmVjdG9yPy5sZW5ndGggfHwgMH1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Ly8gQ2hlY2sgaWYgdmVjdG9yIGlzIGFsbCB6ZXJvcyAoaW5kaWNhdGVzIGZhaWx1cmUpXG5cdFx0XHRcdFx0Y29uc3Qgc3VtID0gdmVjdG9yLnJlZHVjZSgoYSwgYikgPT4gYSArIE1hdGguYWJzKGIpLCAwKTtcblx0XHRcdFx0XHRpZiAoc3VtIDwgMC4wMDEpIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgICAtIOKaoCBXYXJuaW5nOiBWZWN0b3IgYXBwZWFycyB0byBiZSBhbGwgemVyb3MgKHN1bT0ke3N1bX0pYCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHZlY3RvciA9IGJ1aWxkVmVjdG9yKGNoLnRleHQsIHRoaXMuZGltKTtcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBIYXNoLWJhc2VkIHZlY3RvciBnZW5lcmF0ZWQ6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgY29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBDaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzLCAke2NoLnRleHQubGVuZ3RofSBjaGFycylgO1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuZW1iZWRDaHVuaycsIGNvbnRleHQsIGVycik7XG5cdFx0XHRcdFxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofTpgLCBlcnJvck1zZyk7XG5cdFx0XHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIFN0YWNrOiAke2Vycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbiAgICAnKX1gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgRXJyb3IgdHlwZTogJHtlcnIuY29uc3RydWN0b3IubmFtZX1gKTtcblx0XHRcdFx0XHRpZiAoJ2NhdXNlJyBpbiBlcnIpIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBDYXVzZTogJHtlcnIuY2F1c2V9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIElmIEFMTCBjaHVua3MgZmFpbCBmb3IgYSBmaWxlLCB0aGUgZmlsZSB3b24ndCBiZSBpbmRleGVkXG5cdFx0XHRcdC8vIFRoaXMgaXMgYSBjcml0aWNhbCBmYWlsdXJlIHRoYXQgc2hvdWxkIGJlIGxvZ2dlZFxuXHRcdFx0XHRpZiAoaSA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSBDUklUSUNBTDogRmlyc3QgY2h1bmsgZmFpbGVkIGZvciAke3BhdGh9IC0gZmlsZSB3aWxsIG5vdCBiZSBpbmRleGVkYCk7XG5cdFx0XHRcdFx0Zmlyc3RFcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBTa2lwIHRoaXMgY2h1bmsgaWYgZW1iZWRkaW5nIGZhaWxzLCBidXQgY29udGludWUgd2l0aCBvdGhlcnNcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleGNlcnB0ID0gZXhjZXJwdE9mKGNoLnRleHQsIDUwMCk7XG5cdFx0XHR0aGlzLl9zZXRDaHVuayh7XG5cdFx0XHRcdGtleSxcblx0XHRcdFx0cGF0aCxcblx0XHRcdFx0Y2h1bmtJbmRleDogaSxcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydFdvcmQsXG5cdFx0XHRcdGVuZFdvcmQ6IGNoLmVuZFdvcmQsXG5cdFx0XHRcdHRleHRIYXNoLFxuXHRcdFx0XHR2ZWN0b3IsXG5cdFx0XHRcdGV4Y2VycHRcblx0XHRcdH0pO1xuXHRcdFx0c3VjY2Vzc2Z1bENodW5rcysrO1xuXHRcdH1cblx0XHRcblx0XHRpZiAoc3VjY2Vzc2Z1bENodW5rcyA9PT0gMCAmJiBjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgY3JpdGljYWxDb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWRgO1xuXHRcdFx0aWYgKGZpcnN0RXJyb3IpIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgZmlyc3RFcnJvcik7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIENSSVRJQ0FMOiBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkIGZvciAke3BhdGh9IC0gZmlsZSBub3QgaW5kZXhlZGApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIFJvb3QgY2F1c2U6ICR7Zmlyc3RFcnJvci5tZXNzYWdlfWApO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgbmV3IEVycm9yKCdBbGwgY2h1bmtzIGZhaWxlZCBidXQgbm8gZmlyc3QgZXJyb3IgY2FwdHVyZWQnKSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBQYXJ0aWFsIHN1Y2Nlc3MgZm9yICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30vJHtjaHVua3MubGVuZ3RofSBjaHVua3MgaW5kZXhlZGApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cblx0ICovXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdGdldFZlY3RvckZvcktleShrZXk6IHN0cmluZyk6IG51bWJlcltdIHwgbnVsbCB7XG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XG5cdH1cblxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xuXHRcdGlmICh0aGlzLmJhY2tlbmQgIT09ICdtaW5pbG0nKSByZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XG5cdFx0Ly8gTm90ZTogcXVlcnkgZW1iZWRkaW5nIGlzIGFzeW5jOyBwcm92aWRlcnMgc2hvdWxkIGNhbGwgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLlxuXHRcdHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0aWYgKHRoaXMuYmFja2VuZCAhPT0gJ21pbmlsbScpIHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChxdWVyeVRleHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGRpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGRpcik7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG59XG5cblxuIl19