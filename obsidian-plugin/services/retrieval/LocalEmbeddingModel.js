// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin) {
    // Import the vendored transformers library first
    const mod = await import('../../lib/transformers.js');
    // Try multiple ways to access the environment
    // The bundled transformers.js might expose env differently
    let env = null;
    // Method 1: Direct mod.env (standard)
    if (mod.env && mod.env.backends && mod.env.backends.onnx) {
        env = mod.env;
    }
    // Method 2: mod.default.env (if default export)
    else if (mod.default && mod.default.env && mod.default.env.backends && mod.default.env.backends.onnx) {
        env = mod.default.env;
    }
    // Method 3: Try to construct the structure if it doesn't exist
    else if (mod && typeof mod === 'object') {
        // Create env structure if it doesn't exist
        if (!mod.env) {
            mod.env = {};
        }
        if (!mod.env.backends) {
            mod.env.backends = {};
        }
        if (!mod.env.backends.onnx) {
            mod.env.backends.onnx = {};
        }
        env = mod.env;
    }
    // Configure WASM paths if we found/created the environment
    if (env && env.backends && env.backends.onnx) {
        const onnxEnv = env.backends.onnx;
        if (!onnxEnv.wasm)
            onnxEnv.wasm = {};
        const vaultBase = plugin.app.vault.adapter.basePath || '';
        const pluginId = plugin.manifest.id;
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
        console.log(`[LocalEmbeddingModel] === WASM PATH CONFIGURATION ===`);
        console.log(`[LocalEmbeddingModel] Vault base: ${vaultBase}`);
        console.log(`[LocalEmbeddingModel] Plugin ID: ${pluginId}`);
        console.log(`[LocalEmbeddingModel] WASM paths configured:`, wasmPaths);
        console.log(`[LocalEmbeddingModel] ONNX env structure:`, {
            hasEnv: !!env,
            hasBackends: !!env?.backends,
            hasOnnx: !!env?.backends?.onnx,
            hasWasm: !!env?.backends?.onnx?.wasm,
            wasmPathsType: typeof onnxEnv.wasm.wasmPaths,
            wasmPathsIsObject: typeof onnxEnv.wasm.wasmPaths === 'object',
            wasmPathsKeys: typeof onnxEnv.wasm.wasmPaths === 'object' ? Object.keys(onnxEnv.wasm.wasmPaths) : 'N/A'
        });
        console.log(`[LocalEmbeddingModel] === END WASM CONFIGURATION ===`);
    }
    else {
        // Enhanced error logging to see what mod actually contains
        console.error(`[LocalEmbeddingModel] ERROR: Could not find or create mod.env structure`);
        console.error(`[LocalEmbeddingModel] mod type:`, typeof mod);
        console.error(`[LocalEmbeddingModel] mod keys:`, mod ? Object.keys(mod) : 'null');
        console.error(`[LocalEmbeddingModel] mod.env:`, mod?.env);
        console.error(`[LocalEmbeddingModel] mod.default:`, mod?.default);
        console.error(`[LocalEmbeddingModel] mod.pipeline:`, typeof mod?.pipeline);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNkRBQTZEO0FBQzdELHlEQUF5RDtBQUN6RCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQThCO0lBQ3hELGlEQUFpRDtJQUNqRCxNQUFNLEdBQUcsR0FBUSxNQUFNLE1BQU0sQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO0lBRTNELDhDQUE4QztJQUM5QywyREFBMkQ7SUFDM0QsSUFBSSxHQUFHLEdBQVEsSUFBSSxDQUFDO0lBRXBCLHNDQUFzQztJQUN0QyxJQUFJLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDMUQsR0FBRyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7SUFDZixDQUFDO0lBQ0QsZ0RBQWdEO1NBQzNDLElBQUksR0FBRyxDQUFDLE9BQU8sSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3RHLEdBQUcsR0FBRyxHQUFHLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQztJQUN2QixDQUFDO0lBQ0QsK0RBQStEO1NBQzFELElBQUksR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQ3pDLDJDQUEyQztRQUMzQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsR0FBRyxDQUFDLEdBQUcsR0FBRyxFQUFFLENBQUM7UUFDZCxDQUFDO1FBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLENB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IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG4vLyBIZWxwZXIgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uIHdpdGggcHJvcGVyIGVycm9yIGhhbmRsaW5nXHJcbi8vIFVzZXMgdmVuZG9yZWQgdHJhbnNmb3JtZXJzLmpzIHRvIGF2b2lkIGJ1bmRsaW5nIGlzc3Vlc1xyXG5hc3luYyBmdW5jdGlvbiBnZXRQaXBlbGluZShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiBQcm9taXNlPGFueT4ge1xyXG5cdC8vIEltcG9ydCB0aGUgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIGxpYnJhcnkgZmlyc3RcclxuXHRjb25zdCBtb2Q6IGFueSA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFxyXG5cdC8vIFRyeSBtdWx0aXBsZSB3YXlzIHRvIGFjY2VzcyB0aGUgZW52aXJvbm1lbnRcclxuXHQvLyBUaGUgYnVuZGxlZCB0cmFuc2Zvcm1lcnMuanMgbWlnaHQgZXhwb3NlIGVudiBkaWZmZXJlbnRseVxyXG5cdGxldCBlbnY6IGFueSA9IG51bGw7XHJcblx0XHJcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZClcclxuXHRpZiAobW9kLmVudiAmJiBtb2QuZW52LmJhY2tlbmRzICYmIG1vZC5lbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0ZW52ID0gbW9kLmVudjtcclxuXHR9XHJcblx0Ly8gTWV0aG9kIDI6IG1vZC5kZWZhdWx0LmVudiAoaWYgZGVmYXVsdCBleHBvcnQpXHJcblx0ZWxzZSBpZiAobW9kLmRlZmF1bHQgJiYgbW9kLmRlZmF1bHQuZW52ICYmIG1vZC5kZWZhdWx0LmVudi5iYWNrZW5kcyAmJiBtb2QuZGVmYXVsdC5lbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0ZW52ID0gbW9kLmRlZmF1bHQuZW52O1xyXG5cdH1cclxuXHQvLyBNZXRob2QgMzogVHJ5IHRvIGNvbnN0cnVjdCB0aGUgc3RydWN0dXJlIGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuXHRlbHNlIGlmIChtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcpIHtcclxuXHRcdC8vIENyZWF0ZSBlbnYgc3RydWN0dXJlIGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuXHRcdGlmICghbW9kLmVudikge1xyXG5cdFx0XHRtb2QuZW52ID0ge307XHJcblx0XHR9XHJcblx0XHRpZiAoIW1vZC5lbnYuYmFja2VuZHMpIHtcclxuXHRcdFx0bW9kLmVudi5iYWNrZW5kcyA9IHt9O1xyXG5cdFx0fVxyXG5cdFx0aWYgKCFtb2QuZW52LmJhY2tlbmRzLm9ubngpIHtcclxuXHRcdFx0bW9kLmVudi5iYWNrZW5kcy5vbm54ID0ge307XHJcblx0XHR9XHJcblx0XHRlbnYgPSBtb2QuZW52O1xyXG5cdH1cclxuXHRcclxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyBpZiB3ZSBmb3VuZC9jcmVhdGVkIHRoZSBlbnZpcm9ubWVudFxyXG5cdGlmIChlbnYgJiYgZW52LmJhY2tlbmRzICYmIGVudi5iYWNrZW5kcy5vbm54KSB7XHJcblx0XHRjb25zdCBvbm54RW52ID0gZW52LmJhY2tlbmRzLm9ubng7XHJcblx0XHRpZiAoIW9ubnhFbnYud2FzbSkgb25ueEVudi53YXNtID0ge307XHJcblx0XHRcclxuXHRcdGNvbnN0IHZhdWx0QmFzZSA9IChwbHVnaW4uYXBwLnZhdWx0LmFkYXB0ZXIgYXMgYW55KS5iYXNlUGF0aCB8fCAnJztcclxuXHRcdGNvbnN0IHBsdWdpbklkID0gcGx1Z2luLm1hbmlmZXN0LmlkO1xyXG5cdFx0XHJcblx0XHRjb25zdCB3YXNtRmlsZXMgPSBbXHJcblx0XHRcdCdvcnQtd2FzbS53YXNtJyxcclxuXHRcdFx0J29ydC13YXNtLXNpbWQud2FzbScsXHJcblx0XHRcdCdvcnQtd2FzbS10aHJlYWRlZC53YXNtJyxcclxuXHRcdFx0J29ydC13YXNtLXNpbWQtdGhyZWFkZWQud2FzbSdcclxuXHRcdF07XHJcblx0XHRcclxuXHRcdGNvbnN0IHdhc21QYXRoczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xyXG5cdFx0Zm9yIChjb25zdCB3YXNtRmlsZSBvZiB3YXNtRmlsZXMpIHtcclxuXHRcdFx0d2FzbVBhdGhzW3dhc21GaWxlXSA9IGAuL2xpYi8ke3dhc21GaWxlfWA7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPSB3YXNtUGF0aHM7XHJcblx0XHRcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFdBU00gUEFUSCBDT05GSUdVUkFUSU9OID09PWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBWYXVsdCBiYXNlOiAke3ZhdWx0QmFzZX1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGx1Z2luIElEOiAke3BsdWdpbklkfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBXQVNNIHBhdGhzIGNvbmZpZ3VyZWQ6YCwgd2FzbVBhdGhzKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gT05OWCBlbnYgc3RydWN0dXJlOmAsIHtcclxuXHRcdFx0aGFzRW52OiAhIWVudixcclxuXHRcdFx0aGFzQmFja2VuZHM6ICEhZW52Py5iYWNrZW5kcyxcclxuXHRcdFx0aGFzT25ueDogISFlbnY/LmJhY2tlbmRzPy5vbm54LFxyXG5cdFx0XHRoYXNXYXNtOiAhIWVudj8uYmFja2VuZHM/Lm9ubng/Lndhc20sXHJcblx0XHRcdHdhc21QYXRoc1R5cGU6IHR5cGVvZiBvbm54RW52Lndhc20ud2FzbVBhdGhzLFxyXG5cdFx0XHR3YXNtUGF0aHNJc09iamVjdDogdHlwZW9mIG9ubnhFbnYud2FzbS53YXNtUGF0aHMgPT09ICdvYmplY3QnLFxyXG5cdFx0XHR3YXNtUGF0aHNLZXlzOiB0eXBlb2Ygb25ueEVudi53YXNtLndhc21QYXRocyA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhvbm54RW52Lndhc20ud2FzbVBhdGhzKSA6ICdOL0EnXHJcblx0XHR9KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IEVORCBXQVNNIENPTkZJR1VSQVRJT04gPT09YCk7XHJcblx0fSBlbHNlIHtcclxuXHRcdC8vIEVuaGFuY2VkIGVycm9yIGxvZ2dpbmcgdG8gc2VlIHdoYXQgbW9kIGFjdHVhbGx5IGNvbnRhaW5zXHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRVJST1I6IENvdWxkIG5vdCBmaW5kIG9yIGNyZWF0ZSBtb2QuZW52IHN0cnVjdHVyZWApO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIG1vZCB0eXBlOmAsIHR5cGVvZiBtb2QpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIG1vZCBrZXlzOmAsIG1vZCA/IE9iamVjdC5rZXlzKG1vZCkgOiAnbnVsbCcpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIG1vZC5lbnY6YCwgbW9kPy5lbnYpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIG1vZC5kZWZhdWx0OmAsIG1vZD8uZGVmYXVsdCk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gbW9kLnBpcGVsaW5lOmAsIHR5cGVvZiBtb2Q/LnBpcGVsaW5lKTtcclxuXHR9XHJcblx0XHJcblx0Y29uc3QgcGlwZWxpbmUgPSBtb2QucGlwZWxpbmUgfHwgKG1vZC5kZWZhdWx0ICYmIG1vZC5kZWZhdWx0LnBpcGVsaW5lKTtcclxuXHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xyXG5cdH1cclxuXHRyZXR1cm4gcGlwZWxpbmU7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcclxuXHRyZWFkb25seSBkaW06IG51bWJlcjtcclxuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcclxufVxyXG5cclxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcclxuXHRsZXQgc3VtU3EgPSAwO1xyXG5cdGZvciAoY29uc3QgdiBvZiB2ZWMpIHN1bVNxICs9IHYgKiB2O1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRydWUgbG9jYWwgZW1iZWRkaW5ncyB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxyXG4gKi9cclxuaW50ZXJmYWNlIE1vZGVsRXJyb3JMb2dFbnRyeSB7XHJcblx0dGltZXN0YW1wOiBzdHJpbmc7XHJcblx0bG9jYXRpb246IHN0cmluZztcclxuXHRjb250ZXh0OiBzdHJpbmc7XHJcblx0bWVzc2FnZTogc3RyaW5nO1xyXG5cdHN0YWNrPzogc3RyaW5nO1xyXG5cdGVycm9yVHlwZT86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwgaW1wbGVtZW50cyBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xyXG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSBwaXBlbGluZTogbnVsbCB8ICgodGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcltdPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZEF0dGVtcHRzID0gMDtcclxuXHRwcml2YXRlIGxhc3RMb2FkRXJyb3I6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IE1vZGVsRXJyb3JMb2dFbnRyeVtdID0gW107XHJcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSA1MDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGFscmVhZHkgbG9hZGVkYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzLCB3YWl0aW5nLi4uYCk7XHJcblx0XHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFydGluZyBtb2RlbCBsb2FkLi4uYCk7XHJcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xyXG5cdFx0Y29uc3QgbG9hZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uIC0gdXNpbmcgaGVscGVyIHRvIGVuc3VyZSBwcm9wZXIgaW5pdGlhbGl6YXRpb25cclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWRpbmcgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lLi4uYCk7XHJcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xyXG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBpcyBub3QgYSBmdW5jdGlvbicpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgUGlwZWxpbmUgZnVuY3Rpb24gbG9hZGVkYCk7XHJcblx0XHRcdFx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuaW1wb3J0JywgJ0xvYWRpbmcgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lJywgaW1wb3J0RXJyKTtcclxuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXHJcblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cclxuXHRcdFx0XHRjb25zdCBjYWNoZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9tb2RlbHNgO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZGluZyBtb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIgKHF1YW50aXplZCkuLi5gKTtcclxuXHJcblx0XHRcdFx0bGV0IHBpcGVVbmtub3duOiB1bmtub3duO1xyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHQvLyBDYWxsIHBpcGVsaW5lIGRpcmVjdGx5IGFzIGEgZnVuY3Rpb25cclxuXHRcdFx0XHRcdHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoJ2ZlYXR1cmUtZXh0cmFjdGlvbicsICdYZW5vdmEvYWxsLU1pbmlMTS1MNi12MicsIHtcclxuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdFx0XHRjYWNoZV9kaXI6IGNhY2hlRGlyXHJcblx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHR9IGNhdGNoIChwaXBlbGluZUVycikge1xyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcclxuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBNb2RlbCBwaXBlbGluZSBjcmVhdGVkYCk7XHJcblxyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXHJcblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkgJiYgQXJyYXkuaXNBcnJheShvdXRbMF0pKSB7XHJcblx0XHRcdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dFswXSBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSkge1xyXG5cdFx0XHRcdFx0XHRcdHJldHVybiBsMk5vcm1hbGl6ZShvdXQgYXMgbnVtYmVyW10pO1xyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdGNvbnN0IG1heWJlID0gb3V0IGFzIHsgZGF0YT86IG51bWJlcltdIH07XHJcblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkgcmV0dXJuIGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgUHJvY2Vzc2luZyB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycylgLCBlcnIpO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVW5leHBlY3RlZCBvdXRwdXQgZm9ybWF0OmAsIHR5cGVvZiBvdXQsIEFycmF5LmlzQXJyYXkob3V0KSwgb3V0KTtcclxuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycywgJHt0ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgZHVyaW5nIGVtYmVkZGluZyBnZW5lcmF0aW9uOmAsIGVycik7XHJcblx0XHRcdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgTW9kZWwgZnVsbHkgbG9hZGVkIGluICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ2Vuc3VyZUxvYWRlZCcsIGBNb2RlbCBsb2FkaW5nIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCwgZXJyKTtcclxuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcclxuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKclyBNb2RlbCBsb2FkaW5nIGZhaWxlZDpgLCBlcnJvck1zZyk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCA1KS5qb2luKCdcXG4nKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5maW5hbGx5KCgpID0+IHtcclxuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcclxuXHRcdH0pO1xyXG5cclxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0fVxyXG5cclxuXHRhc3luYyBpc1JlYWR5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMucGlwZWxpbmUgIT09IG51bGw7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignaXNSZWFkeScsICdDaGVja2luZyBtb2RlbCByZWFkaW5lc3MnLCBlcnIpO1xyXG5cdFx0XHRyZXR1cm4gZmFsc2U7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xyXG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcclxuXHR9XHJcblxyXG5cdGdldExhc3RMb2FkRXJyb3IoKTogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCB7XHJcblx0XHRyZXR1cm4gdGhpcy5sYXN0TG9hZEVycm9yO1xyXG5cdH1cclxuXHJcblx0Z2V0TG9hZEF0dGVtcHRzKCk6IG51bWJlciB7XHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcclxuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbnRyeTogTW9kZWxFcnJvckxvZ0VudHJ5ID0ge1xyXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuXHRcdFx0bG9jYXRpb24sXHJcblx0XHRcdGNvbnRleHQsXHJcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxyXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcclxuXHRcdFx0ZXJyb3JUeXBlXHJcblx0XHR9O1xyXG5cdFx0XHJcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xyXG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcclxuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBTdG9yZSBhcyBsYXN0IGxvYWQgZXJyb3IgaWYgaXQncyBhIGxvYWRpbmcgZXJyb3JcclxuXHRcdGlmIChsb2NhdGlvbiA9PT0gJ2Vuc3VyZUxvYWRlZCcgfHwgbG9jYXRpb24gPT09ICdpc1JlYWR5Jykge1xyXG5cdFx0XHR0aGlzLmxhc3RMb2FkRXJyb3IgPSBlbnRyeTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XHJcblx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0YXN5bmMgZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Y29uc3QgdCA9ICh0ZXh0IHx8ICcnKS50cmltKCk7XHJcblx0XHRpZiAoIXQpIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1wdHkgdGV4dCBwcm92aWRlZCwgcmV0dXJuaW5nIHplcm8gdmVjdG9yYCk7XHJcblx0XHRcdHJldHVybiBuZXcgQXJyYXk8bnVtYmVyPih0aGlzLmRpbSkuZmlsbCgwKTtcclxuXHRcdH1cclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdGlmICghdGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5ncyBwaXBlbGluZSB1bmF2YWlsYWJsZSBhZnRlciBsb2FkaW5nIGF0dGVtcHQnKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcclxuXHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEdlbmVyYXRlZCBlbWJlZGRpbmcgaW4gJHtlbWJlZER1cmF0aW9ufW1zIGZvciB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgKTtcclxuXHRcdFx0cmV0dXJuIHJlc3VsdDtcclxuXHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbWJlZCcsIGBFbWJlZGRpbmcgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xyXG5cdFx0XHR0aHJvdyBlcnI7XHJcblx0XHR9XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19