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
            // Try multiple ways to access the environment - DON'T CREATE FAKE ONES
            console.log(`[CpuReranker] [STEP 2] Locating ONNX environment structure...`);
            let env = null;
            let envSource = 'none';
            // Method 1: Direct env (standard)
            if (transformersModule.env?.backends?.onnx) {
                console.log(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.env.backends.onnx`);
                env = transformersModule.env;
                envSource = 'transformersModule.env';
            }
            // Method 2: default.env (if default export)
            else if (transformersModule.default?.env?.backends?.onnx) {
                console.log(`[CpuReranker] [STEP 2] ✓ Found env via transformersModule.default.env.backends.onnx`);
                env = transformersModule.default.env;
                envSource = 'transformersModule.default.env';
            }
            else {
                console.warn(`[CpuReranker] [STEP 2] ✗ Could not find ONNX environment structure`);
            }
            // Configure WASM paths ONLY if the real ONNX environment exists
            console.log(`[CpuReranker] [STEP 3] Attempting to configure WASM paths...`);
            if (env && env.backends && env.backends.onnx) {
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
                else {
                    console.warn(`[CpuReranker] [STEP 3] ✗ WASM environment not found`);
                }
                if (wasmEnv) {
                    // Use string-based path (base directory) like transformers.js does
                    const wasmBasePath = './lib/';
                    console.log(`[CpuReranker] [STEP 3] Setting wasmPaths to: ${wasmBasePath}`);
                    wasmEnv.wasmPaths = wasmBasePath;
                    console.log(`[CpuReranker] [STEP 3] ✓ WASM paths configured at ${wasmEnvPath}`);
                }
                else {
                    console.error(`[CpuReranker] [STEP 3] ✗ Cannot configure WASM paths - WASM environment not found`);
                }
            }
            else {
                console.error(`[CpuReranker] [STEP 3] ✗ Cannot configure WASM paths - ONNX backend not found`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ3B1UmVyYW5rZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJDcHVSZXJhbmtlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFekMsU0FBUyxPQUFPLENBQUMsQ0FBUztJQUN6QixJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7UUFBRSxPQUFPLENBQUMsQ0FBQztJQUNsQyxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEMsQ0FBQztBQUVELFNBQVMsYUFBYSxDQUFDLENBQVM7SUFDL0IsT0FBTyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0FBQzlDLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLHdCQUF3QjtJQUE5QjtRQUNVLE9BQUUsR0FBRyw4QkFBOEIsQ0FBQztRQUVyQyxhQUFRLEdBRXdFLElBQUksQ0FBQztRQUNyRixZQUFPLEdBQXlCLElBQUksQ0FBQztJQTBJOUMsQ0FBQztJQXhJUSxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1lBQzVELE9BQU8sQ0FBQyxHQUFHLENBQUMsNEJBQTRCLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1lBRXBFLDJDQUEyQztZ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Q3pFLENBQUMsQ0FBQyxDQUFDO1FBRUwsT0FBTyxHQUFHLENBQUM7SUFDWixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IENvbnRleHRJdGVtIH0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB0eXBlIHsgQ3B1UmVyYW5rZXJNb2RlbCB9IGZyb20gJy4vUmVyYW5rZXJNb2RlbCc7XHJcbmltcG9ydCB7IGZudjFhMzIgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XHJcblxyXG5mdW5jdGlvbiBjbGFtcDAxKHg6IG51bWJlcik6IG51bWJlciB7XHJcblx0aWYgKCFOdW1iZXIuaXNGaW5pdGUoeCkpIHJldHVybiAwO1xyXG5cdHJldHVybiBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCB4KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQoczogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gKHMgfHwgJycpLnJlcGxhY2UoL1xccysvZywgJyAnKS50cmltKCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBDUFUgcmVyYW5rZXIgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBJZiB0aGUgbW9kZWwgZmFpbHMgdG8gbG9hZC9ydW4sIGNhbGxlcnMgc2hvdWxkIGZhbGwgYmFjayB0byB0aGUgcHJlLXJlcmFuayBvcmRlci5cclxuICovXHJcbmNsYXNzIFRyYW5zZm9ybWVyc0Nyb3NzRW5jb2RlciBpbXBsZW1lbnRzIENwdVJlcmFua2VyTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkID0gJ2Nyb3NzLWVuY29kZXItbXNtYXJjby1taW5pbG0nO1xyXG5cclxuXHRwcml2YXRlIHBpcGVsaW5lOlxyXG5cdFx0fCBudWxsXHJcblx0XHR8ICgoaW5wdXQ6IHN0cmluZyB8IEFycmF5PHsgdGV4dDogc3RyaW5nOyB0ZXh0X3BhaXI6IHN0cmluZyB9PikgPT4gUHJvbWlzZTx1bmtub3duPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cclxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSByZXR1cm47XHJcblx0XHRpZiAodGhpcy5sb2FkaW5nICE9PSBudWxsKSByZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdID09PSBTVEFSVElORyBSRVJBTktFUiBMT0FEID09PWApO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeVxyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSBJbXBvcnRpbmcgdHJhbnNmb3JtZXJzLmpzIG1vZHVsZS4uLmApO1xyXG5cdFx0XHRsZXQgdHJhbnNmb3JtZXJzTW9kdWxlOiBhbnk7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0dHJhbnNmb3JtZXJzTW9kdWxlID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMV0g4pyTIE1vZHVsZSBpbXBvcnRlZCBzdWNjZXNzZnVsbHlgKTtcclxuXHRcdFx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCAxXSDinJcgTW9kdWxlIGltcG9ydCBmYWlsZWQ6YCwgaW1wb3J0RXJyKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudCAtIERPTidUIENSRUFURSBGQUtFIE9ORVNcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0gTG9jYXRpbmcgT05OWCBlbnZpcm9ubWVudCBzdHJ1Y3R1cmUuLi5gKTtcclxuXHRcdFx0bGV0IGVudjogYW55ID0gbnVsbDtcclxuXHRcdFx0bGV0IGVudlNvdXJjZSA9ICdub25lJztcclxuXHRcdFx0XHJcblx0XHRcdC8vIE1ldGhvZCAxOiBEaXJlY3QgZW52IChzdGFuZGFyZClcclxuXHRcdFx0aWYgKHRyYW5zZm9ybWVyc01vZHVsZS5lbnY/LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyTIEZvdW5kIGVudiB2aWEgdHJhbnNmb3JtZXJzTW9kdWxlLmVudi5iYWNrZW5kcy5vbm54YCk7XHJcblx0XHRcdFx0ZW52ID0gdHJhbnNmb3JtZXJzTW9kdWxlLmVudjtcclxuXHRcdFx0XHRlbnZTb3VyY2UgPSAndHJhbnNmb3JtZXJzTW9kdWxlLmVudic7XHJcblx0XHRcdH1cclxuXHRcdFx0Ly8gTWV0aG9kIDI6IGRlZmF1bHQuZW52IChpZiBkZWZhdWx0IGV4cG9ydClcclxuXHRcdFx0ZWxzZSBpZiAodHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQ/LmVudj8uYmFja2VuZHM/Lm9ubngpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAyXSDinJMgRm91bmQgZW52IHZpYSB0cmFuc2Zvcm1lcnNNb2R1bGUuZGVmYXVsdC5lbnYuYmFja2VuZHMub25ueGApO1xyXG5cdFx0XHRcdGVudiA9IHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0LmVudjtcclxuXHRcdFx0XHRlbnZTb3VyY2UgPSAndHJhbnNmb3JtZXJzTW9kdWxlLmRlZmF1bHQuZW52JztcclxuXHRcdFx0fVxyXG5cdFx0XHRlbHNlIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtDcHVSZXJhbmtlcl0gW1NURVAgMl0g4pyXIENvdWxkIG5vdCBmaW5kIE9OTlggZW52aXJvbm1lbnQgc3RydWN0dXJlYCk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIENvbmZpZ3VyZSBXQVNNIHBhdGhzIE9OTFkgaWYgdGhlIHJlYWwgT05OWCBlbnZpcm9ubWVudCBleGlzdHNcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBjb25maWd1cmUgV0FTTSBwYXRocy4uLmApO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKGVudiAmJiBlbnYuYmFja2VuZHMgJiYgZW52LmJhY2tlbmRzLm9ubngpIHtcclxuXHRcdFx0XHRjb25zdCBvbm54QmFja2VuZCA9IGVudi5iYWNrZW5kcy5vbm54O1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhICR7ZW52U291cmNlfWApO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIFRyeSB0byBmaW5kIHRoZSBhY3R1YWwgT05OWCBSdW50aW1lIGVudmlyb25tZW50XHJcblx0XHRcdFx0bGV0IHdhc21FbnY6IGFueSA9IG51bGw7XHJcblx0XHRcdFx0bGV0IHdhc21FbnZQYXRoID0gJ25vbmUnO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDNdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC5lbnYud2FzbWApO1xyXG5cdFx0XHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLmVudi53YXNtO1xyXG5cdFx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQuZW52Lndhc20nO1xyXG5cdFx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQud2FzbSkge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLndhc21gKTtcclxuXHRcdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC53YXNtO1xyXG5cdFx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQud2FzbSc7XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJcgV0FTTSBlbnZpcm9ubWVudCBub3QgZm91bmRgKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0aWYgKHdhc21FbnYpIHtcclxuXHRcdFx0XHRcdC8vIFVzZSBzdHJpbmctYmFzZWQgcGF0aCAoYmFzZSBkaXJlY3RvcnkpIGxpa2UgdHJhbnNmb3JtZXJzLmpzIGRvZXNcclxuXHRcdFx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgM10gU2V0dGluZyB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0d2FzbUVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCAzXSDinJMgV0FTTSBwYXRocyBjb25maWd1cmVkIGF0ICR7d2FzbUVudlBhdGh9YCk7XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyXIENhbm5vdCBjb25maWd1cmUgV0FTTSBwYXRocyAtIFdBU00gZW52aXJvbm1lbnQgbm90IGZvdW5kYCk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gW1NURVAgM10g4pyXIENhbm5vdCBjb25maWd1cmUgV0FTTSBwYXRocyAtIE9OTlggYmFja2VuZCBub3QgZm91bmRgKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uXHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIExvY2F0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblx0XHRcdGNvbnN0IHBpcGVsaW5lID0gdHJhbnNmb3JtZXJzTW9kdWxlLnBpcGVsaW5lIHx8IHRyYW5zZm9ybWVyc01vZHVsZS5kZWZhdWx0Py5waXBlbGluZTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0gUGlwZWxpbmUgZm91bmQ6YCwgcGlwZWxpbmUgIT09IHVuZGVmaW5lZCAmJiBwaXBlbGluZSAhPT0gbnVsbCk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDRdIFBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIHBpcGVsaW5lKTtcclxuXHRcdFx0XHJcblx0XHRcdGlmICghcGlwZWxpbmUgfHwgdHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0NwdVJlcmFua2VyXSBbU1RFUCA0XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdUcmFuc2Zvcm1lcnMgcGlwZWxpbmUgaXMgdW5hdmFpbGFibGUnKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNF0g4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGZvdW5kYCk7XHJcblxyXG5cdFx0XHQvLyBDcm9zcy1lbmNvZGVyIHJlcmFua2VyIG1vZGVsIChzbWFsbC1pc2gpLiBCZXN0LWVmZm9ydDogbWF5IGZhaWwgb24gc29tZSBlbnZpcm9ubWVudHMuXHJcblx0XHRcdGNvbnNvbGUubG9nKGBbQ3B1UmVyYW5rZXJdIFtTVEVQIDVdIENyZWF0aW5nIGNyb3NzLWVuY29kZXIgcGlwZWxpbmUuLi5gKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtDcHVSZXJhbmtlcl0gW1NURVAgNV0gTW9kZWw6IFhlbm92YS9jcm9zcy1lbmNvZGVyLW1zLW1hcmNvLU1pbmlMTS1MLTYtdjJgKTtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCBwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKFxyXG5cdFx0XHRcdFx0J3RleHQtY2xhc3NpZmljYXRpb24nLFxyXG5cdFx0XHRcdFx0J1hlbm92YS9jcm9zcy1lbmNvZGVyLW1zLW1hcmNvLU1pbmlMTS1MLTYtdjInLFxyXG5cdFx0XHRcdFx0eyBxdWFudGl6ZWQ6IHRydWUgfVxyXG5cdFx0XHRcdCk7XHJcblx0XHRcdFx0Y29uc3QgcGlwZSA9IHBpcGVVbmtub3duIGFzIChpbnB1dDogdW5rbm93bikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHR0aGlzLnBpcGVsaW5lID0gYXN5bmMgKGlucHV0KSA9PiBhd2FpdCBwaXBlKGlucHV0KTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSBbU1RFUCA1XSDinJMgUGlwZWxpbmUgY3JlYXRlZCBzdWNjZXNzZnVsbHlgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0NwdVJlcmFua2VyXSA9PT0gUkVSQU5LRVIgTE9BRCBDT01QTEVURSA9PT1gKTtcclxuXHRcdFx0fSBjYXRjaCAocGlwZUVycikge1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtDcHVSZXJhbmtlcl0gW1NURVAgNV0g4pyXIFBpcGVsaW5lIGNyZWF0aW9uIGZhaWxlZDpgLCBwaXBlRXJyKTtcclxuXHRcdFx0XHR0aHJvdyBwaXBlRXJyO1xyXG5cdFx0XHR9XHJcblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xyXG5cdFx0fSk7XHJcblxyXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHR9XHJcblxyXG5cdGFzeW5jIHJlcmFua1BhaXIocXVlcnk6IHN0cmluZywgZG9jdW1lbnQ6IHN0cmluZyk6IFByb21pc2U8eyBzY29yZTogbnVtYmVyIH0+IHtcclxuXHRcdGNvbnN0IHEgPSBub3JtYWxpemVUZXh0KHF1ZXJ5KTtcclxuXHRcdGNvbnN0IGQgPSBub3JtYWxpemVUZXh0KGRvY3VtZW50KTtcclxuXHRcdGlmICghcSB8fCAhZCkgcmV0dXJuIHsgc2NvcmU6IDAgfTtcclxuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHRocm93IG5ldyBFcnJvcignUmVyYW5rZXIgcGlwZWxpbmUgdW5hdmFpbGFibGUnKTtcclxuXHJcblx0XHQvLyBQcmVmZXIgcGFpciBpbnB1dCBpZiBzdXBwb3J0ZWQgYnkgdGhlIHBpcGVsaW5lIGltcGxlbWVudGF0aW9uOyBmYWxsIGJhY2sgdG8gY29uY2F0ZW5hdGlvbi5cclxuXHRcdGxldCBvdXQ6IHVua25vd247XHJcblx0XHR0cnkge1xyXG5cdFx0XHRvdXQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKFt7IHRleHQ6IHEsIHRleHRfcGFpcjogZCB9XSk7XHJcblx0XHR9IGNhdGNoIHtcclxuXHRcdFx0b3V0ID0gYXdhaXQgdGhpcy5waXBlbGluZShgJHtxfVxcblxcbiR7ZH1gKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBDb21tb24gb3V0cHV0IGZvcm1hdHM6XHJcblx0XHQvLyAtIFt7IGxhYmVsOiAnTEFCRUxfMScsIHNjb3JlOiAwLjkzIH0sIC4uLl1cclxuXHRcdC8vIC0geyBsYWJlbCwgc2NvcmUgfVxyXG5cdFx0Y29uc3QgZmlyc3QgPSBBcnJheS5pc0FycmF5KG91dCkgPyBvdXRbMF0gOiBvdXQ7XHJcblx0XHRjb25zdCBvYmogPSBmaXJzdCBhcyB7IHNjb3JlPzogdW5rbm93bjsgbGFiZWw/OiB1bmtub3duIH07XHJcblx0XHRjb25zdCBzY29yZSA9IHR5cGVvZiBvYmo/LnNjb3JlID09PSAnbnVtYmVyJyA/IG9iai5zY29yZSA6IDA7XHJcblx0XHRyZXR1cm4geyBzY29yZTogY2xhbXAwMShzY29yZSkgfTtcclxuXHR9XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQ3B1UmVyYW5rT3B0aW9ucyB7XHJcblx0bGltaXQ6IG51bWJlcjsgLy8gaG93IG1hbnkgaXRlbXMgdG8gcmV0dXJuXHJcblx0c2hvcnRsaXN0PzogbnVtYmVyOyAvLyBob3cgbWFueSB0byBzY29yZVxyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgQ3B1UmVyYW5rZXIge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbW9kZWw6IENwdVJlcmFua2VyTW9kZWw7XHJcblx0Ly8gcXVlcnlIYXNoIC0+IGl0ZW1LZXkgLT4gc2NvcmVcclxuXHRwcml2YXRlIHJlYWRvbmx5IGNhY2hlID0gbmV3IE1hcDxzdHJpbmcsIE1hcDxzdHJpbmcsIG51bWJlcj4+KCk7XHJcblxyXG5cdGNvbnN0cnVjdG9yKG1vZGVsPzogQ3B1UmVyYW5rZXJNb2RlbCkge1xyXG5cdFx0dGhpcy5tb2RlbCA9IG1vZGVsID8/IG5ldyBUcmFuc2Zvcm1lcnNDcm9zc0VuY29kZXIoKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgaGFzaFF1ZXJ5KHE6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0XHRyZXR1cm4gZm52MWEzMihub3JtYWxpemVUZXh0KHEpKTtcclxuXHR9XHJcblxyXG5cdHdhcm0ocXVlcnk6IHN0cmluZywgaXRlbXM6IENvbnRleHRJdGVtW10sIG9wdHM/OiB7IHNob3J0bGlzdD86IG51bWJlciB9KTogdm9pZCB7XHJcblx0XHRjb25zdCBzaG9ydGxpc3QgPSBNYXRoLm1heCgxLCBNYXRoLm1pbigxMjAsIE1hdGguZmxvb3Iob3B0cz8uc2hvcnRsaXN0ID8/IDQwKSkpO1xyXG5cdFx0Y29uc3QgcWggPSB0aGlzLmhhc2hRdWVyeShxdWVyeSk7XHJcblx0XHRjb25zdCBtYXAgPSB0aGlzLmNhY2hlLmdldChxaCkgPz8gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuXHRcdHRoaXMuY2FjaGUuc2V0KHFoLCBtYXApO1xyXG5cclxuXHRcdGNvbnN0IHRvU2NvcmUgPSBpdGVtcy5zbGljZSgwLCBzaG9ydGxpc3QpLmZpbHRlcigoaXQpID0+ICFtYXAuaGFzKGl0LmtleSkpO1xyXG5cdFx0aWYgKHRvU2NvcmUubGVuZ3RoID09PSAwKSByZXR1cm47XHJcblxyXG5cdFx0Ly8gRmlyZS1hbmQtZm9yZ2V0IHdhcm11cDsgbmV2ZXIgYmxvY2sgVUkuXHJcblx0XHR2b2lkIChhc3luYyAoKSA9PiB7XHJcblx0XHRcdGZvciAoY29uc3QgaXQgb2YgdG9TY29yZSkge1xyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRjb25zdCBkb2MgPSBgJHtpdC5wYXRofVxcbiR7aXQuZXhjZXJwdH1gO1xyXG5cdFx0XHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xyXG5cdFx0XHRcdFx0bWFwLnNldChpdC5rZXksIHJlcy5zY29yZSk7XHJcblx0XHRcdFx0fSBjYXRjaCB7XHJcblx0XHRcdFx0XHQvLyBzdG9wIHdhcm1pbmcgaWYgbW9kZWwgZmFpbHNcclxuXHRcdFx0XHRcdGJyZWFrO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5jYXRjaCgoKSA9PiB7XHJcblx0XHRcdC8vIGlnbm9yZVxyXG5cdFx0fSk7XHJcblx0fVxyXG5cclxuXHRhc3luYyByZXJhbmsocXVlcnk6IHN0cmluZywgaXRlbXM6IENvbnRleHRJdGVtW10sIG9wdHM6IENwdVJlcmFua09wdGlvbnMpOiBQcm9taXNlPENvbnRleHRJdGVtW10+IHtcclxuXHRcdGNvbnN0IGxpbWl0ID0gTWF0aC5tYXgoMSwgTWF0aC5taW4oMjAwLCBNYXRoLmZsb29yKG9wdHMubGltaXQpKSk7XHJcblx0XHRjb25zdCBzaG9ydGxpc3QgPSBNYXRoLm1heChsaW1pdCwgTWF0aC5taW4oMTIwLCBNYXRoLmZsb29yKG9wdHMuc2hvcnRsaXN0ID8/IDYwKSkpO1xyXG5cdFx0Y29uc3QgcWggPSB0aGlzLmhhc2hRdWVyeShxdWVyeSk7XHJcblx0XHRjb25zdCBtYXAgPSB0aGlzLmNhY2hlLmdldChxaCkgPz8gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcclxuXHRcdHRoaXMuY2FjaGUuc2V0KHFoLCBtYXApO1xyXG5cclxuXHRcdGNvbnN0IHNjb3JlZDogQXJyYXk8eyBpdGVtOiBDb250ZXh0SXRlbTsgc2NvcmU6IG51bWJlciB9PiA9IFtdO1xyXG5cdFx0Y29uc3Qgc2xpY2UgPSBpdGVtcy5zbGljZSgwLCBzaG9ydGxpc3QpO1xyXG5cdFx0Zm9yIChjb25zdCBpdCBvZiBzbGljZSkge1xyXG5cdFx0XHRjb25zdCBjYWNoZWQgPSBtYXAuZ2V0KGl0LmtleSk7XHJcblx0XHRcdGlmICh0eXBlb2YgY2FjaGVkID09PSAnbnVtYmVyJykge1xyXG5cdFx0XHRcdHNjb3JlZC5wdXNoKHsgaXRlbTogaXQsIHNjb3JlOiBjYWNoZWQgfSk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZG9jID0gYCR7aXQucGF0aH1cXG4ke2l0LmV4Y2VycHR9YDtcclxuXHRcdFx0Y29uc3QgcmVzID0gYXdhaXQgdGhpcy5tb2RlbC5yZXJhbmtQYWlyKHF1ZXJ5LCBkb2MpO1xyXG5cdFx0XHRtYXAuc2V0KGl0LmtleSwgcmVzLnNjb3JlKTtcclxuXHRcdFx0c2NvcmVkLnB1c2goeyBpdGVtOiBpdCwgc2NvcmU6IHJlcy5zY29yZSB9KTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBNZXJnZSByZXJhbmsgc2NvcmUgaW50byBmaW5hbCBvcmRlcmluZzsga2VlcCBvcmlnaW5hbCBzY29yZSBhcyBzZWNvbmRhcnkgc2lnbmFsLlxyXG5cdFx0Y29uc3Qgb3V0ID0gc2NvcmVkXHJcblx0XHRcdC5zb3J0KChhLCBiKSA9PiBiLnNjb3JlIC0gYS5zY29yZSB8fCBiLml0ZW0uc2NvcmUgLSBhLml0ZW0uc2NvcmUpXHJcblx0XHRcdC5zbGljZSgwLCBsaW1pdClcclxuXHRcdFx0Lm1hcCgocykgPT4gKHtcclxuXHRcdFx0XHQuLi5zLml0ZW0sXHJcblx0XHRcdFx0Ly8gS2VlcCB0aGUgc2NvcmUgZmllbGQgYXMgdGhlIHJlcmFuayBzY29yZSBzbyBmb3JtYXR0aW5nIHJlZmxlY3RzIHRydWUgb3JkZXIuXHJcblx0XHRcdFx0c2NvcmU6IHMuc2NvcmUsXHJcblx0XHRcdFx0c291cmNlOiAncmVyYW5rJyxcclxuXHRcdFx0XHRyZWFzb25UYWdzOiBBcnJheS5mcm9tKG5ldyBTZXQoWy4uLihzLml0ZW0ucmVhc29uVGFncyA/PyBbXSksICdyZXJhbmsnXSkpXHJcblx0XHRcdH0pKTtcclxuXHJcblx0XHRyZXR1cm4gb3V0O1xyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==