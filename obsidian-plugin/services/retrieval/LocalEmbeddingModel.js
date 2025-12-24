// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin) {
    // Import the vendored transformers library first
    const mod = await import('../../lib/transformers.js');
    // Configure WASM paths - need absolute URLs that Obsidian can serve
    if (mod.env && mod.env.backends && mod.env.backends.onnx) {
        const onnxEnv = mod.env.backends.onnx;
        if (!onnxEnv.wasm)
            onnxEnv.wasm = {};
        // Construct absolute paths to WASM files
        // Obsidian serves plugin files from the plugin directory
        // @ts-ignore - basePath exists but not in types
        const vaultBase = plugin.app.vault.adapter.basePath || '';
        const pluginId = plugin.manifest.id;
        // WASM files that need to be accessible
        const wasmFiles = [
            'ort-wasm.wasm',
            'ort-wasm-simd.wasm',
            'ort-wasm-threaded.wasm',
            'ort-wasm-simd-threaded.wasm'
        ];
        // Strategy: Use object mapping with paths relative to plugin root
        // The library will try to fetch these, so they need to be accessible via HTTP
        // In Obsidian, plugin files are served from .obsidian/plugins/plugin-name/
        const wasmPaths = {};
        // Try relative path from plugin root - Obsidian should serve files from plugin directory
        // The path should be relative to where the plugin is installed
        for (const wasmFile of wasmFiles) {
            // Use relative path - library will resolve from plugin root
            wasmPaths[wasmFile] = `./lib/${wasmFile}`;
        }
        // Set as object mapping (library supports this format)
        onnxEnv.wasm.wasmPaths = wasmPaths;
        // Enhanced logging for diagnostics
        console.log(`[LocalEmbeddingModel] === WASM PATH CONFIGURATION ===`);
        console.log(`[LocalEmbeddingModel] Vault base: ${vaultBase}`);
        console.log(`[LocalEmbeddingModel] Plugin ID: ${pluginId}`);
        console.log(`[LocalEmbeddingModel] WASM paths configured:`, wasmPaths);
        console.log(`[LocalEmbeddingModel] ONNX env structure:`, {
            hasEnv: !!mod.env,
            hasBackends: !!mod.env?.backends,
            hasOnnx: !!mod.env?.backends?.onnx,
            hasWasm: !!mod.env?.backends?.onnx?.wasm,
            wasmPathsType: typeof onnxEnv.wasm.wasmPaths,
            wasmPathsIsObject: typeof onnxEnv.wasm.wasmPaths === 'object',
            wasmPathsKeys: typeof onnxEnv.wasm.wasmPaths === 'object' ? Object.keys(onnxEnv.wasm.wasmPaths) : 'N/A'
        });
        console.log(`[LocalEmbeddingModel] === END WASM CONFIGURATION ===`);
    }
    else {
        console.error(`[LocalEmbeddingModel] ERROR: mod.env structure not found:`, {
            hasMod: !!mod,
            hasEnv: !!mod?.env,
            hasBackends: !!mod?.env?.backends,
            hasOnnx: !!mod?.env?.backends?.onnx,
            modKeys: mod ? Object.keys(mod) : []
        });
    }
    const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
    if (!pipeline || typeof pipeline !== 'function') {
        throw new Error('Pipeline not found in transformers module');
    }
    return pipeline;
}
function l2Normalize(vec) {
    let sumSq = 0;
    for (const v of vec)
        sumSq += v * v;
    const norm = Math.sqrt(sumSq) || 1;
    return vec.map((v) => v / norm);
}
export class MiniLmLocalEmbeddingModel {
    constructor(vault, plugin) {
        this.id = 'minilm';
        this.dim = 384;
        this.pipeline = null;
        this.loading = null;
        this.loadAttempts = 0;
        this.lastLoadError = null;
        this.errorLog = [];
        this.maxStoredErrors = 50;
        this.vault = vault;
        this.plugin = plugin;
    }
    async ensureLoaded() {
        if (this.pipeline) {
            console.log(`[LocalEmbeddingModel] Pipeline already loaded`);
            return;
        }
        if (this.loading !== null) {
            console.log(`[LocalEmbeddingModel] Pipeline loading in progress, waiting...`);
            return this.loading;
        }
        console.log(`[LocalEmbeddingModel] Starting model load...`);
        this.loadAttempts++;
        const loadStart = Date.now();
        this.loading = (async () => {
            try {
                // Get pipeline function - using helper to ensure proper initialization
                console.log(`[LocalEmbeddingModel] Loading vendored transformers pipeline...`);
                let pipeline;
                try {
                    pipeline = await getPipeline(this.plugin);
                    if (!pipeline || typeof pipeline !== 'function') {
                        throw new Error('Pipeline is not a function');
                    }
                    console.log(`[LocalEmbeddingModel] ✓ Pipeline function loaded`);
                }
                catch (importErr) {
                    this.logError('ensureLoaded.import', 'Loading vendored transformers pipeline', importErr);
                    throw new Error(`Failed to load transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
                }
                // Cache models inside plugin data to avoid re-downloading if possible.
                // Note: transformers uses its own caching strategy; this is a hint.
                const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
                console.log(`[LocalEmbeddingModel] Cache directory: ${cacheDir}`);
                console.log(`[LocalEmbeddingModel] Loading model: Xenova/all-MiniLM-L6-v2 (quantized)...`);
                let pipeUnknown;
                try {
                    // Call pipeline directly as a function
                    pipeUnknown = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                        quantized: true,
                        progress_callback: undefined,
                        cache_dir: cacheDir
                    });
                }
                catch (pipelineErr) {
                    this.logError('ensureLoaded.createPipeline', `Creating pipeline with model Xenova/all-MiniLM-L6-v2, cache: ${cacheDir}`, pipelineErr);
                    throw pipelineErr;
                }
                const pipe = pipeUnknown;
                console.log(`[LocalEmbeddingModel] ✓ Model pipeline created`);
                this.pipeline = async (text) => {
                    try {
                        const out = await pipe(text, { pooling: 'mean', normalize: true });
                        // transformers output can vary; handle common cases.
                        if (Array.isArray(out) && Array.isArray(out[0])) {
                            return l2Normalize(out[0]);
                        }
                        if (Array.isArray(out)) {
                            return l2Normalize(out);
                        }
                        const maybe = out;
                        if (Array.isArray(maybe?.data))
                            return l2Normalize(maybe.data);
                        const err = new Error(`Unexpected embeddings output format: ${typeof out}, isArray: ${Array.isArray(out)}`);
                        this.logError('pipeline.embed', `Processing text (${text.length} chars)`, err);
                        console.error(`[LocalEmbeddingModel] Unexpected output format:`, typeof out, Array.isArray(out), out);
                        throw err;
                    }
                    catch (err) {
                        this.logError('pipeline.embed', `Generating embedding for text (${text.length} chars, ${text.split(/\s+/).length} words)`, err);
                        console.error(`[LocalEmbeddingModel] Error during embedding generation:`, err);
                        throw err;
                    }
                };
                const loadDuration = Date.now() - loadStart;
                console.log(`[LocalEmbeddingModel] ✓ Model fully loaded in ${loadDuration}ms`);
            }
            catch (err) {
                this.logError('ensureLoaded', `Model loading attempt #${this.loadAttempts}`, err);
                const errorMsg = err instanceof Error ? err.message : String(err);
                const errorStack = err instanceof Error ? err.stack : undefined;
                console.error(`[LocalEmbeddingModel] ✗ Model loading failed:`, errorMsg);
                if (errorStack) {
                    console.error(`[LocalEmbeddingModel] Stack:`, errorStack.split('\n').slice(0, 5).join('\n'));
                }
                throw err;
            }
        })().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }
    async isReady() {
        try {
            await this.ensureLoaded();
            return this.pipeline !== null;
        }
        catch (err) {
            this.logError('isReady', 'Checking model readiness', err);
            return false;
        }
    }
    getRecentErrors(limit = 20) {
        return this.errorLog.slice(-limit);
    }
    getLastLoadError() {
        return this.lastLoadError;
    }
    getLoadAttempts() {
        return this.loadAttempts;
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
        // Store as last load error if it's a loading error
        if (location === 'ensureLoaded' || location === 'isReady') {
            this.lastLoadError = entry;
        }
        console.error(`[LocalEmbeddingModel] ERROR [${location}] ${context}:`, errorMsg);
        if (errorStack) {
            console.error(`[LocalEmbeddingModel] Stack:`, errorStack.split('\n').slice(0, 3).join('\n'));
        }
    }
    async embed(text) {
        const t = (text || '').trim();
        if (!t) {
            console.warn(`[LocalEmbeddingModel] Empty text provided, returning zero vector`);
            return new Array(this.dim).fill(0);
        }
        try {
            await this.ensureLoaded();
            if (!this.pipeline) {
                throw new Error('Embeddings pipeline unavailable after loading attempt');
            }
            const embedStart = Date.now();
            const result = await this.pipeline(t);
            const embedDuration = Date.now() - embedStart;
            console.log(`[LocalEmbeddingModel] Generated embedding in ${embedDuration}ms for text (${t.length} chars, ${t.split(/\s+/).length} words)`);
            return result;
        }
        catch (err) {
            this.logError('embed', `Embedding text (${t.length} chars, ${t.split(/\s+/).length} words)`, err);
            console.error(`[LocalEmbeddingModel] Embedding generation failed:`, err);
            throw err;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNkRBQTZEO0FBQzdELHlEQUF5RDtBQUN6RCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQThCO0lBQ3hELGlEQUFpRDtJQUNqRCxNQUFNLEdBQUcsR0FBUSxNQUFNLE1BQU0sQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO0lBRTNELG9FQUFvRTtJQUNwRSxJQUFJLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDMUQsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO1FBQ3RDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSTtZQUFFLE9BQU8sQ0FBQyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBRXJDLHlDQUF5QztRQUN6Qyx5REFBeUQ7UUFDekQsZ0RBQWdEO1FBQ2hELE1BQU0sU0FBUyxHQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQWUsQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDO1FBQ25FLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBRXBDLHdDQUF3QztRQUN4QyxNQUFNLFNBQVMsR0FBRztZQUNqQixlQUFlO1lBQ2Ysb0JBQW9CO1lBQ3BCLHdCQUF3QjtZQUN4Qiw2QkFBNkI7U0FDN0IsQ0FBQztRQUVGLGtFQUFrRTtRQUNsRSw4RUFBOEU7UUFDOUUsMkVBQTJFO1FBQzNFLE1BQU0sU0FBUyxHQUEyQixFQUFFLENBQUM7UUFFN0MseUZBQXlGO1FBQ3pGLCtEQUErRDtRQUMvRCxLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQ2xDLDRE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LENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5cbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcbi8vIFVzZXMgdmVuZG9yZWQgdHJhbnNmb3JtZXJzLmpzIHRvIGF2b2lkIGJ1bmRsaW5nIGlzc3Vlc1xuYXN5bmMgZnVuY3Rpb24gZ2V0UGlwZWxpbmUocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogUHJvbWlzZTxhbnk+IHtcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxuXHRjb25zdCBtb2Q6IGFueSA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xuXHRcblx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSBuZWVkIGFic29sdXRlIFVSTHMgdGhhdCBPYnNpZGlhbiBjYW4gc2VydmVcblx0aWYgKG1vZC5lbnYgJiYgbW9kLmVudi5iYWNrZW5kcyAmJiBtb2QuZW52LmJhY2tlbmRzLm9ubngpIHtcblx0XHRjb25zdCBvbm54RW52ID0gbW9kLmVudi5iYWNrZW5kcy5vbm54O1xuXHRcdGlmICghb25ueEVudi53YXNtKSBvbm54RW52Lndhc20gPSB7fTtcblx0XHRcblx0XHQvLyBDb25zdHJ1Y3QgYWJzb2x1dGUgcGF0aHMgdG8gV0FTTSBmaWxlc1xuXHRcdC8vIE9ic2lkaWFuIHNlcnZlcyBwbHVnaW4gZmlsZXMgZnJvbSB0aGUgcGx1Z2luIGRpcmVjdG9yeVxuXHRcdC8vIEB0cy1pZ25vcmUgLSBiYXNlUGF0aCBleGlzdHMgYnV0IG5vdCBpbiB0eXBlc1xuXHRcdGNvbnN0IHZhdWx0QmFzZSA9IChwbHVnaW4uYXBwLnZhdWx0LmFkYXB0ZXIgYXMgYW55KS5iYXNlUGF0aCB8fCAnJztcblx0XHRjb25zdCBwbHVnaW5JZCA9IHBsdWdpbi5tYW5pZmVzdC5pZDtcblx0XHRcblx0XHQvLyBXQVNNIGZpbGVzIHRoYXQgbmVlZCB0byBiZSBhY2Nlc3NpYmxlXG5cdFx0Y29uc3Qgd2FzbUZpbGVzID0gW1xuXHRcdFx0J29ydC13YXNtLndhc20nLFxuXHRcdFx0J29ydC13YXNtLXNpbWQud2FzbScsXG5cdFx0XHQnb3J0LXdhc20tdGhyZWFkZWQud2FzbScsXG5cdFx0XHQnb3J0LXdhc20tc2ltZC10aHJlYWRlZC53YXNtJ1xuXHRcdF07XG5cdFx0XG5cdFx0Ly8gU3RyYXRlZ3k6IFVzZSBvYmplY3QgbWFwcGluZyB3aXRoIHBhdGhzIHJlbGF0aXZlIHRvIHBsdWdpbiByb290XG5cdFx0Ly8gVGhlIGxpYnJhcnkgd2lsbCB0cnkgdG8gZmV0Y2ggdGhlc2UsIHNvIHRoZXkgbmVlZCB0byBiZSBhY2Nlc3NpYmxlIHZpYSBIVFRQXG5cdFx0Ly8gSW4gT2JzaWRpYW4sIHBsdWdpbiBmaWxlcyBhcmUgc2VydmVkIGZyb20gLm9ic2lkaWFuL3BsdWdpbnMvcGx1Z2luLW5hbWUvXG5cdFx0Y29uc3Qgd2FzbVBhdGhzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG5cdFx0XG5cdFx0Ly8gVHJ5IHJlbGF0aXZlIHBhdGggZnJvbSBwbHVnaW4gcm9vdCAtIE9ic2lkaWFuIHNob3VsZCBzZXJ2ZSBmaWxlcyBmcm9tIHBsdWdpbiBkaXJlY3Rvcnlcblx0XHQvLyBUaGUgcGF0aCBzaG91bGQgYmUgcmVsYXRpdmUgdG8gd2hlcmUgdGhlIHBsdWdpbiBpcyBpbnN0YWxsZWRcblx0XHRmb3IgKGNvbnN0IHdhc21GaWxlIG9mIHdhc21GaWxlcykge1xuXHRcdFx0Ly8gVXNlIHJlbGF0aXZlIHBhdGggLSBsaWJyYXJ5IHdpbGwgcmVzb2x2ZSBmcm9tIHBsdWdpbiByb290XG5cdFx0XHR3YXNtUGF0aHNbd2FzbUZpbGVdID0gYC4vbGliLyR7d2FzbUZpbGV9YDtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gU2V0IGFzIG9iamVjdCBtYXBwaW5nIChsaWJyYXJ5IHN1cHBvcnRzIHRoaXMgZm9ybWF0KVxuXHRcdG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPSB3YXNtUGF0aHM7XG5cdFx0XG5cdFx0Ly8gRW5oYW5jZWQgbG9nZ2luZyBmb3IgZGlhZ25vc3RpY3Ncblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBXQVNNIFBBVEggQ09ORklHVVJBVElPTiA9PT1gKTtcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFZhdWx0IGJhc2U6ICR7dmF1bHRCYXNlfWApO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGx1Z2luIElEOiAke3BsdWdpbklkfWApO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gV0FTTSBwYXRocyBjb25maWd1cmVkOmAsIHdhc21QYXRocyk7XG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBPTk5YIGVudiBzdHJ1Y3R1cmU6YCwge1xuXHRcdFx0aGFzRW52OiAhIW1vZC5lbnYsXG5cdFx0XHRoYXNCYWNrZW5kczogISFtb2QuZW52Py5iYWNrZW5kcyxcblx0XHRcdGhhc09ubng6ICEhbW9kLmVudj8uYmFja2VuZHM/Lm9ubngsXG5cdFx0XHRoYXNXYXNtOiAhIW1vZC5lbnY/LmJhY2tlbmRzPy5vbm54Py53YXNtLFxuXHRcdFx0d2FzbVBhdGhzVHlwZTogdHlwZW9mIG9ubnhFbnYud2FzbS53YXNtUGF0aHMsXG5cdFx0XHR3YXNtUGF0aHNJc09iamVjdDogdHlwZW9mIG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPT09ICdvYmplY3QnLFxuXHRcdFx0d2FzbVBhdGhzS2V5czogdHlwZW9mIG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMob25ueEVudi53YXNtLndhc21QYXRocykgOiAnTi9BJ1xuXHRcdH0pO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IEVORCBXQVNNIENPTkZJR1VSQVRJT04gPT09YCk7XG5cdH0gZWxzZSB7XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SOiBtb2QuZW52IHN0cnVjdHVyZSBub3QgZm91bmQ6YCwge1xuXHRcdFx0aGFzTW9kOiAhIW1vZCxcblx0XHRcdGhhc0VudjogISFtb2Q/LmVudixcblx0XHRcdGhhc0JhY2tlbmRzOiAhIW1vZD8uZW52Py5iYWNrZW5kcyxcblx0XHRcdGhhc09ubng6ICEhbW9kPy5lbnY/LmJhY2tlbmRzPy5vbm54LFxuXHRcdFx0bW9kS2V5czogbW9kID8gT2JqZWN0LmtleXMobW9kKSA6IFtdXG5cdFx0fSk7XG5cdH1cblx0XG5cdGNvbnN0IHBpcGVsaW5lID0gbW9kLnBpcGVsaW5lIHx8IChtb2QuZGVmYXVsdCAmJiBtb2QuZGVmYXVsdC5waXBlbGluZSk7XG5cdGlmICghcGlwZWxpbmUgfHwgdHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xuXHR9XG5cdHJldHVybiBwaXBlbGluZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMb2NhbEVtYmVkZGluZ01vZGVsIHtcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XG5cdGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+O1xufVxuXG5mdW5jdGlvbiBsMk5vcm1hbGl6ZSh2ZWM6IG51bWJlcltdKTogbnVtYmVyW10ge1xuXHRsZXQgc3VtU3EgPSAwO1xuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcblx0Y29uc3Qgbm9ybSA9IE1hdGguc3FydChzdW1TcSkgfHwgMTtcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcbn1cblxuLyoqXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxuICogRmFsbHMgYmFjayB0byB0aHJvd2luZyBvbiBsb2FkIGZhaWx1cmU7IGNhbGxlcnMgc2hvdWxkIGNhdGNoIGFuZCB1c2UgaGV1cmlzdGljL2hhc2guXG4gKi9cbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZztcblx0Y29udGV4dDogc3RyaW5nO1xuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XG5cdHJlYWRvbmx5IGlkID0gJ21pbmlsbSc7XG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgbG9hZEF0dGVtcHRzID0gMDtcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogTW9kZWxFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSA1MDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGFscmVhZHkgbG9hZGVkYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgbG9hZGluZyBpbiBwcm9ncmVzcywgd2FpdGluZy4uLmApO1xuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcblx0XHR9XG5cblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YXJ0aW5nIG1vZGVsIGxvYWQuLi5gKTtcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZGluZyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmUuLi5gKTtcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0cGlwZWxpbmUgPSBhd2FpdCBnZXRQaXBlbGluZSh0aGlzLnBsdWdpbik7XG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24nKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgUGlwZWxpbmUgZnVuY3Rpb24gbG9hZGVkYCk7XG5cdFx0XHRcdH0gY2F0Y2ggKGltcG9ydEVycikge1xuXHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ2Vuc3VyZUxvYWRlZC5pbXBvcnQnLCAnTG9hZGluZyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmUnLCBpbXBvcnRFcnIpO1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXG5cdFx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXG5cdFx0XHRcdGNvbnN0IGNhY2hlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L21vZGVsc2A7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWRpbmcgbW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyIChxdWFudGl6ZWQpLi4uYCk7XG5cblx0XHRcdFx0bGV0IHBpcGVVbmtub3duOiB1bmtub3duO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdC8vIENhbGwgcGlwZWxpbmUgZGlyZWN0bHkgYXMgYSBmdW5jdGlvblxuXHRcdFx0XHRcdHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoJ2ZlYXR1cmUtZXh0cmFjdGlvbicsICdYZW5vdmEvYWxsLU1pbmlMTS1MNi12MicsIHtcblx0XHRcdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcblx0XHRcdFx0XHRcdHByb2dyZXNzX2NhbGxiYWNrOiB1bmRlZmluZWQsXG5cdFx0XHRcdFx0XHRjYWNoZV9kaXI6IGNhY2hlRGlyXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdH0gY2F0Y2ggKHBpcGVsaW5lRXJyKSB7XG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcblx0XHRcdFx0XHR0aHJvdyBwaXBlbGluZUVycjtcblx0XHRcdFx0fVxuXHRcdFx0XHRcblx0XHRcdFx0Y29uc3QgcGlwZSA9IHBpcGVVbmtub3duIGFzIChpbnB1dDogc3RyaW5nLCBvcHRzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8dW5rbm93bj47XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0g4pyTIE1vZGVsIHBpcGVsaW5lIGNyZWF0ZWRgKTtcblxuXHRcdFx0XHR0aGlzLnBpcGVsaW5lID0gYXN5bmMgKHRleHQ6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dFswXSBhcyBudW1iZXJbXSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpKSB7XG5cdFx0XHRcdFx0XHRcdHJldHVybiBsMk5vcm1hbGl6ZShvdXQgYXMgbnVtYmVyW10pO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkgcmV0dXJuIGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xuXHRcdFx0XHRcdFx0Y29uc3QgZXJyID0gbmV3IEVycm9yKGBVbmV4cGVjdGVkIGVtYmVkZGluZ3Mgb3V0cHV0IGZvcm1hdDogJHt0eXBlb2Ygb3V0fSwgaXNBcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XG5cdFx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdwaXBlbGluZS5lbWJlZCcsIGBQcm9jZXNzaW5nIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzKWAsIGVycik7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVW5leHBlY3RlZCBvdXRwdXQgZm9ybWF0OmAsIHR5cGVvZiBvdXQsIEFycmF5LmlzQXJyYXkob3V0KSwgb3V0KTtcblx0XHRcdFx0XHRcdHRocm93IGVycjtcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycywgJHt0ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIGR1cmluZyBlbWJlZGRpbmcgZ2VuZXJhdGlvbjpgLCBlcnIpO1xuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgTW9kZWwgZnVsbHkgbG9hZGVkIGluICR7bG9hZER1cmF0aW9ufW1zYCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0g4pyXIE1vZGVsIGxvYWRpbmcgZmFpbGVkOmAsIGVycm9yTXNnKTtcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgNSkuam9pbignXFxuJykpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRocm93IGVycjtcblx0XHRcdH1cblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XG5cdH1cblxuXHRhc3luYyBpc1JlYWR5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdFx0cmV0dXJuIHRoaXMucGlwZWxpbmUgIT09IG51bGw7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdpc1JlYWR5JywgJ0NoZWNraW5nIG1vZGVsIHJlYWRpbmVzcycsIGVycik7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcblx0XHRyZXR1cm4gdGhpcy5lcnJvckxvZy5zbGljZSgtbGltaXQpO1xuXHR9XG5cblx0Z2V0TGFzdExvYWRFcnJvcigpOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsIHtcblx0XHRyZXR1cm4gdGhpcy5sYXN0TG9hZEVycm9yO1xuXHR9XG5cblx0Z2V0TG9hZEF0dGVtcHRzKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogTW9kZWxFcnJvckxvZ0VudHJ5ID0ge1xuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRsb2NhdGlvbixcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxuXHRcdFx0ZXJyb3JUeXBlXG5cdFx0fTtcblx0XHRcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFN0b3JlIGFzIGxhc3QgbG9hZCBlcnJvciBpZiBpdCdzIGEgbG9hZGluZyBlcnJvclxuXHRcdGlmIChsb2NhdGlvbiA9PT0gJ2Vuc3VyZUxvYWRlZCcgfHwgbG9jYXRpb24gPT09ICdpc1JlYWR5Jykge1xuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XG5cdFx0fVxuXHRcdFxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRjb25zdCB0ID0gKHRleHQgfHwgJycpLnRyaW0oKTtcblx0XHRpZiAoIXQpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xuXHRcdFx0cmV0dXJuIG5ldyBBcnJheTxudW1iZXI+KHRoaXMuZGltKS5maWxsKDApO1xuXHRcdH1cblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcblx0XHRcdGlmICghdGhpcy5waXBlbGluZSkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XG5cdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEdlbmVyYXRlZCBlbWJlZGRpbmcgaW4gJHtlbWJlZER1cmF0aW9ufW1zIGZvciB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgKTtcblx0XHRcdHJldHVybiByZXN1bHQ7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbWJlZCcsIGBFbWJlZGRpbmcgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQ6YCwgZXJyKTtcblx0XHRcdHRocm93IGVycjtcblx0XHR9XG5cdH1cbn1cblxuXG4iXX0=