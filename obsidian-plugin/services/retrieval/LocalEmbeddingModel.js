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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNkRBQTZEO0FBQzdELHlEQUF5RDtBQUN6RCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQThCO0lBQ3hELGlEQUFpRDtJQUNqRCxNQUFNLEdBQUcsR0FBUSxNQUFNLE1BQU0sQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO0lBRTNELG9FQUFvRTtJQUNwRSxJQUFJLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDMUQsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO1FBQ3RDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSTtZQUFFLE9BQU8sQ0FBQyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBRXJDLHlDQUF5QztRQUN6Qyx5REFBeUQ7UUFDekQsZ0RBQWdEO1FBQ2hELE1BQU0sU0FBUyxHQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE9BQWUsQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDO1FBQ25FLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1FBRXBDLHdDQUF3QztRQUN4QyxNQUFNLFNBQVMsR0FBRztZQUNqQixlQUFlO1lBQ2Ysb0JBQW9CO1lBQ3BCLHdCQUF3QjtZQUN4Qiw2QkFBNkI7U0FDN0IsQ0FBQztRQUVGLGtFQUFrRTtRQUNsRSw4RUFBOEU7UUFDOUUsMkVBQTJFO1FBQzNFLE1BQU0sU0FBUyxHQUEyQixFQUFFLENBQUM7UUFFN0MseUZBQXlGO1FBQ3pGLCtEQUErRDtRQUMvRCxLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQ2xDLDRE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LENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcclxuLy8gVXNlcyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMuanMgdG8gYXZvaWQgYnVuZGxpbmcgaXNzdWVzXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBpcGVsaW5lKHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IFByb21pc2U8YW55PiB7XHJcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxyXG5cdGNvbnN0IG1vZDogYW55ID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XHJcblx0XHJcblx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSBuZWVkIGFic29sdXRlIFVSTHMgdGhhdCBPYnNpZGlhbiBjYW4gc2VydmVcclxuXHRpZiAobW9kLmVudiAmJiBtb2QuZW52LmJhY2tlbmRzICYmIG1vZC5lbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0Y29uc3Qgb25ueEVudiA9IG1vZC5lbnYuYmFja2VuZHMub25ueDtcclxuXHRcdGlmICghb25ueEVudi53YXNtKSBvbm54RW52Lndhc20gPSB7fTtcclxuXHRcdFxyXG5cdFx0Ly8gQ29uc3RydWN0IGFic29sdXRlIHBhdGhzIHRvIFdBU00gZmlsZXNcclxuXHRcdC8vIE9ic2lkaWFuIHNlcnZlcyBwbHVnaW4gZmlsZXMgZnJvbSB0aGUgcGx1Z2luIGRpcmVjdG9yeVxyXG5cdFx0Ly8gQHRzLWlnbm9yZSAtIGJhc2VQYXRoIGV4aXN0cyBidXQgbm90IGluIHR5cGVzXHJcblx0XHRjb25zdCB2YXVsdEJhc2UgPSAocGx1Z2luLmFwcC52YXVsdC5hZGFwdGVyIGFzIGFueSkuYmFzZVBhdGggfHwgJyc7XHJcblx0XHRjb25zdCBwbHVnaW5JZCA9IHBsdWdpbi5tYW5pZmVzdC5pZDtcclxuXHRcdFxyXG5cdFx0Ly8gV0FTTSBmaWxlcyB0aGF0IG5lZWQgdG8gYmUgYWNjZXNzaWJsZVxyXG5cdFx0Y29uc3Qgd2FzbUZpbGVzID0gW1xyXG5cdFx0XHQnb3J0LXdhc20ud2FzbScsXHJcblx0XHRcdCdvcnQtd2FzbS1zaW1kLndhc20nLFxyXG5cdFx0XHQnb3J0LXdhc20tdGhyZWFkZWQud2FzbScsXHJcblx0XHRcdCdvcnQtd2FzbS1zaW1kLXRocmVhZGVkLndhc20nXHJcblx0XHRdO1xyXG5cdFx0XHJcblx0XHQvLyBTdHJhdGVneTogVXNlIG9iamVjdCBtYXBwaW5nIHdpdGggcGF0aHMgcmVsYXRpdmUgdG8gcGx1Z2luIHJvb3RcclxuXHRcdC8vIFRoZSBsaWJyYXJ5IHdpbGwgdHJ5IHRvIGZldGNoIHRoZXNlLCBzbyB0aGV5IG5lZWQgdG8gYmUgYWNjZXNzaWJsZSB2aWEgSFRUUFxyXG5cdFx0Ly8gSW4gT2JzaWRpYW4sIHBsdWdpbiBmaWxlcyBhcmUgc2VydmVkIGZyb20gLm9ic2lkaWFuL3BsdWdpbnMvcGx1Z2luLW5hbWUvXHJcblx0XHRjb25zdCB3YXNtUGF0aHM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcclxuXHRcdFxyXG5cdFx0Ly8gVHJ5IHJlbGF0aXZlIHBhdGggZnJvbSBwbHVnaW4gcm9vdCAtIE9ic2lkaWFuIHNob3VsZCBzZXJ2ZSBmaWxlcyBmcm9tIHBsdWdpbiBkaXJlY3RvcnlcclxuXHRcdC8vIFRoZSBwYXRoIHNob3VsZCBiZSByZWxhdGl2ZSB0byB3aGVyZSB0aGUgcGx1Z2luIGlzIGluc3RhbGxlZFxyXG5cdFx0Zm9yIChjb25zdCB3YXNtRmlsZSBvZiB3YXNtRmlsZXMpIHtcclxuXHRcdFx0Ly8gVXNlIHJlbGF0aXZlIHBhdGggLSBsaWJyYXJ5IHdpbGwgcmVzb2x2ZSBmcm9tIHBsdWdpbiByb290XHJcblx0XHRcdHdhc21QYXRoc1t3YXNtRmlsZV0gPSBgLi9saWIvJHt3YXNtRmlsZX1gO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBTZXQgYXMgb2JqZWN0IG1hcHBpbmcgKGxpYnJhcnkgc3VwcG9ydHMgdGhpcyBmb3JtYXQpXHJcblx0XHRvbm54RW52Lndhc20ud2FzbVBhdGhzID0gd2FzbVBhdGhzO1xyXG5cdFx0XHJcblx0XHQvLyBFbmhhbmNlZCBsb2dnaW5nIGZvciBkaWFnbm9zdGljc1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gV0FTTSBQQVRIIENPTkZJR1VSQVRJT04gPT09YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFZhdWx0IGJhc2U6ICR7dmF1bHRCYXNlfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQbHVnaW4gSUQ6ICR7cGx1Z2luSWR9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFdBU00gcGF0aHMgY29uZmlndXJlZDpgLCB3YXNtUGF0aHMpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBPTk5YIGVudiBzdHJ1Y3R1cmU6YCwge1xyXG5cdFx0XHRoYXNFbnY6ICEhbW9kLmVudixcclxuXHRcdFx0aGFzQmFja2VuZHM6ICEhbW9kLmVudj8uYmFja2VuZHMsXHJcblx0XHRcdGhhc09ubng6ICEhbW9kLmVudj8uYmFja2VuZHM/Lm9ubngsXHJcblx0XHRcdGhhc1dhc206ICEhbW9kLmVudj8uYmFja2VuZHM/Lm9ubng/Lndhc20sXHJcblx0XHRcdHdhc21QYXRoc1R5cGU6IHR5cGVvZiBvbm54RW52Lndhc20ud2FzbVBhdGhzLFxyXG5cdFx0XHR3YXNtUGF0aHNJc09iamVjdDogdHlwZW9mIG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPT09ICdvYmplY3QnLFxyXG5cdFx0XHR3YXNtUGF0aHNLZXlzOiB0eXBlb2Ygb25ueEVudi53YXNtLndhc21QYXRocyA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhvbm54RW52Lndhc20ud2FzbVBhdGhzKSA6ICdOL0EnXHJcblx0XHR9KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IEVORCBXQVNNIENPTkZJR1VSQVRJT04gPT09YCk7XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUjogbW9kLmVudiBzdHJ1Y3R1cmUgbm90IGZvdW5kOmAsIHtcclxuXHRcdFx0aGFzTW9kOiAhIW1vZCxcclxuXHRcdFx0aGFzRW52OiAhIW1vZD8uZW52LFxyXG5cdFx0XHRoYXNCYWNrZW5kczogISFtb2Q/LmVudj8uYmFja2VuZHMsXHJcblx0XHRcdGhhc09ubng6ICEhbW9kPy5lbnY/LmJhY2tlbmRzPy5vbm54LFxyXG5cdFx0XHRtb2RLZXlzOiBtb2QgPyBPYmplY3Qua2V5cyhtb2QpIDogW11cclxuXHRcdH0pO1xyXG5cdH1cclxuXHRcclxuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCAobW9kLmRlZmF1bHQgJiYgbW9kLmRlZmF1bHQucGlwZWxpbmUpO1xyXG5cdGlmICghcGlwZWxpbmUgfHwgdHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIG5vdCBmb3VuZCBpbiB0cmFuc2Zvcm1lcnMgbW9kdWxlJyk7XHJcblx0fVxyXG5cdHJldHVybiBwaXBlbGluZTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZDogc3RyaW5nO1xyXG5cdHJlYWRvbmx5IGRpbTogbnVtYmVyO1xyXG5cdGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBsMk5vcm1hbGl6ZSh2ZWM6IG51bWJlcltdKTogbnVtYmVyW10ge1xyXG5cdGxldCBzdW1TcSA9IDA7XHJcblx0Zm9yIChjb25zdCB2IG9mIHZlYykgc3VtU3EgKz0gdiAqIHY7XHJcblx0Y29uc3Qgbm9ybSA9IE1hdGguc3FydChzdW1TcSkgfHwgMTtcclxuXHRyZXR1cm4gdmVjLm1hcCgodikgPT4gdiAvIG5vcm0pO1xyXG59XHJcblxyXG4vKipcclxuICogVHJ1ZSBsb2NhbCBlbWJlZGRpbmdzIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cclxuICogRmFsbHMgYmFjayB0byB0aHJvd2luZyBvbiBsb2FkIGZhaWx1cmU7IGNhbGxlcnMgc2hvdWxkIGNhdGNoIGFuZCB1c2UgaGV1cmlzdGljL2hhc2guXHJcbiAqL1xyXG5pbnRlcmZhY2UgTW9kZWxFcnJvckxvZ0VudHJ5IHtcclxuXHR0aW1lc3RhbXA6IHN0cmluZztcclxuXHRsb2NhdGlvbjogc3RyaW5nO1xyXG5cdGNvbnRleHQ6IHN0cmluZztcclxuXHRtZXNzYWdlOiBzdHJpbmc7XHJcblx0c3RhY2s/OiBzdHJpbmc7XHJcblx0ZXJyb3JUeXBlPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCBpbXBsZW1lbnRzIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkID0gJ21pbmlsbSc7XHJcblx0cmVhZG9ubHkgZGltID0gMzg0O1xyXG5cclxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcclxuXHRwcml2YXRlIHBpcGVsaW5lOiBudWxsIHwgKCh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyW10+KSA9IG51bGw7XHJcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XHJcblx0cHJpdmF0ZSBsb2FkQXR0ZW1wdHMgPSAwO1xyXG5cdHByaXZhdGUgbGFzdExvYWRFcnJvcjogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCA9IG51bGw7XHJcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogTW9kZWxFcnJvckxvZ0VudHJ5W10gPSBbXTtcclxuXHRwcml2YXRlIHJlYWRvbmx5IG1heFN0b3JlZEVycm9ycyA9IDUwO1xyXG5cclxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbikge1xyXG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgYWxyZWFkeSBsb2FkZWRgKTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGxvYWRpbmcgaW4gcHJvZ3Jlc3MsIHdhaXRpbmcuLi5gKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHRcdH1cclxuXHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YXJ0aW5nIG1vZGVsIGxvYWQuLi5gKTtcclxuXHRcdHRoaXMubG9hZEF0dGVtcHRzKys7XHJcblx0XHRjb25zdCBsb2FkU3RhcnQgPSBEYXRlLm5vdygpO1xyXG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHQvLyBHZXQgcGlwZWxpbmUgZnVuY3Rpb24gLSB1c2luZyBoZWxwZXIgdG8gZW5zdXJlIHByb3BlciBpbml0aWFsaXphdGlvblxyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZGluZyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmUuLi5gKTtcclxuXHRcdFx0XHRsZXQgcGlwZWxpbmU6IGFueTtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0cGlwZWxpbmUgPSBhd2FpdCBnZXRQaXBlbGluZSh0aGlzLnBsdWdpbik7XHJcblx0XHRcdFx0XHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG5vdCBhIGZ1bmN0aW9uJyk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWRgKTtcclxuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ2Vuc3VyZUxvYWRlZC5pbXBvcnQnLCAnTG9hZGluZyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmUnLCBpbXBvcnRFcnIpO1xyXG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gbG9hZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmU6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0Ly8gQ2FjaGUgbW9kZWxzIGluc2lkZSBwbHVnaW4gZGF0YSB0byBhdm9pZCByZS1kb3dubG9hZGluZyBpZiBwb3NzaWJsZS5cclxuXHRcdFx0XHQvLyBOb3RlOiB0cmFuc2Zvcm1lcnMgdXNlcyBpdHMgb3duIGNhY2hpbmcgc3RyYXRlZ3k7IHRoaXMgaXMgYSBoaW50LlxyXG5cdFx0XHRcdGNvbnN0IGNhY2hlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L21vZGVsc2A7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBDYWNoZSBkaXJlY3Rvcnk6ICR7Y2FjaGVEaXJ9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkaW5nIG1vZGVsOiBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiAocXVhbnRpemVkKS4uLmApO1xyXG5cclxuXHRcdFx0XHRsZXQgcGlwZVVua25vd246IHVua25vd247XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdC8vIENhbGwgcGlwZWxpbmUgZGlyZWN0bHkgYXMgYSBmdW5jdGlvblxyXG5cdFx0XHRcdFx0cGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xyXG5cdFx0XHRcdFx0XHRxdWFudGl6ZWQ6IHRydWUsXHJcblx0XHRcdFx0XHRcdHByb2dyZXNzX2NhbGxiYWNrOiB1bmRlZmluZWQsXHJcblx0XHRcdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcclxuXHRcdFx0XHRcdH0pO1xyXG5cdFx0XHRcdH0gY2F0Y2ggKHBpcGVsaW5lRXJyKSB7XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnLCBgQ3JlYXRpbmcgcGlwZWxpbmUgd2l0aCBtb2RlbCBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiwgY2FjaGU6ICR7Y2FjaGVEaXJ9YCwgcGlwZWxpbmVFcnIpO1xyXG5cdFx0XHRcdFx0dGhyb3cgcGlwZWxpbmVFcnI7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGNvbnN0IHBpcGUgPSBwaXBlVW5rbm93biBhcyAoaW5wdXQ6IHN0cmluZywgb3B0cz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0g4pyTIE1vZGVsIHBpcGVsaW5lIGNyZWF0ZWRgKTtcclxuXHJcblx0XHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jICh0ZXh0OiBzdHJpbmcpID0+IHtcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcclxuXHRcdFx0XHRcdFx0Ly8gdHJhbnNmb3JtZXJzIG91dHB1dCBjYW4gdmFyeTsgaGFuZGxlIGNvbW1vbiBjYXNlcy5cclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcclxuXHRcdFx0XHRcdFx0XHRyZXR1cm4gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpKSB7XHJcblx0XHRcdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkobWF5YmU/LmRhdGEpKSByZXR1cm4gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IGVyciA9IG5ldyBFcnJvcihgVW5leHBlY3RlZCBlbWJlZGRpbmdzIG91dHB1dCBmb3JtYXQ6ICR7dHlwZW9mIG91dH0sIGlzQXJyYXk6ICR7QXJyYXkuaXNBcnJheShvdXQpfWApO1xyXG5cdFx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdwaXBlbGluZS5lbWJlZCcsIGBQcm9jZXNzaW5nIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXQ6YCwgdHlwZW9mIG91dCwgQXJyYXkuaXNBcnJheShvdXQpLCBvdXQpO1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciBkdXJpbmcgZW1iZWRkaW5nIGdlbmVyYXRpb246YCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH07XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBNb2RlbCBmdWxseSBsb2FkZWQgaW4gJHtsb2FkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0g4pyXIE1vZGVsIGxvYWRpbmcgZmFpbGVkOmAsIGVycm9yTXNnKTtcclxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDUpLmpvaW4oJ1xcbicpKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHR9XHJcblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xyXG5cdFx0fSk7XHJcblxyXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHR9XHJcblxyXG5cdGFzeW5jIGlzUmVhZHkoKTogUHJvbWlzZTxib29sZWFuPiB7XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0XHRyZXR1cm4gdGhpcy5waXBlbGluZSAhPT0gbnVsbDtcclxuXHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdpc1JlYWR5JywgJ0NoZWNraW5nIG1vZGVsIHJlYWRpbmVzcycsIGVycik7XHJcblx0XHRcdHJldHVybiBmYWxzZTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBNb2RlbEVycm9yTG9nRW50cnlbXSB7XHJcblx0XHRyZXR1cm4gdGhpcy5lcnJvckxvZy5zbGljZSgtbGltaXQpO1xyXG5cdH1cclxuXHJcblx0Z2V0TGFzdExvYWRFcnJvcigpOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsIHtcclxuXHRcdHJldHVybiB0aGlzLmxhc3RMb2FkRXJyb3I7XHJcblx0fVxyXG5cclxuXHRnZXRMb2FkQXR0ZW1wdHMoKTogbnVtYmVyIHtcclxuXHRcdHJldHVybiB0aGlzLmxvYWRBdHRlbXB0cztcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgbG9nRXJyb3IobG9jYXRpb246IHN0cmluZywgY29udGV4dDogc3RyaW5nLCBlcnJvcjogdW5rbm93bik6IHZvaWQge1xyXG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xyXG5cdFx0Y29uc3QgZXJyb3JUeXBlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyb3I7XHJcblx0XHRcclxuXHRcdGNvbnN0IGVudHJ5OiBNb2RlbEVycm9yTG9nRW50cnkgPSB7XHJcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG5cdFx0XHRsb2NhdGlvbixcclxuXHRcdFx0Y29udGV4dCxcclxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXHJcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxyXG5cdFx0XHRlcnJvclR5cGVcclxuXHRcdH07XHJcblx0XHRcclxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XHJcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xyXG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIFN0b3JlIGFzIGxhc3QgbG9hZCBlcnJvciBpZiBpdCdzIGEgbG9hZGluZyBlcnJvclxyXG5cdFx0aWYgKGxvY2F0aW9uID09PSAnZW5zdXJlTG9hZGVkJyB8fCBsb2NhdGlvbiA9PT0gJ2lzUmVhZHknKSB7XHJcblx0XHRcdHRoaXMubGFzdExvYWRFcnJvciA9IGVudHJ5O1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRVJST1IgWyR7bG9jYXRpb259XSAke2NvbnRleHR9OmAsIGVycm9yTXNnKTtcclxuXHRcdGlmIChlcnJvclN0YWNrKSB7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRhc3luYyBlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCB0ID0gKHRleHQgfHwgJycpLnRyaW0oKTtcclxuXHRcdGlmICghdCkge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbXB0eSB0ZXh0IHByb3ZpZGVkLCByZXR1cm5pbmcgemVybyB2ZWN0b3JgKTtcclxuXHRcdFx0cmV0dXJuIG5ldyBBcnJheTxudW1iZXI+KHRoaXMuZGltKS5maWxsKDApO1xyXG5cdFx0fVxyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbWJlZGRpbmdzIHBpcGVsaW5lIHVuYXZhaWxhYmxlIGFmdGVyIGxvYWRpbmcgYXR0ZW1wdCcpO1xyXG5cdFx0XHR9XHJcblx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKHQpO1xyXG5cdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gR2VuZXJhdGVkIGVtYmVkZGluZyBpbiAke2VtYmVkRHVyYXRpb259bXMgZm9yIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWApO1xyXG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2VtYmVkJywgYEVtYmVkZGluZyB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkOmAsIGVycik7XHJcblx0XHRcdHRocm93IGVycjtcclxuXHRcdH1cclxuXHR9XHJcbn1cclxuXHJcblxyXG4iXX0=