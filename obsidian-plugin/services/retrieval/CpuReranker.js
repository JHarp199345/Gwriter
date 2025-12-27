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
            console.log(`[CpuReranker] === STARTING RERANKER LOAD ===`);
            console.log(`[CpuReranker] Timestamp: ${new Date().toISOString()}`);
            // Import the vendored transformers library
            console.log(`[CpuReranker] [STEP 1] Importing transformers.js module...`);
            let transformersModule;
            try {
                transformersModule = await import('../../lib/transformers.js');
                console.log(`[CpuReranker] [STEP 1] ✓ Module imported successfully`);
            }
            catch (importErr) {
                console.error(`[CpuReranker] [STEP 1] ✗ Module import failed:`, importErr);
                throw new Error(`Failed to import transformers.js: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
            }
            // Try multiple ways to access the environment
            console.log(`[CpuReranker] [STEP 2] Locating environment structure...`);
            let env = null;
            let envSource = 'none';
            // Method 1: Direct env (standard)
            if (transformersModule.env) {
                console.log(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.env`);
                env = transformersModule.env;
                envSource = 'transformersModule.env';
            }
            // Method 2: default.env (if default export)
            else if (transformersModule.default?.env) {
                console.log(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.default.env`);
                env = transformersModule.default.env;
                envSource = 'transformersModule.default.env';
            }
            if (env) {
                console.log(`[CpuReranker] [STEP 2] env.backends exists:`, 'backends' in env);
                console.log(`[CpuReranker] [STEP 2] env.backends.onnx exists:`, env.backends?.onnx !== undefined);
                console.log(`[CpuReranker] [STEP 2] env.useWasm exists:`, typeof env.useWasm === 'function');
            }
            else {
                console.warn(`[CpuReranker] [STEP 2] ✗ Could not find env structure`);
            }
            // Configure WASM paths - CRITICAL: Must be done BEFORE any ONNX backend initialization
            console.log(`[CpuReranker] [STEP 3] Attempting to configure WASM paths...`);
            const wasmBasePath = './lib/';
            if (env) {
                // Approach 1: Try to access ONNX backend directly from the module
                let onnxBackendEnv = null;
                let onnxBackendPath = 'none';
                if (transformersModule?.ONNX) {
                    console.log(`[CpuReranker] [STEP 3] ✓ Found ONNX export in module`);
                    const onnx = transformersModule.ONNX;
                    if (onnx?.env?.wasm) {
                        onnxBackendEnv = onnx.env.wasm;
                        onnxBackendPath = 'transformersModule.ONNX.env.wasm';
                        console.log(`[CpuReranker] [STEP 3] ✓ Found ONNX env.wasm via transformersModule.ONNX`);
                    }
                    else if (onnx?.env) {
                        onnxBackendEnv = onnx.env;
                        onnxBackendPath = 'transformersModule.ONNX.env';
                        console.log(`[CpuReranker] [STEP 3] ✓ Found ONNX env via transformersModule.ONNX`);
                    }
                }
                // Approach 2: Try via env.backends.onnx (transformers.js structure)
                if (!onnxBackendEnv && env.backends?.onnx) {
                    const onnxBackend = env.backends.onnx;
                    console.log(`[CpuReranker] [STEP 3] ✓ ONNX backend found via env.backends.onnx`);
                    if (onnxBackend.env?.wasm) {
                        onnxBackendEnv = onnxBackend.env.wasm;
                        onnxBackendPath = 'env.backends.onnx.env.wasm';
                    }
                    else if (onnxBackend.wasm) {
                        onnxBackendEnv = onnxBackend.wasm;
                        onnxBackendPath = 'onnxBackend.wasm';
                    }
                    else if (onnxBackend.env) {
                        onnxBackendEnv = onnxBackend.env;
                        onnxBackendPath = 'onnxBackend.env';
                    }
                }
                // Set wasmPaths on the ONNX backend environment
                if (onnxBackendEnv) {
                    console.log(`[CpuReranker] [STEP 3] Configuring WASM paths at: ${onnxBackendPath}`);
                    try {
                        if ('wasmPaths' in onnxBackendEnv) {
                            onnxBackendEnv.wasmPaths = wasmBasePath;
                            console.log(`[CpuReranker] [STEP 3] ✓ Updated wasmPaths to: ${wasmBasePath}`);
                        }
                        else {
                            Object.defineProperty(onnxBackendEnv, 'wasmPaths', {
                                value: wasmBasePath,
                                writable: true,
                                enumerable: true,
                                configurable: true
                            });
                            console.log(`[CpuReranker] [STEP 3] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
                        }
                    }
                    catch (pathErr) {
                        console.warn(`[CpuReranker] [STEP 3] Failed to set wasmPaths at ${onnxBackendPath}:`, pathErr);
                    }
                }
                else {
                    console.warn(`[CpuReranker] [STEP 3] ⚠ ONNX backend environment not found - may initialize lazily`);
                }
                // Approach 3: Also try setting at top-level env
                try {
                    if ('wasmPaths' in env) {
                        env.wasmPaths = wasmBasePath;
                        console.log(`[CpuReranker] [STEP 3] ✓ Also set env.wasmPaths to: ${wasmBasePath}`);
                    }
                }
                catch (envPathErr) {
                    console.warn(`[CpuReranker] [STEP 3] Failed to set top-level env.wasmPaths:`, envPathErr);
                }
            }
            else {
                console.warn(`[CpuReranker] [STEP 3] ✗ Cannot configure WASM paths - env not found`);
            }
            // Get pipeline function
            console.log(`[CpuReranker] [STEP 4] Locating pipeline function...`);
            const pipeline = transformersModule.pipeline || transformersModule.default?.pipeline;
            console.log(`[CpuReranker] [STEP 4] Pipeline found:`, pipeline !== undefined && pipeline !== null);
            console.log(`[CpuReranker] [STEP 4] Pipeline type:`, typeof pipeline);
            if (!pipeline || typeof pipeline !== 'function') {
                console.error(`[CpuReranker] [STEP 4] ✗ Pipeline not found or not a function`);
                throw new Error('Transformers pipeline is unavailable');
            }
            console.log(`[CpuReranker] [STEP 4] ✓ Pipeline function found`);
            // Cross-encoder reranker model (small-ish). Best-effort: may fail on some environments.
            console.log(`[CpuReranker] [STEP 5] Creating cross-encoder pipeline...`);
            console.log(`[CpuReranker] [STEP 5] Model: Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2`);
            try {
                const pipeUnknown = await pipeline('text-classification', 'Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2', { quantized: true });
                const pipe = pipeUnknown;
                this.pipeline = async (input) => await pipe(input);
                console.log(`[CpuReranker] [STEP 5] ✓ Pipeline created successfully`);
                console.log(`[CpuReranker] === RERANKER LOAD COMPLETE ===`);
            }
            catch (pipeErr) {
                console.error(`[CpuReranker] [STEP 5] ✗ Pipeline creation failed:`, pipeErr);
                throw pipeErr;
            }
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
        // Gracefully degrade if reranking fails - return original items unchanged
        try {
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
                try {
                    const doc = `${it.path}\n${it.excerpt}`;
                    const res = await this.model.rerankPair(query, doc);
                    map.set(it.key, res.score);
                    scored.push({ item: it, score: res.score });
                }
                catch (err) {
                    // If reranking fails for an item, use original score
                    console.warn(`[CpuReranker] Failed to rerank item ${it.key}, using original score:`, err);
                    scored.push({ item: it, score: it.score });
                }
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
        catch (err) {
            // If reranking completely fails (model not loaded, network error, etc.), return original items
            console.warn('[CpuReranker] Reranking failed, returning original results:', err);
            return items.slice(0, opts.limit);
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQXdMOUMsQ0FBQztJQXRMUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1lBQzVELE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBRXBFLDJDQUEyQztZ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LENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDbkMsQ0FBQztJQUNGLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQ29udGV4dEl0ZW0gfSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHR5cGUgeyBDcHVSZXJhbmtlck1vZGVsIH0gZnJvbSAnLi9SZXJhbmtlck1vZGVsJztcclxuaW1wb3J0IHsgZm52MWEzMiB9IGZyb20gJy4uL0NvbnRlbnRIYXNoJztcclxuXHJcbmZ1bmN0aW9uIGNsYW1wMDEoeDogbnVtYmVyKTogbnVtYmVyIHtcclxuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh4KSkgcmV0dXJuIDA7XHJcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHgpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplVGV4dChzOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiAocyB8fCAnJykucmVwbGFjZSgvXFxzKy9nLCAnICcpLnRyaW0oKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENQVSByZXJhbmtlciB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIElmIHRoZSBtb2RlbCBmYWlscyB0byBsb2FkL3J1biwgY2FsbGVycyBzaG91bGQgZmFsbCBiYWNrIHRvIHRoZSBwcmUtcmVyYW5rIG9yZGVyLlxyXG4gKi9cclxuY2xhc3MgVHJhbnNmb3JtZXJzQ3Jvc3NFbmNvZGVyIGltcGxlbWVudHMgQ3B1UmVyYW5rZXJNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnY3Jvc3MtZW5jb2Rlci1tc21hcmNvLW1pbmlsbSc7XHJcblxyXG5cdHByaXZhdGUgcGlwZWxpbmU6XHJcblx0XHR8IG51bGxcclxuXHRcdHwgKChpbnB1dDogc3RyaW5nIHwgQXJyYXk8eyB0ZXh0OiBzdHJpbmc7IHRleHRfcGFpcjogc3RyaW5nIH0+KSA9PiBQcm9taXNlPHVua25vd24+KSA9IG51bGw7XHJcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHJldHVybjtcclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblxyXG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gPT09IFNUQVJUSU5HIFJFUkFOS0VSIExPQUQgPT09YCk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBJbXBvcnQgdGhlIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBsaWJyYXJ5XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDFdIEltcG9ydGluZyB0cmFuc2Zvcm1lcnMuanMgbW9kdWxlLi4uYCk7XHJcblx0XHRcdGxldCB0cmFuc2Zvcm1lcnNNb2R1bGU6IGFueTtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHR0cmFuc2Zvcm1lcnNNb2R1bGUgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSDinJMgTW9kdWxlIGltcG9ydGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGltcG9ydCB0cmFuc2Zvcm1lcnMuanM6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBUcnkgbXVsdGlwbGUgd2F5cyB0byBhY2Nlc3MgdGhlIGVudmlyb25tZW50XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIExvY2F0aW5nIGVudmlyb25tZW50IHN0cnVjdHVyZS4uLmApO1xyXG5cdFx0XHRsZXQgZW52OiBhbnkgPSBudWxsO1xyXG5cdFx0XHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gTWV0aG9kIDE6IERpcmVjdCBlbnYgKHN0YW5kYXJkKVxyXG5cdFx0XHRpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIOKckyBGb3VuZCBlbnYgdmlhIHRyYW5zZm9ybWVyc01vZHVsZS5lbnZgKTtcclxuXHRcdFx0XHRlbnYgPSB0cmFuc2Zvcm1lcnNNb2R1bGUuZW52O1xyXG5cdFx0XHRcdGVudlNvdXJjZSA9ICd0cmFuc2Zvcm1lcnNNb2R1bGUuZW52JztcclxuXHRcdFx0fVxyXG5cdFx0XHQvLyBNZXRob2QgMjogZGVmYXVsdC5lbnYgKGlmIGRlZmF1bHQgZXhwb3J0KVxyXG5cdFx0XHRlbHNlIGlmICh0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdD8uZW52KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyTIEZvdW5kIGVudiB2aWEgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52YCk7XHJcblx0XHRcdFx0ZW52ID0gdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52O1xyXG5cdFx0XHRcdGVudlNvdXJjZSA9ICd0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnYnO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoZW52KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gZW52LmJhY2tlbmRzIGV4aXN0czpgLCAnYmFja2VuZHMnIGluIGVudik7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSBlbnYudXNlV2FzbSBleGlzdHM6YCwgdHlwZW9mIGVudi51c2VXYXNtID09PSAnZnVuY3Rpb24nKTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyXIENvdWxkIG5vdCBmaW5kIGVudiBzdHJ1Y3R1cmVgKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSBDUklUSUNBTDogTXVzdCBiZSBkb25lIEJFRk9SRSBhbnkgT05OWCBiYWNrZW5kIGluaXRpYWxpemF0aW9uXHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcclxuXHRcdFx0XHJcblx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKGVudikge1xyXG5cdFx0XHRcdC8vIEFwcHJvYWNoIDE6IFRyeSB0byBhY2Nlc3MgT05OWCBiYWNrZW5kIGRpcmVjdGx5IGZyb20gdGhlIG1vZHVsZVxyXG5cdFx0XHRcdGxldCBvbm54QmFja2VuZEVudjogYW55ID0gbnVsbDtcclxuXHRcdFx0XHRsZXQgb25ueEJhY2tlbmRQYXRoID0gJ25vbmUnO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGlmICh0cmFuc2Zvcm1lcnNNb2R1bGU/Lk9OTlgpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBPTk5YIGV4cG9ydCBpbiBtb2R1bGVgKTtcclxuXHRcdFx0XHRcdGNvbnN0IG9ubnggPSB0cmFuc2Zvcm1lcnNNb2R1bGUuT05OWDtcclxuXHRcdFx0XHRcdGlmIChvbm54Py5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54LmVudi53YXNtO1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAndHJhbnNmb3JtZXJzTW9kdWxlLk9OTlguZW52Lndhc20nO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgRm91bmQgT05OWCBlbnYud2FzbSB2aWEgdHJhbnNmb3JtZXJzTW9kdWxlLk9OTlhgKTtcclxuXHRcdFx0XHRcdH0gZWxzZSBpZiAob25ueD8uZW52KSB7XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueC5lbnY7XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICd0cmFuc2Zvcm1lcnNNb2R1bGUuT05OWC5lbnYnO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgRm91bmQgT05OWCBlbnYgdmlhIHRyYW5zZm9ybWVyc01vZHVsZS5PTk5YYCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIEFwcHJvYWNoIDI6IFRyeSB2aWEgZW52LmJhY2tlbmRzLm9ubnggKHRyYW5zZm9ybWVycy5qcyBzdHJ1Y3R1cmUpXHJcblx0XHRcdFx0aWYgKCFvbm54QmFja2VuZEVudiAmJiBlbnYuYmFja2VuZHM/Lm9ubngpIHtcclxuXHRcdFx0XHRcdGNvbnN0IG9ubnhCYWNrZW5kID0gZW52LmJhY2tlbmRzLm9ubng7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgT05OWCBiYWNrZW5kIGZvdW5kIHZpYSBlbnYuYmFja2VuZHMub25ueGApO1xyXG5cdFx0XHRcdFx0XHJcblx0XHRcdFx0XHRpZiAob25ueEJhY2tlbmQuZW52Py53YXNtKSB7XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQuZW52Lndhc207XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdlbnYuYmFja2VuZHMub25ueC5lbnYud2FzbSc7XHJcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLndhc20pIHtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54QmFja2VuZC53YXNtO1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnb25ueEJhY2tlbmQud2FzbSc7XHJcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLmVudikge1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnhCYWNrZW5kLmVudjtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ29ubnhCYWNrZW5kLmVudic7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIFNldCB3YXNtUGF0aHMgb24gdGhlIE9OTlggYmFja2VuZCBlbnZpcm9ubWVudFxyXG5cdFx0XHRcdGlmIChvbm54QmFja2VuZEVudikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gQ29uZmlndXJpbmcgV0FTTSBwYXRocyBhdDogJHtvbm54QmFja2VuZFBhdGh9YCk7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRpZiAoJ3dhc21QYXRocycgaW4gb25ueEJhY2tlbmRFbnYpIHtcclxuXHRcdFx0XHRcdFx0XHRvbm54QmFja2VuZEVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIFVwZGF0ZWQgd2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkob25ueEJhY2tlbmRFbnYsICd3YXNtUGF0aHMnLCB7XHJcblx0XHRcdFx0XHRcdFx0XHR2YWx1ZTogd2FzbUJhc2VQYXRoLFxyXG5cdFx0XHRcdFx0XHRcdFx0d3JpdGFibGU6IHRydWUsXHJcblx0XHRcdFx0XHRcdFx0XHRlbnVtZXJhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRcdFx0Y29uZmlndXJhYmxlOiB0cnVlXHJcblx0XHRcdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR9IGNhdGNoIChwYXRoRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBGYWlsZWQgdG8gc2V0IHdhc21QYXRocyBhdCAke29ubnhCYWNrZW5kUGF0aH06YCwgcGF0aEVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDimqAgT05OWCBiYWNrZW5kIGVudmlyb25tZW50IG5vdCBmb3VuZCAtIG1heSBpbml0aWFsaXplIGxhemlseWApO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBBcHByb2FjaCAzOiBBbHNvIHRyeSBzZXR0aW5nIGF0IHRvcC1sZXZlbCBlbnZcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIGVudikge1xyXG5cdFx0XHRcdFx0XHRlbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgQWxzbyBzZXQgZW52Lndhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSBjYXRjaCAoZW52UGF0aEVycikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEZhaWxlZCB0byBzZXQgdG9wLWxldmVsIGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJcgQ2Fubm90IGNvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gZW52IG5vdCBmb3VuZGApO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBHZXQgcGlwZWxpbmUgZnVuY3Rpb25cclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRcdFx0Y29uc3QgcGlwZWxpbmUgPSB0cmFuc2Zvcm1lcnNNb2R1bGUucGlwZWxpbmUgfHwgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LnBpcGVsaW5lO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIOKclyBQaXBlbGluZSBub3QgZm91bmQgb3Igbm90IGEgZnVuY3Rpb25gKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1RyYW5zZm9ybWVycyBwaXBlbGluZSBpcyB1bmF2YWlsYWJsZScpO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSDinJMgUGlwZWxpbmUgZnVuY3Rpb24gZm91bmRgKTtcclxuXHJcblx0XHRcdC8vIENyb3NzLWVuY29kZXIgcmVyYW5rZXIgbW9kZWwgKHNtYWxsLWlzaCkuIEJlc3QtZWZmb3J0OiBtYXkgZmFpbCBvbiBzb21lIGVudmlyb25tZW50cy5cclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNV0gQ3JlYXRpbmcgY3Jvc3MtZW5jb2RlciBwaXBlbGluZS4uLmApO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSBNb2RlbDogWGVub3ZhL2Nyb3NzLWVuY29kZXItbXMtbWFyY28tTWluaUxNLUwtNi12MmApO1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnN0IHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoXHJcblx0XHRcdFx0XHQndGV4dC1jbGFzc2lmaWNhdGlvbicsXHJcblx0XHRcdFx0XHQnWGVub3ZhL2Nyb3NzLWVuY29kZXItbXMtbWFyY28tTWluaUxNLUwtNi12MicsXHJcblx0XHRcdFx0XHR7IHF1YW50aXplZDogdHJ1ZSB9XHJcblx0XHRcdFx0KTtcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiB1bmtub3duKSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAoaW5wdXQpID0+IGF3YWl0IHBpcGUoaW5wdXQpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBjcmVhdGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdID09PSBSRVJBTktFUiBMT0FEIENPTVBMRVRFID09PWApO1xyXG5cdFx0XHR9IGNhdGNoIChwaXBlRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkOmAsIHBpcGVFcnIpO1xyXG5cdFx0XHRcdHRocm93IHBpcGVFcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgcmVyYW5rUGFpcihxdWVyeTogc3RyaW5nLCBkb2N1bWVudDogc3RyaW5nKTogUHJvbWlzZTx7IHNjb3JlOiBudW1iZXIgfT4ge1xyXG5cdFx0Y29uc3QgcSA9IG5vcm1hbGl6ZVRleHQocXVlcnkpO1xyXG5cdFx0Y29uc3QgZCA9IG5vcm1hbGl6ZVRleHQoZG9jdW1lbnQpO1xyXG5cdFx0aWYgKCFxIHx8ICFkKSByZXR1cm4geyBzY29yZTogMCB9O1xyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdGlmICghdGhpcy5waXBlbGluZSkgdGhyb3cgbmV3IEVycm9yKCdSZXJhbmtlciBwaXBlbGluZSB1bmF2YWlsYWJsZScpO1xyXG5cclxuXHRcdC8vIFByZWZlciBwYWlyIGlucHV0IGlmIHN1cHBvcnRlZCBieSB0aGUgcGlwZWxpbmUgaW1wbGVtZW50YXRpb247IGZhbGwgYmFjayB0byBjb25jYXRlbmF0aW9uLlxyXG5cdFx0bGV0IG91dDogdW5rbm93bjtcclxuXHRcdHRyeSB7XHJcblx0XHRcdG91dCA9IGF3YWl0IHRoaXMucGlwZWxpbmUoW3sgdGV4dDogcSwgdGV4dF9wYWlyOiBkIH1dKTtcclxuXHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRvdXQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKGAke3F9XFxuXFxuJHtkfWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIENvbW1vbiBvdXRwdXQgZm9ybWF0czpcclxuXHRcdC8vIC0gW3sgbGFiZWw6ICdMQUJFTF8xJywgc2NvcmU6IDAuOTMgfSwgLi4uXVxyXG5cdFx0Ly8gLSB7IGxhYmVsLCBzY29yZSB9XHJcblx0XHRjb25zdCBmaXJzdCA9IEFycmF5LmlzQXJyYXkob3V0KSA/IG91dFswXSA6IG91dDtcclxuXHRcdGNvbnN0IG9iaiA9IGZpcnN0IGFzIHsgc2NvcmU/OiB1bmtub3duOyBsYWJlbD86IHVua25vd24gfTtcclxuXHRcdGNvbnN0IHNjb3JlID0gdHlwZW9mIG9iaj8uc2NvcmUgPT09ICdudW1iZXInID8gb2JqLnNjb3JlIDogMDtcclxuXHRcdHJldHVybiB7IHNjb3JlOiBjbGFtcDAxKHNjb3JlKSB9O1xyXG5cdH1cclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDcHVSZXJhbmtPcHRpb25zIHtcclxuXHRsaW1pdDogbnVtYmVyOyAvLyBob3cgbWFueSBpdGVtcyB0byByZXR1cm5cclxuXHRzaG9ydGxpc3Q/OiBudW1iZXI7IC8vIGhvdyBtYW55IHRvIHNjb3JlXHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBDcHVSZXJhbmtlciB7XHJcblx0cHJpdmF0ZSByZWFkb25seSBtb2RlbDogQ3B1UmVyYW5rZXJNb2RlbDtcclxuXHQvLyBxdWVyeUhhc2ggLT4gaXRlbUtleSAtPiBzY29yZVxyXG5cdHByaXZhdGUgcmVhZG9ubHkgY2FjaGUgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgbnVtYmVyPj4oKTtcclxuXHJcblx0Y29uc3RydWN0b3IobW9kZWw/OiBDcHVSZXJhbmtlck1vZGVsKSB7XHJcblx0XHR0aGlzLm1vZGVsID0gbW9kZWwgPz8gbmV3IFRyYW5zZm9ybWVyc0Nyb3NzRW5jb2RlcigpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBoYXNoUXVlcnkocTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRcdHJldHVybiBmbnYxYTMyKG5vcm1hbGl6ZVRleHQocSkpO1xyXG5cdH1cclxuXHJcblx0d2FybShxdWVyeTogc3RyaW5nLCBpdGVtczogQ29udGV4dEl0ZW1bXSwgb3B0cz86IHsgc2hvcnRsaXN0PzogbnVtYmVyIH0pOiB2b2lkIHtcclxuXHRcdGNvbnN0IHNob3J0bGlzdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDEyMCwgTWF0aC5mbG9vcihvcHRzPy5zaG9ydGxpc3QgPz8gNDApKSk7XHJcblx0XHRjb25zdCBxaCA9IHRoaXMuaGFzaFF1ZXJ5KHF1ZXJ5KTtcclxuXHRcdGNvbnN0IG1hcCA9IHRoaXMuY2FjaGUuZ2V0KHFoKSA/PyBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xyXG5cdFx0dGhpcy5jYWNoZS5zZXQocWgsIG1hcCk7XHJcblxyXG5cdFx0Y29uc3QgdG9TY29yZSA9IGl0ZW1zLnNsaWNlKDAsIHNob3J0bGlzdCkuZmlsdGVyKChpdCkgPT4gIW1hcC5oYXMoaXQua2V5KSk7XHJcblx0XHRpZiAodG9TY29yZS5sZW5ndGggPT09IDApIHJldHVybjtcclxuXHJcblx0XHQvLyBGaXJlLWFuZC1mb3JnZXQgd2FybXVwOyBuZXZlciBibG9jayBVSS5cclxuXHRcdHZvaWQgKGFzeW5jICgpID0+IHtcclxuXHRcdFx0Zm9yIChjb25zdCBpdCBvZiB0b1Njb3JlKSB7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdGNvbnN0IGRvYyA9IGAke2l0LnBhdGh9XFxuJHtpdC5leGNlcnB0fWA7XHJcblx0XHRcdFx0XHRjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1vZGVsLnJlcmFua1BhaXIocXVlcnksIGRvYyk7XHJcblx0XHRcdFx0XHRtYXAuc2V0KGl0LmtleSwgcmVzLnNjb3JlKTtcclxuXHRcdFx0XHR9IGNhdGNoIHtcclxuXHRcdFx0XHRcdC8vIHN0b3Agd2FybWluZyBpZiBtb2RlbCBmYWlsc1xyXG5cdFx0XHRcdFx0YnJlYWs7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHR9KSgpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0Ly8gaWdub3JlXHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdGFzeW5jIHJlcmFuayhxdWVyeTogc3RyaW5nLCBpdGVtczogQ29udGV4dEl0ZW1bXSwgb3B0czogQ3B1UmVyYW5rT3B0aW9ucyk6IFByb21pc2U8Q29udGV4dEl0ZW1bXT4ge1xyXG5cdFx0Ly8gR3JhY2VmdWxseSBkZWdyYWRlIGlmIHJlcmFua2luZyBmYWlscyAtIHJldHVybiBvcmlnaW5hbCBpdGVtcyB1bmNoYW5nZWRcclxuXHRcdHRyeSB7XHJcblx0XHRcdGNvbnN0IGxpbWl0ID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oMjAwLCBNYXRoLmZsb29yKG9wdHMubGltaXQpKSk7XHJcblx0XHRcdGNvbnN0IHNob3J0bGlzdCA9IE1hdGgubWF4KGxpbWl0LCBNYXRoLm1pbigxMjAsIE1hdGguZmxvb3Iob3B0cy5zaG9ydGxpc3QgPz8gNjApKSk7XHJcblx0XHRcdGNvbnN0IHFoID0gdGhpcy5oYXNoUXVlcnkocXVlcnkpO1xyXG5cdFx0XHRjb25zdCBtYXAgPSB0aGlzLmNhY2hlLmdldChxaCkgPz8gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuXHRcdFx0dGhpcy5jYWNoZS5zZXQocWgsIG1hcCk7XHJcblxyXG5cdFx0XHRjb25zdCBzY29yZWQ6IEFycmF5PHsgaXRlbTogQ29udGV4dEl0ZW07IHNjb3JlOiBudW1iZXIgfT4gPSBbXTtcclxuXHRcdFx0Y29uc3Qgc2xpY2UgPSBpdGVtcy5zbGljZSgwLCBzaG9ydGxpc3QpO1xyXG5cdFx0XHRmb3IgKGNvbnN0IGl0IG9mIHNsaWNlKSB7XHJcblx0XHRcdFx0Y29uc3QgY2FjaGVkID0gbWFwLmdldChpdC5rZXkpO1xyXG5cdFx0XHRcdGlmICh0eXBlb2YgY2FjaGVkID09PSAnbnVtYmVyJykge1xyXG5cdFx0XHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IGNhY2hlZCB9KTtcclxuXHRcdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgZG9jID0gYCR7aXQucGF0aH1cXG4ke2l0LmV4Y2VycHR9YDtcclxuXHRcdFx0XHRcdGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubW9kZWwucmVyYW5rUGFpcihxdWVyeSwgZG9jKTtcclxuXHRcdFx0XHRcdG1hcC5zZXQoaXQua2V5LCByZXMuc2NvcmUpO1xyXG5cdFx0XHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IHJlcy5zY29yZSB9KTtcclxuXHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdC8vIElmIHJlcmFua2luZyBmYWlscyBmb3IgYW4gaXRlbSwgdXNlIG9yaWdpbmFsIHNjb3JlXHJcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gRmFpbGVkIHRvIHJlcmFuayBpdGVtICR7aXQua2V5fSwgdXNpbmcgb3JpZ2luYWwgc2NvcmU6YCwgZXJyKTtcclxuXHRcdFx0XHRcdHNjb3JlZC5wdXNoKHsgaXRlbTogaXQsIHNjb3JlOiBpdC5zY29yZSB9KTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdC8vIE1lcmdlIHJlcmFuayBzY29yZSBpbnRvIGZpbmFsIG9yZGVyaW5nOyBrZWVwIG9yaWdpbmFsIHNjb3JlIGFzIHNlY29uZGFyeSBzaWduYWwuXHJcblx0XHRcdGNvbnN0IG91dCA9IHNjb3JlZFxyXG5cdFx0XHRcdC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBiLml0ZW0uc2NvcmUgLSBhLml0ZW0uc2NvcmUpXHJcblx0XHRcdFx0LnNsaWNlKDAsIGxpbWl0KVxyXG5cdFx0XHRcdC5tYXAoKHMpID0+ICh7XHJcblx0XHRcdFx0XHQuLi5zLml0ZW0sXHJcblx0XHRcdFx0XHQvLyBLZWVwIHRoZSBzY29yZSBmaWVsZCBhcyB0aGUgcmVyYW5rIHNjb3JlIHNvIGZvcm1hdHRpbmcgcmVmbGVjdHMgdHJ1ZSBvcmRlci5cclxuXHRcdFx0XHRcdHNjb3JlOiBzLnNjb3JlLFxyXG5cdFx0XHRcdFx0c291cmNlOiAncmVyYW5rJyxcclxuXHRcdFx0XHRcdHJlYXNvblRhZ3M6IEFycmF5LmZyb20obmV3IFNldChbLi4uKHMuaXRlbS5yZWFzb25UYWdzID8/IFtdKSwgJ3JlcmFuayddKSlcclxuXHRcdFx0XHR9KSk7XHJcblxyXG5cdFx0XHRyZXR1cm4gb3V0O1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdC8vIElmIHJlcmFua2luZyBjb21wbGV0ZWx5IGZhaWxzIChtb2RlbCBub3QgbG9hZGVkLCBuZXR3b3JrIGVycm9yLCBldGMuKSwgcmV0dXJuIG9yaWdpbmFsIGl0ZW1zXHJcblx0XHRcdGNvbnNvbGUud2FybignW0NwdVJlcmFua2VyXSBSZXJhbmtpbmcgZmFpbGVkLCByZXR1cm5pbmcgb3JpZ2luYWwgcmVzdWx0czonLCBlcnIpO1xyXG5cdFx0XHRyZXR1cm4gaXRlbXMuc2xpY2UoMCwgb3B0cy5saW1pdCk7XHJcblx0XHR9XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19