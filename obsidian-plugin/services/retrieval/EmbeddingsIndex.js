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
                console.warn(`Failed to index file ${next}:`, err);
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
            console.error(`[EmbeddingsIndex] CRITICAL: All ${chunks.length} chunks failed for ${path} - file not indexed`);
            if (firstError) {
                console.error(`  Root cause: ${firstError.message}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUMxQixNQUFNLENBQUMsR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7UUFDcEIsOENBQThDO1FBQzlDLE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNwQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDO0lBQ2xCLENBQUM7SUFDRCxlQUFlO0lBQ2YsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEdBQUcsRUFBRSxDQUFDLEVBQUU7UUFBRSxLQUFLLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN2RCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUMsRUFBRTtRQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDO0lBQ3JELE9BQU8sR0FBRyxDQUFDO0FBQ1osQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLE1BQThCO0lBQ2xELE9BQU87UUFDTixZQUFZLEVBQUUsTUFBTSxDQUFDLFFBQVEsQ0FBQywwQkFBMEIsSUFBSSxJQUFJO1FBQ2hFLFdBQVcsRUFBRSxRQUFRLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsSUFBSSxHQUFHLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQztRQUM1RSxZQUFZLEVBQUUsUUFBUSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsMEJBQTBCLElBQUksR0FBRyxFQUFFLENBQUMsRUFBRSxHQUFHLENBQUM7S0FDakYsQ0FBQztBQUNILENBQUM7QUFFRCxTQUFTLFNBQVMsQ0FBQyxJQUFZLEVBQUUsUUFBZ0I7SUFDaEQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDakQsSUFBSSxPQUFPLENBQUMsTUFBTSxJQUFJLFFBQVE7UUFBRSxPQUFPLE9BQU8sQ0FBQztJQUMvQyxPQUFPLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsUUFBUSxDQUFDLEdBQUcsQ0FBQztBQUN6QyxDQUFDO0FBRUQsTUFBTSxPQUFPLGVBQWU7SUFnQjNCLFlBQVksS0FBWSxFQUFFLE1BQThCLEVBQUUsTUFBYyxHQUFHO1FBVG5FLFdBQU0sR0FBRyxLQUFLLENBQUM7UUFDZixnQkFBVyxHQUFHLElBQUksR0FBRyxFQUF3QixDQUFDO1FBQzlDLG9CQUFlLEdBQUcsSUFBSSxHQUFHLEVBQXVCLENBQUM7UUFFeEMsVUFBSyxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFDbkMsa0JBQWEsR0FBRyxLQUFLLENBQUM7UUFDdEIsaUJBQVksR0FBa0IsSUFBSSxDQUFDO1FBQ25DLHNCQUFpQixHQUFrQixJQUFJLENBQUM7UUFHL0MsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFDckIsTUFBTSxPQUFPLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyx5QkFBeUIsQ0FBQztRQUMxRCxJQUFJLENBQUMsT0FBTyxHQUFHLE9BQU8sS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO1FBQ3RELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLE9BQU8sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO1FBQ2pELElBQUksQ0FBQyxLQUFLLEdBQUcsSUFBSSx5QkFBeUIsQ0FBQyxLQUFLLEVBQUUsTUFBTSxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUVELGdCQUFnQjtRQUNmLE9BQU8sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLHVCQUF1QixDQUFDO0lBQzFGLENBQUM7SUFFRCxLQUFLLENBQUMsWUFBWTtRQUNqQixJQUFJLElBQUksQ0FBQyxNQUFNO1lBQUUsT0FBTztRQUN4QixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUVuQixJQUFJLENBQUM7WUFDSixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUNyQyxJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFBRSxPQUFPO1lBQ3JELE1BQU0sR0FBRyxHQUFHLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2hELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFxQixDQUFDO1lBQ25ELElBQUksTUFBTSxFQUFFLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUM7Z0JBQUUsT0FBTztZQUNuRSxJQUFJLE1BQU0sQ0FBQyxPQUFPLElBQUksTUFBTSxDQUFDLE9BQU8sS0FBSyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7Z0JBQ3ZELHdEQUF3RDtnQkFDeEQsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7Z0JBQ3pCLE9BQU87WUFDUixDQUFDO1lBQ0QsSUFBSSxPQUFPLE1BQU0sQ0FBQyxHQUFHLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxHQUFHLEtBQUssSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO2dCQUMvRCwwREFBMEQ7Z0JBQzFELElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO2dCQUN6QixPQUFPO1lBQ1IsQ0FBQztZQUNELE1BQU0sZ0JBQWdCLEdBQUcsV0FBVyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUNsRCxJQUNDLE1BQU0sQ0FBQyxRQUFRO2dCQUNmLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEtBQUssZ0JBQWdCLENBQUMsWUFBWTtvQkFDOUQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxXQUFXLEtBQUssZ0JBQWdCLENBQUMsV0FBVztvQkFDNUQsTUFBTSxDQUFDLFFBQVEsQ0FBQyxZQUFZLEtBQUssZ0JBQWdCLENBQUMsWUFBWSxDQUFDLEVBQy9ELENBQUM7Z0JBQ0YsMENBQTBDO2dCQUMxQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztnQkFDekIsT0FBTztZQUNSLENBQUM7WUFDRCxLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDbkMsSUFBSSxDQUFDLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLEVBQUUsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDO29CQUFFLFNBQVM7Z0JBQzFFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDdkIsQ0FBQztRQUNGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUixtRUFBbUU7WUFDbkUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUN6QixJQUFJLENBQUMsZUFBZSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQzlCLENBQUM7SUFDRixDQUFDO0lBRUQsU0FBUztRQUNSLE9BQU87WUFDTixZQUFZLEVBQUUsSUFBSSxDQUFDLGVBQWUsQ0FBQyxJQUFJO1lBQ3ZDLGFBQWEsRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUk7WUFDcEMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxvQkFBb0IsQ0FBQztZQUMxRCxNQUFNLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJO1NBQ3ZCLENBQUM7SUFDSCxDQUFDO0lBRUQsaUJBQWlCO1FBQ2hCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLHdCQUF3QixFQUFFLENBQUM7UUFDbEUsS0FBSyxNQUFNLENBQUMsSUFBSSxLQUFLO1lBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzlDLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUNwQixDQUFDO0lBRUQsZUFBZSxDQUFDLElBQVk7UUFDM0IsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPO1FBQ2xCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3JCLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztJQUNwQixDQUFDO0lBRUQsZUFBZSxDQUFDLElBQVk7UUFDM0IsSUFBSSxDQUFDLElBQUk7WUFBRSxPQUFPO1FBQ2xCLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDdkIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLHFCQUFxQixFQUFFLENBQUM7SUFDOUIsQ0FBQztJQUVPLFdBQVc7UUFDbEIsSUFBSSxJQUFJLENBQUMsYUFBYTtZQUFFLE9BQU87UUFDL0IsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7UUFDMUIsb0RBQW9EO1FBQ3BELEtBQUssSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7WUFDakMsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUM7UUFDNUIsQ0FBQyxDQUFDLENBQUM7SUFDSixDQUFDO0lBRU8sS0FBSyxDQUFDLFVBQVU7UUFDdkIsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUIsSUFBSSxjQUFjLEdBQUcsQ0FBQyxDQUFDO1FBQ3ZCLElBQUksZUFBZSxHQUFHLENBQUMsQ0FBQztRQUN4QixJQUFJLGtCQUFrQixHQUFHLENBQUMsQ0FBQztRQUMzQixJQUFJLGdCQUFnQixHQUFHLENBQUMsQ0FBQztRQUN6QixJQUFJLFlBQVksR0FBRyxDQUFDLENBQUM7UUFFckIsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUM1QixJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG9CQUFvQjtnQkFBRSxNQUFNO1lBQ3JELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLENBQUMsS0FBZSxDQUFDO1lBQ3hELElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3hCLGNBQWMsRUFBRSxDQUFDO1lBRWpCLG1FQUFtRTtZQUNuRSxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO2dCQUNuRCxlQUFlLEVBQUUsQ0FBQztnQkFDbEIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDdkIsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7Z0JBQ3hCLElBQUksQ0FBQyxxQkFBcUIsRUFBRSxDQUFDO2dCQUM3QixTQUFTO1lBQ1YsQ0FBQztZQUVELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDcEQsNkJBQTZCO1lBQzdCLElBQUksQ0FBQyxDQUFDLElBQUksWUFBWSxLQUFLLENBQUMsSUFBSSxJQUFJLENBQUMsU0FBUyxLQUFLLElBQUksRUFBRSxDQUFDO2dCQUN6RCxrQkFBa0IsRUFBRSxDQUFDO2dCQUNyQixJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUN2QixJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztnQkFDeEIsSUFBSSxDQUFDLHFCQUFxQixFQUFFLENBQUM7Z0JBQzdCLFNBQVM7WUFDVixDQUFDO1lBRUQsSUFBSSxDQUFDO2dCQUNKLE1BQU0sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQzVDLE1BQU0sUUFBUSxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDbEMsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDOUQsTUFBTSxrQkFBa0IsR0FBRyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFFMUQseURBQXlEO2dCQUN6RCxpRkFBaUY7Z0JBQ2pGLElBQUksSUFBSSxFQUFFLElBQUksS0FBSyxRQUFRLElBQUksa0JBQWtCLEVBQUUsQ0FBQztvQkFDbkQsZ0JBQWdCLEVBQUUsQ0FBQztvQkFDbkIsU0FBUztnQkFDVixDQUFDO2dCQUVELE1BQU0sSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7Z0JBQ3ZDLFlBQVksRUFBRSxDQUFDO2dCQUNmLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixHQUFHO29CQUMxQyxHQUFHLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLElBQUksRUFBRSxDQUFDO29CQUNuRCxDQUFDLElBQUksQ0FBQyxFQUFFO3dCQUNQLElBQUksRUFBRSxRQUFRO3dCQUNkLFVBQVUsRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLElBQUksQ0FBQzt3QkFDckQsU0FBUyxFQUFFLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFO3FCQUNuQztpQkFDRCxDQUFDO2dCQUNGLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO2dCQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztZQUM5QixDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDZCwrQ0FBK0M7Z0JBQy9DLE9BQU8sQ0FBQyxJQUFJLENBQUMsd0JBQXdCLElBQUksR0FBRyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3BELENBQUM7WUFFRCwrQkFBK0I7WUFDL0IsTUFBTSxJQUFJLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQzdDLENBQUM7UUFFRCxtQ0FBbUM7UUFDbkMsSUFBSSxjQUFjLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDeEIsT0FBTyxDQUFDLEdBQUcsQ0FBQywrQkFBK0IsY0FBYyxXQUFXLFlBQVksYUFBYSxlQUFlLGNBQWMsa0JBQWtCLGtCQUFrQixnQkFBZ0IsK0JBQStCLENBQUMsQ0FBQztRQUNoTixDQUFDO1FBRUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUM7SUFDNUIsQ0FBQztJQUVPLEtBQUssQ0FBQyxZQUFZLENBQUMsSUFBWSxFQUFFLE9BQWU7UUFDdkQsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUV2QixtQkFBbUI7UUFDbkIsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLENBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQzdDLE9BQU8sQ0FBQyxJQUFJLENBQUMsMENBQTBDLElBQUksRUFBRSxDQUFDLENBQUM7WUFDL0QsT0FBTztRQUNSLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBRyxXQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3JDLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0NBQXNDLElBQUksRUFBRSxDQUFDLENBQUM7UUFDMUQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQkFBZ0IsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDNUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyx1QkFBdUIsT0FBTyxDQUFDLE1BQU0sV0FBVyxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sUUFBUSxDQUFDLENBQUM7UUFDakcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxQ0FBcUMsR0FBRyxDQUFDLFlBQVksaUJBQWlCLEdBQUcsQ0FBQyxXQUFXLGtCQUFrQixHQUFHLENBQUMsWUFBWSxFQUFFLENBQUMsQ0FBQztRQUV2SSxNQUFNLE1BQU0sR0FBRyxnQkFBZ0IsQ0FBQztZQUMvQixJQUFJLEVBQUUsT0FBTztZQUNiLFlBQVksRUFBRSxHQUFHLENBQUMsWUFBWTtZQUM5QixXQUFXLEVBQUUsR0FBRyxDQUFDLFdBQVc7WUFDNUIsWUFBWSxFQUFFLEdBQUcsQ0FBQyxZQUFZO1NBQzlCLENBQUMsQ0FBQztRQUVILE9BQU8sQ0FBQyxHQUFHLENBQUMsdUJBQXVCLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ3BELElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUN2QixPQUFPLENBQUMsR0FBRyxDQUFDLDRCQUE0QixNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2hGLENBQUM7UUFFRCxnRkFBZ0Y7UUFDaEYsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3pCLE9BQU8sQ0FBQyxJQUFJLENBQUMsMkNBQTJDLElBQUksd0RBQXdELENBQUMsQ0FBQztZQUN0SCxPQUFPO1FBQ1IsQ0FBQztRQUVELCtDQUErQztRQUMvQyxJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDL0IsSUFBSSxDQUFDO2dCQUNKLE1BQU0sT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztnQkFDM0MsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQkFBb0IsT0FBTyxFQUFFLENBQUMsQ0FBQztnQkFDM0MsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO29CQUNkLE9BQU8sQ0FBQyxJQUFJLENBQUMsNENBQTRDLENBQUMsQ0FBQztnQkFDNUQsQ0FBQztZQUNGLENBQUM7WUFBQyxPQUFPLGFBQWEsRUFBRSxDQUFDO2dCQUN4QixPQUFPLENBQUMsS0FBSyxDQUFDLG1DQUFtQyxFQUFFLGFBQWEsQ0FBQyxDQUFDO1lBQ25FLENBQUM7UUFDRixDQUFDO1FBRUQsSUFBSSxnQkFBZ0IsR0FBRyxDQUFDLENBQUM7UUFDekIsSUFBSSxVQUFVLEdBQWlCLElBQUksQ0FBQztRQUNwQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ3hDLE1BQU0sRUFBRSxHQUFHLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUNyQixNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ2xDLE1BQU0sR0FBRyxHQUFHLFNBQVMsSUFBSSxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ2pDLElBQUksTUFBZ0IsQ0FBQztZQUNyQixJQUFJLENBQUM7Z0JBQ0osT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQ0FBc0MsQ0FBQyxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLEVBQUUsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sWUFBWSxDQUFDLENBQUM7Z0JBQ3RILE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztnQkFDOUIsSUFBSSxJQUFJLENBQUMsT0FBTyxLQUFLLFFBQVEsRUFBRSxDQUFDO29CQUMvQixpRUFBaUU7b0JBQ2pFLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztvQkFDekMsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFVBQVUsQ0FBQztvQkFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnQ0FBZ0MsYUFBYSxPQUFPLE1BQU0sQ0FBQyxNQUFNLGFBQWEsQ0FBQyxDQUFDO29CQUM1Rix5QkFBeUI7b0JBQ3pCLElBQUksQ0FBQyxNQUFNLElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7d0JBQzNDLE1BQU0sSUFBSSxLQUFLLENBQUMsdUNBQXVDLElBQUksQ0FBQyxHQUFHLFNBQVMsTUFBTSxFQUFFLE1BQU0sSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO29CQUNoRyxDQUFDO29CQUNELG1EQUFtRDtvQkFDbkQsTUFBTSxHQUFHLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO29CQUN4RCxJQUFJLEdBQUcsR0FBRyxLQUFLLEVBQUUsQ0FBQzt3QkFDakIsT0FBTyxDQUFDLElBQUksQ0FBQyxzREFBc0QsR0FBRyxHQUFHLENBQUMsQ0FBQztvQkFDNUUsQ0FBQztnQkFDRixDQUFDO3FCQUFNLENBQUM7b0JBQ1AsTUFBTSxHQUFHLFdBQVcsQ0FBQyxFQUFFLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztvQkFDeEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQ0FBc0MsTUFBTSxDQUFDLE1BQU0sYUFBYSxDQUFDLENBQUM7Z0JBQy9FLENBQUM7WUFDRixDQUFDO1lBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztnQkFDZCxNQUFNLFFBQVEsR0FBRyxHQUFHLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ2xFLE1BQU0sVUFBVSxHQUFHLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztnQkFDaEUsT0FBTyxDQUFDLEtBQUssQ0FBQywrQ0FBK0MsQ0FBQyxHQUFHLENBQUMsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLEVBQUUsUUFBUSxDQUFDLENBQUM7Z0JBQ2xHLElBQUksVUFBVSxFQUFFLENBQUM7b0JBQ2hCLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDbEYsQ0FBQztnQkFDRCxJQUFJLEdBQUcsWUFBWSxLQUFLLEVBQUUsQ0FBQztvQkFDMUIsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQkFBbUIsR0FBRyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO29CQUN6RCxJQUFJLE9BQU8sSUFBSSxHQUFHLEVBQUUsQ0FBQzt3QkFDcEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxjQUFjLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO29CQUMxQyxDQUFDO2dCQUNGLENBQUM7Z0JBQ0QsMkRBQTJEO2dCQUMzRCxtREFBbUQ7Z0JBQ25ELElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO29CQUNiLE9BQU8sQ0FBQyxLQUFLLENBQUMsd0NBQXdDLElBQUksNkJBQTZCLENBQUMsQ0FBQztvQkFDekYsVUFBVSxHQUFHLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7Z0JBQ2xFLENBQUM7Z0JBQ0QsK0RBQStEO2dCQUMvRCxTQUFTO1lBQ1YsQ0FBQztZQUNELE1BQU0sT0FBTyxHQUFHLFNBQVMsQ0FBQyxFQUFFLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3hDLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ2QsR0FBRztnQkFDSCxJQUFJO2dCQUNKLFVBQVUsRUFBRSxDQUFDO2dCQUNiLFNBQVMsRUFBRSxFQUFFLENBQUMsU0FBUztnQkFDdkIsT0FBTyxFQUFFLEVBQUUsQ0FBQyxPQUFPO2dCQUNuQixRQUFRO2dCQUNSLE1BQU07Z0JBQ04sT0FBTzthQUNQLENBQUMsQ0FBQztZQUNILGdCQUFnQixFQUFFLENBQUM7UUFDcEIsQ0FBQztRQUVELElBQUksZ0JBQWdCLEtBQUssQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDakQsT0FBTyxDQUFDLEtBQUssQ0FBQyxtQ0FBbUMsTUFBTSxDQUFDLE1BQU0sc0JBQXNCLElBQUkscUJBQXFCLENBQUMsQ0FBQztZQUMvRyxJQUFJLFVBQVUsRUFBRSxDQUFDO2dCQUNoQixPQUFPLENBQUMsS0FBSyxDQUFDLGlCQUFpQixVQUFVLENBQUMsT0FBTyxFQUFFLENBQUMsQ0FBQztZQUN0RCxDQUFDO1FBQ0YsQ0FBQzthQUFNLElBQUksZ0JBQWdCLEdBQUcsTUFBTSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQzdDLE9BQU8sQ0FBQyxJQUFJLENBQUMseUNBQXlDLElBQUksS0FBSyxnQkFBZ0IsSUFBSSxNQUFNLENBQUMsTUFBTSxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3BILENBQUM7YUFBTSxDQUFDO1lBQ1AsT0FBTyxDQUFDLEdBQUcsQ0FBQyw0Q0FBNEMsSUFBSSxLQUFLLGdCQUFnQixTQUFTLENBQUMsQ0FBQztRQUM3RixDQUFDO0lBQ0YsQ0FBQztJQUVPLFNBQVMsQ0FBQyxLQUFtQjtRQUNwQyxJQUFJLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3ZDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxJQUFJLEdBQUcsRUFBVSxDQUFDO1FBQ3RFLEdBQUcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ25CLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDM0MsQ0FBQztJQUVPLFdBQVcsQ0FBQyxJQUFZO1FBQy9CLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzVDLElBQUksSUFBSSxFQUFFLENBQUM7WUFDVixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUk7Z0JBQUUsSUFBSSxDQUFDLFdBQVcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbEQsQ0FBQztRQUNELElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRWxDLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3RELE1BQU0sSUFBSSxHQUFHLEVBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7WUFDckUsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDbEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLEdBQUcsSUFBSSxDQUFDO1FBQ2pELENBQUM7SUFDRixDQUFDO0lBRUQsWUFBWTtRQUNYLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDOUMsQ0FBQztJQUVELGVBQWU7UUFDZCxPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2hELENBQUM7SUFFRDs7T0FFRztJQUNILHNCQUFzQjtRQUNyQixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxlQUFlLEVBQUU7WUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUMxRCxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDcEIsQ0FBQztJQUVELGVBQWUsQ0FBQyxHQUFXO1FBQzFCLE1BQU0sRUFBRSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3JDLE9BQU8sRUFBRSxFQUFFLE1BQU0sSUFBSSxJQUFJLENBQUM7SUFDM0IsQ0FBQztJQUVELGdCQUFnQixDQUFDLFNBQWlCO1FBQ2pDLElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxRQUFRO1lBQUUsT0FBTyxXQUFXLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN2RSxrRkFBa0Y7UUFDbEYsT0FBTyxXQUFXLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUN6QyxDQUFDO0lBRUQsS0FBSyxDQUFDLGdCQUFnQixDQUFDLFNBQWlCO1FBQ3ZDLElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxRQUFRO1lBQUUsT0FBTyxXQUFXLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUN2RSxPQUFPLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUVPLGdCQUFnQjtRQUN2QixJQUFJLElBQUksQ0FBQyxZQUFZO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDOUQsSUFBSSxDQUFDLFlBQVksR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMxQyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQztZQUN6QixLQUFLLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUNsQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0lBRU8sS0FBSyxDQUFDLFdBQVc7UUFDeEIsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLFlBQVksQ0FBQztRQUNuRixJQUFJLENBQUM7WUFDSixJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQzdDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1lBQ3JDLENBQUM7UUFDRixDQUFDO1FBQUMsTUFBTSxDQUFDO1lBQ1Isd0JBQXdCO1FBQ3pCLENBQUM7UUFFRCxNQUFNLE9BQU8sR0FBcUI7WUFDakMsT0FBTyxFQUFFLENBQUM7WUFDVixHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDYixPQUFPLEVBQUUsSUFBSSxDQUFDLE9BQU87WUFDckIsUUFBUSxFQUFFLFdBQVcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDO1lBQ2xDLE1BQU0sRUFBRSxJQUFJLENBQUMsWUFBWSxFQUFFO1NBQzNCLENBQUM7UUFDRixNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7SUFDbEYsQ0FBQztJQUVPLHFCQUFxQjtRQUM1QixJQUFJLElBQUksQ0FBQyxpQkFBaUI7WUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3hFLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMvQyxJQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1lBQzlCLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUMxQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgVEZpbGUgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcbmltcG9ydCB7IGZudjFhMzIgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XG5pbXBvcnQgeyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIH0gZnJvbSAnLi9Mb2NhbEVtYmVkZGluZ01vZGVsJztcbmltcG9ydCB7IGJ1aWxkSW5kZXhDaHVua3MgfSBmcm9tICcuL0NodW5raW5nJztcblxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xuXHRrZXk6IHN0cmluZztcblx0cGF0aDogc3RyaW5nO1xuXHRjaHVua0luZGV4OiBudW1iZXI7XG5cdHN0YXJ0V29yZDogbnVtYmVyO1xuXHRlbmRXb3JkOiBudW1iZXI7XG5cdHRleHRIYXNoOiBzdHJpbmc7XG5cdHZlY3RvcjogbnVtYmVyW107XG5cdGV4Y2VycHQ6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZEluZGV4VjEge1xuXHR2ZXJzaW9uOiAxO1xuXHRkaW06IG51bWJlcjtcblx0YmFja2VuZDogJ2hhc2gnIHwgJ21pbmlsbSc7XG5cdGNodW5raW5nPzogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfTtcblx0Y2h1bmtzOiBJbmRleGVkQ2h1bmtbXTtcbn1cblxuZnVuY3Rpb24gY2xhbXBJbnQodmFsdWU6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcblx0aWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gbWluO1xuXHRyZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIE1hdGguZmxvb3IodmFsdWUpKSk7XG59XG5cbmZ1bmN0aW9uIHRva2VuaXplKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG5cdHJldHVybiB2YWx1ZVxuXHRcdC50b0xvd2VyQ2FzZSgpXG5cdFx0LnNwbGl0KC9bXmEtejAtOV0rL2cpXG5cdFx0Lm1hcCgodCkgPT4gdC50cmltKCkpXG5cdFx0LmZpbHRlcigodCkgPT4gdC5sZW5ndGggPj0gMik7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkVmVjdG9yKHRleHQ6IHN0cmluZywgZGltOiBudW1iZXIpOiBudW1iZXJbXSB7XG5cdGNvbnN0IHZlYyA9IG5ldyBBcnJheTxudW1iZXI+KGRpbSkuZmlsbCgwKTtcblx0Y29uc3QgdG9rZW5zID0gdG9rZW5pemUodGV4dCk7XG5cdGZvciAoY29uc3QgdG9rIG9mIHRva2Vucykge1xuXHRcdGNvbnN0IGggPSBwYXJzZUludChmbnYxYTMyKHRvayksIDE2KTtcblx0XHRjb25zdCBpZHggPSBoICUgZGltO1xuXHRcdC8vIFNpZ25lZCBoYXNoaW5nIGhlbHBzIHJlZHVjZSBjb2xsaXNpb25zIGJpYXNcblx0XHRjb25zdCBzaWduID0gKGggJiAxKSA9PT0gMCA/IDEgOiAtMTtcblx0XHR2ZWNbaWR4XSArPSBzaWduO1xuXHR9XG5cdC8vIEwyIG5vcm1hbGl6ZVxuXHRsZXQgc3VtU3EgPSAwO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGRpbTsgaSsrKSBzdW1TcSArPSB2ZWNbaV0gKiB2ZWNbaV07XG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XG5cdGZvciAobGV0IGkgPSAwOyBpIDwgZGltOyBpKyspIHZlY1tpXSA9IHZlY1tpXSAvIG5vcm07XG5cdHJldHVybiB2ZWM7XG59XG5cbmZ1bmN0aW9uIGNodW5raW5nS2V5KHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH0ge1xuXHRyZXR1cm4ge1xuXHRcdGhlYWRpbmdMZXZlbDogcGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rSGVhZGluZ0xldmVsID8/ICdoMScsXG5cdFx0dGFyZ2V0V29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua1dvcmRzID8/IDUwMCwgMjAwLCAyMDAwKSxcblx0XHRvdmVybGFwV29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkcyA/PyAxMDAsIDAsIDUwMClcblx0fTtcbn1cblxuZnVuY3Rpb24gZXhjZXJwdE9mKHRleHQ6IHN0cmluZywgbWF4Q2hhcnM6IG51bWJlcik6IHN0cmluZyB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0ZXh0LnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csICcgJyk7XG5cdGlmICh0cmltbWVkLmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRyaW1tZWQ7XG5cdHJldHVybiBgJHt0cmltbWVkLnNsaWNlKDAsIG1heENoYXJzKX3igKZgO1xufVxuXG5leHBvcnQgY2xhc3MgRW1iZWRkaW5nc0luZGV4IHtcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xuXHRwcml2YXRlIHJlYWRvbmx5IGRpbTogbnVtYmVyO1xuXHRwcml2YXRlIHJlYWRvbmx5IGJhY2tlbmQ6ICdoYXNoJyB8ICdtaW5pbG0nO1xuXHRwcml2YXRlIHJlYWRvbmx5IG1vZGVsOiBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsO1xuXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xuXHRwcml2YXRlIGNodW5rS2V5c0J5UGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdHByaXZhdGUgd29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHBlcnNpc3RUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc2V0dGluZ3NTYXZlVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luLCBkaW06IG51bWJlciA9IDI1Nikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHRjb25zdCBiYWNrZW5kID0gcGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEVtYmVkZGluZ0JhY2tlbmQ7XG5cdFx0dGhpcy5iYWNrZW5kID0gYmFja2VuZCA9PT0gJ2hhc2gnID8gJ2hhc2gnIDogJ21pbmlsbSc7XG5cdFx0dGhpcy5kaW0gPSB0aGlzLmJhY2tlbmQgPT09ICdtaW5pbG0nID8gMzg0IDogZGltO1xuXHRcdHRoaXMubW9kZWwgPSBuZXcgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCh2YXVsdCwgcGx1Z2luKTtcblx0fVxuXG5cdGdldEluZGV4RmlsZVBhdGgoKTogc3RyaW5nIHtcblx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L2luZGV4Lmpzb25gO1xuXHR9XG5cblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQocGF0aCk7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcblx0XHRcdGlmIChwYXJzZWQ/LnZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocGFyc2VkLmNodW5rcykpIHJldHVybjtcblx0XHRcdGlmIChwYXJzZWQuYmFja2VuZCAmJiBwYXJzZWQuYmFja2VuZCAhPT0gdGhpcy5iYWNrZW5kKSB7XG5cdFx0XHRcdC8vIEJhY2tlbmQgbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJyAmJiBwYXJzZWQuZGltICE9PSB0aGlzLmRpbSkge1xuXHRcdFx0XHQvLyBEaW1lbnNpb24gbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhwZWN0ZWRDaHVua2luZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcblx0XHRcdGlmIChcblx0XHRcdFx0cGFyc2VkLmNodW5raW5nICYmXG5cdFx0XHRcdChwYXJzZWQuY2h1bmtpbmcuaGVhZGluZ0xldmVsICE9PSBleHBlY3RlZENodW5raW5nLmhlYWRpbmdMZXZlbCB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy50YXJnZXRXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy50YXJnZXRXb3JkcyB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy5vdmVybGFwV29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcub3ZlcmxhcFdvcmRzKVxuXHRcdFx0KSB7XG5cdFx0XHRcdC8vIENodW5raW5nIGNvbmZpZyBjaGFuZ2VkOyByZWJ1aWxkIGluZGV4LlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGZvciAoY29uc3QgY2h1bmsgb2YgcGFyc2VkLmNodW5rcykge1xuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xuXHRcdFx0XHR0aGlzLl9zZXRDaHVuayhjaHVuayk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBDb3JydXB0IGluZGV4IHNob3VsZCBub3QgYnJlYWsgdGhlIHBsdWdpbi4gV2UnbGwgcmVidWlsZCBsYXppbHkuXG5cdFx0XHR0aGlzLmNodW5rc0J5S2V5LmNsZWFyKCk7XG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdH1cblx0fVxuXG5cdGdldFN0YXR1cygpOiB7IGluZGV4ZWRGaWxlczogbnVtYmVyOyBpbmRleGVkQ2h1bmtzOiBudW1iZXI7IHBhdXNlZDogYm9vbGVhbjsgcXVldWVkOiBudW1iZXIgfSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcblx0XHRcdGluZGV4ZWRDaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSxcblx0XHRcdHBhdXNlZDogQm9vbGVhbih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCksXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxuXHRcdH07XG5cdH1cblxuXHRlbnF1ZXVlRnVsbFJlc2NhbigpOiB2b2lkIHtcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0cXVldWVVcGRhdGVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlUmVtb3ZlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdH1cblxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSB0cnVlO1xuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cblx0XHRsZXQgcHJvY2Vzc2VkQ291bnQgPSAwO1xuXHRcdGxldCBza2lwcGVkRXhjbHVkZWQgPSAwO1xuXHRcdGxldCBza2lwcGVkTm90TWFya2Rvd24gPSAwO1xuXHRcdGxldCBza2lwcGVkSGFzaE1hdGNoID0gMDtcblx0XHRsZXQgaW5kZXhlZENvdW50ID0gMDtcblx0XHRcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBmbnYxYTMyKGNvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHRjb25zb2xlLndhcm4oYEZhaWxlZCB0byBpbmRleCBmaWxlICR7bmV4dH06YCwgZXJyKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gWWllbGQgdG8ga2VlcCBVSSByZXNwb25zaXZlLlxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcblx0XHR9XG5cblx0XHQvLyBMb2cgaW5kZXhpbmcgc3RhdHMgZm9yIGRlYnVnZ2luZ1xuXHRcdGlmIChwcm9jZXNzZWRDb3VudCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzZWQgJHtwcm9jZXNzZWRDb3VudH0gZmlsZXM6ICR7aW5kZXhlZENvdW50fSBpbmRleGVkLCAke3NraXBwZWRFeGNsdWRlZH0gZXhjbHVkZWQsICR7c2tpcHBlZE5vdE1hcmtkb3dufSBub3QgbWFya2Rvd24sICR7c2tpcHBlZEhhc2hNYXRjaH0gaGFzaCBtYXRjaCAoYWxyZWFkeSBpbmRleGVkKWApO1xuXHRcdH1cblxuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcmVpbmRleEZpbGUocGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXG5cdFx0Ly8gU2tpcCBlbXB0eSBmaWxlc1xuXHRcdGlmICghY29udGVudCB8fCBjb250ZW50LnRyaW0oKS5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gU2tpcHBpbmcgZW1wdHkgZmlsZTogJHtwYXRofWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGNmZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcblx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2luZyBmaWxlOiAke3BhdGh9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBCYWNrZW5kOiAke3RoaXMuYmFja2VuZH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENvbnRlbnQgbGVuZ3RoOiAke2NvbnRlbnQubGVuZ3RofSBjaGFycywgJHtjb250ZW50LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3Jkc2ApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtpbmcgY29uZmlnOiBoZWFkaW5nTGV2ZWw9JHtjZmcuaGVhZGluZ0xldmVsfSwgdGFyZ2V0V29yZHM9JHtjZmcudGFyZ2V0V29yZHN9LCBvdmVybGFwV29yZHM9JHtjZmcub3ZlcmxhcFdvcmRzfWApO1xuXHRcdFxuXHRcdGNvbnN0IGNodW5rcyA9IGJ1aWxkSW5kZXhDaHVua3Moe1xuXHRcdFx0dGV4dDogY29udGVudCxcblx0XHRcdGhlYWRpbmdMZXZlbDogY2ZnLmhlYWRpbmdMZXZlbCxcblx0XHRcdHRhcmdldFdvcmRzOiBjZmcudGFyZ2V0V29yZHMsXG5cdFx0XHRvdmVybGFwV29yZHM6IGNmZy5vdmVybGFwV29yZHNcblx0XHR9KTtcblx0XHRcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5rcyBjcmVhdGVkOiAke2NodW5rcy5sZW5ndGh9YCk7XG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgICAtIEZpcnN0IGNodW5rIHByZXZpZXc6ICR7Y2h1bmtzWzBdLnRleHQuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIElmIG5vIGNodW5rcyBjcmVhdGVkLCBza2lwIHRoaXMgZmlsZSAobWlnaHQgYmUgdG9vIHNob3J0IG9yIGhhdmUgbm8gaGVhZGluZ3MpXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gTm8gY2h1bmtzIGNyZWF0ZWQgZm9yICR7cGF0aH0gLSBmaWxlIHRvbyBzaG9ydCBvciBubyBoZWFkaW5ncyBtYXRjaCBjaHVua2luZyBjb25maWdgKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBDaGVjayBpZiBtb2RlbCBpcyByZWFkeSAoZm9yIG1pbmlsbSBiYWNrZW5kKVxuXHRcdGlmICh0aGlzLmJhY2tlbmQgPT09ICdtaW5pbG0nKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBpc1JlYWR5ID0gYXdhaXQgdGhpcy5tb2RlbC5pc1JlYWR5KCk7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gTW9kZWwgcmVhZHk6ICR7aXNSZWFkeX1gKTtcblx0XHRcdFx0aWYgKCFpc1JlYWR5KSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGAgIC0gTW9kZWwgbm90IHJlYWR5LCBhdHRlbXB0aW5nIHRvIGxvYWQuLi5gKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAobW9kZWxDaGVja0Vycikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0gTW9kZWwgcmVhZGluZXNzIGNoZWNrIGZhaWxlZDpgLCBtb2RlbENoZWNrRXJyKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gZm52MWEzMihjaC50ZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0aWYgKHRoaXMuYmFja2VuZCA9PT0gJ21pbmlsbScpIHtcblx0XHRcdFx0XHQvLyBNaW5pbG0gcmVxdWlyZXMgYXN5bmMgbW9kZWwgbG9hZGluZyAtIHRoaXMgbWlnaHQgZmFpbCBzaWxlbnRseVxuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMubW9kZWwuZW1iZWQoY2gudGV4dCk7XG5cdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgaW4gJHtlbWJlZER1cmF0aW9ufW1zOiAke3ZlY3Rvci5sZW5ndGh9IGRpbWVuc2lvbnNgKTtcblx0XHRcdFx0XHQvLyBWZXJpZnkgdmVjdG9yIGlzIHZhbGlkXG5cdFx0XHRcdFx0aWYgKCF2ZWN0b3IgfHwgdmVjdG9yLmxlbmd0aCAhPT0gdGhpcy5kaW0pIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgSW52YWxpZCB2ZWN0b3IgZGltZW5zaW9uczogZXhwZWN0ZWQgJHt0aGlzLmRpbX0sIGdvdCAke3ZlY3Rvcj8ubGVuZ3RoIHx8IDB9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdC8vIENoZWNrIGlmIHZlY3RvciBpcyBhbGwgemVyb3MgKGluZGljYXRlcyBmYWlsdXJlKVxuXHRcdFx0XHRcdGNvbnN0IHN1bSA9IHZlY3Rvci5yZWR1Y2UoKGEsIGIpID0+IGEgKyBNYXRoLmFicyhiKSwgMCk7XG5cdFx0XHRcdFx0aWYgKHN1bSA8IDAuMDAxKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLndhcm4oYCAgLSDimqAgV2FybmluZzogVmVjdG9yIGFwcGVhcnMgdG8gYmUgYWxsIHplcm9zIChzdW09JHtzdW19KWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR2ZWN0b3IgPSBidWlsZFZlY3RvcihjaC50ZXh0LCB0aGlzLmRpbSk7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSDinJMgSGFzaC1iYXNlZCB2ZWN0b3IgZ2VuZXJhdGVkOiAke3ZlY3Rvci5sZW5ndGh9IGRpbWVuc2lvbnNgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9OmAsIGVycm9yTXNnKTtcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgU3RhY2s6ICR7ZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuICAgICcpfWApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChlcnIgaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBFcnJvciB0eXBlOiAke2Vyci5jb25zdHJ1Y3Rvci5uYW1lfWApO1xuXHRcdFx0XHRcdGlmICgnY2F1c2UnIGluIGVycikge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIENhdXNlOiAke2Vyci5jYXVzZX1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gSWYgQUxMIGNodW5rcyBmYWlsIGZvciBhIGZpbGUsIHRoZSBmaWxlIHdvbid0IGJlIGluZGV4ZWRcblx0XHRcdFx0Ly8gVGhpcyBpcyBhIGNyaXRpY2FsIGZhaWx1cmUgdGhhdCBzaG91bGQgYmUgbG9nZ2VkXG5cdFx0XHRcdGlmIChpID09PSAwKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIENSSVRJQ0FMOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIHdpbGwgbm90IGJlIGluZGV4ZWRgKTtcblx0XHRcdFx0XHRmaXJzdEVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgNTAwKTtcblx0XHRcdHRoaXMuX3NldENodW5rKHtcblx0XHRcdFx0a2V5LFxuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxuXHRcdFx0XHRzdGFydFdvcmQ6IGNoLnN0YXJ0V29yZCxcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcblx0XHRcdFx0dGV4dEhhc2gsXG5cdFx0XHRcdHZlY3Rvcixcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0XHRzdWNjZXNzZnVsQ2h1bmtzKys7XG5cdFx0fVxuXHRcdFxuXHRcdGlmIChzdWNjZXNzZnVsQ2h1bmtzID09PSAwICYmIGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBDUklUSUNBTDogQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgbm90IGluZGV4ZWRgKTtcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgUm9vdCBjYXVzZTogJHtmaXJzdEVycm9yLm1lc3NhZ2V9YCk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBQYXJ0aWFsIHN1Y2Nlc3MgZm9yICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30vJHtjaHVua3MubGVuZ3RofSBjaHVua3MgaW5kZXhlZGApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cblx0ICovXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdGdldFZlY3RvckZvcktleShrZXk6IHN0cmluZyk6IG51bWJlcltdIHwgbnVsbCB7XG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XG5cdH1cblxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xuXHRcdGlmICh0aGlzLmJhY2tlbmQgIT09ICdtaW5pbG0nKSByZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XG5cdFx0Ly8gTm90ZTogcXVlcnkgZW1iZWRkaW5nIGlzIGFzeW5jOyBwcm92aWRlcnMgc2hvdWxkIGNhbGwgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLlxuXHRcdHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0aWYgKHRoaXMuYmFja2VuZCAhPT0gJ21pbmlsbScpIHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChxdWVyeVRleHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGRpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGRpcik7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG59XG5cblxuIl19