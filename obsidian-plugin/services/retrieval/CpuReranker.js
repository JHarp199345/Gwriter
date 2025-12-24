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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQXdMOUMsQ0FBQztJQXRMUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1lBQzVELE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBRXBFLDJDQUEyQztZ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QUFNO2FBQ2hCLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEtBQUssSUFBSSxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQzthQUNoRSxLQUFLLENBQUMsQ0FBQyxFQUFFLEtBQUssQ0FBQzthQUNmLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQztZQUNaLEdBQUcsQ0FBQyxDQUFDLElBQUk7WUFDVCw4RUFBOEU7WUFDOUUsS0FBSyxFQUFFLENBQUMsQ0FBQyxLQUFLO1lBQ2QsTUFBTSxFQUFFLFFBQVE7WUFDaEIsVUFBVSxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxVQUFVLElBQUksRUFBRSxDQUFDLEVBQUUsUUFBUSxDQUFDLENBQUMsQ0FBQztTQUN6RSxDQUFDLENBQUMsQ0FBQztRQUVMLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb250ZXh0SXRlbSB9IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgdHlwZSB7IENwdVJlcmFua2VyTW9kZWwgfSBmcm9tICcuL1JlcmFua2VyTW9kZWwnO1xyXG5pbXBvcnQgeyBmbnYxYTMyIH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xyXG5cclxuZnVuY3Rpb24gY2xhbXAwMSh4OiBudW1iZXIpOiBudW1iZXIge1xyXG5cdGlmICghTnVtYmVyLmlzRmluaXRlKHgpKSByZXR1cm4gMDtcclxuXHRyZXR1cm4gTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgeCkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVUZXh0KHM6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0cmV0dXJuIChzIHx8ICcnKS5yZXBsYWNlKC9cXHMrL2csICcgJykudHJpbSgpO1xyXG59XHJcblxyXG4vKipcclxuICogQ1BVIHJlcmFua2VyIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cclxuICogSWYgdGhlIG1vZGVsIGZhaWxzIHRvIGxvYWQvcnVuLCBjYWxsZXJzIHNob3VsZCBmYWxsIGJhY2sgdG8gdGhlIHByZS1yZXJhbmsgb3JkZXIuXHJcbiAqL1xyXG5jbGFzcyBUcmFuc2Zvcm1lcnNDcm9zc0VuY29kZXIgaW1wbGVtZW50cyBDcHVSZXJhbmtlck1vZGVsIHtcclxuXHRyZWFkb25seSBpZCA9ICdjcm9zcy1lbmNvZGVyLW1zbWFyY28tbWluaWxtJztcclxuXHJcblx0cHJpdmF0ZSBwaXBlbGluZTpcclxuXHRcdHwgbnVsbFxyXG5cdFx0fCAoKGlucHV0OiBzdHJpbmcgfCBBcnJheTx7IHRleHQ6IHN0cmluZzsgdGV4dF9wYWlyOiBzdHJpbmcgfT4pID0+IFByb21pc2U8dW5rbm93bj4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5waXBlbGluZSkgcmV0dXJuO1xyXG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkgcmV0dXJuIHRoaXMubG9hZGluZztcclxuXHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSA9PT0gU1RBUlRJTkcgUkVSQU5LRVIgTE9BRCA9PT1gKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gVGltZXN0YW1wOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIEltcG9ydCB0aGUgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIGxpYnJhcnlcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMV0gSW1wb3J0aW5nIHRyYW5zZm9ybWVycy5qcyBtb2R1bGUuLi5gKTtcclxuXHRcdFx0bGV0IHRyYW5zZm9ybWVyc01vZHVsZTogYW55O1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdHRyYW5zZm9ybWVyc01vZHVsZSA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDFdIOKckyBNb2R1bGUgaW1wb3J0ZWQgc3VjY2Vzc2Z1bGx5YCk7XHJcblx0XHRcdH0gY2F0Y2ggKGltcG9ydEVycikge1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gW1NURVAgMV0g4pyXIE1vZHVsZSBpbXBvcnQgZmFpbGVkOmAsIGltcG9ydEVycik7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gaW1wb3J0IHRyYW5zZm9ybWVycy5qczogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIFRyeSBtdWx0aXBsZSB3YXlzIHRvIGFjY2VzcyB0aGUgZW52aXJvbm1lbnRcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gTG9jYXRpbmcgZW52aXJvbm1lbnQgc3RydWN0dXJlLi4uYCk7XHJcblx0XHRcdGxldCBlbnY6IGFueSA9IG51bGw7XHJcblx0XHRcdGxldCBlbnZTb3VyY2UgPSAnbm9uZSc7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBNZXRob2QgMTogRGlyZWN0IGVudiAoc3RhbmRhcmQpXHJcblx0XHRcdGlmICh0cmFuc2Zvcm1lcnNNb2R1bGUuZW52KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyTIEZvdW5kIGVudiB2aWEgdHJhbnNmb3JtZXJzTW9kdWxlLmVudmApO1xyXG5cdFx0XHRcdGVudiA9IHRyYW5zZm9ybWVyc01vZHVsZS5lbnY7XHJcblx0XHRcdFx0ZW52U291cmNlID0gJ3RyYW5zZm9ybWVyc01vZHVsZS5lbnYnO1xyXG5cdFx0XHR9XHJcblx0XHRcdC8vIE1ldGhvZCAyOiBkZWZhdWx0LmVudiAoaWYgZGVmYXVsdCBleHBvcnQpXHJcblx0XHRcdGVsc2UgaWYgKHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0Py5lbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSDinJMgRm91bmQgZW52IHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnZgKTtcclxuXHRcdFx0XHRlbnYgPSB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnY7XHJcblx0XHRcdFx0ZW52U291cmNlID0gJ3RyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudic7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdGlmIChlbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSBlbnYuYmFja2VuZHMgZXhpc3RzOmAsICdiYWNrZW5kcycgaW4gZW52KTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSBlbnYuYmFja2VuZHMub25ueCBleGlzdHM6YCwgZW52LmJhY2tlbmRzPy5vbm54ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIGVudi51c2VXYXNtIGV4aXN0czpgLCB0eXBlb2YgZW52LnVzZVdhc20gPT09ICdmdW5jdGlvbicpO1xyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSDinJcgQ291bGQgbm90IGZpbmQgZW52IHN0cnVjdHVyZWApO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIENSSVRJQ0FMOiBNdXN0IGJlIGRvbmUgQkVGT1JFIGFueSBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6YXRpb25cclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBjb25maWd1cmUgV0FTTSBwYXRocy4uLmApO1xyXG5cdFx0XHRcclxuXHRcdFx0Y29uc3Qgd2FzbUJhc2VQYXRoID0gJy4vbGliLyc7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoZW52KSB7XHJcblx0XHRcdFx0Ly8gQXBwcm9hY2ggMTogVHJ5IHRvIGFjY2VzcyBPTk5YIGJhY2tlbmQgZGlyZWN0bHkgZnJvbSB0aGUgbW9kdWxlXHJcblx0XHRcdFx0bGV0IG9ubnhCYWNrZW5kRW52OiBhbnkgPSBudWxsO1xyXG5cdFx0XHRcdGxldCBvbm54QmFja2VuZFBhdGggPSAnbm9uZSc7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0aWYgKHRyYW5zZm9ybWVyc01vZHVsZT8uT05OWCkge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIEZvdW5kIE9OTlggZXhwb3J0IGluIG1vZHVsZWApO1xyXG5cdFx0XHRcdFx0Y29uc3Qgb25ueCA9IHRyYW5zZm9ybWVyc01vZHVsZS5PTk5YO1xyXG5cdFx0XHRcdFx0aWYgKG9ubng/LmVudj8ud2FzbSkge1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnguZW52Lndhc207XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICd0cmFuc2Zvcm1lcnNNb2R1bGUuT05OWC5lbnYud2FzbSc7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBPTk5YIGVudi53YXNtIHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuT05OWGApO1xyXG5cdFx0XHRcdFx0fSBlbHNlIGlmIChvbm54Py5lbnYpIHtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54LmVudjtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ3RyYW5zZm9ybWVyc01vZHVsZS5PTk5YLmVudic7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBPTk5YIGVudiB2aWEgdHJhbnNmb3JtZXJzTW9kdWxlLk9OTlhgKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gQXBwcm9hY2ggMjogVHJ5IHZpYSBlbnYuYmFja2VuZHMub25ueCAodHJhbnNmb3JtZXJzLmpzIHN0cnVjdHVyZSlcclxuXHRcdFx0XHRpZiAoIW9ubnhCYWNrZW5kRW52ICYmIGVudi5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0XHRcdFx0Y29uc3Qgb25ueEJhY2tlbmQgPSBlbnYuYmFja2VuZHMub25ueDtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhIGVudi5iYWNrZW5kcy5vbm54YCk7XHJcblx0XHRcdFx0XHRcclxuXHRcdFx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcclxuXHRcdFx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ2Vudi5iYWNrZW5kcy5vbm54LmVudi53YXNtJztcclxuXHRcdFx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQud2FzbSkge1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnhCYWNrZW5kLndhc207XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdvbm54QmFja2VuZC53YXNtJztcclxuXHRcdFx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQuZW52KSB7XHJcblx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQuZW52O1xyXG5cdFx0XHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnb25ueEJhY2tlbmQuZW52JztcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gU2V0IHdhc21QYXRocyBvbiB0aGUgT05OWCBiYWNrZW5kIGVudmlyb25tZW50XHJcblx0XHRcdFx0aWYgKG9ubnhCYWNrZW5kRW52KSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBDb25maWd1cmluZyBXQVNNIHBhdGhzIGF0OiAke29ubnhCYWNrZW5kUGF0aH1gKTtcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiBvbm54QmFja2VuZEVudikge1xyXG5cdFx0XHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52Lndhc21QYXRocyA9IHdhc21CYXNlUGF0aDtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgVXBkYXRlZCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0XHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eShvbm54QmFja2VuZEVudiwgJ3dhc21QYXRocycsIHtcclxuXHRcdFx0XHRcdFx0XHRcdHZhbHVlOiB3YXNtQmFzZVBhdGgsXHJcblx0XHRcdFx0XHRcdFx0XHR3cml0YWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0XHRcdGVudW1lcmFibGU6IHRydWUsXHJcblx0XHRcdFx0XHRcdFx0XHRjb25maWd1cmFibGU6IHRydWVcclxuXHRcdFx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgQ3JlYXRlZCBhbmQgc2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdH0gY2F0Y2ggKHBhdGhFcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzIGF0ICR7b25ueEJhY2tlbmRQYXRofTpgLCBwYXRoRXJyKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKaoCBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnQgbm90IGZvdW5kIC0gbWF5IGluaXRpYWxpemUgbGF6aWx5YCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIEFwcHJvYWNoIDM6IEFsc28gdHJ5IHNldHRpbmcgYXQgdG9wLWxldmVsIGVudlxyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRpZiAoJ3dhc21QYXRocycgaW4gZW52KSB7XHJcblx0XHRcdFx0XHRcdGVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBBbHNvIHNldCBlbnYud2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gRmFpbGVkIHRvIHNldCB0b3AtbGV2ZWwgZW52Lndhc21QYXRoczpgLCBlbnZQYXRoRXJyKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBMb2NhdGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xyXG5cdFx0XHRjb25zdCBwaXBlbGluZSA9IHRyYW5zZm9ybWVyc01vZHVsZS5waXBlbGluZSB8fCB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdD8ucGlwZWxpbmU7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIFBpcGVsaW5lIGZvdW5kOmAsIHBpcGVsaW5lICE9PSB1bmRlZmluZWQgJiYgcGlwZWxpbmUgIT09IG51bGwpO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBQaXBlbGluZSB0eXBlOmAsIHR5cGVvZiBwaXBlbGluZSk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0g4pyXIFBpcGVsaW5lIG5vdCBmb3VuZCBvciBub3QgYSBmdW5jdGlvbmApO1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignVHJhbnNmb3JtZXJzIHBpcGVsaW5lIGlzIHVuYXZhaWxhYmxlJyk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xyXG5cclxuXHRcdFx0Ly8gQ3Jvc3MtZW5jb2RlciByZXJhbmtlciBtb2RlbCAoc21hbGwtaXNoKS4gQmVzdC1lZmZvcnQ6IG1heSBmYWlsIG9uIHNvbWUgZW52aXJvbm1lbnRzLlxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSBDcmVhdGluZyBjcm9zcy1lbmNvZGVyIHBpcGVsaW5lLi4uYCk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIE1vZGVsOiBYZW5vdmEvY3Jvc3MtZW5jb2Rlci1tcy1tYXJjby1NaW5pTE0tTC02LXYyYCk7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgcGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZShcclxuXHRcdFx0XHRcdCd0ZXh0LWNsYXNzaWZpY2F0aW9uJyxcclxuXHRcdFx0XHRcdCdYZW5vdmEvY3Jvc3MtZW5jb2Rlci1tcy1tYXJjby1NaW5pTE0tTC02LXYyJyxcclxuXHRcdFx0XHRcdHsgcXVhbnRpemVkOiB0cnVlIH1cclxuXHRcdFx0XHQpO1xyXG5cdFx0XHRcdGNvbnN0IHBpcGUgPSBwaXBlVW5rbm93biBhcyAoaW5wdXQ6IHVua25vd24pID0+IFByb21pc2U8dW5rbm93bj47XHJcblx0XHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jIChpbnB1dCkgPT4gYXdhaXQgcGlwZShpbnB1dCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNV0g4pyTIFBpcGVsaW5lIGNyZWF0ZWQgc3VjY2Vzc2Z1bGx5YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gPT09IFJFUkFOS0VSIExPQUQgQ09NUExFVEUgPT09YCk7XHJcblx0XHRcdH0gY2F0Y2ggKHBpcGVFcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIOKclyBQaXBlbGluZSBjcmVhdGlvbiBmYWlsZWQ6YCwgcGlwZUVycik7XHJcblx0XHRcdFx0dGhyb3cgcGlwZUVycjtcclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5maW5hbGx5KCgpID0+IHtcclxuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcclxuXHRcdH0pO1xyXG5cclxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0fVxyXG5cclxuXHRhc3luYyByZXJhbmtQYWlyKHF1ZXJ5OiBzdHJpbmcsIGRvY3VtZW50OiBzdHJpbmcpOiBQcm9taXNlPHsgc2NvcmU6IG51bWJlciB9PiB7XHJcblx0XHRjb25zdCBxID0gbm9ybWFsaXplVGV4dChxdWVyeSk7XHJcblx0XHRjb25zdCBkID0gbm9ybWFsaXplVGV4dChkb2N1bWVudCk7XHJcblx0XHRpZiAoIXEgfHwgIWQpIHJldHVybiB7IHNjb3JlOiAwIH07XHJcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB0aHJvdyBuZXcgRXJyb3IoJ1JlcmFua2VyIHBpcGVsaW5lIHVuYXZhaWxhYmxlJyk7XHJcblxyXG5cdFx0Ly8gUHJlZmVyIHBhaXIgaW5wdXQgaWYgc3VwcG9ydGVkIGJ5IHRoZSBwaXBlbGluZSBpbXBsZW1lbnRhdGlvbjsgZmFsbCBiYWNrIHRvIGNvbmNhdGVuYXRpb24uXHJcblx0XHRsZXQgb3V0OiB1bmtub3duO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0b3V0ID0gYXdhaXQgdGhpcy5waXBlbGluZShbeyB0ZXh0OiBxLCB0ZXh0X3BhaXI6IGQgfV0pO1xyXG5cdFx0fSBjYXRjaCB7XHJcblx0XHRcdG91dCA9IGF3YWl0IHRoaXMucGlwZWxpbmUoYCR7cX1cXG5cXG4ke2R9YCk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gQ29tbW9uIG91dHB1dCBmb3JtYXRzOlxyXG5cdFx0Ly8gLSBbeyBsYWJlbDogJ0xBQkVMXzEnLCBzY29yZTogMC45MyB9LCAuLi5dXHJcblx0XHQvLyAtIHsgbGFiZWwsIHNjb3JlIH1cclxuXHRcdGNvbnN0IGZpcnN0ID0gQXJyYXkuaXNBcnJheShvdXQpID8gb3V0WzBdIDogb3V0O1xyXG5cdFx0Y29uc3Qgb2JqID0gZmlyc3QgYXMgeyBzY29yZT86IHVua25vd247IGxhYmVsPzogdW5rbm93biB9O1xyXG5cdFx0Y29uc3Qgc2NvcmUgPSB0eXBlb2Ygb2JqPy5zY29yZSA9PT0gJ251bWJlcicgPyBvYmouc2NvcmUgOiAwO1xyXG5cdFx0cmV0dXJuIHsgc2NvcmU6IGNsYW1wMDEoc2NvcmUpIH07XHJcblx0fVxyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIENwdVJlcmFua09wdGlvbnMge1xyXG5cdGxpbWl0OiBudW1iZXI7IC8vIGhvdyBtYW55IGl0ZW1zIHRvIHJldHVyblxyXG5cdHNob3J0bGlzdD86IG51bWJlcjsgLy8gaG93IG1hbnkgdG8gc2NvcmVcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIENwdVJlcmFua2VyIHtcclxuXHRwcml2YXRlIHJlYWRvbmx5IG1vZGVsOiBDcHVSZXJhbmtlck1vZGVsO1xyXG5cdC8vIHF1ZXJ5SGFzaCAtPiBpdGVtS2V5IC0+IHNjb3JlXHJcblx0cHJpdmF0ZSByZWFkb25seSBjYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBNYXA8c3RyaW5nLCBudW1iZXI+PigpO1xyXG5cclxuXHRjb25zdHJ1Y3Rvcihtb2RlbD86IENwdVJlcmFua2VyTW9kZWwpIHtcclxuXHRcdHRoaXMubW9kZWwgPSBtb2RlbCA/PyBuZXcgVHJhbnNmb3JtZXJzQ3Jvc3NFbmNvZGVyKCk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGhhc2hRdWVyeShxOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdFx0cmV0dXJuIGZudjFhMzIobm9ybWFsaXplVGV4dChxKSk7XHJcblx0fVxyXG5cclxuXHR3YXJtKHF1ZXJ5OiBzdHJpbmcsIGl0ZW1zOiBDb250ZXh0SXRlbVtdLCBvcHRzPzogeyBzaG9ydGxpc3Q/OiBudW1iZXIgfSk6IHZvaWQge1xyXG5cdFx0Y29uc3Qgc2hvcnRsaXN0ID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oMTIwLCBNYXRoLmZsb29yKG9wdHM/LnNob3J0bGlzdCA/PyA0MCkpKTtcclxuXHRcdGNvbnN0IHFoID0gdGhpcy5oYXNoUXVlcnkocXVlcnkpO1xyXG5cdFx0Y29uc3QgbWFwID0gdGhpcy5jYWNoZS5nZXQocWgpID8/IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XHJcblx0XHR0aGlzLmNhY2hlLnNldChxaCwgbWFwKTtcclxuXHJcblx0XHRjb25zdCB0b1Njb3JlID0gaXRlbXMuc2xpY2UoMCwgc2hvcnRsaXN0KS5maWx0ZXIoKGl0KSA9PiAhbWFwLmhhcyhpdC5rZXkpKTtcclxuXHRcdGlmICh0b1Njb3JlLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xyXG5cclxuXHRcdC8vIEZpcmUtYW5kLWZvcmdldCB3YXJtdXA7IG5ldmVyIGJsb2NrIFVJLlxyXG5cdFx0dm9pZCAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHRmb3IgKGNvbnN0IGl0IG9mIHRvU2NvcmUpIHtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgZG9jID0gYCR7aXQucGF0aH1cXG4ke2l0LmV4Y2VycHR9YDtcclxuXHRcdFx0XHRcdGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubW9kZWwucmVyYW5rUGFpcihxdWVyeSwgZG9jKTtcclxuXHRcdFx0XHRcdG1hcC5zZXQoaXQua2V5LCByZXMuc2NvcmUpO1xyXG5cdFx0XHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRcdFx0Ly8gc3RvcCB3YXJtaW5nIGlmIG1vZGVsIGZhaWxzXHJcblx0XHRcdFx0XHRicmVhaztcclxuXHRcdFx0XHR9XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuY2F0Y2goKCkgPT4ge1xyXG5cdFx0XHQvLyBpZ25vcmVcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgcmVyYW5rKHF1ZXJ5OiBzdHJpbmcsIGl0ZW1zOiBDb250ZXh0SXRlbVtdLCBvcHRzOiBDcHVSZXJhbmtPcHRpb25zKTogUHJvbWlzZTxDb250ZXh0SXRlbVtdPiB7XHJcblx0XHRjb25zdCBsaW1pdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDIwMCwgTWF0aC5mbG9vcihvcHRzLmxpbWl0KSkpO1xyXG5cdFx0Y29uc3Qgc2hvcnRsaXN0ID0gTWF0aC5tYXgobGltaXQsIE1hdGgubWluKDEyMCwgTWF0aC5mbG9vcihvcHRzLnNob3J0bGlzdCA/PyA2MCkpKTtcclxuXHRcdGNvbnN0IHFoID0gdGhpcy5oYXNoUXVlcnkocXVlcnkpO1xyXG5cdFx0Y29uc3QgbWFwID0gdGhpcy5jYWNoZS5nZXQocWgpID8/IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XHJcblx0XHR0aGlzLmNhY2hlLnNldChxaCwgbWFwKTtcclxuXHJcblx0XHRjb25zdCBzY29yZWQ6IEFycmF5PHsgaXRlbTogQ29udGV4dEl0ZW07IHNjb3JlOiBudW1iZXIgfT4gPSBbXTtcclxuXHRcdGNvbnN0IHNsaWNlID0gaXRlbXMuc2xpY2UoMCwgc2hvcnRsaXN0KTtcclxuXHRcdGZvciAoY29uc3QgaXQgb2Ygc2xpY2UpIHtcclxuXHRcdFx0Y29uc3QgY2FjaGVkID0gbWFwLmdldChpdC5rZXkpO1xyXG5cdFx0XHRpZiAodHlwZW9mIGNhY2hlZCA9PT0gJ251bWJlcicpIHtcclxuXHRcdFx0XHRzY29yZWQucHVzaCh7IGl0ZW06IGl0LCBzY29yZTogY2FjaGVkIH0pO1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblx0XHRcdGNvbnN0IGRvYyA9IGAke2l0LnBhdGh9XFxuJHtpdC5leGNlcnB0fWA7XHJcblx0XHRcdGNvbnN0IHJlcyA9IGF3YWl0IHRoaXMubW9kZWwucmVyYW5rUGFpcihxdWVyeSwgZG9jKTtcclxuXHRcdFx0bWFwLnNldChpdC5rZXksIHJlcy5zY29yZSk7XHJcblx0XHRcdHNjb3JlZC5wdXNoKHsgaXRlbTogaXQsIHNjb3JlOiByZXMuc2NvcmUgfSk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gTWVyZ2UgcmVyYW5rIHNjb3JlIGludG8gZmluYWwgb3JkZXJpbmc7IGtlZXAgb3JpZ2luYWwgc2NvcmUgYXMgc2Vjb25kYXJ5IHNpZ25hbC5cclxuXHRcdGNvbnN0IG91dCA9IHNjb3JlZFxyXG5cdFx0XHQuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUgfHwgYi5pdGVtLnNjb3JlIC0gYS5pdGVtLnNjb3JlKVxyXG5cdFx0XHQuc2xpY2UoMCwgbGltaXQpXHJcblx0XHRcdC5tYXAoKHMpID0+ICh7XHJcblx0XHRcdFx0Li4ucy5pdGVtLFxyXG5cdFx0XHRcdC8vIEtlZXAgdGhlIHNjb3JlIGZpZWxkIGFzIHRoZSByZXJhbmsgc2NvcmUgc28gZm9ybWF0dGluZyByZWZsZWN0cyB0cnVlIG9yZGVyLlxyXG5cdFx0XHRcdHNjb3JlOiBzLnNjb3JlLFxyXG5cdFx0XHRcdHNvdXJjZTogJ3JlcmFuaycsXHJcblx0XHRcdFx0cmVhc29uVGFnczogQXJyYXkuZnJvbShuZXcgU2V0KFsuLi4ocy5pdGVtLnJlYXNvblRhZ3MgPz8gW10pLCAncmVyYW5rJ10pKVxyXG5cdFx0XHR9KSk7XHJcblxyXG5cdFx0cmV0dXJuIG91dDtcclxuXHR9XHJcbn1cclxuXHJcblxyXG4iXX0=