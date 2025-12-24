import { TFile } from 'obsidian';
import { fnv1a32 } from '../ContentHash';
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
        this.backend = 'hash';
        this.dim = dim;
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
                vector = buildVector(ch.text, this.dim);
                const embedDuration = Date.now() - embedStart;
                console.log(`  - ✓ Hash-based vector generated in ${embedDuration}ms: ${vector.length} dimensions`);
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
        return buildVector(queryText, this.dim);
    }
    async embedQueryVector(queryText) {
        return buildVector(queryText, this.dim);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFN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T0FBTyxHQUFxQjtZQUNqQyxPQUFPLEVBQUUsQ0FBQztZQUNWLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztZQUNiLE9BQU8sRUFBRSxJQUFJLENBQUMsT0FBTztZQUNyQixRQUFRLEVBQUUsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUM7WUFDbEMsTUFBTSxFQUFFLElBQUksQ0FBQyxZQUFZLEVBQUU7U0FDM0IsQ0FBQztRQUNGLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztJQUNsRixDQUFDO0lBRU8scUJBQXFCO1FBQzVCLElBQUksSUFBSSxDQUFDLGlCQUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xuaW1wb3J0IHsgZm52MWEzMiB9IGZyb20gJy4uL0NvbnRlbnRIYXNoJztcbmltcG9ydCB7IGJ1aWxkSW5kZXhDaHVua3MgfSBmcm9tICcuL0NodW5raW5nJztcblxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xuXHRrZXk6IHN0cmluZztcblx0cGF0aDogc3RyaW5nO1xuXHRjaHVua0luZGV4OiBudW1iZXI7XG5cdHN0YXJ0V29yZDogbnVtYmVyO1xuXHRlbmRXb3JkOiBudW1iZXI7XG5cdHRleHRIYXNoOiBzdHJpbmc7XG5cdHZlY3RvcjogbnVtYmVyW107XG5cdGV4Y2VycHQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZEluZGV4VjEge1xuXHR2ZXJzaW9uOiAxO1xuXHRkaW06IG51bWJlcjtcblx0YmFja2VuZDogJ2hhc2gnO1xuXHRjaHVua2luZz86IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH07XG5cdGNodW5rczogSW5kZXhlZENodW5rW107XG59XG5cbmZ1bmN0aW9uIGNsYW1wSW50KHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xufVxuXG5mdW5jdGlvbiB0b2tlbml6ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRyZXR1cm4gdmFsdWVcblx0XHQudG9Mb3dlckNhc2UoKVxuXHRcdC5zcGxpdCgvW15hLXowLTldKy9nKVxuXHRcdC5tYXAoKHQpID0+IHQudHJpbSgpKVxuXHRcdC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpO1xufVxuXG5mdW5jdGlvbiBidWlsZFZlY3Rvcih0ZXh0OiBzdHJpbmcsIGRpbTogbnVtYmVyKTogbnVtYmVyW10ge1xuXHRjb25zdCB2ZWMgPSBuZXcgQXJyYXk8bnVtYmVyPihkaW0pLmZpbGwoMCk7XG5cdGNvbnN0IHRva2VucyA9IHRva2VuaXplKHRleHQpO1xuXHRmb3IgKGNvbnN0IHRvayBvZiB0b2tlbnMpIHtcblx0XHRjb25zdCBoID0gcGFyc2VJbnQoZm52MWEzMih0b2spLCAxNik7XG5cdFx0Y29uc3QgaWR4ID0gaCAlIGRpbTtcblx0XHQvLyBTaWduZWQgaGFzaGluZyBoZWxwcyByZWR1Y2UgY29sbGlzaW9ucyBiaWFzXG5cdFx0Y29uc3Qgc2lnbiA9IChoICYgMSkgPT09IDAgPyAxIDogLTE7XG5cdFx0dmVjW2lkeF0gKz0gc2lnbjtcblx0fVxuXHQvLyBMMiBub3JtYWxpemVcblx0bGV0IHN1bVNxID0gMDtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgc3VtU3EgKz0gdmVjW2ldICogdmVjW2ldO1xuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGRpbTsgaSsrKSB2ZWNbaV0gPSB2ZWNbaV0gLyBub3JtO1xuXHRyZXR1cm4gdmVjO1xufVxuXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXG5cdFx0b3ZlcmxhcFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwLCAwLCA1MDApXG5cdH07XG59XG5cbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuXHRpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkO1xuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcbn1cblxuaW50ZXJmYWNlIEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZzsgLy8gV2hlcmUgdGhlIGVycm9yIG9jY3VycmVkIChtZXRob2QvZnVuY3Rpb24gbmFtZSlcblx0Y29udGV4dDogc3RyaW5nOyAvLyBXaGF0IHdhcyBoYXBwZW5pbmcgKGZpbGUgcGF0aCwgY2h1bmsgaW5kZXgsIGV0Yy4pXG5cdG1lc3NhZ2U6IHN0cmluZztcblx0c3RhY2s/OiBzdHJpbmc7XG5cdGVycm9yVHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSByZWFkb25seSBkaW06IG51bWJlcjtcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnaGFzaCc7XG5cblx0cHJpdmF0ZSBsb2FkZWQgPSBmYWxzZTtcblx0cHJpdmF0ZSBjaHVua3NCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBJbmRleGVkQ2h1bms+KCk7XG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgcXVldWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgcGVyc2lzdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gRXJyb3IgdHJhY2tpbmdcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xuXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luLCBkaW06IG51bWJlciA9IDI1Nikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHR0aGlzLmJhY2tlbmQgPSAnaGFzaCc7XG5cdFx0dGhpcy5kaW0gPSBkaW07XG5cdH1cblxuXHRnZXRJbmRleEZpbGVQYXRoKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9pbmRleC5qc29uYDtcblx0fVxuXG5cdGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5sb2FkZWQpIHJldHVybjtcblx0XHR0aGlzLmxvYWRlZCA9IHRydWU7XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcGF0aCA9IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkpIHJldHVybjtcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIFBlcnNpc3RlZEluZGV4VjE7XG5cdFx0XHRpZiAocGFyc2VkPy52ZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5jaHVua3MpKSByZXR1cm47XG5cdFx0XHRpZiAocGFyc2VkLmJhY2tlbmQgJiYgcGFyc2VkLmJhY2tlbmQgIT09IHRoaXMuYmFja2VuZCkge1xuXHRcdFx0XHQvLyBCYWNrZW5kIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmICh0eXBlb2YgcGFyc2VkLmRpbSA9PT0gJ251bWJlcicgJiYgcGFyc2VkLmRpbSAhPT0gdGhpcy5kaW0pIHtcblx0XHRcdFx0Ly8gRGltZW5zaW9uIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4cGVjdGVkQ2h1bmtpbmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0XHRpZiAoXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxuXHRcdFx0XHQocGFyc2VkLmNodW5raW5nLmhlYWRpbmdMZXZlbCAhPT0gZXhwZWN0ZWRDaHVua2luZy5oZWFkaW5nTGV2ZWwgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcudGFyZ2V0V29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcudGFyZ2V0V29yZHMgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3Jkcylcblx0XHRcdCkge1xuXHRcdFx0XHQvLyBDaHVua2luZyBjb25maWcgY2hhbmdlZDsgcmVidWlsZCBpbmRleC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcblx0XHRcdFx0aWYgKCFjaHVuaz8ua2V5IHx8ICFjaHVuaz8ucGF0aCB8fCAhQXJyYXkuaXNBcnJheShjaHVuay52ZWN0b3IpKSBjb250aW51ZTtcblx0XHRcdFx0dGhpcy5fc2V0Q2h1bmsoY2h1bmspO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gQ29ycnVwdCBpbmRleCBzaG91bGQgbm90IGJyZWFrIHRoZSBwbHVnaW4uIFdlJ2xsIHJlYnVpbGQgbGF6aWx5LlxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcblx0XHR9XG5cdH1cblxuXHRnZXRTdGF0dXMoKTogeyBpbmRleGVkRmlsZXM6IG51bWJlcjsgaW5kZXhlZENodW5rczogbnVtYmVyOyBwYXVzZWQ6IGJvb2xlYW47IHF1ZXVlZDogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXG5cdFx0XHRpbmRleGVkQ2h1bmtzOiB0aGlzLmNodW5rc0J5S2V5LnNpemUsXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcblx0XHR9O1xuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IEVycm9yTG9nRW50cnlbXSB7XG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcblx0fVxuXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xuXHRcdGNvbnN0IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcblx0XHRmb3IgKGNvbnN0IGVyciBvZiB0aGlzLmVycm9yTG9nKSB7XG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcblx0XHRcdGJ5TG9jYXRpb24sXG5cdFx0XHRyZWNlbnQ6IHRoaXMuZXJyb3JMb2cuc2xpY2UoLTEwKVxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXHRcdFxuXHRcdGNvbnN0IGVudHJ5OiBFcnJvckxvZ0VudHJ5ID0ge1xuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRsb2NhdGlvbixcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxuXHRcdFx0ZXJyb3JUeXBlXG5cdFx0fTtcblx0XHRcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIEFsc28gbG9nIHRvIGNvbnNvbGUgZm9yIGRlYnVnZ2luZ1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcblx0XHR9XG5cdH1cblxuXHRlbnF1ZXVlRnVsbFJlc2NhbigpOiB2b2lkIHtcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0cXVldWVVcGRhdGVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlUmVtb3ZlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdH1cblxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSB0cnVlO1xuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cblx0XHRsZXQgcHJvY2Vzc2VkQ291bnQgPSAwO1xuXHRcdGxldCBza2lwcGVkRXhjbHVkZWQgPSAwO1xuXHRcdGxldCBza2lwcGVkTm90TWFya2Rvd24gPSAwO1xuXHRcdGxldCBza2lwcGVkSGFzaE1hdGNoID0gMDtcblx0XHRsZXQgaW5kZXhlZENvdW50ID0gMDtcblx0XHRcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBmbnYxYTMyKGNvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHR9XG5cblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQmFja2VuZDogJHt0aGlzLmJhY2tlbmR9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDb250ZW50IGxlbmd0aDogJHtjb250ZW50Lmxlbmd0aH0gY2hhcnMsICR7Y29udGVudC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHNgKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5raW5nIGNvbmZpZzogaGVhZGluZ0xldmVsPSR7Y2ZnLmhlYWRpbmdMZXZlbH0sIHRhcmdldFdvcmRzPSR7Y2ZnLnRhcmdldFdvcmRzfSwgb3ZlcmxhcFdvcmRzPSR7Y2ZnLm92ZXJsYXBXb3Jkc31gKTtcblx0XHRcblx0XHRjb25zdCBjaHVua3MgPSBidWlsZEluZGV4Q2h1bmtzKHtcblx0XHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGNmZy5oZWFkaW5nTGV2ZWwsXG5cdFx0XHR0YXJnZXRXb3JkczogY2ZnLnRhcmdldFdvcmRzLFxuXHRcdFx0b3ZlcmxhcFdvcmRzOiBjZmcub3ZlcmxhcFdvcmRzXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua3MgY3JlYXRlZDogJHtjaHVua3MubGVuZ3RofWApO1xuXHRcdGlmIChjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYCAgLSBGaXJzdCBjaHVuayBwcmV2aWV3OiAke2NodW5rc1swXS50ZXh0LnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuXHRcdH1cblx0XHRcblx0XHQvLyBJZiBubyBjaHVua3MgY3JlYXRlZCwgc2tpcCB0aGlzIGZpbGUgKG1pZ2h0IGJlIHRvbyBzaG9ydCBvciBoYXZlIG5vIGhlYWRpbmdzKVxuXHRcdGlmIChjaHVua3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE5vIGNodW5rcyBjcmVhdGVkIGZvciAke3BhdGh9IC0gZmlsZSB0b28gc2hvcnQgb3Igbm8gaGVhZGluZ3MgbWF0Y2ggY2h1bmtpbmcgY29uZmlnYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gZm52MWEzMihjaC50ZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0dmVjdG9yID0gYnVpbGRWZWN0b3IoY2gudGV4dCwgdGhpcy5kaW0pO1xuXHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIEhhc2gtYmFzZWQgdmVjdG9yIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnN0IGNvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQ2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcywgJHtjaC50ZXh0Lmxlbmd0aH0gY2hhcnMpYDtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmVtYmVkQ2h1bmsnLCBjb250ZXh0LCBlcnIpO1xuXHRcdFx0XHRcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIOKclyBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH06YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XG5cdFx0XHRcdFx0aWYgKCdjYXVzZScgaW4gZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcblx0XHRcdFx0aWYgKGkgPT09IDApIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0gQ1JJVElDQUw6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgd2lsbCBub3QgYmUgaW5kZXhlZGApO1xuXHRcdFx0XHRcdGZpcnN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gU2tpcCB0aGlzIGNodW5rIGlmIGVtYmVkZGluZyBmYWlscywgYnV0IGNvbnRpbnVlIHdpdGggb3RoZXJzXG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGV4Y2VycHRPZihjaC50ZXh0LCAyNTAwKTtcblx0XHRcdHRoaXMuX3NldENodW5rKHtcblx0XHRcdFx0a2V5LFxuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxuXHRcdFx0XHRzdGFydFdvcmQ6IGNoLnN0YXJ0V29yZCxcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcblx0XHRcdFx0dGV4dEhhc2gsXG5cdFx0XHRcdHZlY3Rvcixcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0XHRzdWNjZXNzZnVsQ2h1bmtzKys7XG5cdFx0fVxuXHRcdFxuXHRcdGlmIChzdWNjZXNzZnVsQ2h1bmtzID09PSAwICYmIGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBjcml0aWNhbENvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZGA7XG5cdFx0XHRpZiAoZmlyc3RFcnJvcikge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBmaXJzdEVycm9yKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIG5vdCBpbmRleGVkYCk7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgUm9vdCBjYXVzZTogJHtmaXJzdEVycm9yLm1lc3NhZ2V9YCk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBuZXcgRXJyb3IoJ0FsbCBjaHVua3MgZmFpbGVkIGJ1dCBubyBmaXJzdCBlcnJvciBjYXB0dXJlZCcpKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKHN1Y2Nlc3NmdWxDaHVua3MgPCBjaHVua3MubGVuZ3RoKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSDinJMgU3VjY2Vzc2Z1bGx5IGluZGV4ZWQgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfSBjaHVua3NgKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5zZXQoY2h1bmsua2V5LCBjaHVuayk7XG5cdFx0Y29uc3Qgc2V0ID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KGNodW5rLnBhdGgpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5zZXQoY2h1bmsucGF0aCwgc2V0KTtcblx0fVxuXG5cdHByaXZhdGUgX3JlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2V5cyA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChwYXRoKTtcblx0XHRpZiAoa2V5cykge1xuXHRcdFx0Zm9yIChjb25zdCBrIG9mIGtleXMpIHRoaXMuY2h1bmtzQnlLZXkuZGVsZXRlKGspO1xuXHRcdH1cblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XG5cblx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdKSB7XG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcblx0XHRcdGRlbGV0ZSBuZXh0W3BhdGhdO1xuXHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IG5leHQ7XG5cdFx0fVxuXHR9XG5cblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rc0J5S2V5LnZhbHVlcygpKTtcblx0fVxuXG5cdGdldEluZGV4ZWRQYXRocygpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua0tleXNCeVBhdGgua2V5cygpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxuXHQgKi9cblx0cXVldWVSZWNoZWNrQWxsSW5kZXhlZCgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0Z2V0VmVjdG9yRm9yS2V5KGtleTogc3RyaW5nKTogbnVtYmVyW10gfCBudWxsIHtcblx0XHRjb25zdCBjaCA9IHRoaXMuY2h1bmtzQnlLZXkuZ2V0KGtleSk7XG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcblx0fVxuXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XG5cdFx0cmV0dXJuIGJ1aWxkVmVjdG9yKHF1ZXJ5VGV4dCwgdGhpcy5kaW0pO1xuXHR9XG5cblx0YXN5bmMgZW1iZWRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRyZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVBlcnNpc3QoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMucGVyc2lzdFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucGVyc2lzdFRpbWVyKTtcblx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucGVyc2lzdFRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5fcGVyc2lzdE5vdygpLmNhdGNoKCgpID0+IHtcblx0XHRcdFx0Ly8gaWdub3JlXG5cdFx0XHR9KTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3BlcnNpc3ROb3coKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgZGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR0cnkge1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhkaXIpKSkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoZGlyKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIGlnbm9yZSBta2RpciBmYWlsdXJlc1xuXHRcdH1cblxuXHRcdGNvbnN0IHBheWxvYWQ6IFBlcnNpc3RlZEluZGV4VjEgPSB7XG5cdFx0XHR2ZXJzaW9uOiAxLFxuXHRcdFx0ZGltOiB0aGlzLmRpbSxcblx0XHRcdGJhY2tlbmQ6IHRoaXMuYmFja2VuZCxcblx0XHRcdGNodW5raW5nOiBjaHVua2luZ0tleSh0aGlzLnBsdWdpbiksXG5cdFx0XHRjaHVua3M6IHRoaXMuZ2V0QWxsQ2h1bmtzKClcblx0XHR9O1xuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZSh0aGlzLmdldEluZGV4RmlsZVBhdGgoKSwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XG5cdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblx0XG59XG5cblxuIl19