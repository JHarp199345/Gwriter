import { fnv1a32 } from '../ContentHash';
function clamp01(x) {
    if (!Number.isFinite(x))
        return 0;
    return Math.max(0, Math.min(1, x));
}
function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}
/**
 * CPU reranker using @xenova/transformers (WASM). Loaded lazily.
 * If the model fails to load/run, callers should fall back to the pre-rerank order.
 */
class TransformersCrossEncoder {
    constructor() {
        this.id = 'cross-encoder-msmarco-minilm';
        this.pipeline = null;
        this.loading = null;
    }
    async ensureLoaded() {
        if (this.pipeline)
            return;
        if (this.loading !== null)
            return this.loading;
        this.loading = (async () => {
            // Import the vendored transformers library
            const transformersModule = await import('../../lib/transformers.js');
            // Try multiple ways to access the environment
            let env = null;
            // Method 1: Direct env (standard)
            if (transformersModule.env && transformersModule.env.backends && transformersModule.env.backends.onnx) {
                env = transformersModule.env;
            }
            // Method 2: default.env (if default export)
            else if (transformersModule.default && transformersModule.default.env && transformersModule.default.env.backends && transformersModule.default.env.backends.onnx) {
                env = transformersModule.default.env;
            }
            // Method 3: Create structure if it doesn't exist
            else if (transformersModule && typeof transformersModule === 'object') {
                if (!transformersModule.env) {
                    transformersModule.env = {};
                }
                if (!transformersModule.env.backends) {
                    transformersModule.env.backends = {};
                }
                if (!transformersModule.env.backends.onnx) {
                    transformersModule.env.backends.onnx = {};
                }
                env = transformersModule.env;
            }
            // Configure WASM paths if we found/created the environment
            if (env && env.backends && env.backends.onnx) {
                const onnxEnv = env.backends.onnx;
                if (!onnxEnv.wasm)
                    onnxEnv.wasm = {};
                const wasmFiles = [
                    'ort-wasm.wasm',
                    'ort-wasm-simd.wasm',
                    'ort-wasm-threaded.wasm',
                    'ort-wasm-simd-threaded.wasm'
                ];
                const wasmPaths = {};
                for (const wasmFile of wasmFiles) {
                    wasmPaths[wasmFile] = `./lib/${wasmFile}`;
                }
                onnxEnv.wasm.wasmPaths = wasmPaths;
                console.log(`[CpuReranker] Configured WASM paths:`, wasmPaths);
            }
            else {
                console.error(`[CpuReranker] Could not configure WASM paths - env structure not found`);
            }
            // @xenova/transformers exports pipeline as a named export
            // It might be on the default export or as a named export
            const pipeline = transformersModule.pipeline || transformersModule.default?.pipeline;
            if (!pipeline || typeof pipeline !== 'function') {
                throw new Error('Transformers pipeline is unavailable');
            }
            // Cross-encoder reranker model (small-ish). Best-effort: may fail on some environments.
            const pipeUnknown = await pipeline('text-classification', 'Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2', { quantized: true });
            const pipe = pipeUnknown;
            this.pipeline = async (input) => await pipe(input);
        })().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }
    async rerankPair(query, document) {
        const q = normalizeText(query);
        const d = normalizeText(document);
        if (!q || !d)
            return { score: 0 };
        await this.ensureLoaded();
        if (!this.pipeline)
            throw new Error('Reranker pipeline unavailable');
        // Prefer pair input if supported by the pipeline implementation; fall back to concatenation.
        let out;
        try {
            out = await this.pipeline([{ text: q, text_pair: d }]);
        }
        catch {
            out = await this.pipeline(`${q}\n\n${d}`);
        }
        // Common output formats:
        // - [{ label: 'LABEL_1', score: 0.93 }, ...]
        // - { label, score }
        const first = Array.isArray(out) ? out[0] : out;
        const obj = first;
        const score = typeof obj?.score === 'number' ? obj.score : 0;
        return { score: clamp01(score) };
    }
}
export class CpuReranker {
    constructor(model) {
        // queryHash -> itemKey -> score
        this.cache = new Map();
        this.model = model ?? new TransformersCrossEncoder();
    }
    hashQuery(q) {
        return fnv1a32(normalizeText(q));
    }
    warm(query, items, opts) {
        const shortlist = Math.max(1, Math.min(120, Math.floor(opts?.shortlist ?? 40)));
        const qh = this.hashQuery(query);
        const map = this.cache.get(qh) ?? new Map();
        this.cache.set(qh, map);
        const toScore = items.slice(0, shortlist).filter((it) => !map.has(it.key));
        if (toScore.length === 0)
            return;
        // Fire-and-forget warmup; never block UI.
        void (async () => {
            for (const it of toScore) {
                try {
                    const doc = `${it.path}\n${it.excerpt}`;
                    const res = await this.model.rerankPair(query, doc);
                    map.set(it.key, res.score);
                }
                catch {
                    // stop warming if model fails
                    break;
                }
            }
        })().catch(() => {
            // ignore
        });
    }
    async rerank(query, items, opts) {
        const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
        const shortlist = Math.max(limit, Math.min(120, Math.floor(opts.shortlist ?? 60)));
        const qh = this.hashQuery(query);
        const map = this.cache.get(qh) ?? new Map();
        this.cache.set(qh, map);
        const scored = [];
        const slice = items.slice(0, shortlist);
        for (const it of slice) {
            const cached = map.get(it.key);
            if (typeof cached === 'number') {
                scored.push({ item: it, score: cached });
                continue;
            }
            const doc = `${it.path}\n${it.excerpt}`;
            const res = await this.model.rerankPair(query, doc);
            map.set(it.key, res.score);
            scored.push({ item: it, score: res.score });
        }
        // Merge rerank score into final ordering; keep original score as secondary signal.
        const out = scored
            .sort((a, b) => b.score - a.score || b.item.score - a.item.score)
            .slice(0, limit)
            .map((s) => ({
            ...s.item,
            // Keep the score field as the rerank score so formatting reflects true order.
            score: s.score,
            source: 'rerank',
            reasonTags: Array.from(new Set([...(s.item.reasonTags ?? []), 'rerank']))
        }));
        return out;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQXVHOUMsQ0FBQztJQXJHUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsMkNBQTJDO1lBQzNDLE1BQU0sa0JBQWtCLEdBQVEsTUFBTSxNQUFNLENBQUMsMkJBQTJCLENBQUMsQ0FBQztZQUUxRSw4Q0FBOEM7WUFDOUMsSUFBSSxHQUFHLEdBQVEsSUFBSSxDQUFDO1lBRXBCLGtDQUFrQztZQUNsQyxJQUFJ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SyxDQUFDLENBQUM7WUFDM0IsTUFBTSxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUcsQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBQzdDLENBQUM7UUFFRCxtRkFBbUY7UUFDbkYsTUFBTSxHQUFHLEdBQUcsTUFBTTthQUNoQixJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxLQUFLLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUM7YUFDaEUsS0FBSyxDQUFDLENBQUMsRUFBRSxLQUFLLENBQUM7YUFDZixHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDWixHQUFHLENBQUMsQ0FBQyxJQUFJO1lBQ1QsOEVBQThFO1lBQzlFLEtBQUssRUFBRSxDQUFDLENBQUMsS0FBSztZQUNkLE1BQU0sRUFBRSxRQUFRO1lBQ2hCLFVBQVUsRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUM7U0FDekUsQ0FBQyxDQUFDLENBQUM7UUFFTCxPQUFPLEdBQUcsQ0FBQztJQUNaLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQ29udGV4dEl0ZW0gfSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHR5cGUgeyBDcHVSZXJhbmtlck1vZGVsIH0gZnJvbSAnLi9SZXJhbmtlck1vZGVsJztcclxuaW1wb3J0IHsgZm52MWEzMiB9IGZyb20gJy4uL0NvbnRlbnRIYXNoJztcclxuXHJcbmZ1bmN0aW9uIGNsYW1wMDEoeDogbnVtYmVyKTogbnVtYmVyIHtcclxuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh4KSkgcmV0dXJuIDA7XHJcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHgpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplVGV4dChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiAocyB8fCAnJykucmVwbGFjZSgvXFxzKy9nLCAnICcpLnRyaW0oKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENQVSByZXJhbmtlciB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIElmIHRoZSBtb2RlbCBmYWlscyB0byBsb2FkL3J1biwgY2FsbGVycyBzaG91bGQgZmFsbCBiYWNrIHRvIHRoZSBwcmUtcmVyYW5rIG9yZGVyLlxyXG4gKi9cclxuY2xhc3MgVHJhbnNmb3JtZXJzQ3Jvc3NFbmNvZGVyIGltcGxlbWVudHMgQ3B1UmVyYW5rZXJNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnY3Jvc3MtZW5jb2Rlci1tc21hcmNvLW1pbmlsbSc7XHJcblxyXG5cdHByaXZhdGUgcGlwZWxpbmU6XHJcblx0XHR8IG51bGxcclxuXHRcdHwgKChpbnB1dDogc3RyaW5nIHwgQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IHRleHRfcGFpcjogc3RyaW5nIH0+KSA9PiBQcm9taXNlPHVua25vd24+KSA9IG51bGw7XHJcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHJldHVybjtcclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblxyXG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcclxuXHRcdFx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeVxyXG5cdFx0XHRjb25zdCB0cmFuc2Zvcm1lcnNNb2R1bGU6IGFueSA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudFxyXG5cdFx0XHRsZXQgZW52OiBhbnkgPSBudWxsO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gTWV0aG9kIDE6IERpcmVjdCBlbnYgKHN0YW5kYXJkKVxyXG5cdFx0XHRpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmVudiAmJiB0cmFuc2Zvcm1lcnNNb2R1bGUuZW52LmJhY2tlbmRzICYmIHRyYW5zZm9ybWVyc01vZHVsZS5lbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0XHRcdGVudiA9IHRyYW5zZm9ybWVyc01vZHVsZS5lbnY7XHJcblx0XHRcdH1cclxuXHRcdFx0Ly8gTWV0aG9kIDI6IGRlZmF1bHQuZW52IChpZiBkZWZhdWx0IGV4cG9ydClcclxuXHRcdFx0ZWxzZSBpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQgJiYgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52ICYmIHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudi5iYWNrZW5kcyAmJiB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0XHRcdGVudiA9IHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudjtcclxuXHRcdFx0fVxyXG5cdFx0XHQvLyBNZXRob2QgMzogQ3JlYXRlIHN0cnVjdHVyZSBpZiBpdCBkb2Vzbid0IGV4aXN0XHJcblx0XHRcdGVsc2UgaWYgKHRyYW5zZm9ybWVyc01vZHVsZSAmJiB0eXBlb2YgdHJhbnNmb3JtZXJzTW9kdWxlID09PSAnb2JqZWN0Jykge1xyXG5cdFx0XHRcdGlmICghdHJhbnNmb3JtZXJzTW9kdWxlLmVudikge1xyXG5cdFx0XHRcdFx0dHJhbnNmb3JtZXJzTW9kdWxlLmVudiA9IHt9O1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRpZiAoIXRyYW5zZm9ybWVyc01vZHVsZS5lbnYuYmFja2VuZHMpIHtcclxuXHRcdFx0XHRcdHRyYW5zZm9ybWVyc01vZHVsZS5lbnYuYmFja2VuZHMgPSB7fTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0aWYgKCF0cmFuc2Zvcm1lcnNNb2R1bGUuZW52LmJhY2tlbmRzLm9ubngpIHtcclxuXHRcdFx0XHRcdHRyYW5zZm9ybWVyc01vZHVsZS5lbnYuYmFja2VuZHMub25ueCA9IHt9O1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRlbnYgPSB0cmFuc2Zvcm1lcnNNb2R1bGUuZW52O1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyBpZiB3ZSBmb3VuZC9jcmVhdGVkIHRoZSBlbnZpcm9ubWVudFxyXG5cdFx0XHRpZiAoZW52ICYmIGVudi5iYWNrZW5kcyAmJiBlbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0XHRcdGNvbnN0IG9ubnhFbnYgPSBlbnYuYmFja2VuZHMub25ueDtcclxuXHRcdFx0XHRpZiAoIW9ubnhFbnYud2FzbSkgb25ueEVudi53YXNtID0ge307XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Y29uc3Qgd2FzbUZpbGVzID0gW1xyXG5cdFx0XHRcdFx0J29ydC13YXNtLndhc20nLFxyXG5cdFx0XHRcdFx0J29ydC13YXNtLXNpbWQud2FzbScsXHJcblx0XHRcdFx0XHQnb3J0LXdhc20tdGhyZWFkZWQud2FzbScsXHJcblx0XHRcdFx0XHQnb3J0LXdhc20tc2ltZC10aHJlYWRlZC53YXNtJ1xyXG5cdFx0XHRcdF07XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Y29uc3Qgd2FzbVBhdGhzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XHJcblx0XHRcdFx0Zm9yIChjb25zdCB3YXNtRmlsZSBvZiB3YXNtRmlsZXMpIHtcclxuXHRcdFx0XHRcdHdhc21QYXRoc1t3YXNtRmlsZV0gPSBgLi9saWIvJHt3YXNtRmlsZX1gO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRvbm54RW52Lndhc20ud2FzbVBhdGhzID0gd2FzbVBhdGhzO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIENvbmZpZ3VyZWQgV0FTTSBwYXRoczpgLCB3YXNtUGF0aHMpO1xyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gQ291bGQgbm90IGNvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gZW52IHN0cnVjdHVyZSBub3QgZm91bmRgKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQHhlbm92YS90cmFuc2Zvcm1lcnMgZXhwb3J0cyBwaXBlbGluZSBhcyBhIG5hbWVkIGV4cG9ydFxyXG5cdFx0XHQvLyBJdCBtaWdodCBiZSBvbiB0aGUgZGVmYXVsdCBleHBvcnQgb3IgYXMgYSBuYW1lZCBleHBvcnRcclxuXHRcdFx0Y29uc3QgcGlwZWxpbmUgPSB0cmFuc2Zvcm1lcnNNb2R1bGUucGlwZWxpbmUgfHwgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LnBpcGVsaW5lO1xyXG5cdFx0XHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignVHJhbnNmb3JtZXJzIHBpcGVsaW5lIGlzIHVuYXZhaWxhYmxlJyk7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdC8vIENyb3NzLWVuY29kZXIgcmVyYW5rZXIgbW9kZWwgKHNtYWxsLWlzaCkuIEJlc3QtZWZmb3J0OiBtYXkgZmFpbCBvbiBzb21lIGVudmlyb25tZW50cy5cclxuXHRcdFx0Y29uc3QgcGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZShcclxuXHRcdFx0XHQndGV4dC1jbGFzc2lmaWNhdGlvbicsXHJcblx0XHRcdFx0J1hlbm92YS9jcm9zcy1lbmNvZGVyLW1zLW1hcmNvLU1pbmlMTS1MLTYtdjInLFxyXG5cdFx0XHRcdHsgcXVhbnRpemVkOiB0cnVlIH1cclxuXHRcdFx0KTtcclxuXHRcdFx0Y29uc3QgcGlwZSA9IHBpcGVVbmtub3duIGFzIChpbnB1dDogdW5rbm93bikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jIChpbnB1dCkgPT4gYXdhaXQgcGlwZShpbnB1dCk7XHJcblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xyXG5cdFx0fSk7XHJcblxyXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHR9XHJcblxyXG5cdGFzeW5jIHJlcmFua1BhaXIocXVlcnk6IHN0cmluZywgZG9jdW1lbnQ6IHN0cmluZyk6IFByb21pc2U8eyBzY29yZTogbnVtYmVyIH0+IHtcclxuXHRcdGNvbnN0IHEgPSBub3JtYWxpemVUZXh0KHF1ZXJ5KTtcclxuXHRcdGNvbnN0IGQgPSBub3JtYWxpemVUZXh0KGRvY3VtZW50KTtcclxuXHRcdGlmICghcSB8fCAhZCkgcmV0dXJuIHsgc2NvcmU6IDAgfTtcclxuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHRocm93IG5ldyBFcnJvcignUmVyYW5rZXIgcGlwZWxpbmUgdW5hdmFpbGFibGUnKTtcclxuXHJcblx0XHQvLyBQcmVmZXIgcGFpciBpbnB1dCBpZiBzdXBwb3J0ZWQgYnkgdGhlIHBpcGVsaW5lIGltcGxlbWVudGF0aW9uOyBmYWxsIGJhY2sgdG8gY29uY2F0ZW5hdGlvbi5cclxuXHRcdGxldCBvdXQ6IHVua25vd247XHJcblx0XHR0cnkge1xyXG5cdFx0XHRvdXQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKFt7IHRleHQ6IHEsIHRleHRfcGFpcjogZCB9XSk7XHJcblx0XHR9IGNhdGNoIHtcclxuXHRcdFx0b3V0ID0gYXdhaXQgdGhpcy5waXBlbGluZShgJHtxfVxcblxcbiR7ZH1gKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBDb21tb24gb3V0cHV0IGZvcm1hdHM6XHJcblx0XHQvLyAtIFt7IGxhYmVsOiAnTEFCRUxfMScsIHNjb3JlOiAwLjkzIH0sIC4uLl1cclxuXHRcdC8vIC0geyBsYWJlbCwgc2NvcmUgfVxyXG5cdFx0Y29uc3QgZmlyc3QgPSBBcnJheS5pc0FycmF5KG91dCkgPyBvdXRbMF0gOiBvdXQ7XHJcblx0XHRjb25zdCBvYmogPSBmaXJzdCBhcyB7IHNjb3JlPzogdW5rbm93bjsgbGFiZWw/OiB1bmtub3duIH07XHJcblx0XHRjb25zdCBzY29yZSA9IHR5cGVvZiBvYmo/LnNjb3JlID09PSAnbnVtYmVyJyA/IG9iai5zY29yZSA6IDA7XHJcblx0XHRyZXR1cm4geyBzY29yZTogY2xhbXAwMShzY29yZSkgfTtcclxuXHR9XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQ3B1UmVyYW5rT3B0aW9ucyB7XHJcblx0bGltaXQ6IG51bWJlcjsgLy8gaG93IG1hbnkgaXRlbXMgdG8gcmV0dXJuXHJcblx0c2hvcnRsaXN0PzogbnVtYmVyOyAvLyBob3cgbWFueSB0byBzY29yZVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgQ3B1UmVyYW5rZXIge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbW9kZWw6IENwdVJlcmFua2VyTW9kZWw7XHJcblx0Ly8gcXVlcnlIYXNoIC0+IGl0ZW1LZXkgLT4gc2NvcmVcclxuXHRwcml2YXRlIHJlYWRvbmx5IGNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIG51bWJlcj4+KCk7XHJcblxyXG5cdGNvbnN0cnVjdG9yKG1vZGVsPzogQ3B1UmVyYW5rZXJNb2RlbCkge1xyXG5cdFx0dGhpcy5tb2RlbCA9IG1vZGVsID8/IG5ldyBUcmFuc2Zvcm1lcnNDcm9zc0VuY29kZXIoKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgaGFzaFF1ZXJ5KHE6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0XHRyZXR1cm4gZm52MWEzMihub3JtYWxpemVUZXh0KHEpKTtcclxuXHR9XHJcblxyXG5cdHdhcm0ocXVlcnk6IHN0cmluZywgaXRlbXM6IENvbnRleHRJdGVtW10sIG9wdHM/OiB7IHNob3J0bGlzdD86IG51bWJlciB9KTogdm9pZCB7XHJcblx0XHRjb25zdCBzaG9ydGxpc3QgPSBNYXRoLm1heCgxLCBNYXRoLm1pbigxMjAsIE1hdGguZmxvb3Iob3B0cz8uc2hvcnRsaXN0ID8/IDQwKSkpO1xyXG5cdFx0Y29uc3QgcWggPSB0aGlzLmhhc2hRdWVyeShxdWVyeSk7XHJcblx0XHRjb25zdCBtYXAgPSB0aGlzLmNhY2hlLmdldChxaCkgPz8gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuXHRcdHRoaXMuY2FjaGUuc2V0KHFoLCBtYXApO1xyXG5cclxuXHRcdGNvbnN0IHRvU2NvcmUgPSBpdGVtcy5zbGljZSgwLCBzaG9ydGxpc3QpLmZpbHRlcigoaXQpID0+ICFtYXAuaGFzKGl0LmtleSkpO1xyXG5cdFx0aWYgKHRvU2NvcmUubGVuZ3RoID09PSAwKSByZXR1cm47XHJcblxyXG5cdFx0Ly8gRmlyZS1hbmQtZm9yZ2V0IHdhcm11cDsgbmV2ZXIgYmxvY2sgVUkuXHJcblx0XHR2b2lkIChhc3luYyAoKSA9PiB7XHJcblx0XHRcdGZvciAoY29uc3QgaXQgb2YgdG9TY29yZSkge1xyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRjb25zdCBkb2MgPSBgJHtpdC5wYXRofVxcbiR7aXQuZXhjZXJwdH1gO1xyXG5cdFx0XHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xyXG5cdFx0XHRcdFx0bWFwLnNldChpdC5rZXksIHJlcy5zY29yZSk7XHJcblx0XHRcdFx0fSBjYXRjaCB7XHJcblx0XHRcdFx0XHQvLyBzdG9wIHdhcm1pbmcgaWYgbW9kZWwgZmFpbHNcclxuXHRcdFx0XHRcdGJyZWFrO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdC8vIGlnbm9yZVxyXG5cdFx0fSk7XHJcblx0fVxyXG5cclxuXHRhc3luYyByZXJhbmsocXVlcnk6IHN0cmluZywgaXRlbXM6IENvbnRleHRJdGVtW10sIG9wdHM6IENwdVJlcmFua09wdGlvbnMpOiBQcm9taXNlPENvbnRleHRJdGVtW10+IHtcclxuXHRcdGNvbnN0IGxpbWl0ID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oMjAwLCBNYXRoLmZsb29yKG9wdHMubGltaXQpKSk7XHJcblx0XHRjb25zdCBzaG9ydGxpc3QgPSBNYXRoLm1heChsaW1pdCwgTWF0aC5taW4oMTIwLCBNYXRoLmZsb29yKG9wdHMuc2hvcnRsaXN0ID8/IDYwKSkpO1xyXG5cdFx0Y29uc3QgcWggPSB0aGlzLmhhc2hRdWVyeShxdWVyeSk7XHJcblx0XHRjb25zdCBtYXAgPSB0aGlzLmNhY2hlLmdldChxaCkgPz8gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuXHRcdHRoaXMuY2FjaGUuc2V0KHFoLCBtYXApO1xyXG5cclxuXHRcdGNvbnN0IHNjb3JlZDogQXJyYXk8eyBpdGVtOiBDb250ZXh0SXRlbTsgc2NvcmU6IG51bWJlciB9PiA9IFtdO1xyXG5cdFx0Y29uc3Qgc2xpY2UgPSBpdGVtcy5zbGljZSgwLCBzaG9ydGxpc3QpO1xyXG5cdFx0Zm9yIChjb25zdCBpdCBvZiBzbGljZSkge1xyXG5cdFx0XHRjb25zdCBjYWNoZWQgPSBtYXAuZ2V0KGl0LmtleSk7XHJcblx0XHRcdGlmICh0eXBlb2YgY2FjaGVkID09PSAnbnVtYmVyJykge1xyXG5cdFx0XHRcdHNjb3JlZC5wdXNoKHsgaXRlbTogaXQsIHNjb3JlOiBjYWNoZWQgfSk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZG9jID0gYCR7aXQucGF0aH1cXG4ke2l0LmV4Y2VycHR9YDtcclxuXHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xyXG5cdFx0XHRtYXAuc2V0KGl0LmtleSwgcmVzLnNjb3JlKTtcclxuXHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IHJlcy5zY29yZSB9KTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBNZXJnZSByZXJhbmsgc2NvcmUgaW50byBmaW5hbCBvcmRlcmluZzsga2VlcCBvcmlnaW5hbCBzY29yZSBhcyBzZWNvbmRhcnkgc2lnbmFsLlxyXG5cdFx0Y29uc3Qgb3V0ID0gc2NvcmVkXHJcblx0XHRcdC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBiLml0ZW0uc2NvcmUgLSBhLml0ZW0uc2NvcmUpXHJcblx0XHRcdC5zbGljZSgwLCBsaW1pdClcclxuXHRcdFx0Lm1hcCgocykgPT4gKHtcclxuXHRcdFx0XHQuLi5zLml0ZW0sXHJcblx0XHRcdFx0Ly8gS2VlcCB0aGUgc2NvcmUgZmllbGQgYXMgdGhlIHJlcmFuayBzY29yZSBzbyBmb3JtYXR0aW5nIHJlZmxlY3RzIHRydWUgb3JkZXIuXHJcblx0XHRcdFx0c2NvcmU6IHMuc2NvcmUsXHJcblx0XHRcdFx0c291cmNlOiAncmVyYW5rJyxcclxuXHRcdFx0XHRyZWFzb25UYWdzOiBBcnJheS5mcm9tKG5ldyBTZXQoWy4uLihzLml0ZW0ucmVhc29uVGFncyA/PyBbXSksICdyZXJhbmsnXSkpXHJcblx0XHRcdH0pKTtcclxuXHJcblx0XHRyZXR1cm4gb3V0O1xyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==