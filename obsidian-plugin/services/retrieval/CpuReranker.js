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
            // Configure WASM paths - try multiple approaches
            console.log(`[CpuReranker] [STEP 3] Attempting to configure WASM paths...`);
            if (env) {
                // Approach 1: Try env.useWasm() if available (transformers.js API)
                if (typeof env.useWasm === 'function') {
                    try {
                        console.log(`[CpuReranker] [STEP 3] Attempting env.useWasm()...`);
                        env.useWasm();
                        console.log(`[CpuReranker] [STEP 3] ✓ Called env.useWasm()`);
                    }
                    catch (useWasmErr) {
                        console.warn(`[CpuReranker] [STEP 3] env.useWasm() failed:`, useWasmErr);
                    }
                }
                // Approach 2: Try to configure WASM paths via backends.onnx.env.wasm
                if (env.backends?.onnx) {
                    const onnxBackend = env.backends.onnx;
                    console.log(`[CpuReranker] [STEP 3] ✓ ONNX backend found via ${envSource}`);
                    // Try to find the actual ONNX Runtime environment
                    let wasmEnv = null;
                    let wasmEnvPath = 'none';
                    if (onnxBackend.env?.wasm) {
                        console.log(`[CpuReranker] [STEP 3] ✓ Found WASM env at onnxBackend.env.wasm`);
                        wasmEnv = onnxBackend.env.wasm;
                        wasmEnvPath = 'onnxBackend.env.wasm';
                    }
                    else if (onnxBackend.wasm) {
                        console.log(`[CpuReranker] [STEP 3] ✓ Found WASM env at onnxBackend.wasm`);
                        wasmEnv = onnxBackend.wasm;
                        wasmEnvPath = 'onnxBackend.wasm';
                    }
                    else if (onnxBackend.env) {
                        console.log(`[CpuReranker] [STEP 3] ✓ Found env at onnxBackend.env (trying as WASM env)`);
                        wasmEnv = onnxBackend.env;
                        wasmEnvPath = 'onnxBackend.env';
                    }
                    if (wasmEnv) {
                        const wasmBasePath = './lib/';
                        console.log(`[CpuReranker] [STEP 3] Configuring WASM paths at: ${wasmEnvPath}`);
                        if ('wasmPaths' in wasmEnv) {
                            try {
                                wasmEnv.wasmPaths = wasmBasePath;
                                console.log(`[CpuReranker] [STEP 3] ✓ Set wasmPaths to: ${wasmBasePath}`);
                            }
                            catch (pathErr) {
                                console.warn(`[CpuReranker] [STEP 3] Failed to set wasmPaths:`, pathErr);
                            }
                        }
                        else {
                            try {
                                Object.defineProperty(wasmEnv, 'wasmPaths', {
                                    value: wasmBasePath,
                                    writable: true,
                                    enumerable: true,
                                    configurable: true
                                });
                                console.log(`[CpuReranker] [STEP 3] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
                            }
                            catch (defineErr) {
                                console.warn(`[CpuReranker] [STEP 3] Failed to define wasmPaths:`, defineErr);
                            }
                        }
                    }
                }
                // Approach 3: Try to set env.wasmPaths directly if available
                if ('wasmPaths' in env) {
                    try {
                        const wasmBasePath = './lib/';
                        console.log(`[CpuReranker] [STEP 3] Found env.wasmPaths, setting to: ${wasmBasePath}`);
                        env.wasmPaths = wasmBasePath;
                        console.log(`[CpuReranker] [STEP 3] ✓ Set env.wasmPaths to: ${wasmBasePath}`);
                    }
                    catch (envPathErr) {
                        console.warn(`[CpuReranker] [STEP 3] Failed to set env.wasmPaths:`, envPathErr);
                    }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQTJMOUMsQ0FBQztJQXpMUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1lBQzVELE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBRXBFLDJDQUEyQztZ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QUssRUFBRSxHQUFHLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQztRQUM3QyxDQUFDO1FBRUQsbUZBQW1GO1FBQ25GLE1BQU0sR0FBRyxHQUFHLE1BQU07YUFDaEIsSUFBSSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsS0FBSyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDO2FBQ2hFLEtBQUssQ0FBQyxDQUFDLEVBQUUsS0FBSyxDQUFDO2FBQ2YsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBQ1osR0FBRyxDQUFDLENBQUMsSUFBSTtZQUNULDhFQUE4RTtZQUM5RSxLQUFLLEVBQUUsQ0FBQyxDQUFDLEtBQUs7WUFDZCxNQUFNLEVBQUUsUUFBUTtZQUNoQixVQUFVLEVBQUUsS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDO1NBQ3pFLENBQUMsQ0FBQyxDQUFDO1FBRUwsT0FBTyxHQUFHLENBQUM7SUFDWixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IENvbnRleHRJdGVtIH0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB0eXBlIHsgQ3B1UmVyYW5rZXJNb2RlbCB9IGZyb20gJy4vUmVyYW5rZXJNb2RlbCc7XHJcbmltcG9ydCB7IGZudjFhMzIgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XHJcblxyXG5mdW5jdGlvbiBjbGFtcDAxKHg6IG51bWJlcik6IG51bWJlciB7XHJcblx0aWYgKCFOdW1iZXIuaXNGaW5pdGUoeCkpIHJldHVybiAwO1xyXG5cdHJldHVybiBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCB4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQoczogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gKHMgfHwgJycpLnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDUFUgcmVyYW5rZXIgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBJZiB0aGUgbW9kZWwgZmFpbHMgdG8gbG9hZC9ydW4sIGNhbGxlcnMgc2hvdWxkIGZhbGwgYmFjayB0byB0aGUgcHJlLXJlcmFuayBvcmRlci5cclxuICovXHJcbmNsYXNzIFRyYW5zZm9ybWVyc0Nyb3NzRW5jb2RlciBpbXBsZW1lbnRzIENwdVJlcmFua2VyTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkID0gJ2Nyb3NzLWVuY29kZXItbXNtYXJjby1taW5pbG0nO1xyXG5cclxuXHRwcml2YXRlIHBpcGVsaW5lOlxyXG5cdFx0fCBudWxsXHJcblx0XHR8ICgoaW5wdXQ6IHN0cmluZyB8IEFycmF5PHsgdGV4dDogc3RyaW5nOyB0ZXh0X3BhaXI6IHN0cmluZyB9PikgPT4gUHJvbWlzZTx1bmtub3duPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cclxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSByZXR1cm47XHJcblx0XHRpZiAodGhpcy5sb2FkaW5nICE9PSBudWxsKSByZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdID09PSBTVEFSVElORyBSRVJBTktFUiBMT0FEID09PWApO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeVxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSBJbXBvcnRpbmcgdHJhbnNmb3JtZXJzLmpzIG1vZHVsZS4uLmApO1xyXG5cdFx0XHRsZXQgdHJhbnNmb3JtZXJzTW9kdWxlOiBhbnk7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0dHJhbnNmb3JtZXJzTW9kdWxlID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMV0g4pyTIE1vZHVsZSBpbXBvcnRlZCBzdWNjZXNzZnVsbHlgKTtcclxuXHRcdFx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSDinJcgTW9kdWxlIGltcG9ydCBmYWlsZWQ6YCwgaW1wb3J0RXJyKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudFxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSBMb2NhdGluZyBlbnZpcm9ubWVudCBzdHJ1Y3R1cmUuLi5gKTtcclxuXHRcdFx0bGV0IGVudjogYW55ID0gbnVsbDtcclxuXHRcdFx0bGV0IGVudlNvdXJjZSA9ICdub25lJztcclxuXHRcdFx0XHJcblx0XHRcdC8vIE1ldGhvZCAxOiBEaXJlY3QgZW52IChzdGFuZGFyZClcclxuXHRcdFx0aWYgKHRyYW5zZm9ybWVyc01vZHVsZS5lbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSDinJMgRm91bmQgZW52IHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuZW52YCk7XHJcblx0XHRcdFx0ZW52ID0gdHJhbnNmb3JtZXJzTW9kdWxlLmVudjtcclxuXHRcdFx0XHRlbnZTb3VyY2UgPSAndHJhbnNmb3JtZXJzTW9kdWxlLmVudic7XHJcblx0XHRcdH1cclxuXHRcdFx0Ly8gTWV0aG9kIDI6IGRlZmF1bHQuZW52IChpZiBkZWZhdWx0IGV4cG9ydClcclxuXHRcdFx0ZWxzZSBpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LmVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIOKckyBGb3VuZCBlbnYgdmlhIHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudmApO1xyXG5cdFx0XHRcdGVudiA9IHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudjtcclxuXHRcdFx0XHRlbnZTb3VyY2UgPSAndHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52JztcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0aWYgKGVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIGVudi5iYWNrZW5kcyBleGlzdHM6YCwgJ2JhY2tlbmRzJyBpbiBlbnYpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIGVudi5iYWNrZW5kcy5vbm54IGV4aXN0czpgLCBlbnYuYmFja2VuZHM/Lm9ubnggIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDJdIOKclyBDb3VsZCBub3QgZmluZCBlbnYgc3RydWN0dXJlYCk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIENvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gdHJ5IG11bHRpcGxlIGFwcHJvYWNoZXNcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBjb25maWd1cmUgV0FTTSBwYXRocy4uLmApO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKGVudikge1xyXG5cdFx0XHRcdC8vIEFwcHJvYWNoIDE6IFRyeSBlbnYudXNlV2FzbSgpIGlmIGF2YWlsYWJsZSAodHJhbnNmb3JtZXJzLmpzIEFQSSlcclxuXHRcdFx0XHRpZiAodHlwZW9mIGVudi51c2VXYXNtID09PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBBdHRlbXB0aW5nIGVudi51c2VXYXNtKCkuLi5gKTtcclxuXHRcdFx0XHRcdFx0ZW52LnVzZVdhc20oKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIENhbGxlZCBlbnYudXNlV2FzbSgpYCk7XHJcblx0XHRcdFx0XHR9IGNhdGNoICh1c2VXYXNtRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBlbnYudXNlV2FzbSgpIGZhaWxlZDpgLCB1c2VXYXNtRXJyKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gQXBwcm9hY2ggMjogVHJ5IHRvIGNvbmZpZ3VyZSBXQVNNIHBhdGhzIHZpYSBiYWNrZW5kcy5vbm54LmVudi53YXNtXHJcblx0XHRcdFx0aWYgKGVudi5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0XHRcdFx0Y29uc3Qgb25ueEJhY2tlbmQgPSBlbnYuYmFja2VuZHMub25ueDtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhICR7ZW52U291cmNlfWApO1xyXG5cdFx0XHRcdFx0XHJcblx0XHRcdFx0XHQvLyBUcnkgdG8gZmluZCB0aGUgYWN0dWFsIE9OTlggUnVudGltZSBlbnZpcm9ubWVudFxyXG5cdFx0XHRcdFx0bGV0IHdhc21FbnY6IGFueSA9IG51bGw7XHJcblx0XHRcdFx0XHRsZXQgd2FzbUVudlBhdGggPSAnbm9uZSc7XHJcblx0XHRcdFx0XHRcclxuXHRcdFx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLmVudi53YXNtYCk7XHJcblx0XHRcdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcclxuXHRcdFx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQuZW52Lndhc20nO1xyXG5cdFx0XHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC53YXNtKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC53YXNtYCk7XHJcblx0XHRcdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC53YXNtO1xyXG5cdFx0XHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC53YXNtJztcclxuXHRcdFx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQuZW52KSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgYXQgb25ueEJhY2tlbmQuZW52ICh0cnlpbmcgYXMgV0FTTSBlbnYpYCk7XHJcblx0XHRcdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC5lbnY7XHJcblx0XHRcdFx0XHRcdHdhc21FbnZQYXRoID0gJ29ubnhCYWNrZW5kLmVudic7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcclxuXHRcdFx0XHRcdGlmICh3YXNtRW52KSB7XHJcblx0XHRcdFx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBDb25maWd1cmluZyBXQVNNIHBhdGhzIGF0OiAke3dhc21FbnZQYXRofWApO1xyXG5cdFx0XHRcdFx0XHRcclxuXHRcdFx0XHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIHdhc21FbnYpIHtcclxuXHRcdFx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRcdFx0d2FzbUVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgU2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHRcdFx0fSBjYXRjaCAocGF0aEVycikge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzOmAsIHBhdGhFcnIpO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KHdhc21FbnYsICd3YXNtUGF0aHMnLCB7XHJcblx0XHRcdFx0XHRcdFx0XHRcdHZhbHVlOiB3YXNtQmFzZVBhdGgsXHJcblx0XHRcdFx0XHRcdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRcdFx0XHRlbnVtZXJhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRcdFx0XHRjb25maWd1cmFibGU6IHRydWVcclxuXHRcdFx0XHRcdFx0XHRcdH0pO1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0XHRcdH0gY2F0Y2ggKGRlZmluZUVycikge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIEZhaWxlZCB0byBkZWZpbmUgd2FzbVBhdGhzOmAsIGRlZmluZUVycik7XHJcblx0XHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIEFwcHJvYWNoIDM6IFRyeSB0byBzZXQgZW52Lndhc21QYXRocyBkaXJlY3RseSBpZiBhdmFpbGFibGVcclxuXHRcdFx0XHRpZiAoJ3dhc21QYXRocycgaW4gZW52KSB7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gRm91bmQgZW52Lndhc21QYXRocywgc2V0dGluZyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHRcdGVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBTZXQgZW52Lndhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSBGYWlsZWQgdG8gc2V0IGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJcgQ2Fubm90IGNvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gZW52IG5vdCBmb3VuZGApO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBHZXQgcGlwZWxpbmUgZnVuY3Rpb25cclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRcdFx0Y29uc3QgcGlwZWxpbmUgPSB0cmFuc2Zvcm1lcnNNb2R1bGUucGlwZWxpbmUgfHwgdHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LnBpcGVsaW5lO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIOKclyBQaXBlbGluZSBub3QgZm91bmQgb3Igbm90IGEgZnVuY3Rpb25gKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1RyYW5zZm9ybWVycyBwaXBlbGluZSBpcyB1bmF2YWlsYWJsZScpO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSDinJMgUGlwZWxpbmUgZnVuY3Rpb24gZm91bmRgKTtcclxuXHJcblx0XHRcdC8vIENyb3NzLWVuY29kZXIgcmVyYW5rZXIgbW9kZWwgKHNtYWxsLWlzaCkuIEJlc3QtZWZmb3J0OiBtYXkgZmFpbCBvbiBzb21lIGVudmlyb25tZW50cy5cclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNV0gQ3JlYXRpbmcgY3Jvc3MtZW5jb2RlciBwaXBlbGluZS4uLmApO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSBNb2RlbDogWGVub3ZhL2Nyb3NzLWVuY29kZXItbXMtbWFyY28tTWluaUxNLUwtNi12MmApO1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnN0IHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoXHJcblx0XHRcdFx0XHQndGV4dC1jbGFzc2lmaWNhdGlvbicsXHJcblx0XHRcdFx0XHQnWGVub3ZhL2Nyb3NzLWVuY29kZXItbXMtbWFyY28tTWluaUxNLUwtNi12MicsXHJcblx0XHRcdFx0XHR7IHF1YW50aXplZDogdHJ1ZSB9XHJcblx0XHRcdFx0KTtcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiB1bmtub3duKSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAoaW5wdXQpID0+IGF3YWl0IHBpcGUoaW5wdXQpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBjcmVhdGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdID09PSBSRVJBTktFUiBMT0FEIENPTVBMRVRFID09PWApO1xyXG5cdFx0XHR9IGNhdGNoIChwaXBlRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkOmAsIHBpcGVFcnIpO1xyXG5cdFx0XHRcdHRocm93IHBpcGVFcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgcmVyYW5rUGFpcihxdWVyeTogc3RyaW5nLCBkb2N1bWVudDogc3RyaW5nKTogUHJvbWlzZTx7IHNjb3JlOiBudW1iZXIgfT4ge1xyXG5cdFx0Y29uc3QgcSA9IG5vcm1hbGl6ZVRleHQocXVlcnkpO1xyXG5cdFx0Y29uc3QgZCA9IG5vcm1hbGl6ZVRleHQoZG9jdW1lbnQpO1xyXG5cdFx0aWYgKCFxIHx8ICFkKSByZXR1cm4geyBzY29yZTogMCB9O1xyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdGlmICghdGhpcy5waXBlbGluZSkgdGhyb3cgbmV3IEVycm9yKCdSZXJhbmtlciBwaXBlbGluZSB1bmF2YWlsYWJsZScpO1xyXG5cclxuXHRcdC8vIFByZWZlciBwYWlyIGlucHV0IGlmIHN1cHBvcnRlZCBieSB0aGUgcGlwZWxpbmUgaW1wbGVtZW50YXRpb247IGZhbGwgYmFjayB0byBjb25jYXRlbmF0aW9uLlxyXG5cdFx0bGV0IG91dDogdW5rbm93bjtcclxuXHRcdHRyeSB7XHJcblx0XHRcdG91dCA9IGF3YWl0IHRoaXMucGlwZWxpbmUoW3sgdGV4dDogcSwgdGV4dF9wYWlyOiBkIH1dKTtcclxuXHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRvdXQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKGAke3F9XFxuXFxuJHtkfWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIENvbW1vbiBvdXRwdXQgZm9ybWF0czpcclxuXHRcdC8vIC0gW3sgbGFiZWw6ICdMQUJFTF8xJywgc2NvcmU6IDAuOTMgfSwgLi4uXVxyXG5cdFx0Ly8gLSB7IGxhYmVsLCBzY29yZSB9XHJcblx0XHRjb25zdCBmaXJzdCA9IEFycmF5LmlzQXJyYXkob3V0KSA/IG91dFswXSA6IG91dDtcclxuXHRcdGNvbnN0IG9iaiA9IGZpcnN0IGFzIHsgc2NvcmU/OiB1bmtub3duOyBsYWJlbD86IHVua25vd24gfTtcclxuXHRcdGNvbnN0IHNjb3JlID0gdHlwZW9mIG9iaj8uc2NvcmUgPT09ICdudW1iZXInID8gb2JqLnNjb3JlIDogMDtcclxuXHRcdHJldHVybiB7IHNjb3JlOiBjbGFtcDAxKHNjb3JlKSB9O1xyXG5cdH1cclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBDcHVSZXJhbmtPcHRpb25zIHtcclxuXHRsaW1pdDogbnVtYmVyOyAvLyBob3cgbWFueSBpdGVtcyB0byByZXR1cm5cclxuXHRzaG9ydGxpc3Q/OiBudW1iZXI7IC8vIGhvdyBtYW55IHRvIHNjb3JlXHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBDcHVSZXJhbmtlciB7XHJcblx0cHJpdmF0ZSByZWFkb25seSBtb2RlbDogQ3B1UmVyYW5rZXJNb2RlbDtcclxuXHQvLyBxdWVyeUhhc2ggLT4gaXRlbUtleSAtPiBzY29yZVxyXG5cdHByaXZhdGUgcmVhZG9ubHkgY2FjaGUgPSBuZXcgTWFwPHN0cmluZywgTWFwPHN0cmluZywgbnVtYmVyPj4oKTtcclxuXHJcblx0Y29uc3RydWN0b3IobW9kZWw/OiBDcHVSZXJhbmtlck1vZGVsKSB7XHJcblx0XHR0aGlzLm1vZGVsID0gbW9kZWwgPz8gbmV3IFRyYW5zZm9ybWVyc0Nyb3NzRW5jb2RlcigpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBoYXNoUXVlcnkocTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRcdHJldHVybiBmbnYxYTMyKG5vcm1hbGl6ZVRleHQocSkpO1xyXG5cdH1cclxuXHJcblx0d2FybShxdWVyeTogc3RyaW5nLCBpdGVtczogQ29udGV4dEl0ZW1bXSwgb3B0cz86IHsgc2hvcnRsaXN0PzogbnVtYmVyIH0pOiB2b2lkIHtcclxuXHRcdGNvbnN0IHNob3J0bGlzdCA9IE1hdGgubWF4KDEsIE1hdGgubWluKDEyMCwgTWF0aC5mbG9vcihvcHRzPy5zaG9ydGxpc3QgPz8gNDApKSk7XHJcblx0XHRjb25zdCBxaCA9IHRoaXMuaGFzaFF1ZXJ5KHF1ZXJ5KTtcclxuXHRcdGNvbnN0IG1hcCA9IHRoaXMuY2FjaGUuZ2V0KHFoKSA/PyBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xyXG5cdFx0dGhpcy5jYWNoZS5zZXQocWgsIG1hcCk7XHJcblxyXG5cdFx0Y29uc3QgdG9TY29yZSA9IGl0ZW1zLnNsaWNlKDAsIHNob3J0bGlzdCkuZmlsdGVyKChpdCkgPT4gIW1hcC5oYXMoaXQua2V5KSk7XHJcblx0XHRpZiAodG9TY29yZS5sZW5ndGggPT09IDApIHJldHVybjtcclxuXHJcblx0XHQvLyBGaXJlLWFuZC1mb3JnZXQgd2FybXVwOyBuZXZlciBibG9jayBVSS5cclxuXHRcdHZvaWQgKGFzeW5jICgpID0+IHtcclxuXHRcdFx0Zm9yIChjb25zdCBpdCBvZiB0b1Njb3JlKSB7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdGNvbnN0IGRvYyA9IGAke2l0LnBhdGh9XFxuJHtpdC5leGNlcnB0fWA7XHJcblx0XHRcdFx0XHRjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1vZGVsLnJlcmFua1BhaXIocXVlcnksIGRvYyk7XHJcblx0XHRcdFx0XHRtYXAuc2V0KGl0LmtleSwgcmVzLnNjb3JlKTtcclxuXHRcdFx0XHR9IGNhdGNoIHtcclxuXHRcdFx0XHRcdC8vIHN0b3Agd2FybWluZyBpZiBtb2RlbCBmYWlsc1xyXG5cdFx0XHRcdFx0YnJlYWs7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHR9KSgpLmNhdGNoKCgpID0+IHtcclxuXHRcdFx0Ly8gaWdub3JlXHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdGFzeW5jIHJlcmFuayhxdWVyeTogc3RyaW5nLCBpdGVtczogQ29udGV4dEl0ZW1bXSwgb3B0czogQ3B1UmVyYW5rT3B0aW9ucyk6IFByb21pc2U8Q29udGV4dEl0ZW1bXT4ge1xyXG5cdFx0Y29uc3QgbGltaXQgPSBNYXRoLm1heCgxLCBNYXRoLm1pbigyMDAsIE1hdGguZmxvb3Iob3B0cy5saW1pdCkpKTtcclxuXHRcdGNvbnN0IHNob3J0bGlzdCA9IE1hdGgubWF4KGxpbWl0LCBNYXRoLm1pbigxMjAsIE1hdGguZmxvb3Iob3B0cy5zaG9ydGxpc3QgPz8gNjApKSk7XHJcblx0XHRjb25zdCBxaCA9IHRoaXMuaGFzaFF1ZXJ5KHF1ZXJ5KTtcclxuXHRcdGNvbnN0IG1hcCA9IHRoaXMuY2FjaGUuZ2V0KHFoKSA/PyBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xyXG5cdFx0dGhpcy5jYWNoZS5zZXQocWgsIG1hcCk7XHJcblxyXG5cdFx0Y29uc3Qgc2NvcmVkOiBBcnJheTx7IGl0ZW06IENvbnRleHRJdGVtOyBzY29yZTogbnVtYmVyIH0+ID0gW107XHJcblx0XHRjb25zdCBzbGljZSA9IGl0ZW1zLnNsaWNlKDAsIHNob3J0bGlzdCk7XHJcblx0XHRmb3IgKGNvbnN0IGl0IG9mIHNsaWNlKSB7XHJcblx0XHRcdGNvbnN0IGNhY2hlZCA9IG1hcC5nZXQoaXQua2V5KTtcclxuXHRcdFx0aWYgKHR5cGVvZiBjYWNoZWQgPT09ICdudW1iZXInKSB7XHJcblx0XHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IGNhY2hlZCB9KTtcclxuXHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0fVxyXG5cdFx0XHRjb25zdCBkb2MgPSBgJHtpdC5wYXRofVxcbiR7aXQuZXhjZXJwdH1gO1xyXG5cdFx0XHRjb25zdCByZXMgPSBhd2FpdCB0aGlzLm1vZGVsLnJlcmFua1BhaXIocXVlcnksIGRvYyk7XHJcblx0XHRcdG1hcC5zZXQoaXQua2V5LCByZXMuc2NvcmUpO1xyXG5cdFx0XHRzY29yZWQucHVzaCh7IGl0ZW06IGl0LCBzY29yZTogcmVzLnNjb3JlIH0pO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIE1lcmdlIHJlcmFuayBzY29yZSBpbnRvIGZpbmFsIG9yZGVyaW5nOyBrZWVwIG9yaWdpbmFsIHNjb3JlIGFzIHNlY29uZGFyeSBzaWduYWwuXHJcblx0XHRjb25zdCBvdXQgPSBzY29yZWRcclxuXHRcdFx0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlIHx8IGIuaXRlbS5zY29yZSAtIGEuaXRlbS5zY29yZSlcclxuXHRcdFx0LnNsaWNlKDAsIGxpbWl0KVxyXG5cdFx0XHQubWFwKChzKSA9PiAoe1xyXG5cdFx0XHRcdC4uLnMuaXRlbSxcclxuXHRcdFx0XHQvLyBLZWVwIHRoZSBzY29yZSBmaWVsZCBhcyB0aGUgcmVyYW5rIHNjb3JlIHNvIGZvcm1hdHRpbmcgcmVmbGVjdHMgdHJ1ZSBvcmRlci5cclxuXHRcdFx0XHRzY29yZTogcy5zY29yZSxcclxuXHRcdFx0XHRzb3VyY2U6ICdyZXJhbmsnLFxyXG5cdFx0XHRcdHJlYXNvblRhZ3M6IEFycmF5LmZyb20obmV3IFNldChbLi4uKHMuaXRlbS5yZWFzb25UYWdzID8/IFtdKSwgJ3JlcmFuayddKSlcclxuXHRcdFx0fSkpO1xyXG5cclxuXHRcdHJldHVybiBvdXQ7XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19