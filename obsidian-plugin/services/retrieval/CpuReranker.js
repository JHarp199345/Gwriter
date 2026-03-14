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
            console.debug(`[CpuReranker] === STARTING RERANKER LOAD ===`);
            console.debug(`[CpuReranker] Timestamp: ${new Date().toISOString()}`);
            // Import the vendored transformers library
            console.debug(`[CpuReranker] [STEP 1] Importing transformers.js module...`);
            let transformersModule;
            try {
                transformersModule = await import('../../lib/transformers.js');
                console.debug(`[CpuReranker] [STEP 1] ✓ Module imported successfully`);
            }
            catch (importErr) {
                console.error(`[CpuReranker] [STEP 1] ✗ Module import failed:`, importErr);
                throw new Error(`Failed to import transformers.js: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
            }
            // Try multiple ways to access the environment
            console.debug(`[CpuReranker] [STEP 2] Locating environment structure...`);
            let env = null;
            let envSource = 'none';
            // Method 1: Direct env (standard)
            if (transformersModule.env) {
                console.debug(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.env`);
                env = transformersModule.env;
                envSource = 'transformersModule.env';
            }
            // Method 2: default.env (if default export)
            else if (transformersModule.default?.env) {
                console.debug(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.default.env`);
                env = transformersModule.default.env;
                envSource = 'transformersModule.default.env';
            }
            if (env) {
                console.debug(`[CpuReranker] [STEP 2] env.backends exists:`, 'backends' in env);
                console.debug(`[CpuReranker] [STEP 2] env.backends.onnx exists:`, env.backends?.onnx !== undefined);
                console.debug(`[CpuReranker] [STEP 2] env.useWasm exists:`, typeof env.useWasm === 'function');
            }
            else {
                console.warn(`[CpuReranker] [STEP 2] ✗ Could not find env structure`);
            }
            // Configure WASM paths - CRITICAL: Must be done BEFORE any ONNX backend initialization
            console.debug(`[CpuReranker] [STEP 3] Attempting to configure WASM paths...`);
            const wasmBasePath = './lib/';
            if (env) {
                // Approach 1: Try to access ONNX backend directly from the module
                let onnxBackendEnv = null;
                let onnxBackendPath = 'none';
                if (transformersModule?.ONNX) {
                    console.debug(`[CpuReranker] [STEP 3] ✓ Found ONNX export in module`);
                    const onnx = transformersModule.ONNX;
                    if (onnx?.env?.wasm) {
                        onnxBackendEnv = onnx.env.wasm;
                        onnxBackendPath = 'transformersModule.ONNX.env.wasm';
                        console.debug(`[CpuReranker] [STEP 3] ✓ Found ONNX env.wasm via transformersModule.ONNX`);
                    }
                    else if (onnx?.env) {
                        onnxBackendEnv = onnx.env;
                        onnxBackendPath = 'transformersModule.ONNX.env';
                        console.debug(`[CpuReranker] [STEP 3] ✓ Found ONNX env via transformersModule.ONNX`);
                    }
                }
                // Approach 2: Try via env.backends.onnx (transformers.js structure)
                if (!onnxBackendEnv && env.backends?.onnx) {
                    const onnxBackend = env.backends.onnx;
                    console.debug(`[CpuReranker] [STEP 3] ✓ ONNX backend found via env.backends.onnx`);
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
                    console.debug(`[CpuReranker] [STEP 3] Configuring WASM paths at: ${onnxBackendPath}`);
                    try {
                        if ('wasmPaths' in onnxBackendEnv) {
                            onnxBackendEnv.wasmPaths = wasmBasePath;
                            console.debug(`[CpuReranker] [STEP 3] ✓ Updated wasmPaths to: ${wasmBasePath}`);
                        }
                        else {
                            Object.defineProperty(onnxBackendEnv, 'wasmPaths', {
                                value: wasmBasePath,
                                writable: true,
                                enumerable: true,
                                configurable: true
                            });
                            console.debug(`[CpuReranker] [STEP 3] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
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
                        console.debug(`[CpuReranker] [STEP 3] ✓ Also set env.wasmPaths to: ${wasmBasePath}`);
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
            console.debug(`[CpuReranker] [STEP 4] Locating pipeline function...`);
            const pipeline = transformersModule.pipeline || transformersModule.default?.pipeline;
            console.debug(`[CpuReranker] [STEP 4] Pipeline found:`, pipeline !== undefined && pipeline !== null);
            console.debug(`[CpuReranker] [STEP 4] Pipeline type:`, typeof pipeline);
            if (!pipeline || typeof pipeline !== 'function') {
                console.error(`[CpuReranker] [STEP 4] ✗ Pipeline not found or not a function`);
                throw new Error('Transformers pipeline is unavailable');
            }
            console.debug(`[CpuReranker] [STEP 4] ✓ Pipeline function found`);
            // Cross-encoder reranker model (small-ish). Best-effort: may fail on some environments.
            console.debug(`[CpuReranker] [STEP 5] Creating cross-encoder pipeline...`);
            console.debug(`[CpuReranker] [STEP 5] Model: Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2`);
            try {
                const pipeUnknown = await pipeline('text-classification', 'Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2', { quantized: true });
                const pipe = pipeUnknown;
                this.pipeline = async (input) => await pipe(input);
                console.debug(`[CpuReranker] [STEP 5] ✓ Pipeline created successfully`);
                console.debug(`[CpuReranker] === RERANKER LOAD COMPLETE ===`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQXdMOUMsQ0FBQztJQXRMUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsT0FBTyxDQUFDLEtBQUssQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1lBQzlELE9BQU8sQ0FBQyxLQUFLLENBQUMsNEJBQTRCLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBRXRFLDJDQUEyQztZ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LENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDbkMsQ0FBQztJQUNGLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQ29udGV4dEl0ZW0gfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB0eXBlIHsgQ3B1UmVyYW5rZXJNb2RlbCB9IGZyb20gJy4vUmVyYW5rZXJNb2RlbCc7XG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuXG5mdW5jdGlvbiBjbGFtcDAxKHg6IG51bWJlcik6IG51bWJlciB7XG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHgpKSByZXR1cm4gMDtcblx0cmV0dXJuIE1hdGgubWF4KDAsIE1hdGgubWluKDEsIHgpKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVGV4dChzOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gKHMgfHwgJycpLnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCk7XG59XG5cbi8qKlxuICogQ1BVIHJlcmFua2VyIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cbiAqIElmIHRoZSBtb2RlbCBmYWlscyB0byBsb2FkL3J1biwgY2FsbGVycyBzaG91bGQgZmFsbCBiYWNrIHRvIHRoZSBwcmUtcmVyYW5rIG9yZGVyLlxuICovXG5jbGFzcyBUcmFuc2Zvcm1lcnNDcm9zc0VuY29kZXIgaW1wbGVtZW50cyBDcHVSZXJhbmtlck1vZGVsIHtcblx0cmVhZG9ubHkgaWQgPSAnY3Jvc3MtZW5jb2Rlci1tc21hcmNvLW1pbmlsbSc7XG5cblx0cHJpdmF0ZSBwaXBlbGluZTpcblx0XHR8IG51bGxcblx0XHR8ICgoaW5wdXQ6IHN0cmluZyB8IEFycmF5PHsgdGV4dDogc3RyaW5nOyB0ZXh0X3BhaXI6IHN0cmluZyB9PikgPT4gUHJvbWlzZTx1bmtub3duPikgPSBudWxsO1xuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcblxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5waXBlbGluZSkgcmV0dXJuO1xuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHJldHVybiB0aGlzLmxvYWRpbmc7XG5cblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSA9PT0gU1RBUlRJTkcgUkVSQU5LRVIgTE9BRCA9PT1gKTtcblx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gVGltZXN0YW1wOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcblx0XHRcdFxuXHRcdFx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeVxuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSBJbXBvcnRpbmcgdHJhbnNmb3JtZXJzLmpzIG1vZHVsZS4uLmApO1xuXHRcdFx0bGV0IHRyYW5zZm9ybWVyc01vZHVsZTogYW55O1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0dHJhbnNmb3JtZXJzTW9kdWxlID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgMV0g4pyTIE1vZHVsZSBpbXBvcnRlZCBzdWNjZXNzZnVsbHlgKTtcblx0XHRcdH0gY2F0Y2ggKGltcG9ydEVycikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudFxuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSBMb2NhdGluZyBlbnZpcm9ubWVudCBzdHJ1Y3R1cmUuLi5gKTtcblx0XHRcdGxldCBlbnY6IGFueSA9IG51bGw7XG5cdFx0XHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xuXHRcdFx0XG5cdFx0XHQvLyBNZXRob2QgMTogRGlyZWN0IGVudiAoc3RhbmRhcmQpXG5cdFx0XHRpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmVudikge1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIOKckyBGb3VuZCBlbnYgdmlhIHRyYW5zZm9ybWVyc01vZHVsZS5lbnZgKTtcblx0XHRcdFx0ZW52ID0gdHJhbnNmb3JtZXJzTW9kdWxlLmVudjtcblx0XHRcdFx0ZW52U291cmNlID0gJ3RyYW5zZm9ybWVyc01vZHVsZS5lbnYnO1xuXHRcdFx0fVxuXHRcdFx0Ly8gTWV0aG9kIDI6IGRlZmF1bHQuZW52IChpZiBkZWZhdWx0IGV4cG9ydClcblx0XHRcdGVsc2UgaWYgKHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0Py5lbnYpIHtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSDinJMgRm91bmQgZW52IHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnZgKTtcblx0XHRcdFx0ZW52ID0gdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52O1xuXHRcdFx0XHRlbnZTb3VyY2UgPSAndHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52Jztcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0aWYgKGVudikge1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIGVudi5iYWNrZW5kcyBleGlzdHM6YCwgJ2JhY2tlbmRzJyBpbiBlbnYpO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIGVudi5iYWNrZW5kcy5vbm54IGV4aXN0czpgLCBlbnYuYmFja2VuZHM/Lm9ubnggIT09IHVuZGVmaW5lZCk7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyXIENvdWxkIG5vdCBmaW5kIGVudiBzdHJ1Y3R1cmVgKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSBDUklUSUNBTDogTXVzdCBiZSBkb25lIEJFRk9SRSBhbnkgT05OWCBiYWNrZW5kIGluaXRpYWxpemF0aW9uXG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcblx0XHRcdFxuXHRcdFx0Y29uc3Qgd2FzbUJhc2VQYXRoID0gJy4vbGliLyc7XG5cdFx0XHRcblx0XHRcdGlmIChlbnYpIHtcblx0XHRcdFx0Ly8gQXBwcm9hY2ggMTogVHJ5IHRvIGFjY2VzcyBPTk5YIGJhY2tlbmQgZGlyZWN0bHkgZnJvbSB0aGUgbW9kdWxlXG5cdFx0XHRcdGxldCBvbm54QmFja2VuZEVudjogYW55ID0gbnVsbDtcblx0XHRcdFx0bGV0IG9ubnhCYWNrZW5kUGF0aCA9ICdub25lJztcblx0XHRcdFx0XG5cdFx0XHRcdGlmICh0cmFuc2Zvcm1lcnNNb2R1bGU/Lk9OTlgpIHtcblx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBPTk5YIGV4cG9ydCBpbiBtb2R1bGVgKTtcblx0XHRcdFx0XHRjb25zdCBvbm54ID0gdHJhbnNmb3JtZXJzTW9kdWxlLk9OTlg7XG5cdFx0XHRcdFx0aWYgKG9ubng/LmVudj8ud2FzbSkge1xuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54LmVudi53YXNtO1xuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ3RyYW5zZm9ybWVyc01vZHVsZS5PTk5YLmVudi53YXNtJztcblx0XHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIEZvdW5kIE9OTlggZW52Lndhc20gdmlhIHRyYW5zZm9ybWVyc01vZHVsZS5PTk5YYCk7XG5cdFx0XHRcdFx0fSBlbHNlIGlmIChvbm54Py5lbnYpIHtcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueC5lbnY7XG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAndHJhbnNmb3JtZXJzTW9kdWxlLk9OTlguZW52Jztcblx0XHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIEZvdW5kIE9OTlggZW52IHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuT05OWGApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRcblx0XHRcdFx0Ly8gQXBwcm9hY2ggMjogVHJ5IHZpYSBlbnYuYmFja2VuZHMub25ueCAodHJhbnNmb3JtZXJzLmpzIHN0cnVjdHVyZSlcblx0XHRcdFx0aWYgKCFvbm54QmFja2VuZEVudiAmJiBlbnYuYmFja2VuZHM/Lm9ubngpIHtcblx0XHRcdFx0XHRjb25zdCBvbm54QmFja2VuZCA9IGVudi5iYWNrZW5kcy5vbm54O1xuXHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIE9OTlggYmFja2VuZCBmb3VuZCB2aWEgZW52LmJhY2tlbmRzLm9ubnhgKTtcblx0XHRcdFx0XHRcblx0XHRcdFx0XHRpZiAob25ueEJhY2tlbmQuZW52Py53YXNtKSB7XG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnhCYWNrZW5kLmVudi53YXNtO1xuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ2Vudi5iYWNrZW5kcy5vbm54LmVudi53YXNtJztcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLndhc20pIHtcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQud2FzbTtcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdvbm54QmFja2VuZC53YXNtJztcblx0XHRcdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLmVudikge1xuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54QmFja2VuZC5lbnY7XG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnb25ueEJhY2tlbmQuZW52Jztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0XG5cdFx0XHRcdC8vIFNldCB3YXNtUGF0aHMgb24gdGhlIE9OTlggYmFja2VuZCBlbnZpcm9ubWVudFxuXHRcdFx0XHRpZiAob25ueEJhY2tlbmRFbnYpIHtcblx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIENvbmZpZ3VyaW5nIFdBU00gcGF0aHMgYXQ6ICR7b25ueEJhY2tlbmRQYXRofWApO1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRpZiAoJ3dhc21QYXRocycgaW4gb25ueEJhY2tlbmRFbnYpIHtcblx0XHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBVcGRhdGVkIHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkob25ueEJhY2tlbmRFbnYsICd3YXNtUGF0aHMnLCB7XG5cdFx0XHRcdFx0XHRcdFx0dmFsdWU6IHdhc21CYXNlUGF0aCxcblx0XHRcdFx0XHRcdFx0XHR3cml0YWJsZTogdHJ1ZSxcblx0XHRcdFx0XHRcdFx0XHRlbnVtZXJhYmxlOiB0cnVlLFxuXHRcdFx0XHRcdFx0XHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxuXHRcdFx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgQ3JlYXRlZCBhbmQgc2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fSBjYXRjaCAocGF0aEVycikge1xuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzIGF0ICR7b25ueEJhY2tlbmRQYXRofTpgLCBwYXRoRXJyKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKaoCBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnQgbm90IGZvdW5kIC0gbWF5IGluaXRpYWxpemUgbGF6aWx5YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0XG5cdFx0XHRcdC8vIEFwcHJvYWNoIDM6IEFsc28gdHJ5IHNldHRpbmcgYXQgdG9wLWxldmVsIGVudlxuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiBlbnYpIHtcblx0XHRcdFx0XHRcdGVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBBbHNvIHNldCBlbnYud2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH0gY2F0Y2ggKGVudlBhdGhFcnIpIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gRmFpbGVkIHRvIHNldCB0b3AtbGV2ZWwgZW52Lndhc21QYXRoczpgLCBlbnZQYXRoRXJyKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBMb2NhdGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xuXHRcdFx0Y29uc3QgcGlwZWxpbmUgPSB0cmFuc2Zvcm1lcnNNb2R1bGUucGlwZWxpbmUgfHwgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LnBpcGVsaW5lO1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcblx0XHRcdGNvbnNvbGUuZGVidWcoYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xuXHRcdFx0XG5cdFx0XHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIOKclyBQaXBlbGluZSBub3QgZm91bmQgb3Igbm90IGEgZnVuY3Rpb25gKTtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdUcmFuc2Zvcm1lcnMgcGlwZWxpbmUgaXMgdW5hdmFpbGFibGUnKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSDinJMgUGlwZWxpbmUgZnVuY3Rpb24gZm91bmRgKTtcblxuXHRcdFx0Ly8gQ3Jvc3MtZW5jb2RlciByZXJhbmtlciBtb2RlbCAoc21hbGwtaXNoKS4gQmVzdC1lZmZvcnQ6IG1heSBmYWlsIG9uIHNvbWUgZW52aXJvbm1lbnRzLlxuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSBDcmVhdGluZyBjcm9zcy1lbmNvZGVyIHBpcGVsaW5lLi4uYCk7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIE1vZGVsOiBYZW5vdmEvY3Jvc3MtZW5jb2Rlci1tcy1tYXJjby1NaW5pTE0tTC02LXYyYCk7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKFxuXHRcdFx0XHRcdCd0ZXh0LWNsYXNzaWZpY2F0aW9uJyxcblx0XHRcdFx0XHQnWGVub3ZhL2Nyb3NzLWVuY29kZXItbXMtbWFyY28tTWluaUxNLUwtNi12MicsXG5cdFx0XHRcdFx0eyBxdWFudGl6ZWQ6IHRydWUgfVxuXHRcdFx0XHQpO1xuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiB1bmtub3duKSA9PiBQcm9taXNlPHVua25vd24+O1xuXHRcdFx0XHR0aGlzLnBpcGVsaW5lID0gYXN5bmMgKGlucHV0KSA9PiBhd2FpdCBwaXBlKGlucHV0KTtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSDinJMgUGlwZWxpbmUgY3JlYXRlZCBzdWNjZXNzZnVsbHlgKTtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0NwdVJlcmFua2VyXSA9PT0gUkVSQU5LRVIgTE9BRCBDT01QTEVURSA9PT1gKTtcblx0XHRcdH0gY2F0Y2ggKHBpcGVFcnIpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkOmAsIHBpcGVFcnIpO1xuXHRcdFx0XHR0aHJvdyBwaXBlRXJyO1xuXHRcdFx0fVxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcblx0fVxuXG5cdGFzeW5jIHJlcmFua1BhaXIocXVlcnk6IHN0cmluZywgZG9jdW1lbnQ6IHN0cmluZyk6IFByb21pc2U8eyBzY29yZTogbnVtYmVyIH0+IHtcblx0XHRjb25zdCBxID0gbm9ybWFsaXplVGV4dChxdWVyeSk7XG5cdFx0Y29uc3QgZCA9IG5vcm1hbGl6ZVRleHQoZG9jdW1lbnQpO1xuXHRcdGlmICghcSB8fCAhZCkgcmV0dXJuIHsgc2NvcmU6IDAgfTtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdGlmICghdGhpcy5waXBlbGluZSkgdGhyb3cgbmV3IEVycm9yKCdSZXJhbmtlciBwaXBlbGluZSB1bmF2YWlsYWJsZScpO1xuXG5cdFx0Ly8gUHJlZmVyIHBhaXIgaW5wdXQgaWYgc3VwcG9ydGVkIGJ5IHRoZSBwaXBlbGluZSBpbXBsZW1lbnRhdGlvbjsgZmFsbCBiYWNrIHRvIGNvbmNhdGVuYXRpb24uXG5cdFx0bGV0IG91dDogdW5rbm93bjtcblx0XHR0cnkge1xuXHRcdFx0b3V0ID0gYXdhaXQgdGhpcy5waXBlbGluZShbeyB0ZXh0OiBxLCB0ZXh0X3BhaXI6IGQgfV0pO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0b3V0ID0gYXdhaXQgdGhpcy5waXBlbGluZShgJHtxfVxcblxcbiR7ZH1gKTtcblx0XHR9XG5cblx0XHQvLyBDb21tb24gb3V0cHV0IGZvcm1hdHM6XG5cdFx0Ly8gLSBbeyBsYWJlbDogJ0xBQkVMXzEnLCBzY29yZTogMC45MyB9LCAuLi5dXG5cdFx0Ly8gLSB7IGxhYmVsLCBzY29yZSB9XG5cdFx0Y29uc3QgZmlyc3QgPSBBcnJheS5pc0FycmF5KG91dCkgPyBvdXRbMF0gOiBvdXQ7XG5cdFx0Y29uc3Qgb2JqID0gZmlyc3QgYXMgeyBzY29yZT86IHVua25vd247IGxhYmVsPzogdW5rbm93biB9O1xuXHRcdGNvbnN0IHNjb3JlID0gdHlwZW9mIG9iaj8uc2NvcmUgPT09ICdudW1iZXInID8gb2JqLnNjb3JlIDogMDtcblx0XHRyZXR1cm4geyBzY29yZTogY2xhbXAwMShzY29yZSkgfTtcblx0fVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIENwdVJlcmFua09wdGlvbnMge1xuXHRsaW1pdDogbnVtYmVyOyAvLyBob3cgbWFueSBpdGVtcyB0byByZXR1cm5cblx0c2hvcnRsaXN0PzogbnVtYmVyOyAvLyBob3cgbWFueSB0byBzY29yZVxufVxuXG5leHBvcnQgY2xhc3MgQ3B1UmVyYW5rZXIge1xuXHRwcml2YXRlIHJlYWRvbmx5IG1vZGVsOiBDcHVSZXJhbmtlck1vZGVsO1xuXHQvLyBxdWVyeUhhc2ggLT4gaXRlbUtleSAtPiBzY29yZVxuXHRwcml2YXRlIHJlYWRvbmx5IGNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIG51bWJlcj4+KCk7XG5cblx0Y29uc3RydWN0b3IobW9kZWw/OiBDcHVSZXJhbmtlck1vZGVsKSB7XG5cdFx0dGhpcy5tb2RlbCA9IG1vZGVsID8/IG5ldyBUcmFuc2Zvcm1lcnNDcm9zc0VuY29kZXIoKTtcblx0fVxuXG5cdHByaXZhdGUgaGFzaFF1ZXJ5KHE6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIGZudjFhMzIobm9ybWFsaXplVGV4dChxKSk7XG5cdH1cblxuXHR3YXJtKHF1ZXJ5OiBzdHJpbmcsIGl0ZW1zOiBDb250ZXh0SXRlbVtdLCBvcHRzPzogeyBzaG9ydGxpc3Q/OiBudW1iZXIgfSk6IHZvaWQge1xuXHRcdGNvbnN0IHNob3J0bGlzdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDEyMCwgTWF0aC5mbG9vcihvcHRzPy5zaG9ydGxpc3QgPz8gNDApKSk7XG5cdFx0Y29uc3QgcWggPSB0aGlzLmhhc2hRdWVyeShxdWVyeSk7XG5cdFx0Y29uc3QgbWFwID0gdGhpcy5jYWNoZS5nZXQocWgpID8/IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cdFx0dGhpcy5jYWNoZS5zZXQocWgsIG1hcCk7XG5cblx0XHRjb25zdCB0b1Njb3JlID0gaXRlbXMuc2xpY2UoMCwgc2hvcnRsaXN0KS5maWx0ZXIoKGl0KSA9PiAhbWFwLmhhcyhpdC5rZXkpKTtcblx0XHRpZiAodG9TY29yZS5sZW5ndGggPT09IDApIHJldHVybjtcblxuXHRcdC8vIEZpcmUtYW5kLWZvcmdldCB3YXJtdXA7IG5ldmVyIGJsb2NrIFVJLlxuXHRcdHZvaWQgKGFzeW5jICgpID0+IHtcblx0XHRcdGZvciAoY29uc3QgaXQgb2YgdG9TY29yZSkge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGRvYyA9IGAke2l0LnBhdGh9XFxuJHtpdC5leGNlcnB0fWA7XG5cdFx0XHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xuXHRcdFx0XHRcdG1hcC5zZXQoaXQua2V5LCByZXMuc2NvcmUpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBzdG9wIHdhcm1pbmcgaWYgbW9kZWwgZmFpbHNcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0pKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0Ly8gaWdub3JlXG5cdFx0fSk7XG5cdH1cblxuXHRhc3luYyByZXJhbmsocXVlcnk6IHN0cmluZywgaXRlbXM6IENvbnRleHRJdGVtW10sIG9wdHM6IENwdVJlcmFua09wdGlvbnMpOiBQcm9taXNlPENvbnRleHRJdGVtW10+IHtcblx0XHQvLyBHcmFjZWZ1bGx5IGRlZ3JhZGUgaWYgcmVyYW5raW5nIGZhaWxzIC0gcmV0dXJuIG9yaWdpbmFsIGl0ZW1zIHVuY2hhbmdlZFxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBsaW1pdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDIwMCwgTWF0aC5mbG9vcihvcHRzLmxpbWl0KSkpO1xuXHRcdFx0Y29uc3Qgc2hvcnRsaXN0ID0gTWF0aC5tYXgobGltaXQsIE1hdGgubWluKDEyMCwgTWF0aC5mbG9vcihvcHRzLnNob3J0bGlzdCA/PyA2MCkpKTtcblx0XHRcdGNvbnN0IHFoID0gdGhpcy5oYXNoUXVlcnkocXVlcnkpO1xuXHRcdFx0Y29uc3QgbWFwID0gdGhpcy5jYWNoZS5nZXQocWgpID8/IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG5cdFx0XHR0aGlzLmNhY2hlLnNldChxaCwgbWFwKTtcblxuXHRcdFx0Y29uc3Qgc2NvcmVkOiBBcnJheTx7IGl0ZW06IENvbnRleHRJdGVtOyBzY29yZTogbnVtYmVyIH0+ID0gW107XG5cdFx0XHRjb25zdCBzbGljZSA9IGl0ZW1zLnNsaWNlKDAsIHNob3J0bGlzdCk7XG5cdFx0XHRmb3IgKGNvbnN0IGl0IG9mIHNsaWNlKSB7XG5cdFx0XHRcdGNvbnN0IGNhY2hlZCA9IG1hcC5nZXQoaXQua2V5KTtcblx0XHRcdFx0aWYgKHR5cGVvZiBjYWNoZWQgPT09ICdudW1iZXInKSB7XG5cdFx0XHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IGNhY2hlZCB9KTtcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IGRvYyA9IGAke2l0LnBhdGh9XFxuJHtpdC5leGNlcnB0fWA7XG5cdFx0XHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xuXHRcdFx0XHRcdG1hcC5zZXQoaXQua2V5LCByZXMuc2NvcmUpO1xuXHRcdFx0XHRcdHNjb3JlZC5wdXNoKHsgaXRlbTogaXQsIHNjb3JlOiByZXMuc2NvcmUgfSk7XG5cdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdC8vIElmIHJlcmFua2luZyBmYWlscyBmb3IgYW4gaXRlbSwgdXNlIG9yaWdpbmFsIHNjb3JlXG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIEZhaWxlZCB0byByZXJhbmsgaXRlbSAke2l0LmtleX0sIHVzaW5nIG9yaWdpbmFsIHNjb3JlOmAsIGVycik7XG5cdFx0XHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IGl0LnNjb3JlIH0pO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIE1lcmdlIHJlcmFuayBzY29yZSBpbnRvIGZpbmFsIG9yZGVyaW5nOyBrZWVwIG9yaWdpbmFsIHNjb3JlIGFzIHNlY29uZGFyeSBzaWduYWwuXG5cdFx0XHRjb25zdCBvdXQgPSBzY29yZWRcblx0XHRcdFx0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlIHx8IGIuaXRlbS5zY29yZSAtIGEuaXRlbS5zY29yZSlcblx0XHRcdFx0LnNsaWNlKDAsIGxpbWl0KVxuXHRcdFx0XHQubWFwKChzKSA9PiAoe1xuXHRcdFx0XHRcdC4uLnMuaXRlbSxcblx0XHRcdFx0XHQvLyBLZWVwIHRoZSBzY29yZSBmaWVsZCBhcyB0aGUgcmVyYW5rIHNjb3JlIHNvIGZvcm1hdHRpbmcgcmVmbGVjdHMgdHJ1ZSBvcmRlci5cblx0XHRcdFx0XHRzY29yZTogcy5zY29yZSxcblx0XHRcdFx0XHRzb3VyY2U6ICdyZXJhbmsnLFxuXHRcdFx0XHRcdHJlYXNvblRhZ3M6IEFycmF5LmZyb20obmV3IFNldChbLi4uKHMuaXRlbS5yZWFzb25UYWdzID8/IFtdKSwgJ3JlcmFuayddKSlcblx0XHRcdFx0fSkpO1xuXG5cdFx0XHRyZXR1cm4gb3V0O1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Ly8gSWYgcmVyYW5raW5nIGNvbXBsZXRlbHkgZmFpbHMgKG1vZGVsIG5vdCBsb2FkZWQsIG5ldHdvcmsgZXJyb3IsIGV0Yy4pLCByZXR1cm4gb3JpZ2luYWwgaXRlbXNcblx0XHRcdGNvbnNvbGUud2FybignW0NwdVJlcmFua2VyXSBSZXJhbmtpbmcgZmFpbGVkLCByZXR1cm5pbmcgb3JpZ2luYWwgcmVzdWx0czonLCBlcnIpO1xuXHRcdFx0cmV0dXJuIGl0ZW1zLnNsaWNlKDAsIG9wdHMubGltaXQpO1xuXHRcdH1cblx0fVxufVxuXG5cbiJdfQ==