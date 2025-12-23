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
        const chunks = buildIndexChunks({
            text: content,
            headingLevel: cfg.headingLevel,
            targetWords: cfg.targetWords,
            overlapWords: cfg.overlapWords
        });
        // If no chunks created, skip this file (might be too short or have no headings)
        if (chunks.length === 0) {
            console.warn(`[EmbeddingsIndex] No chunks created for ${path} - file too short or no headings match chunking config`);
            return;
        }
        let successfulChunks = 0;
        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            const textHash = fnv1a32(ch.text);
            const key = `chunk:${path}:${i}`;
            let vector;
            try {
                if (this.backend === 'minilm') {
                    // Minilm requires async model loading - this might fail silently
                    vector = await this.model.embed(ch.text);
                }
                else {
                    vector = buildVector(ch.text, this.dim);
                }
            }
            catch (err) {
                console.error(`[EmbeddingsIndex] Failed to generate embedding for chunk ${i} of ${path}:`, err);
                // If ALL chunks fail for a file, the file won't be indexed
                // This is a critical failure that should be logged
                if (i === 0) {
                    console.error(`[EmbeddingsIndex] CRITICAL: First chunk failed for ${path} - file will not be indexed`);
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
        }
        else if (successfulChunks < chunks.length) {
            console.warn(`[EmbeddingsIndex] Partial success for ${path}: ${successfulChunks}/${chunks.length} chunks indexed`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLE9BQU8sRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ3pDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBQ2xFLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQXFCOUMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMs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QUFJLENBQUMsaUJBQWlCLEdBQUcsTUFBTSxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUU7WUFDL0MsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQztZQUM5QixLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsWUFBWSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtnQkFDMUMsU0FBUztZQUNWLENBQUMsQ0FBQyxDQUFDO1FBQ0osQ0FBQyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ1YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuaW1wb3J0IHsgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCB9IGZyb20gJy4vTG9jYWxFbWJlZGRpbmdNb2RlbCc7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgSW5kZXhlZENodW5rIHtcblx0a2V5OiBzdHJpbmc7XG5cdHBhdGg6IHN0cmluZztcblx0Y2h1bmtJbmRleDogbnVtYmVyO1xuXHRzdGFydFdvcmQ6IG51bWJlcjtcblx0ZW5kV29yZDogbnVtYmVyO1xuXHR0ZXh0SGFzaDogc3RyaW5nO1xuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRJbmRleFYxIHtcblx0dmVyc2lvbjogMTtcblx0ZGltOiBudW1iZXI7XG5cdGJhY2tlbmQ6ICdoYXNoJyB8ICdtaW5pbG0nO1xuXHRjaHVua2luZz86IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH07XG5cdGNodW5rczogSW5kZXhlZENodW5rW107XG59XG5cbmZ1bmN0aW9uIGNsYW1wSW50KHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkgcmV0dXJuIG1pbjtcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xufVxuXG5mdW5jdGlvbiB0b2tlbml6ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRyZXR1cm4gdmFsdWVcblx0XHQudG9Mb3dlckNhc2UoKVxuXHRcdC5zcGxpdCgvW15hLXowLTldKy9nKVxuXHRcdC5tYXAoKHQpID0+IHQudHJpbSgpKVxuXHRcdC5maWx0ZXIoKHQpID0+IHQubGVuZ3RoID49IDIpO1xufVxuXG5mdW5jdGlvbiBidWlsZFZlY3Rvcih0ZXh0OiBzdHJpbmcsIGRpbTogbnVtYmVyKTogbnVtYmVyW10ge1xuXHRjb25zdCB2ZWMgPSBuZXcgQXJyYXk8bnVtYmVyPihkaW0pLmZpbGwoMCk7XG5cdGNvbnN0IHRva2VucyA9IHRva2VuaXplKHRleHQpO1xuXHRmb3IgKGNvbnN0IHRvayBvZiB0b2tlbnMpIHtcblx0XHRjb25zdCBoID0gcGFyc2VJbnQoZm52MWEzMih0b2spLCAxNik7XG5cdFx0Y29uc3QgaWR4ID0gaCAlIGRpbTtcblx0XHQvLyBTaWduZWQgaGFzaGluZyBoZWxwcyByZWR1Y2UgY29sbGlzaW9ucyBiaWFzXG5cdFx0Y29uc3Qgc2lnbiA9IChoICYgMSkgPT09IDAgPyAxIDogLTE7XG5cdFx0dmVjW2lkeF0gKz0gc2lnbjtcblx0fVxuXHQvLyBMMiBub3JtYWxpemVcblx0bGV0IHN1bVNxID0gMDtcblx0Zm9yIChsZXQgaSA9IDA7IGkgPCBkaW07IGkrKykgc3VtU3EgKz0gdmVjW2ldICogdmVjW2ldO1xuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xuXHRmb3IgKGxldCBpID0gMDsgaSA8IGRpbTsgaSsrKSB2ZWNbaV0gPSB2ZWNbaV0gLyBub3JtO1xuXHRyZXR1cm4gdmVjO1xufVxuXG5mdW5jdGlvbiBjaHVua2luZ0tleShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9IHtcblx0cmV0dXJuIHtcblx0XHRoZWFkaW5nTGV2ZWw6IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbCA/PyAnaDEnLFxuXHRcdHRhcmdldFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDAsIDIwMCwgMjAwMCksXG5cdFx0b3ZlcmxhcFdvcmRzOiBjbGFtcEludChwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwLCAwLCA1MDApXG5cdH07XG59XG5cbmZ1bmN0aW9uIGV4Y2VycHRPZih0ZXh0OiBzdHJpbmcsIG1heENoYXJzOiBudW1iZXIpOiBzdHJpbmcge1xuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xuXHRpZiAodHJpbW1lZC5sZW5ndGggPD0gbWF4Q2hhcnMpIHJldHVybiB0cmltbWVkO1xuXHRyZXR1cm4gYCR7dHJpbW1lZC5zbGljZSgwLCBtYXhDaGFycyl94oCmYDtcbn1cblxuZXhwb3J0IGNsYXNzIEVtYmVkZGluZ3NJbmRleCB7XG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSByZWFkb25seSBkaW06IG51bWJlcjtcblx0cHJpdmF0ZSByZWFkb25seSBiYWNrZW5kOiAnaGFzaCcgfCAnbWluaWxtJztcblx0cHJpdmF0ZSByZWFkb25seSBtb2RlbDogTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbDtcblxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xuXHRwcml2YXRlIGNodW5rc0J5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIEluZGV4ZWRDaHVuaz4oKTtcblx0cHJpdmF0ZSBjaHVua0tleXNCeVBhdGggPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XG5cblx0cHJpdmF0ZSByZWFkb25seSBxdWV1ZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRwcml2YXRlIHdvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHNldHRpbmdzU2F2ZVRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZGltOiBudW1iZXIgPSAyNTYpIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdFx0Y29uc3QgYmFja2VuZCA9IHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxFbWJlZGRpbmdCYWNrZW5kO1xuXHRcdHRoaXMuYmFja2VuZCA9IGJhY2tlbmQgPT09ICdoYXNoJyA/ICdoYXNoJyA6ICdtaW5pbG0nO1xuXHRcdHRoaXMuZGltID0gdGhpcy5iYWNrZW5kID09PSAnbWluaWxtJyA/IDM4NCA6IGRpbTtcblx0XHR0aGlzLm1vZGVsID0gbmV3IE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwodmF1bHQsIHBsdWdpbik7XG5cdH1cblxuXHRnZXRJbmRleEZpbGVQYXRoKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9pbmRleC5qc29uYDtcblx0fVxuXG5cdGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5sb2FkZWQpIHJldHVybjtcblx0XHR0aGlzLmxvYWRlZCA9IHRydWU7XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcGF0aCA9IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkpIHJldHVybjtcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIFBlcnNpc3RlZEluZGV4VjE7XG5cdFx0XHRpZiAocGFyc2VkPy52ZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5jaHVua3MpKSByZXR1cm47XG5cdFx0XHRpZiAocGFyc2VkLmJhY2tlbmQgJiYgcGFyc2VkLmJhY2tlbmQgIT09IHRoaXMuYmFja2VuZCkge1xuXHRcdFx0XHQvLyBCYWNrZW5kIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmICh0eXBlb2YgcGFyc2VkLmRpbSA9PT0gJ251bWJlcicgJiYgcGFyc2VkLmRpbSAhPT0gdGhpcy5kaW0pIHtcblx0XHRcdFx0Ly8gRGltZW5zaW9uIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4cGVjdGVkQ2h1bmtpbmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0XHRpZiAoXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxuXHRcdFx0XHQocGFyc2VkLmNodW5raW5nLmhlYWRpbmdMZXZlbCAhPT0gZXhwZWN0ZWRDaHVua2luZy5oZWFkaW5nTGV2ZWwgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcudGFyZ2V0V29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcudGFyZ2V0V29yZHMgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3Jkcylcblx0XHRcdCkge1xuXHRcdFx0XHQvLyBDaHVua2luZyBjb25maWcgY2hhbmdlZDsgcmVidWlsZCBpbmRleC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcblx0XHRcdFx0aWYgKCFjaHVuaz8ua2V5IHx8ICFjaHVuaz8ucGF0aCB8fCAhQXJyYXkuaXNBcnJheShjaHVuay52ZWN0b3IpKSBjb250aW51ZTtcblx0XHRcdFx0dGhpcy5fc2V0Q2h1bmsoY2h1bmspO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gQ29ycnVwdCBpbmRleCBzaG91bGQgbm90IGJyZWFrIHRoZSBwbHVnaW4uIFdlJ2xsIHJlYnVpbGQgbGF6aWx5LlxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcblx0XHR9XG5cdH1cblxuXHRnZXRTdGF0dXMoKTogeyBpbmRleGVkRmlsZXM6IG51bWJlcjsgaW5kZXhlZENodW5rczogbnVtYmVyOyBwYXVzZWQ6IGJvb2xlYW47IHF1ZXVlZDogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXG5cdFx0XHRpbmRleGVkQ2h1bmtzOiB0aGlzLmNodW5rc0J5S2V5LnNpemUsXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcblx0XHR9O1xuXHR9XG5cblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XG5cdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB0aGlzLnF1ZXVlLmFkZChmLnBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLnF1ZXVlLmFkZChwYXRoKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy53b3JrZXJSdW5uaW5nKSByZXR1cm47XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXG5cdFx0dm9pZCB0aGlzLl9ydW5Xb3JrZXIoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXG5cdFx0bGV0IHByb2Nlc3NlZENvdW50ID0gMDtcblx0XHRsZXQgc2tpcHBlZEV4Y2x1ZGVkID0gMDtcblx0XHRsZXQgc2tpcHBlZE5vdE1hcmtkb3duID0gMDtcblx0XHRsZXQgc2tpcHBlZEhhc2hNYXRjaCA9IDA7XG5cdFx0bGV0IGluZGV4ZWRDb3VudCA9IDA7XG5cdFx0XG5cdFx0d2hpbGUgKHRoaXMucXVldWUuc2l6ZSA+IDApIHtcblx0XHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCkgYnJlYWs7XG5cdFx0XHRjb25zdCBuZXh0ID0gdGhpcy5xdWV1ZS52YWx1ZXMoKS5uZXh0KCkudmFsdWUgYXMgc3RyaW5nO1xuXHRcdFx0dGhpcy5xdWV1ZS5kZWxldGUobmV4dCk7XG5cdFx0XHRwcm9jZXNzZWRDb3VudCsrO1xuXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKG5leHQpKSB7XG5cdFx0XHRcdHNraXBwZWRFeGNsdWRlZCsrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcblx0XHRcdC8vIE9ubHkgaW5kZXggbWFya2Rvd24gZmlsZXMuXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSB7XG5cdFx0XHRcdHNraXBwZWROb3RNYXJrZG93bisrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gZm52MWEzMihjb250ZW50KTtcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcblx0XHRcdFx0XHRbbmV4dF06IHtcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcblx0XHRcdFx0Y29uc29sZS53YXJuKGBGYWlsZWQgdG8gaW5kZXggZmlsZSAke25leHR9OmAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHR9XG5cblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XG5cdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3Jkcyxcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xuXHRcdH0pO1xuXHRcdFxuXHRcdC8vIElmIG5vIGNodW5rcyBjcmVhdGVkLCBza2lwIHRoaXMgZmlsZSAobWlnaHQgYmUgdG9vIHNob3J0IG9yIGhhdmUgbm8gaGVhZGluZ3MpXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gTm8gY2h1bmtzIGNyZWF0ZWQgZm9yICR7cGF0aH0gLSBmaWxlIHRvbyBzaG9ydCBvciBubyBoZWFkaW5ncyBtYXRjaCBjaHVua2luZyBjb25maWdgKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0XG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gZm52MWEzMihjaC50ZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAodGhpcy5iYWNrZW5kID09PSAnbWluaWxtJykge1xuXHRcdFx0XHRcdC8vIE1pbmlsbSByZXF1aXJlcyBhc3luYyBtb2RlbCBsb2FkaW5nIC0gdGhpcyBtaWdodCBmYWlsIHNpbGVudGx5XG5cdFx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChjaC50ZXh0KTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHR2ZWN0b3IgPSBidWlsZFZlY3RvcihjaC50ZXh0LCB0aGlzLmRpbSk7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBGYWlsZWQgdG8gZ2VuZXJhdGUgZW1iZWRkaW5nIGZvciBjaHVuayAke2l9IG9mICR7cGF0aH06YCwgZXJyKTtcblx0XHRcdFx0Ly8gSWYgQUxMIGNodW5rcyBmYWlsIGZvciBhIGZpbGUsIHRoZSBmaWxlIHdvbid0IGJlIGluZGV4ZWRcblx0XHRcdFx0Ly8gVGhpcyBpcyBhIGNyaXRpY2FsIGZhaWx1cmUgdGhhdCBzaG91bGQgYmUgbG9nZ2VkXG5cdFx0XHRcdGlmIChpID09PSAwKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgd2lsbCBub3QgYmUgaW5kZXhlZGApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgNTAwKTtcblx0XHRcdHRoaXMuX3NldENodW5rKHtcblx0XHRcdFx0a2V5LFxuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxuXHRcdFx0XHRzdGFydFdvcmQ6IGNoLnN0YXJ0V29yZCxcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcblx0XHRcdFx0dGV4dEhhc2gsXG5cdFx0XHRcdHZlY3Rvcixcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0XHRzdWNjZXNzZnVsQ2h1bmtzKys7XG5cdFx0fVxuXHRcdFxuXHRcdGlmIChzdWNjZXNzZnVsQ2h1bmtzID09PSAwICYmIGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBDUklUSUNBTDogQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgbm90IGluZGV4ZWRgKTtcblx0XHR9IGVsc2UgaWYgKHN1Y2Nlc3NmdWxDaHVua3MgPCBjaHVua3MubGVuZ3RoKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cblx0ICovXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdGdldFZlY3RvckZvcktleShrZXk6IHN0cmluZyk6IG51bWJlcltdIHwgbnVsbCB7XG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XG5cdH1cblxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xuXHRcdGlmICh0aGlzLmJhY2tlbmQgIT09ICdtaW5pbG0nKSByZXR1cm4gYnVpbGRWZWN0b3IocXVlcnlUZXh0LCB0aGlzLmRpbSk7XG5cdFx0Ly8gTm90ZTogcXVlcnkgZW1iZWRkaW5nIGlzIGFzeW5jOyBwcm92aWRlcnMgc2hvdWxkIGNhbGwgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLlxuXHRcdHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0aWYgKHRoaXMuYmFja2VuZCAhPT0gJ21pbmlsbScpIHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5tb2RlbC5lbWJlZChxdWVyeVRleHQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IGRpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGRpcik7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUodGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG59XG5cblxuIl19