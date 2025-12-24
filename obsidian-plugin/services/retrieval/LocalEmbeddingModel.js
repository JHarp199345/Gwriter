// Helper function to safely inspect object structure without causing errors
function deepInspect(obj, maxDepth = 3, currentDepth = 0, visited = new WeakSet()) {
    if (currentDepth >= maxDepth || obj === null || obj === undefined) {
        return typeof obj;
    }
    if (typeof obj !== 'object') {
        return obj;
    }
    if (visited.has(obj)) {
        return '[Circular]';
    }
    visited.add(obj);
    const result = {};
    try {
        const keys = Object.keys(obj).slice(0, 20); // Limit keys to avoid huge output
        for (const key of keys) {
            try {
                const val = obj[key];
                if (typeof val === 'function') {
                    result[key] = `[Function: ${val.name || 'anonymous'}]`;
                }
                else if (typeof val === 'object' && val !== null) {
                    result[key] = deepInspect(val, maxDepth, currentDepth + 1, visited);
                }
                else {
                    result[key] = val;
                }
            }
            catch (e) {
                result[key] = `[Error accessing: ${e}]`;
            }
        }
    }
    catch (e) {
        return `[Error inspecting: ${e}]`;
    }
    return result;
}
// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin) {
    console.log(`[LocalEmbeddingModel] === STARTING PIPELINE LOAD ===`);
    console.log(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
    // Import the vendored transformers library first
    console.log(`[LocalEmbeddingModel] [STEP 1] Importing transformers.js module...`);
    let mod;
    try {
        mod = await import('../../lib/transformers.js');
        console.log(`[LocalEmbeddingModel] [STEP 1] ✓ Module imported successfully`);
        console.log(`[LocalEmbeddingModel] [STEP 1] Module type: ${typeof mod}`);
        console.log(`[LocalEmbeddingModel] [STEP 1] Module is null: ${mod === null}`);
        console.log(`[LocalEmbeddingModel] [STEP 1] Module is undefined: ${mod === undefined}`);
    }
    catch (importErr) {
        console.error(`[LocalEmbeddingModel] [STEP 1] ✗ Module import failed:`, importErr);
        throw new Error(`Failed to import transformers.js: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
    }
    // Deep inspection of module structure
    console.log(`[LocalEmbeddingModel] [STEP 2] Inspecting module structure...`);
    console.log(`[LocalEmbeddingModel] [STEP 2] Module keys (first 30):`, mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 30) : 'N/A');
    console.log(`[LocalEmbeddingModel] [STEP 2] Has 'env' property:`, 'env' in (mod || {}));
    console.log(`[LocalEmbeddingModel] [STEP 2] Has 'default' property:`, 'default' in (mod || {}));
    console.log(`[LocalEmbeddingModel] [STEP 2] Has 'pipeline' property:`, 'pipeline' in (mod || {}));
    console.log(`[LocalEmbeddingModel] [STEP 2] mod.env type:`, typeof mod?.env);
    console.log(`[LocalEmbeddingModel] [STEP 2] mod.default type:`, typeof mod?.default);
    console.log(`[LocalEmbeddingModel] [STEP 2] mod.pipeline type:`, typeof mod?.pipeline);
    // Try multiple ways to access the environment
    let env = null;
    let envSource = 'none';
    console.log(`[LocalEmbeddingModel] [STEP 3] Attempting to locate environment structure...`);
    // Method 1: Direct mod.env (standard structure)
    if (mod?.env) {
        console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.env`);
        env = mod.env;
        envSource = 'mod.env';
    }
    // Method 2: mod.default.env (if default export)
    else if (mod?.default?.env) {
        console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.default.env`);
        env = mod.default.env;
        envSource = 'mod.default.env';
    }
    // Deep inspection of what we have
    if (env) {
        console.log(`[LocalEmbeddingModel] [STEP 3] env type: ${typeof env}`);
        console.log(`[LocalEmbeddingModel] [STEP 3] env keys (first 30):`, Object.keys(env).slice(0, 30));
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends exists:`, 'backends' in env);
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx exists:`, env.backends?.onnx !== undefined);
        console.log(`[LocalEmbeddingModel] [STEP 3] env.useWasm exists:`, typeof env.useWasm === 'function');
        if (env.backends) {
            console.log(`[LocalEmbeddingModel] [STEP 3] env.backends keys:`, Object.keys(env.backends));
        }
        if (env.backends?.onnx) {
            console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
            console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, Object.keys(env.backends.onnx).slice(0, 20));
        }
    }
    else {
        console.warn(`[LocalEmbeddingModel] [STEP 3] ✗ Could not find env structure`);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env exists:`, mod?.env !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default exists:`, mod?.default !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env exists:`, mod?.default?.env !== undefined);
        if (mod?.env) {
            console.log(`[LocalEmbeddingModel] [STEP 3] mod.env structure (depth 3):`, deepInspect(mod.env, 3));
        }
        if (mod?.default?.env) {
            console.log(`[LocalEmbeddingModel] [STEP 3] mod.default.env structure (depth 3):`, deepInspect(mod.default.env, 3));
        }
    }
    // Configure WASM paths - try multiple approaches
    console.log(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
    if (env) {
        // Approach 1: Try env.useWasm() if available (transformers.js API)
        if (typeof env.useWasm === 'function') {
            try {
                console.log(`[LocalEmbeddingModel] [STEP 4] Attempting env.useWasm()...`);
                env.useWasm();
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Called env.useWasm()`);
            }
            catch (useWasmErr) {
                console.warn(`[LocalEmbeddingModel] [STEP 4] env.useWasm() failed:`, useWasmErr);
            }
        }
        // Approach 2: Try to configure WASM paths via backends.onnx.env.wasm
        if (env.backends?.onnx) {
            const onnxBackend = env.backends.onnx;
            console.log(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via ${envSource}`);
            // Try to find the actual ONNX Runtime environment
            // It might be at: onnxBackend.env.wasm OR onnxBackend.wasm OR onnxBackend.env
            let wasmEnv = null;
            let wasmEnvPath = 'none';
            if (onnxBackend.env?.wasm) {
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.env.wasm`);
                wasmEnv = onnxBackend.env.wasm;
                wasmEnvPath = 'onnxBackend.env.wasm';
            }
            else if (onnxBackend.wasm) {
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.wasm`);
                wasmEnv = onnxBackend.wasm;
                wasmEnvPath = 'onnxBackend.wasm';
            }
            else if (onnxBackend.env) {
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found env at onnxBackend.env (trying as WASM env)`);
                wasmEnv = onnxBackend.env;
                wasmEnvPath = 'onnxBackend.env';
            }
            else {
                console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ WASM environment not found at expected paths`);
                console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env exists:`, onnxBackend.env !== undefined);
                console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.wasm exists:`, onnxBackend.wasm !== undefined);
                console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend keys:`, Object.keys(onnxBackend).slice(0, 30));
                if (onnxBackend.env) {
                    console.log(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env structure:`, deepInspect(onnxBackend.env, 2));
                }
            }
            if (wasmEnv) {
                console.log(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${wasmEnvPath}`);
                // Use string-based path (base directory) like transformers.js does internally
                const wasmBasePath = './lib/';
                // Check current wasmPaths value
                if ('wasmPaths' in wasmEnv) {
                    const currentPaths = wasmEnv.wasmPaths;
                    console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths value:`, currentPaths);
                    console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths type:`, typeof currentPaths);
                    // Set the base path (transformers.js uses string, not object mapping)
                    try {
                        wasmEnv.wasmPaths = wasmBasePath;
                        console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Set wasmPaths to: ${wasmBasePath}`);
                        console.log(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths after setting:`, wasmEnv.wasmPaths);
                    }
                    catch (pathErr) {
                        console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set wasmPaths:`, pathErr);
                    }
                }
                else {
                    // Try to create wasmPaths property if it doesn't exist
                    try {
                        Object.defineProperty(wasmEnv, 'wasmPaths', {
                            value: wasmBasePath,
                            writable: true,
                            enumerable: true,
                            configurable: true
                        });
                        console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
                    }
                    catch (defineErr) {
                        console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to define wasmPaths:`, defineErr);
                    }
                }
            }
        }
        // Approach 3: Try to set env.wasmPaths directly if available
        if ('wasmPaths' in env) {
            try {
                const wasmBasePath = './lib/';
                console.log(`[LocalEmbeddingModel] [STEP 4] Found env.wasmPaths, setting to: ${wasmBasePath}`);
                env.wasmPaths = wasmBasePath;
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Set env.wasmPaths to: ${wasmBasePath}`);
            }
            catch (envPathErr) {
                console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set env.wasmPaths:`, envPathErr);
            }
        }
    }
    else {
        console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - env not found`);
    }
    // Get pipeline function
    console.log(`[LocalEmbeddingModel] [STEP 5] Locating pipeline function...`);
    const pipeline = mod.pipeline || mod.default?.pipeline;
    console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline found:`, pipeline !== undefined && pipeline !== null);
    console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline type:`, typeof pipeline);
    console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline is function:`, typeof pipeline === 'function');
    if (!pipeline || typeof pipeline !== 'function') {
        console.error(`[LocalEmbeddingModel] [STEP 5] ✗ Pipeline not found or not a function`);
        console.error(`[LocalEmbeddingModel] [STEP 5] mod.pipeline:`, mod?.pipeline);
        console.error(`[LocalEmbeddingModel] [STEP 5] mod.default.pipeline:`, mod?.default?.pipeline);
        throw new Error('Pipeline not found in transformers module');
    }
    console.log(`[LocalEmbeddingModel] [STEP 5] ✓ Pipeline function found`);
    console.log(`[LocalEmbeddingModel] === PIPELINE LOAD COMPLETE ===`);
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
            console.log(`[LocalEmbeddingModel] Pipeline already loaded (attempt #${this.loadAttempts})`);
            return;
        }
        if (this.loading !== null) {
            console.log(`[LocalEmbeddingModel] Pipeline loading in progress (attempt #${this.loadAttempts}), waiting...`);
            return this.loading;
        }
        console.log(`[LocalEmbeddingModel] === STARTING MODEL LOAD ===`);
        console.log(`[LocalEmbeddingModel] Load attempt #${this.loadAttempts + 1}`);
        console.log(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
        this.loadAttempts++;
        const loadStart = Date.now();
        this.loading = (async () => {
            try {
                // Get pipeline function - using helper to ensure proper initialization
                console.log(`[LocalEmbeddingModel] [LOAD] Step 1: Getting pipeline function...`);
                let pipeline;
                try {
                    pipeline = await getPipeline(this.plugin);
                    if (!pipeline) {
                        throw new Error('Pipeline is null or undefined');
                    }
                    if (typeof pipeline !== 'function') {
                        throw new Error(`Pipeline is not a function, got: ${typeof pipeline}`);
                    }
                    console.log(`[LocalEmbeddingModel] [LOAD] Step 1: ✓ Pipeline function loaded (type: ${typeof pipeline}, name: ${pipeline.name || 'anonymous'})`);
                }
                catch (importErr) {
                    console.error(`[LocalEmbeddingModel] [LOAD] Step 1: ✗ Failed to get pipeline function`);
                    this.logError('ensureLoaded.import', 'Loading vendored transformers pipeline', importErr);
                    throw new Error(`Failed to load transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
                }
                // Cache models inside plugin data to avoid re-downloading if possible.
                // Note: transformers uses its own caching strategy; this is a hint.
                const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
                console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Preparing model cache...`);
                console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Cache directory: ${cacheDir}`);
                console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Model: Xenova/all-MiniLM-L6-v2`);
                console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Quantized: true`);
                console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Creating model pipeline (this may take time)...`);
                let pipeUnknown;
                try {
                    const pipelineStartTime = Date.now();
                    // Call pipeline directly as a function
                    pipeUnknown = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                        quantized: true,
                        progress_callback: undefined,
                        cache_dir: cacheDir
                    });
                    const pipelineDuration = Date.now() - pipelineStartTime;
                    console.log(`[LocalEmbeddingModel] [LOAD] Step 3: ✓ Pipeline created in ${pipelineDuration}ms`);
                    console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output type: ${typeof pipeUnknown}`);
                    console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output is array: ${Array.isArray(pipeUnknown)}`);
                }
                catch (pipelineErr) {
                    console.error(`[LocalEmbeddingModel] [LOAD] Step 3: ✗ Pipeline creation failed`);
                    console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error type: ${pipelineErr instanceof Error ? pipelineErr.constructor.name : typeof pipelineErr}`);
                    console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error message: ${pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)}`);
                    if (pipelineErr instanceof Error && pipelineErr.stack) {
                        console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error stack (first 10 lines):`);
                        console.error(pipelineErr.stack.split('\n').slice(0, 10).join('\n'));
                    }
                    this.logError('ensureLoaded.createPipeline', `Creating pipeline with model Xenova/all-MiniLM-L6-v2, cache: ${cacheDir}`, pipelineErr);
                    throw pipelineErr;
                }
                const pipe = pipeUnknown;
                console.log(`[LocalEmbeddingModel] [LOAD] Step 4: Wrapping pipeline function...`);
                this.pipeline = async (text) => {
                    const embedStartTime = Date.now();
                    try {
                        console.log(`[LocalEmbeddingModel] [EMBED] Starting embedding generation for text (${text.length} chars, ${text.split(/\s+/).length} words)...`);
                        const out = await pipe(text, { pooling: 'mean', normalize: true });
                        const embedDuration = Date.now() - embedStartTime;
                        console.log(`[LocalEmbeddingModel] [EMBED] Raw output received in ${embedDuration}ms`);
                        console.log(`[LocalEmbeddingModel] [EMBED] Output type: ${typeof out}`);
                        console.log(`[LocalEmbeddingModel] [EMBED] Output is array: ${Array.isArray(out)}`);
                        // transformers output can vary; handle common cases.
                        let result;
                        if (Array.isArray(out) && Array.isArray(out[0])) {
                            console.log(`[LocalEmbeddingModel] [EMBED] Format: Array<Array<number>>, using out[0]`);
                            result = l2Normalize(out[0]);
                        }
                        else if (Array.isArray(out)) {
                            console.log(`[LocalEmbeddingModel] [EMBED] Format: Array<number>, using directly`);
                            result = l2Normalize(out);
                        }
                        else {
                            const maybe = out;
                            if (Array.isArray(maybe?.data)) {
                                console.log(`[LocalEmbeddingModel] [EMBED] Format: Object with data array, using data`);
                                result = l2Normalize(maybe.data);
                            }
                            else {
                                const err = new Error(`Unexpected embeddings output format: ${typeof out}, isArray: ${Array.isArray(out)}`);
                                this.logError('pipeline.embed', `Processing text (${text.length} chars)`, err);
                                console.error(`[LocalEmbeddingModel] [EMBED] ✗ Unexpected output format`);
                                console.error(`[LocalEmbeddingModel] [EMBED] Output:`, out);
                                throw err;
                            }
                        }
                        console.log(`[LocalEmbeddingModel] [EMBED] ✓ Embedding generated successfully (${result.length} dimensions)`);
                        return result;
                    }
                    catch (err) {
                        const embedDuration = Date.now() - embedStartTime;
                        console.error(`[LocalEmbeddingModel] [EMBED] ✗ Embedding generation failed after ${embedDuration}ms`);
                        this.logError('pipeline.embed', `Generating embedding for text (${text.length} chars, ${text.split(/\s+/).length} words)`, err);
                        console.error(`[LocalEmbeddingModel] [EMBED] Error:`, err);
                        throw err;
                    }
                };
                const loadDuration = Date.now() - loadStart;
                console.log(`[LocalEmbeddingModel] [LOAD] Step 4: ✓ Pipeline wrapper created`);
                console.log(`[LocalEmbeddingModel] === MODEL FULLY LOADED ===`);
                console.log(`[LocalEmbeddingModel] Total load time: ${loadDuration}ms`);
                console.log(`[LocalEmbeddingModel] Load attempts: ${this.loadAttempts}`);
            }
            catch (err) {
                const loadDuration = Date.now() - loadStart;
                console.error(`[LocalEmbeddingModel] === MODEL LOAD FAILED ===`);
                console.error(`[LocalEmbeddingModel] Total load time: ${loadDuration}ms`);
                console.error(`[LocalEmbeddingModel] Load attempt: #${this.loadAttempts}`);
                this.logError('ensureLoaded', `Model loading attempt #${this.loadAttempts}`, err);
                const errorMsg = err instanceof Error ? err.message : String(err);
                const errorStack = err instanceof Error ? err.stack : undefined;
                const errorType = err instanceof Error ? err.constructor.name : typeof err;
                console.error(`[LocalEmbeddingModel] Error type: ${errorType}`);
                console.error(`[LocalEmbeddingModel] Error message: ${errorMsg}`);
                if (errorStack) {
                    console.error(`[LocalEmbeddingModel] Error stack (first 15 lines):`);
                    console.error(errorStack.split('\n').slice(0, 15).join('\n'));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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QUksQ0FBQyxrRUFBa0UsQ0FBQyxDQUFDO1lBQ2pGLE9BQU8sSUFBSSxLQUFLLENBQVMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM1QyxDQUFDO1FBQ0QsSUFBSSxDQUFDO1lBQ0osTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDMUIsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1lBQzFFLENBQUM7WUFDRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDOUIsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxVQUFVLENBQUM7WUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnREFBZ0QsYUFBYSxnQkFBZ0IsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUM7WUFDNUksT0FBTyxNQUFNLENBQUM7UUFDZixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLG1CQUFtQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbi8vIEhlbHBlciBmdW5jdGlvbiB0byBzYWZlbHkgaW5zcGVjdCBvYmplY3Qgc3RydWN0dXJlIHdpdGhvdXQgY2F1c2luZyBlcnJvcnNcclxuZnVuY3Rpb24gZGVlcEluc3BlY3Qob2JqOiBhbnksIG1heERlcHRoOiBudW1iZXIgPSAzLCBjdXJyZW50RGVwdGg6IG51bWJlciA9IDAsIHZpc2l0ZWQ6IFdlYWtTZXQ8YW55PiA9IG5ldyBXZWFrU2V0KCkpOiBhbnkge1xyXG5cdGlmIChjdXJyZW50RGVwdGggPj0gbWF4RGVwdGggfHwgb2JqID09PSBudWxsIHx8IG9iaiA9PT0gdW5kZWZpbmVkKSB7XHJcblx0XHRyZXR1cm4gdHlwZW9mIG9iajtcclxuXHR9XHJcblx0aWYgKHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSB7XHJcblx0XHRyZXR1cm4gb2JqO1xyXG5cdH1cclxuXHRpZiAodmlzaXRlZC5oYXMob2JqKSkge1xyXG5cdFx0cmV0dXJuICdbQ2lyY3VsYXJdJztcclxuXHR9XHJcblx0dmlzaXRlZC5hZGQob2JqKTtcclxuXHRcclxuXHRjb25zdCByZXN1bHQ6IGFueSA9IHt9O1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBrZXlzID0gT2JqZWN0LmtleXMob2JqKS5zbGljZSgwLCAyMCk7IC8vIExpbWl0IGtleXMgdG8gYXZvaWQgaHVnZSBvdXRwdXRcclxuXHRcdGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCB2YWwgPSBvYmpba2V5XTtcclxuXHRcdFx0XHRpZiAodHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Z1bmN0aW9uOiAke3ZhbC5uYW1lIHx8ICdhbm9ueW1vdXMnfV1gO1xyXG5cdFx0XHRcdH0gZWxzZSBpZiAodHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgJiYgdmFsICE9PSBudWxsKSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IGRlZXBJbnNwZWN0KHZhbCwgbWF4RGVwdGgsIGN1cnJlbnREZXB0aCArIDEsIHZpc2l0ZWQpO1xyXG5cdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IHZhbDtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gY2F0Y2ggKGUpIHtcclxuXHRcdFx0XHRyZXN1bHRba2V5XSA9IGBbRXJyb3IgYWNjZXNzaW5nOiAke2V9XWA7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9IGNhdGNoIChlKSB7XHJcblx0XHRyZXR1cm4gYFtFcnJvciBpbnNwZWN0aW5nOiAke2V9XWA7XHJcblx0fVxyXG5cdHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcclxuLy8gVXNlcyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMuanMgdG8gYXZvaWQgYnVuZGxpbmcgaXNzdWVzXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBpcGVsaW5lKHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IFByb21pc2U8YW55PiB7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgUElQRUxJTkUgTE9BRCA9PT1gKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHJcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gSW1wb3J0aW5nIHRyYW5zZm9ybWVycy5qcyBtb2R1bGUuLi5gKTtcclxuXHRsZXQgbW9kOiBhbnk7XHJcblx0dHJ5IHtcclxuXHRcdG1vZCA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSDinJMgTW9kdWxlIGltcG9ydGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgdHlwZTogJHt0eXBlb2YgbW9kfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgaXMgbnVsbDogJHttb2QgPT09IG51bGx9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSBpcyB1bmRlZmluZWQ6ICR7bW9kID09PSB1bmRlZmluZWR9YCk7XHJcblx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0g4pyXIE1vZHVsZSBpbXBvcnQgZmFpbGVkOmAsIGltcG9ydEVycik7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHR9XHJcblx0XHJcblx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIG1vZHVsZSBzdHJ1Y3R1cmVcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEluc3BlY3RpbmcgbW9kdWxlIHN0cnVjdHVyZS4uLmApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gTW9kdWxlIGtleXMgKGZpcnN0IDMwKTpgLCBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDMwKSA6ICdOL0EnKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAnZW52JyBwcm9wZXJ0eTpgLCAnZW52JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2RlZmF1bHQnIHByb3BlcnR5OmAsICdkZWZhdWx0JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ3BpcGVsaW5lJyBwcm9wZXJ0eTpgLCAncGlwZWxpbmUnIGluIChtb2QgfHwge30pKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5lbnYgdHlwZTpgLCB0eXBlb2YgbW9kPy5lbnYpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmRlZmF1bHQgdHlwZTpgLCB0eXBlb2YgbW9kPy5kZWZhdWx0KTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5waXBlbGluZSB0eXBlOmAsIHR5cGVvZiBtb2Q/LnBpcGVsaW5lKTtcclxuXHRcclxuXHQvLyBUcnkgbXVsdGlwbGUgd2F5cyB0byBhY2Nlc3MgdGhlIGVudmlyb25tZW50XHJcblx0bGV0IGVudjogYW55ID0gbnVsbDtcclxuXHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xyXG5cdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBsb2NhdGUgZW52aXJvbm1lbnQgc3RydWN0dXJlLi4uYCk7XHJcblx0XHJcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXHJcblx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5lbnZgKTtcclxuXHRcdGVudiA9IG1vZC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmVudic7XHJcblx0fVxyXG5cdC8vIE1ldGhvZCAyOiBtb2QuZGVmYXVsdC5lbnYgKGlmIGRlZmF1bHQgZXhwb3J0KVxyXG5cdGVsc2UgaWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5kZWZhdWx0LmVudmApO1xyXG5cdFx0ZW52ID0gbW9kLmRlZmF1bHQuZW52O1xyXG5cdFx0ZW52U291cmNlID0gJ21vZC5kZWZhdWx0LmVudic7XHJcblx0fVxyXG5cdFxyXG5cdC8vIERlZXAgaW5zcGVjdGlvbiBvZiB3aGF0IHdlIGhhdmVcclxuXHRpZiAoZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiB0eXBlOiAke3R5cGVvZiBlbnZ9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiBrZXlzIChmaXJzdCAzMCk6YCwgT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAzMCkpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMgZXhpc3RzOmAsICdiYWNrZW5kcycgaW4gZW52KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzIGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzKSk7XHJcblx0XHR9XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzLm9ubngpLnNsaWNlKDAsIDIwKSk7XHJcblx0XHR9XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKclyBDb3VsZCBub3QgZmluZCBlbnYgc3RydWN0dXJlYCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZW52IGV4aXN0czpgLCBtb2Q/LmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0IGV4aXN0czpgLCBtb2Q/LmRlZmF1bHQgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdC5lbnYgZXhpc3RzOmAsIG1vZD8uZGVmYXVsdD8uZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5lbnYsIDMpKTtcclxuXHRcdH1cclxuXHRcdGlmIChtb2Q/LmRlZmF1bHQ/LmVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5kZWZhdWx0LmVudiwgMykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHRcclxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIHRyeSBtdWx0aXBsZSBhcHByb2FjaGVzXHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBdHRlbXB0aW5nIHRvIGNvbmZpZ3VyZSBXQVNNIHBhdGhzLi4uYCk7XHJcblx0XHJcblx0aWYgKGVudikge1xyXG5cdFx0Ly8gQXBwcm9hY2ggMTogVHJ5IGVudi51c2VXYXNtKCkgaWYgYXZhaWxhYmxlICh0cmFuc2Zvcm1lcnMuanMgQVBJKVxyXG5cdFx0aWYgKHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQXR0ZW1wdGluZyBlbnYudXNlV2FzbSgpLi4uYCk7XHJcblx0XHRcdFx0ZW52LnVzZVdhc20oKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBDYWxsZWQgZW52LnVzZVdhc20oKWApO1xyXG5cdFx0XHR9IGNhdGNoICh1c2VXYXNtRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gZW52LnVzZVdhc20oKSBmYWlsZWQ6YCwgdXNlV2FzbUVycik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQXBwcm9hY2ggMjogVHJ5IHRvIGNvbmZpZ3VyZSBXQVNNIHBhdGhzIHZpYSBiYWNrZW5kcy5vbm54LmVudi53YXNtXHJcblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdGNvbnN0IG9ubnhCYWNrZW5kID0gZW52LmJhY2tlbmRzLm9ubng7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIE9OTlggYmFja2VuZCBmb3VuZCB2aWEgJHtlbnZTb3VyY2V9YCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBUcnkgdG8gZmluZCB0aGUgYWN0dWFsIE9OTlggUnVudGltZSBlbnZpcm9ubWVudFxyXG5cdFx0XHQvLyBJdCBtaWdodCBiZSBhdDogb25ueEJhY2tlbmQuZW52Lndhc20gT1Igb25ueEJhY2tlbmQud2FzbSBPUiBvbm54QmFja2VuZC5lbnZcclxuXHRcdFx0bGV0IHdhc21FbnY6IGFueSA9IG51bGw7XHJcblx0XHRcdGxldCB3YXNtRW52UGF0aCA9ICdub25lJztcclxuXHRcdFx0XHJcblx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC5lbnYud2FzbWApO1xyXG5cdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC5lbnYud2FzbSc7XHJcblx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQud2FzbSkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLndhc21gKTtcclxuXHRcdFx0XHR3YXNtRW52ID0gb25ueEJhY2tlbmQud2FzbTtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC53YXNtJztcclxuXHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC5lbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBlbnYgYXQgb25ueEJhY2tlbmQuZW52ICh0cnlpbmcgYXMgV0FTTSBlbnYpYCk7XHJcblx0XHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLmVudjtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC5lbnYnO1xyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBXQVNNIGVudmlyb25tZW50IG5vdCBmb3VuZCBhdCBleHBlY3RlZCBwYXRoc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudiBleGlzdHM6YCwgb25ueEJhY2tlbmQuZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLndhc20gZXhpc3RzOmAsIG9ubnhCYWNrZW5kLndhc20gIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQga2V5czpgLCBPYmplY3Qua2V5cyhvbm54QmFja2VuZCkuc2xpY2UoMCwgMzApKTtcclxuXHRcdFx0XHRpZiAob25ueEJhY2tlbmQuZW52KSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudiBzdHJ1Y3R1cmU6YCwgZGVlcEluc3BlY3Qob25ueEJhY2tlbmQuZW52LCAyKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAod2FzbUVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ29uZmlndXJpbmcgV0FTTSBwYXRocyBhdDogJHt3YXNtRW52UGF0aH1gKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBVc2Ugc3RyaW5nLWJhc2VkIHBhdGggKGJhc2UgZGlyZWN0b3J5KSBsaWtlIHRyYW5zZm9ybWVycy5qcyBkb2VzIGludGVybmFsbHlcclxuXHRcdFx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBDaGVjayBjdXJyZW50IHdhc21QYXRocyB2YWx1ZVxyXG5cdFx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiB3YXNtRW52KSB7XHJcblx0XHRcdFx0XHRjb25zdCBjdXJyZW50UGF0aHMgPSB3YXNtRW52Lndhc21QYXRocztcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3VycmVudCB3YXNtUGF0aHMgdmFsdWU6YCwgY3VycmVudFBhdGhzKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3VycmVudCB3YXNtUGF0aHMgdHlwZTpgLCB0eXBlb2YgY3VycmVudFBhdGhzKTtcclxuXHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0Ly8gU2V0IHRoZSBiYXNlIHBhdGggKHRyYW5zZm9ybWVycy5qcyB1c2VzIHN0cmluZywgbm90IG9iamVjdCBtYXBwaW5nKVxyXG5cdFx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdFx0d2FzbUVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIFNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIFZlcmlmaWVkIHdhc21QYXRocyBhZnRlciBzZXR0aW5nOmAsIHdhc21FbnYud2FzbVBhdGhzKTtcclxuXHRcdFx0XHRcdH0gY2F0Y2ggKHBhdGhFcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCB3YXNtUGF0aHM6YCwgcGF0aEVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdC8vIFRyeSB0byBjcmVhdGUgd2FzbVBhdGhzIHByb3BlcnR5IGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3YXNtRW52LCAnd2FzbVBhdGhzJywge1xyXG5cdFx0XHRcdFx0XHRcdHZhbHVlOiB3YXNtQmFzZVBhdGgsXHJcblx0XHRcdFx0XHRcdFx0d3JpdGFibGU6IHRydWUsXHJcblx0XHRcdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0XHRjb25maWd1cmFibGU6IHRydWVcclxuXHRcdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0fSBjYXRjaCAoZGVmaW5lRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBkZWZpbmUgd2FzbVBhdGhzOmAsIGRlZmluZUVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIEFwcHJvYWNoIDM6IFRyeSB0byBzZXQgZW52Lndhc21QYXRocyBkaXJlY3RseSBpZiBhdmFpbGFibGVcclxuXHRcdGlmICgnd2FzbVBhdGhzJyBpbiBlbnYpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZvdW5kIGVudi53YXNtUGF0aHMsIHNldHRpbmcgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdGVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgU2V0IGVudi53YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCBlbnYud2FzbVBhdGhzOmAsIGVudlBhdGhFcnIpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCBtb2QuZGVmYXVsdD8ucGlwZWxpbmU7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIHBpcGVsaW5lKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGlzIGZ1bmN0aW9uOmAsIHR5cGVvZiBwaXBlbGluZSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHJcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLnBpcGVsaW5lOmAsIG1vZD8ucGlwZWxpbmUpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5kZWZhdWx0LnBpcGVsaW5lOmAsIG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xyXG5cdH1cclxuXHRcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFBJUEVMSU5FIExPQUQgQ09NUExFVEUgPT09YCk7XHJcblx0cmV0dXJuIHBpcGVsaW5lO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XHJcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XHJcblx0bGV0IHN1bVNxID0gMDtcclxuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cclxuICovXHJcbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xyXG5cdHRpbWVzdGFtcDogc3RyaW5nO1xyXG5cdGxvY2F0aW9uOiBzdHJpbmc7XHJcblx0Y29udGV4dDogc3RyaW5nO1xyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcclxuXHRyZWFkb25seSBkaW0gPSAzODQ7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XHJcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBNb2RlbEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZCAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSksIHdhaXRpbmcuLi5gKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHRcdH1cclxuXHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBTVEFSVElORyBNT0RFTCBMT0FEID09PWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHMgKyAxfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0dGhpcy5sb2FkQXR0ZW1wdHMrKztcclxuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiBHZXR0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xyXG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSkge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG51bGwgb3IgdW5kZWZpbmVkJyk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRpZiAodHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24sIGdvdDogJHt0eXBlb2YgcGlwZWxpbmV9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWQgKHR5cGU6ICR7dHlwZW9mIHBpcGVsaW5lfSwgbmFtZTogJHtwaXBlbGluZS5uYW1lIHx8ICdhbm9ueW1vdXMnfSlgKTtcclxuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiDinJcgRmFpbGVkIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbmApO1xyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XHJcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHRyYW5zZm9ybWVycyBwaXBlbGluZTogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxyXG5cdFx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogTW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IENyZWF0aW5nIG1vZGVsIHBpcGVsaW5lICh0aGlzIG1heSB0YWtlIHRpbWUpLi4uYCk7XHJcblxyXG5cdFx0XHRcdGxldCBwaXBlVW5rbm93bjogdW5rbm93bjtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgcGlwZWxpbmVTdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXHJcblx0XHRcdFx0XHRwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKCdmZWF0dXJlLWV4dHJhY3Rpb24nLCAnWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjInLCB7XHJcblx0XHRcdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcclxuXHRcdFx0XHRcdFx0Y2FjaGVfZGlyOiBjYWNoZURpclxyXG5cdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZUR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHBpcGVsaW5lU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJMgUGlwZWxpbmUgY3JlYXRlZCBpbiAke3BpcGVsaW5lRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogUGlwZWxpbmUgb3V0cHV0IHR5cGU6ICR7dHlwZW9mIHBpcGVVbmtub3dufWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShwaXBlVW5rbm93bil9YCk7XHJcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkYCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgdHlwZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBwaXBlbGluZUVycn1gKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBtZXNzYWdlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5tZXNzYWdlIDogU3RyaW5nKHBpcGVsaW5lRXJyKX1gKTtcclxuXHRcdFx0XHRcdGlmIChwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yICYmIHBpcGVsaW5lRXJyLnN0YWNrKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBzdGFjayAoZmlyc3QgMTAgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKHBpcGVsaW5lRXJyLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxMCkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcclxuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IFdyYXBwaW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblxyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gU3RhcnRpbmcgZW1iZWRkaW5nIGdlbmVyYXRpb24gZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xyXG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBSYXcgb3V0cHV0IHJlY2VpdmVkIGluICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IHR5cGU6ICR7dHlwZW9mIG91dH1gKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XHJcblx0XHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdFx0XHRsZXQgcmVzdWx0OiBudW1iZXJbXTtcclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxBcnJheTxudW1iZXI+PiwgdXNpbmcgb3V0WzBdYCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxudW1iZXI+LCB1c2luZyBkaXJlY3RseWApO1xyXG5cdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcclxuXHRcdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtYXliZT8uZGF0YSkpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IE9iamVjdCB3aXRoIGRhdGEgYXJyYXksIHVzaW5nIGRhdGFgKTtcclxuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIOKclyBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXRgKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dDpgLCBvdXQpO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgc3VjY2Vzc2Z1bGx5ICgke3Jlc3VsdC5sZW5ndGh9IGRpbWVuc2lvbnMpYCk7XHJcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEVycm9yOmAsIGVycik7XHJcblx0XHRcdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiDinJMgUGlwZWxpbmUgd3JhcHBlciBjcmVhdGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgRlVMTFkgTE9BREVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0czogJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IE1PREVMIExPQUQgRkFJTEVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdDogIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycjtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgdHlwZTogJHtlcnJvclR5cGV9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIG1lc3NhZ2U6ICR7ZXJyb3JNc2d9YCk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciBzdGFjayAoZmlyc3QgMTUgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxNSkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgaXNSZWFkeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdHJldHVybiB0aGlzLnBpcGVsaW5lICE9PSBudWxsO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcclxuXHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcclxuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XHJcblx0fVxyXG5cclxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xyXG5cdFx0cmV0dXJuIHRoaXMubGFzdExvYWRFcnJvcjtcclxuXHR9XHJcblxyXG5cdGdldExvYWRBdHRlbXB0cygpOiBudW1iZXIge1xyXG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XHJcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcclxuXHRcdFxyXG5cdFx0Y29uc3QgZW50cnk6IE1vZGVsRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXHJcblx0XHRpZiAobG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQnIHx8IGxvY2F0aW9uID09PSAnaXNSZWFkeScpIHtcclxuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xyXG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHR9XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XHJcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBHZW5lcmF0ZWQgZW1iZWRkaW5nIGluICR7ZW1iZWREdXJhdGlvbn1tcyBmb3IgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCk7XHJcblx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignZW1iZWQnLCBgRW1iZWRkaW5nIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQ6YCwgZXJyKTtcclxuXHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==