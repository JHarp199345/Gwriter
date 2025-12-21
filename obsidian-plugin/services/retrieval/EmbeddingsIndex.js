import { __awaiter } from "tslib";
import { TFile } from 'obsidian';
import { fnv1a32 } from '../ContentHash';
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
function chunkWords(text, chunkWordsCount, overlapWordsCount) {
    const words = text.split(/\s+/g).filter(Boolean);
    const chunks = [];
    const size = clampInt(chunkWordsCount, 200, 2000);
    const overlap = clampInt(overlapWordsCount, 0, Math.max(0, size - 1));
    const step = Math.max(1, size - overlap);
    for (let start = 0; start < words.length; start += step) {
        const end = Math.min(words.length, start + size);
        const slice = words.slice(start, end).join(' ');
        chunks.push({ start, end, text: slice });
        if (end >= words.length)
            break;
    }
    return chunks;
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
        this.dim = dim;
    }
    getIndexFilePath() {
        return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/index.json`;
    }
    ensureLoaded() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.loaded)
                return;
            this.loaded = true;
            try {
                const path = this.getIndexFilePath();
                if (!(yield this.vault.adapter.exists(path)))
                    return;
                const raw = yield this.vault.adapter.read(path);
                const parsed = JSON.parse(raw);
                if ((parsed === null || parsed === void 0 ? void 0 : parsed.version) !== 1 || !Array.isArray(parsed.chunks))
                    return;
                if (typeof parsed.dim === 'number' && parsed.dim !== this.dim) {
                    // Dimension mismatch: ignore persisted index and rebuild.
                    return;
                }
                for (const chunk of parsed.chunks) {
                    if (!(chunk === null || chunk === void 0 ? void 0 : chunk.key) || !(chunk === null || chunk === void 0 ? void 0 : chunk.path) || !Array.isArray(chunk.vector))
                        continue;
                    this._setChunk(chunk);
                }
            }
            catch (_a) {
                // Corrupt index should not break the plugin. We'll rebuild lazily.
                this.chunksByKey.clear();
                this.chunkKeysByPath.clear();
            }
        });
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
    _runWorker() {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            yield this.ensureLoaded();
            while (this.queue.size > 0) {
                if (this.plugin.settings.retrievalIndexPaused)
                    break;
                const next = this.queue.values().next().value;
                this.queue.delete(next);
                // Exclusions can change at any time; honor them during processing.
                if (this.plugin.vaultService.isExcludedPath(next)) {
                    this._removePath(next);
                    this._schedulePersist();
                    this._scheduleSettingsSave();
                    continue;
                }
                const file = this.vault.getAbstractFileByPath(next);
                // Only index markdown files.
                if (!(file instanceof TFile) || file.extension !== 'md') {
                    this._removePath(next);
                    this._schedulePersist();
                    this._scheduleSettingsSave();
                    continue;
                }
                try {
                    const content = yield this.vault.read(file);
                    const fileHash = fnv1a32(content);
                    const prev = (_a = this.plugin.settings.retrievalIndexState) === null || _a === void 0 ? void 0 : _a[next];
                    if ((prev === null || prev === void 0 ? void 0 : prev.hash) === fileHash) {
                        continue;
                    }
                    this._reindexFile(next, content);
                    this.plugin.settings.retrievalIndexState = Object.assign(Object.assign({}, (this.plugin.settings.retrievalIndexState || {})), { [next]: {
                            hash: fileHash,
                            chunkCount: (_c = (_b = this.chunkKeysByPath.get(next)) === null || _b === void 0 ? void 0 : _b.size) !== null && _c !== void 0 ? _c : 0,
                            updatedAt: new Date().toISOString()
                        } });
                    this._schedulePersist();
                    this._scheduleSettingsSave();
                }
                catch (_d) {
                    // Skip unreadable files.
                }
                // Yield to keep UI responsive.
                yield new Promise((r) => setTimeout(r, 10));
            }
            this.workerRunning = false;
        });
    }
    _reindexFile(path, content) {
        var _a, _b;
        this._removePath(path);
        const chunkWordsCount = (_a = this.plugin.settings.retrievalChunkWords) !== null && _a !== void 0 ? _a : 500;
        const overlap = (_b = this.plugin.settings.retrievalChunkOverlapWords) !== null && _b !== void 0 ? _b : 100;
        const chunks = chunkWords(content, chunkWordsCount, overlap);
        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            const textHash = fnv1a32(ch.text);
            const key = `chunk:${path}:${i}`;
            const vector = buildVector(ch.text, this.dim);
            const excerpt = excerptOf(ch.text, 500);
            this._setChunk({
                key,
                path,
                chunkIndex: i,
                startWord: ch.start,
                endWord: ch.end,
                textHash,
                vector,
                excerpt
            });
        }
    }
    _setChunk(chunk) {
        var _a;
        this.chunksByKey.set(chunk.key, chunk);
        const set = (_a = this.chunkKeysByPath.get(chunk.path)) !== null && _a !== void 0 ? _a : new Set();
        set.add(chunk.key);
        this.chunkKeysByPath.set(chunk.path, set);
    }
    _removePath(path) {
        var _a;
        const keys = this.chunkKeysByPath.get(path);
        if (keys) {
            for (const k of keys)
                this.chunksByKey.delete(k);
        }
        this.chunkKeysByPath.delete(path);
        if ((_a = this.plugin.settings.retrievalIndexState) === null || _a === void 0 ? void 0 : _a[path]) {
            const next = Object.assign({}, (this.plugin.settings.retrievalIndexState || {}));
            delete next[path];
            this.plugin.settings.retrievalIndexState = next;
        }
    }
    getAllChunks() {
        return Array.from(this.chunksByKey.values());
    }
    buildQueryVector(queryText) {
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
    _persistNow() {
        return __awaiter(this, void 0, void 0, function* () {
            const dir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
            try {
                if (!(yield this.vault.adapter.exists(dir))) {
                    yield this.vault.adapter.mkdir(dir);
                }
            }
            catch (_a) {
                // ignore mkdir failures
            }
            const payload = {
                version: 1,
                dim: this.dim,
                chunks: this.getAllChunks()
            };
            yield this.vault.adapter.write(this.getIndexFilePath(), JSON.stringify(payload));
        });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFDQSxPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBRWpDLE9BQU8sRUFBRSxPQUFPLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQW1CekMsU0FBUyxRQUFRLENBQUMsS0FBYSxFQUFFLEdBQVcsRUFBRSxHQUFXO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3hDLE9BQU8sSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQztBQUVELFNBQVMsUUFBUSxDQUFDLEtBQWE7SUFDOUIsT0FBTyxLQUFLO1NBQ1YsV0FBVyxFQUFFO1NBQ2IsS0FBSyxDQUFDLGFBQWEsQ0FBQztTQUNwQixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNwQixNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQztBQUVELFNBQVMsV0FBVyxDQUFDLElBQVksRUFBRSxHQUFXO0lBQzdDLE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxDQUFTLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxNQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDOUIsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLEVBQUUsQ0FBQztRQUMxQixNQUFNLENBQUMsR0FBRyxRQUFRLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ3JDLE1BQU0sR0FBRyxHQUFHLENBQUMsR0FBRyxHQUFHLENBQUM7UUFDcEIsOENBQThDO1FBQzlDLE1BQU0sSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNwQyxHQUFHLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxDQUFDO0lBQ2xCLENBQUM7SUFDRCxlQUFlO0lBQ2YsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLEdBQUcsRUFBRSxDQUFDLEVBQUU7UUFBRSxLQUFLLElBQUksR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUN2RCxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuQyxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUMsRUFBRTtRQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxHQUFHLENBQUMsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDO0lBQ3JELE9BQU8sR0FBRyxDQUFDO0FBQ1osQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLElBQVksRUFBRSxlQUF1QixFQUFFLGlCQUF5QjtJQUNuRixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNqRCxNQUFNLE1BQU0sR0FBd0QsRUFBRSxDQUFDO0lBQ3ZFLE1BQU0sSUFBSSxHQUFHLFFBQVEsQ0FBQyxlQUFlLEVBQUUsR0FBRyxFQUFFLElBQUksQ0FBQyxDQUFDO0lBQ2xELE1BQU0sT0FBTyxHQUFHLFFBQVEsQ0FBQyxpQkFBaUIsRUFBRSxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDdEUsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxHQUFHLE9BQU8sQ0FBQyxDQUFDO0lBRXpDLEtBQUssSUFBSSxLQUFLLEdBQUcsQ0FBQyxFQUFFLEtBQUssR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUN6RCxNQUFNLEdBQUcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxHQUFHLElBQUksQ0FBQyxDQUFDO1FBQ2pELE1BQU0sS0FBSyxHQUFHLEtBQUssQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNoRCxNQUFNLENBQUMsSUFBSSxDQUFDLEVBQUUsS0FBSyxFQUFFLEdBQUcsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUN6QyxJQUFJLEdBQUcsSUFBSSxLQUFLLENBQUMsTUFBTTtZQUFFLE1BQU07SUFDaEMsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2YsQ0FBQztBQUVELFNBQVMsU0FBUyxDQUFDLElBQVksRUFBRSxRQUFnQjtJQUNoRCxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxHQUFHLENBQUMsQ0FBQztJQUNqRCxJQUFJLE9BQU8sQ0FBQyxNQUFNLElBQUksUUFBUTtRQUFFLE9BQU8sT0FBTyxDQUFDO0lBQy9DLE9BQU8sR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxRQUFRLENBQUMsR0FBRyxDQUFDO0FBQ3pDLENBQUM7QUFFRCxNQUFNLE9BQU8sZUFBZTtJQWMzQixZQUFZLEtBQVksRUFBRSxNQUE4QixFQUFFLE1BQWMsR0FBRztRQVRuRSxXQUFNLEdBQUcsS0FBSyxDQUFDO1FBQ2YsZ0JBQVcsR0FBRyxJQUFJLEdBQUcsRUFBd0IsQ0FBQztRQUM5QyxvQkFBZSxHQUFHLElBQUksR0FBRyxFQUF1QixDQUFDO1FBRXhDLFVBQUssR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO1FBQ25DLGtCQUFhLEdBQUcsS0FBSyxDQUFDO1FBQ3RCLGlCQUFZLEdBQWtCLElBQUksQ0FBQztRQUNuQyxzQkFBaUIsR0FBa0IsSUFBSSxDQUFDO1FBRy9DLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO1FBQ3JCLElBQUksQ0FBQyxHQUFHLEdBQUcsR0FBRyxDQUFDO0lBQ2hCLENBQUM7SUFFRCxnQkFBZ0I7UUFDZixPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLFlBQVksSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSx1QkFBdUIsQ0FBQztJQUMxRixDQUFDO0lBRUssWUFBWTs7WUFDakIsSUFBSSxJQUFJLENBQUMsTUFBTTtnQkFBRSxPQUFPO1lBQ3hCLElBQUksQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFDO1lBRW5CLElBQUksQ0FBQztnQkFDSixNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztnQkFDckMsSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQUUsT0FBTztnQkFDckQsTUFBTSxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ2hELE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFxQixDQUFDO2dCQUNuRCxJQUFJLENBQUEsTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLE9BQU8sTUFBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUM7b0JBQUUsT0FBTztnQkFDbkUsSUFBSSxPQUFPLE1BQU0sQ0FBQyxHQUFHLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxHQUFHLEtBQUssSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO29CQUMvRCwwREFBMEQ7b0JBQzFELE9BQU87Z0JBQ1IsQ0FBQztnQkFDRCxLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQztvQkFDbkMsSUFBSSxDQUFDLENBQUEsS0FBSyxhQUFMLEtBQUssdUJBQUwsS0FBSyxDQUFFLEdBQUcsQ0FBQSxJQUFJLENBQUMsQ0FBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsSUFBSSxDQUFBLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUM7d0JBQUUsU0FBUztvQkFDMUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztnQkFDdkIsQ0FBQztZQUNGLENBQUM7WUFBQyxXQUFNLENBQUM7Z0JBQ1IsbUVBQW1FO2dCQUNuRSxJQUFJLENBQUMsV0FBVyxDQUFDLEtBQUssRUFBRSxDQUFDO2dCQUN6QixJQUFJLENBQUMsZUFBZSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQzlCLENBQUM7UUFDRixDQUFDO0tBQUE7SUFFRCxTQUFTO1FBQ1IsT0FBTztZQUNOLFlBQVksRUFBRSxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUk7WUFDdkMsYUFBYSxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSTtZQUNwQyxNQUFNLEVBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG9CQUFvQixDQUFDO1lBQzFELE1BQU0sRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUk7U0FDdkIsQ0FBQztJQUNILENBQUM7SUFFRCxpQkFBaUI7UUFDaEIsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsd0JBQXdCLEVBQUUsQ0FBQztRQUNsRSxLQUFLLE1BQU0sQ0FBQyxJQUFJLEtBQUs7WUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDOUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3BCLENBQUM7SUFFRCxlQUFlLENBQUMsSUFBWTtRQUMzQixJQUFJLENBQUMsSUFBSTtZQUFFLE9BQU87UUFDbEIsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckIsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3BCLENBQUM7SUFFRCxlQUFlLENBQUMsSUFBWTtRQUMzQixJQUFJLENBQUMsSUFBSTtZQUFFLE9BQU87UUFDbEIsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN2QixJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztRQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztJQUM5QixDQUFDO0lBRU8sV0FBVztRQUNsQixJQUFJLElBQUksQ0FBQyxhQUFhO1lBQUUsT0FBTztRQUMvQixJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztRQUMxQixvREFBb0Q7UUFDcEQsS0FBSyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRTtZQUNqQyxJQUFJLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQztRQUM1QixDQUFDLENBQUMsQ0FBQztJQUNKLENBQUM7SUFFYSxVQUFVOzs7WUFDdkIsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFFMUIsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDNUIsSUFBSSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxvQkFBb0I7b0JBQUUsTUFBTTtnQkFDckQsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFlLENBQUM7Z0JBQ3hELElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUV4QixtRUFBbUU7Z0JBQ25FLElBQUksSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7b0JBQ25ELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ3ZCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO29CQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztvQkFDN0IsU0FBUztnQkFDVixDQUFDO2dCQUVELE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMscUJBQXFCLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQ3BELDZCQUE2QjtnQkFDN0IsSUFBSSxDQUFDLENBQUMsSUFBSSxZQUFZLEtBQUssQ0FBQyxJQUFJLElBQUksQ0FBQyxTQUFTLEtBQUssSUFBSSxFQUFFLENBQUM7b0JBQ3pELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ3ZCLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO29CQUN4QixJQUFJLENBQUMscUJBQXFCLEVBQUUsQ0FBQztvQkFDN0IsU0FBUztnQkFDVixDQUFDO2dCQUVELElBQUksQ0FBQztvQkFDSixNQUFNLE9BQU8sR0FBRyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO29CQUM1QyxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7b0JBQ2xDLE1BQU0sSUFBSSxHQUFHLE1BQUEsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLDBDQUFHLElBQUksQ0FBQyxDQUFDO29CQUM5RCxJQUFJLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLElBQUksTUFBSyxRQUFRLEVBQUUsQ0FBQzt3QkFDN0IsU0FBUztvQkFDVixDQUFDO29CQUVELElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDO29CQUNqQyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxtQkFBbUIsbUNBQ3BDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLElBQUksRUFBRSxDQUFDLEtBQ25ELENBQUMsSUFBSSxDQUFDLEVBQUU7NEJBQ1AsSUFBSSxFQUFFLFFBQVE7NEJBQ2QsVUFBVSxFQUFFLE1BQUEsTUFBQSxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsMENBQUUsSUFBSSxtQ0FBSSxDQUFDOzRCQUNyRCxTQUFTLEVBQUUsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7eUJBQ25DLEdBQ0QsQ0FBQztvQkFDRixJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztvQkFDeEIsSUFBSSxDQUFDLHFCQUFxQixFQUFFLENBQUM7Z0JBQzlCLENBQUM7Z0JBQUMsV0FBTSxDQUFDO29CQUNSLHlCQUF5QjtnQkFDMUIsQ0FBQztnQkFFRCwrQkFBK0I7Z0JBQy9CLE1BQU0sSUFBSSxPQUFPLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQztZQUM3QyxDQUFDO1lBRUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxLQUFLLENBQUM7UUFDNUIsQ0FBQztLQUFBO0lBRU8sWUFBWSxDQUFDLElBQVksRUFBRSxPQUFlOztRQUNqRCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBRXZCLE1BQU0sZUFBZSxHQUFHLE1BQUEsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLG1DQUFJLEdBQUcsQ0FBQztRQUN4RSxNQUFNLE9BQU8sR0FBRyxNQUFBLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixtQ0FBSSxHQUFHLENBQUM7UUFFdkUsTUFBTSxNQUFNLEdBQUcsVUFBVSxDQUFDLE9BQU8sRUFBRSxlQUFlLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFDN0QsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxNQUFNLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztZQUN4QyxNQUFNLEVBQUUsR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDckIsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNsQyxNQUFNLEdBQUcsR0FBRyxTQUFTLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUNqQyxNQUFNLE1BQU0sR0FBRyxXQUFXLENBQUMsRUFBRSxDQUFDLElBQUksRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDOUMsTUFBTSxPQUFPLEdBQUcsU0FBUyxDQUFDLEVBQUUsQ0FBQyxJQUFJLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDeEMsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDZCxHQUFHO2dCQUNILElBQUk7Z0JBQ0osVUFBVSxFQUFFLENBQUM7Z0JBQ2IsU0FBUyxFQUFFLEVBQUUsQ0FBQyxLQUFLO2dCQUNuQixPQUFPLEVBQUUsRUFBRSxDQUFDLEdBQUc7Z0JBQ2YsUUFBUTtnQkFDUixNQUFNO2dCQUNOLE9BQU87YUFDUCxDQUFDLENBQUM7UUFDSixDQUFDO0lBQ0YsQ0FBQztJQUVPLFNBQVMsQ0FBQyxLQUFtQjs7UUFDcEMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUN2QyxNQUFNLEdBQUcsR0FBRyxNQUFBLElBQUksQ0FBQyxlQUFlLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsbUNBQUksSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUN0RSxHQUFHLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQixJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFFTyxXQUFXLENBQUMsSUFBWTs7UUFDL0IsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDNUMsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUNWLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSTtnQkFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNsRCxDQUFDO1FBQ0QsSUFBSSxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7UUFFbEMsSUFBSSxNQUFBLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQiwwQ0FBRyxJQUFJLENBQUMsRUFBRSxDQUFDO1lBQ3RELE1BQU0sSUFBSSxxQkFBUSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEVBQUUsQ0FBQyxDQUFFLENBQUM7WUFDckUsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDbEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsbUJBQW1CLEdBQUcsSUFBSSxDQUFDO1FBQ2pELENBQUM7SUFDRixDQUFDO0lBRUQsWUFBWTtRQUNYLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUM7SUFDOUMsQ0FBQztJQUVELGdCQUFnQixDQUFDLFNBQWlCO1FBQ2pDLE9BQU8sV0FBVyxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDekMsQ0FBQztJQUVPLGdCQUFnQjtRQUN2QixJQUFJLElBQUksQ0FBQyxZQUFZO1lBQUUsTUFBTSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDOUQsSUFBSSxDQUFDLFlBQVksR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMxQyxJQUFJLENBQUMsWUFBWSxHQUFHLElBQUksQ0FBQztZQUN6QixLQUFLLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUNsQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0lBRWEsV0FBVzs7WUFDeEIsTUFBTSxHQUFHLEdBQUcsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLFNBQVMsWUFBWSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLFlBQVksQ0FBQztZQUNuRixJQUFJLENBQUM7Z0JBQ0osSUFBSSxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDO29CQUM3QyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztnQkFDckMsQ0FBQztZQUNGLENBQUM7WUFBQyxXQUFNLENBQUM7Z0JBQ1Isd0JBQXdCO1lBQ3pCLENBQUM7WUFFRCxNQUFNLE9BQU8sR0FBcUI7Z0JBQ2pDLE9BQU8sRUFBRSxDQUFDO2dCQUNWLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRztnQkFDYixNQUFNLEVBQUUsSUFBSSxDQUFDLFlBQVksRUFBRTthQUMzQixDQUFDO1lBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLGdCQUFnQixFQUFFLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDO1FBQ2xGLENBQUM7S0FBQTtJQUVPLHFCQUFxQjtRQUM1QixJQUFJLElBQUksQ0FBQyxpQkFBaUI7WUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3hFLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMvQyxJQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1lBQzlCLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUMxQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcbmltcG9ydCB7IGZudjFhMzIgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XHJcblx0a2V5OiBzdHJpbmc7XHJcblx0cGF0aDogc3RyaW5nO1xyXG5cdGNodW5rSW5kZXg6IG51bWJlcjtcclxuXHRzdGFydFdvcmQ6IG51bWJlcjtcclxuXHRlbmRXb3JkOiBudW1iZXI7XHJcblx0dGV4dEhhc2g6IHN0cmluZztcclxuXHR2ZWN0b3I6IG51bWJlcltdO1xyXG5cdGV4Y2VycHQ6IHN0cmluZztcclxufVxyXG5cclxuaW50ZXJmYWNlIFBlcnNpc3RlZEluZGV4VjEge1xyXG5cdHZlcnNpb246IDE7XHJcblx0ZGltOiBudW1iZXI7XHJcblx0Y2h1bmtzOiBJbmRleGVkQ2h1bmtbXTtcclxufVxyXG5cclxuZnVuY3Rpb24gY2xhbXBJbnQodmFsdWU6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcclxuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XHJcblx0cmV0dXJuIE1hdGgubWF4KG1pbiwgTWF0aC5taW4obWF4LCBNYXRoLmZsb29yKHZhbHVlKSkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB0b2tlbml6ZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nW10ge1xyXG5cdHJldHVybiB2YWx1ZVxyXG5cdFx0LnRvTG93ZXJDYXNlKClcclxuXHRcdC5zcGxpdCgvW15hLXowLTldKy9nKVxyXG5cdFx0Lm1hcCgodCkgPT4gdC50cmltKCkpXHJcblx0XHQuZmlsdGVyKCh0KSA9PiB0Lmxlbmd0aCA+PSAyKTtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGRWZWN0b3IodGV4dDogc3RyaW5nLCBkaW06IG51bWJlcik6IG51bWJlcltdIHtcclxuXHRjb25zdCB2ZWMgPSBuZXcgQXJyYXk8bnVtYmVyPihkaW0pLmZpbGwoMCk7XHJcblx0Y29uc3QgdG9rZW5zID0gdG9rZW5pemUodGV4dCk7XHJcblx0Zm9yIChjb25zdCB0b2sgb2YgdG9rZW5zKSB7XHJcblx0XHRjb25zdCBoID0gcGFyc2VJbnQoZm52MWEzMih0b2spLCAxNik7XHJcblx0XHRjb25zdCBpZHggPSBoICUgZGltO1xyXG5cdFx0Ly8gU2lnbmVkIGhhc2hpbmcgaGVscHMgcmVkdWNlIGNvbGxpc2lvbnMgYmlhc1xyXG5cdFx0Y29uc3Qgc2lnbiA9IChoICYgMSkgPT09IDAgPyAxIDogLTE7XHJcblx0XHR2ZWNbaWR4XSArPSBzaWduO1xyXG5cdH1cclxuXHQvLyBMMiBub3JtYWxpemVcclxuXHRsZXQgc3VtU3EgPSAwO1xyXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgZGltOyBpKyspIHN1bVNxICs9IHZlY1tpXSAqIHZlY1tpXTtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgZGltOyBpKyspIHZlY1tpXSA9IHZlY1tpXSAvIG5vcm07XHJcblx0cmV0dXJuIHZlYztcclxufVxyXG5cclxuZnVuY3Rpb24gY2h1bmtXb3Jkcyh0ZXh0OiBzdHJpbmcsIGNodW5rV29yZHNDb3VudDogbnVtYmVyLCBvdmVybGFwV29yZHNDb3VudDogbnVtYmVyKTogQXJyYXk8eyBzdGFydDogbnVtYmVyOyBlbmQ6IG51bWJlcjsgdGV4dDogc3RyaW5nIH0+IHtcclxuXHRjb25zdCB3b3JkcyA9IHRleHQuc3BsaXQoL1xccysvZykuZmlsdGVyKEJvb2xlYW4pO1xyXG5cdGNvbnN0IGNodW5rczogQXJyYXk8eyBzdGFydDogbnVtYmVyOyBlbmQ6IG51bWJlcjsgdGV4dDogc3RyaW5nIH0+ID0gW107XHJcblx0Y29uc3Qgc2l6ZSA9IGNsYW1wSW50KGNodW5rV29yZHNDb3VudCwgMjAwLCAyMDAwKTtcclxuXHRjb25zdCBvdmVybGFwID0gY2xhbXBJbnQob3ZlcmxhcFdvcmRzQ291bnQsIDAsIE1hdGgubWF4KDAsIHNpemUgLSAxKSk7XHJcblx0Y29uc3Qgc3RlcCA9IE1hdGgubWF4KDEsIHNpemUgLSBvdmVybGFwKTtcclxuXHJcblx0Zm9yIChsZXQgc3RhcnQgPSAwOyBzdGFydCA8IHdvcmRzLmxlbmd0aDsgc3RhcnQgKz0gc3RlcCkge1xyXG5cdFx0Y29uc3QgZW5kID0gTWF0aC5taW4od29yZHMubGVuZ3RoLCBzdGFydCArIHNpemUpO1xyXG5cdFx0Y29uc3Qgc2xpY2UgPSB3b3Jkcy5zbGljZShzdGFydCwgZW5kKS5qb2luKCcgJyk7XHJcblx0XHRjaHVua3MucHVzaCh7IHN0YXJ0LCBlbmQsIHRleHQ6IHNsaWNlIH0pO1xyXG5cdFx0aWYgKGVuZCA+PSB3b3Jkcy5sZW5ndGgpIGJyZWFrO1xyXG5cdH1cclxuXHRyZXR1cm4gY2h1bmtzO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcclxuXHRjb25zdCB0cmltbWVkID0gdGV4dC50cmltKCkucmVwbGFjZSgvXFxzKy9nLCAnICcpO1xyXG5cdGlmICh0cmltbWVkLmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRyaW1tZWQ7XHJcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblxyXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XHJcblx0cHJpdmF0ZSBjaHVua3NCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBJbmRleGVkQ2h1bms+KCk7XHJcblx0cHJpdmF0ZSBjaHVua0tleXNCeVBhdGggPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgcXVldWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcclxuXHRwcml2YXRlIHdvcmtlclJ1bm5pbmcgPSBmYWxzZTtcclxuXHRwcml2YXRlIHBlcnNpc3RUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luLCBkaW06IG51bWJlciA9IDI1Nikge1xyXG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0XHR0aGlzLmRpbSA9IGRpbTtcclxuXHR9XHJcblxyXG5cdGdldEluZGV4RmlsZVBhdGgoKTogc3RyaW5nIHtcclxuXHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvaW5kZXguanNvbmA7XHJcblx0fVxyXG5cclxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5sb2FkZWQpIHJldHVybjtcclxuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcclxuXHJcblx0XHR0cnkge1xyXG5cdFx0XHRjb25zdCBwYXRoID0gdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XHJcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XHJcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xyXG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcclxuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xyXG5cdFx0XHRpZiAodHlwZW9mIHBhcnNlZC5kaW0gPT09ICdudW1iZXInICYmIHBhcnNlZC5kaW0gIT09IHRoaXMuZGltKSB7XHJcblx0XHRcdFx0Ly8gRGltZW5zaW9uIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxyXG5cdFx0XHRcdHJldHVybjtcclxuXHRcdFx0fVxyXG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcclxuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xyXG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cclxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xyXG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcclxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxyXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxyXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG5cdGVucXVldWVGdWxsUmVzY2FuKCk6IHZvaWQge1xyXG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XHJcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XHJcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XHJcblx0fVxyXG5cclxuXHRxdWV1ZVVwZGF0ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XHJcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcclxuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xyXG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xyXG5cdH1cclxuXHJcblx0cXVldWVSZW1vdmVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xyXG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XHJcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xyXG5cdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcclxuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcclxuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IHRydWU7XHJcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXHJcblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblxyXG5cdFx0d2hpbGUgKHRoaXMucXVldWUuc2l6ZSA+IDApIHtcclxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcclxuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcclxuXHRcdFx0dGhpcy5xdWV1ZS5kZWxldGUobmV4dCk7XHJcblxyXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXHJcblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcclxuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcclxuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cclxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCBmaWxlLmV4dGVuc2lvbiAhPT0gJ21kJykge1xyXG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XHJcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcclxuXHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xyXG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gZm52MWEzMihjb250ZW50KTtcclxuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xyXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCkge1xyXG5cdFx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHR0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcclxuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xyXG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxyXG5cdFx0XHRcdFx0W25leHRdOiB7XHJcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxyXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcclxuXHRcdFx0XHRcdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xyXG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XHJcblx0XHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRcdC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlcy5cclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0Ly8gWWllbGQgdG8ga2VlcCBVSSByZXNwb25zaXZlLlxyXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xyXG5cdFx0fVxyXG5cclxuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfcmVpbmRleEZpbGUocGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XHJcblxyXG5cdFx0Y29uc3QgY2h1bmtXb3Jkc0NvdW50ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtXb3JkcyA/PyA1MDA7XHJcblx0XHRjb25zdCBvdmVybGFwID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtPdmVybGFwV29yZHMgPz8gMTAwO1xyXG5cclxuXHRcdGNvbnN0IGNodW5rcyA9IGNodW5rV29yZHMoY29udGVudCwgY2h1bmtXb3Jkc0NvdW50LCBvdmVybGFwKTtcclxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRcdGNvbnN0IGNoID0gY2h1bmtzW2ldO1xyXG5cdFx0XHRjb25zdCB0ZXh0SGFzaCA9IGZudjFhMzIoY2gudGV4dCk7XHJcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xyXG5cdFx0XHRjb25zdCB2ZWN0b3IgPSBidWlsZFZlY3RvcihjaC50ZXh0LCB0aGlzLmRpbSk7XHJcblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgNTAwKTtcclxuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xyXG5cdFx0XHRcdGtleSxcclxuXHRcdFx0XHRwYXRoLFxyXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXHJcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydCxcclxuXHRcdFx0XHRlbmRXb3JkOiBjaC5lbmQsXHJcblx0XHRcdFx0dGV4dEhhc2gsXHJcblx0XHRcdFx0dmVjdG9yLFxyXG5cdFx0XHRcdGV4Y2VycHRcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XHJcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcclxuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcclxuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcclxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcclxuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XHJcblx0XHRpZiAoa2V5cykge1xyXG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XHJcblx0XHR9XHJcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XHJcblxyXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xyXG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcclxuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XHJcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcclxuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xyXG5cdH1cclxuXHJcblx0YnVpbGRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IG51bWJlcltdIHtcclxuXHRcdHJldHVybiBidWlsZFZlY3RvcihxdWVyeVRleHQsIHRoaXMuZGltKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgX3NjaGVkdWxlUGVyc2lzdCgpOiB2b2lkIHtcclxuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XHJcblx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcclxuXHRcdFx0dGhpcy5wZXJzaXN0VGltZXIgPSBudWxsO1xyXG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdFx0Ly8gaWdub3JlXHJcblx0XHRcdH0pO1xyXG5cdFx0fSwgMTAwMCk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0Y29uc3QgZGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcclxuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoZGlyKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdC8vIGlnbm9yZSBta2RpciBmYWlsdXJlc1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IHBheWxvYWQ6IFBlcnNpc3RlZEluZGV4VjEgPSB7XHJcblx0XHRcdHZlcnNpb246IDEsXHJcblx0XHRcdGRpbTogdGhpcy5kaW0sXHJcblx0XHRcdGNodW5rczogdGhpcy5nZXRBbGxDaHVua3MoKVxyXG5cdFx0fTtcclxuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZSh0aGlzLmdldEluZGV4RmlsZVBhdGgoKSwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBfc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTogdm9pZCB7XHJcblx0XHRpZiAodGhpcy5zZXR0aW5nc1NhdmVUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKTtcclxuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XHJcblx0XHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSBudWxsO1xyXG5cdFx0XHR2b2lkIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0XHQvLyBpZ25vcmVcclxuXHRcdFx0fSk7XHJcblx0XHR9LCAxMDAwKTtcclxuXHR9XHJcbn1cclxuXHJcblxyXG4iXX0=