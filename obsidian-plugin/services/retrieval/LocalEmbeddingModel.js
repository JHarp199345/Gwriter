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
    // Try multiple ways to access the environment - DON'T CREATE FAKE ONES
    let env = null;
    let envSource = 'none';
    console.log(`[LocalEmbeddingModel] [STEP 3] Attempting to locate ONNX environment structure...`);
    // Method 1: Direct mod.env.backends.onnx (standard structure)
    if (mod?.env?.backends?.onnx) {
        console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.env.backends.onnx`);
        env = mod.env;
        envSource = 'mod.env';
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, typeof env.backends.onnx === 'object' && env.backends.onnx ? Object.keys(env.backends.onnx).slice(0, 20) : 'N/A');
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env exists:`, 'env' in (env.backends.onnx || {}));
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env.wasm exists:`, env.backends.onnx?.env?.wasm !== undefined);
    }
    // Method 2: mod.default.env.backends.onnx (if default export)
    else if (mod?.default?.env?.backends?.onnx) {
        console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.default.env.backends.onnx`);
        env = mod.default.env;
        envSource = 'mod.default.env';
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, typeof env.backends.onnx === 'object' && env.backends.onnx ? Object.keys(env.backends.onnx).slice(0, 20) : 'N/A');
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env exists:`, 'env' in (env.backends.onnx || {}));
        console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env.wasm exists:`, env.backends.onnx?.env?.wasm !== undefined);
    }
    else {
        console.warn(`[LocalEmbeddingModel] [STEP 3] ✗ Could not find ONNX environment structure`);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env exists:`, mod?.env !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env.backends exists:`, mod?.env?.backends !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env.backends.onnx exists:`, mod?.env?.backends?.onnx !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default exists:`, mod?.default !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env exists:`, mod?.default?.env !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env.backends exists:`, mod?.default?.env?.backends !== undefined);
        console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env.backends.onnx exists:`, mod?.default?.env?.backends?.onnx !== undefined);
        // Deep inspection of what we DO have
        if (mod?.env) {
            console.log(`[LocalEmbeddingModel] [STEP 3] mod.env structure (depth 3):`, deepInspect(mod.env, 3));
        }
        if (mod?.default?.env) {
            console.log(`[LocalEmbeddingModel] [STEP 3] mod.default.env structure (depth 3):`, deepInspect(mod.default.env, 3));
        }
    }
    // Configure WASM paths ONLY if the real ONNX environment exists
    // The structure should be: env.backends.onnx.env.wasm (note the nested .env)
    console.log(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
    if (env && env.backends && env.backends.onnx) {
        const onnxBackend = env.backends.onnx;
        console.log(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via ${envSource}`);
        // Try to find the actual ONNX Runtime environment
        // It might be at: onnxBackend.env.wasm OR onnxBackend.wasm
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
        else {
            console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ WASM environment not found at expected paths`);
            console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env exists:`, onnxBackend.env !== undefined);
            console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env.wasm exists:`, onnxBackend.env?.wasm !== undefined);
            console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.wasm exists:`, onnxBackend.wasm !== undefined);
            console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend keys:`, Object.keys(onnxBackend).slice(0, 30));
            if (onnxBackend.env) {
                console.log(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env structure:`, deepInspect(onnxBackend.env, 2));
            }
        }
        if (wasmEnv) {
            const vaultBase = plugin.app.vault.adapter.basePath || '';
            const pluginId = plugin.manifest.id;
            console.log(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${wasmEnvPath}`);
            console.log(`[LocalEmbeddingModel] [STEP 4] Vault base: ${vaultBase}`);
            console.log(`[LocalEmbeddingModel] [STEP 4] Plugin ID: ${pluginId}`);
            // Use string-based path (base directory) like transformers.js does internally
            const wasmBasePath = './lib/';
            // Check current wasmPaths value
            const currentPaths = wasmEnv.wasmPaths;
            console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths value:`, currentPaths);
            console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths type:`, typeof currentPaths);
            // Set the base path (transformers.js uses string, not object mapping)
            wasmEnv.wasmPaths = wasmBasePath;
            console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Set wasmPaths to: ${wasmBasePath}`);
            console.log(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths after setting:`, wasmEnv.wasmPaths);
            console.log(`[LocalEmbeddingModel] [STEP 4] wasmEnv structure after config:`, deepInspect(wasmEnv, 2));
        }
        else {
            console.error(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - WASM environment not found`);
        }
    }
    else {
        console.error(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - ONNX backend not found`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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QUFDLEdBQUcsRUFBRSxDQUFDO1lBQzlCLE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUN0QyxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsVUFBVSxDQUFDO1lBQzlDLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0RBQWdELGFBQWEsZ0JBQWdCLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLFNBQVMsQ0FBQyxDQUFDO1lBQzVJLE9BQU8sTUFBTSxDQUFDO1FBQ2YsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDZCxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sRUFBRSxtQkFBbUIsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ2xHLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0RBQW9ELEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDekUsTUFBTSxHQUFHLENBQUM7UUFDWCxDQUFDO0lBQ0YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG4vLyBIZWxwZXIgZnVuY3Rpb24gdG8gc2FmZWx5IGluc3BlY3Qgb2JqZWN0IHN0cnVjdHVyZSB3aXRob3V0IGNhdXNpbmcgZXJyb3JzXHJcbmZ1bmN0aW9uIGRlZXBJbnNwZWN0KG9iajogYW55LCBtYXhEZXB0aDogbnVtYmVyID0gMywgY3VycmVudERlcHRoOiBudW1iZXIgPSAwLCB2aXNpdGVkOiBXZWFrU2V0PGFueT4gPSBuZXcgV2Vha1NldCgpKTogYW55IHtcclxuXHRpZiAoY3VycmVudERlcHRoID49IG1heERlcHRoIHx8IG9iaiA9PT0gbnVsbCB8fCBvYmogPT09IHVuZGVmaW5lZCkge1xyXG5cdFx0cmV0dXJuIHR5cGVvZiBvYmo7XHJcblx0fVxyXG5cdGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0Jykge1xyXG5cdFx0cmV0dXJuIG9iajtcclxuXHR9XHJcblx0aWYgKHZpc2l0ZWQuaGFzKG9iaikpIHtcclxuXHRcdHJldHVybiAnW0NpcmN1bGFyXSc7XHJcblx0fVxyXG5cdHZpc2l0ZWQuYWRkKG9iaik7XHJcblx0XHJcblx0Y29uc3QgcmVzdWx0OiBhbnkgPSB7fTtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iaikuc2xpY2UoMCwgMjApOyAvLyBMaW1pdCBrZXlzIHRvIGF2b2lkIGh1Z2Ugb3V0cHV0XHJcblx0XHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgdmFsID0gb2JqW2tleV07XHJcblx0XHRcdFx0aWYgKHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdHJlc3VsdFtrZXldID0gYFtGdW5jdGlvbjogJHt2YWwubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcclxuXHRcdFx0XHR9IGVsc2UgaWYgKHR5cGVvZiB2YWwgPT09ICdvYmplY3QnICYmIHZhbCAhPT0gbnVsbCkge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBkZWVwSW5zcGVjdCh2YWwsIG1heERlcHRoLCBjdXJyZW50RGVwdGggKyAxLCB2aXNpdGVkKTtcclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSB2YWw7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlKSB7XHJcblx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Vycm9yIGFjY2Vzc2luZzogJHtlfV1gO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fSBjYXRjaCAoZSkge1xyXG5cdFx0cmV0dXJuIGBbRXJyb3IgaW5zcGVjdGluZzogJHtlfV1gO1xyXG5cdH1cclxuXHRyZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vLyBIZWxwZXIgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uIHdpdGggcHJvcGVyIGVycm9yIGhhbmRsaW5nXHJcbi8vIFVzZXMgdmVuZG9yZWQgdHJhbnNmb3JtZXJzLmpzIHRvIGF2b2lkIGJ1bmRsaW5nIGlzc3Vlc1xyXG5hc3luYyBmdW5jdGlvbiBnZXRQaXBlbGluZShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiBQcm9taXNlPGFueT4ge1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFNUQVJUSU5HIFBJUEVMSU5FIExPQUQgPT09YCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFxyXG5cdC8vIEltcG9ydCB0aGUgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIGxpYnJhcnkgZmlyc3RcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIEltcG9ydGluZyB0cmFuc2Zvcm1lcnMuanMgbW9kdWxlLi4uYCk7XHJcblx0bGV0IG1vZDogYW55O1xyXG5cdHRyeSB7XHJcblx0XHRtb2QgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0g4pyTIE1vZHVsZSBpbXBvcnRlZCBzdWNjZXNzZnVsbHlgKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIHR5cGU6ICR7dHlwZW9mIG1vZH1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIG51bGw6ICR7bW9kID09PSBudWxsfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgaXMgdW5kZWZpbmVkOiAke21vZCA9PT0gdW5kZWZpbmVkfWApO1xyXG5cdH0gY2F0Y2ggKGltcG9ydEVycikge1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gaW1wb3J0IHRyYW5zZm9ybWVycy5qczogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIERlZXAgaW5zcGVjdGlvbiBvZiBtb2R1bGUgc3RydWN0dXJlXHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBJbnNwZWN0aW5nIG1vZHVsZSBzdHJ1Y3R1cmUuLi5gKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIE1vZHVsZSBrZXlzIChmaXJzdCAzMCk6YCwgbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAzMCkgOiAnTi9BJyk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2VudicgcHJvcGVydHk6YCwgJ2VudicgaW4gKG1vZCB8fCB7fSkpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdkZWZhdWx0JyBwcm9wZXJ0eTpgLCAnZGVmYXVsdCcgaW4gKG1vZCB8fCB7fSkpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdwaXBlbGluZScgcHJvcGVydHk6YCwgJ3BpcGVsaW5lJyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QuZW52IHR5cGU6YCwgdHlwZW9mIG1vZD8uZW52KTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5kZWZhdWx0IHR5cGU6YCwgdHlwZW9mIG1vZD8uZGVmYXVsdCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QucGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgbW9kPy5waXBlbGluZSk7XHJcblx0XHJcblx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudCAtIERPTidUIENSRUFURSBGQUtFIE9ORVNcclxuXHRsZXQgZW52OiBhbnkgPSBudWxsO1xyXG5cdGxldCBlbnZTb3VyY2UgPSAnbm9uZSc7XHJcblx0XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBBdHRlbXB0aW5nIHRvIGxvY2F0ZSBPTk5YIGVudmlyb25tZW50IHN0cnVjdHVyZS4uLmApO1xyXG5cdFxyXG5cdC8vIE1ldGhvZCAxOiBEaXJlY3QgbW9kLmVudi5iYWNrZW5kcy5vbm54IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXHJcblx0aWYgKG1vZD8uZW52Py5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJMgRm91bmQgZW52IHZpYSBtb2QuZW52LmJhY2tlbmRzLm9ubnhgKTtcclxuXHRcdGVudiA9IG1vZC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmVudic7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IHR5cGU6YCwgdHlwZW9mIGVudi5iYWNrZW5kcy5vbm54KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubngga2V5czpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubnggPT09ICdvYmplY3QnICYmIGVudi5iYWNrZW5kcy5vbm54ID8gT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzLm9ubngpLnNsaWNlKDAsIDIwKSA6ICdOL0EnKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnguZW52IGV4aXN0czpgLCAnZW52JyBpbiAoZW52LmJhY2tlbmRzLm9ubnggfHwge30pKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnguZW52Lndhc20gZXhpc3RzOmAsIGVudi5iYWNrZW5kcy5vbm54Py5lbnY/Lndhc20gIT09IHVuZGVmaW5lZCk7XHJcblx0fVxyXG5cdC8vIE1ldGhvZCAyOiBtb2QuZGVmYXVsdC5lbnYuYmFja2VuZHMub25ueCAoaWYgZGVmYXVsdCBleHBvcnQpXHJcblx0ZWxzZSBpZiAobW9kPy5kZWZhdWx0Py5lbnY/LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5kZWZhdWx0LmVudi5iYWNrZW5kcy5vbm54YCk7XHJcblx0XHRlbnYgPSBtb2QuZGVmYXVsdC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmRlZmF1bHQuZW52JztcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueCBrZXlzOmAsIHR5cGVvZiBlbnYuYmFja2VuZHMub25ueCA9PT0gJ29iamVjdCcgJiYgZW52LmJhY2tlbmRzLm9ubnggPyBPYmplY3Qua2V5cyhlbnYuYmFja2VuZHMub25ueCkuc2xpY2UoMCwgMjApIDogJ04vQScpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueC5lbnYgZXhpc3RzOmAsICdlbnYnIGluIChlbnYuYmFja2VuZHMub25ueCB8fCB7fSkpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueC5lbnYud2FzbSBleGlzdHM6YCwgZW52LmJhY2tlbmRzLm9ubng/LmVudj8ud2FzbSAhPT0gdW5kZWZpbmVkKTtcclxuXHR9XHJcblx0ZWxzZSB7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJcgQ291bGQgbm90IGZpbmQgT05OWCBlbnZpcm9ubWVudCBzdHJ1Y3R1cmVgKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5lbnYgZXhpc3RzOmAsIG1vZD8uZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudi5iYWNrZW5kcyBleGlzdHM6YCwgbW9kPy5lbnY/LmJhY2tlbmRzICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudi5iYWNrZW5kcy5vbm54IGV4aXN0czpgLCBtb2Q/LmVudj8uYmFja2VuZHM/Lm9ubnggIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdCBleGlzdHM6YCwgbW9kPy5kZWZhdWx0ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IGV4aXN0czpgLCBtb2Q/LmRlZmF1bHQ/LmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudi5iYWNrZW5kcyBleGlzdHM6YCwgbW9kPy5kZWZhdWx0Py5lbnY/LmJhY2tlbmRzICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIG1vZD8uZGVmYXVsdD8uZW52Py5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdFxyXG5cdFx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIHdoYXQgd2UgRE8gaGF2ZVxyXG5cdFx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5lbnYsIDMpKTtcclxuXHRcdH1cclxuXHRcdGlmIChtb2Q/LmRlZmF1bHQ/LmVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5kZWZhdWx0LmVudiwgMykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHRcclxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyBPTkxZIGlmIHRoZSByZWFsIE9OTlggZW52aXJvbm1lbnQgZXhpc3RzXHJcblx0Ly8gVGhlIHN0cnVjdHVyZSBzaG91bGQgYmU6IGVudi5iYWNrZW5kcy5vbm54LmVudi53YXNtIChub3RlIHRoZSBuZXN0ZWQgLmVudilcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcclxuXHRcclxuXHRpZiAoZW52ICYmIGVudi5iYWNrZW5kcyAmJiBlbnYuYmFja2VuZHMub25ueCkge1xyXG5cdFx0Y29uc3Qgb25ueEJhY2tlbmQgPSBlbnYuYmFja2VuZHMub25ueDtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIE9OTlggYmFja2VuZCBmb3VuZCB2aWEgJHtlbnZTb3VyY2V9YCk7XHJcblx0XHRcclxuXHRcdC8vIFRyeSB0byBmaW5kIHRoZSBhY3R1YWwgT05OWCBSdW50aW1lIGVudmlyb25tZW50XHJcblx0XHQvLyBJdCBtaWdodCBiZSBhdDogb25ueEJhY2tlbmQuZW52Lndhc20gT1Igb25ueEJhY2tlbmQud2FzbVxyXG5cdFx0bGV0IHdhc21FbnY6IGFueSA9IG51bGw7XHJcblx0XHRsZXQgd2FzbUVudlBhdGggPSAnbm9uZSc7XHJcblx0XHRcclxuXHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgV0FTTSBlbnYgYXQgb25ueEJhY2tlbmQuZW52Lndhc21gKTtcclxuXHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLmVudi53YXNtO1xyXG5cdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC5lbnYud2FzbSc7XHJcblx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLndhc20pIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgV0FTTSBlbnYgYXQgb25ueEJhY2tlbmQud2FzbWApO1xyXG5cdFx0XHR3YXNtRW52ID0gb25ueEJhY2tlbmQud2FzbTtcclxuXHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQud2FzbSc7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJcgV0FTTSBlbnZpcm9ubWVudCBub3QgZm91bmQgYXQgZXhwZWN0ZWQgcGF0aHNgKTtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQuZW52IGV4aXN0czpgLCBvbm54QmFja2VuZC5lbnYgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudi53YXNtIGV4aXN0czpgLCBvbm54QmFja2VuZC5lbnY/Lndhc20gIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLndhc20gZXhpc3RzOmAsIG9ubnhCYWNrZW5kLndhc20gIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kIGtleXM6YCwgT2JqZWN0LmtleXMob25ueEJhY2tlbmQpLnNsaWNlKDAsIDMwKSk7XHJcblx0XHRcdGlmIChvbm54QmFja2VuZC5lbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudiBzdHJ1Y3R1cmU6YCwgZGVlcEluc3BlY3Qob25ueEJhY2tlbmQuZW52LCAyKSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0aWYgKHdhc21FbnYpIHtcclxuXHRcdFx0Y29uc3QgdmF1bHRCYXNlID0gKHBsdWdpbi5hcHAudmF1bHQuYWRhcHRlciBhcyBhbnkpLmJhc2VQYXRoIHx8ICcnO1xyXG5cdFx0XHRjb25zdCBwbHVnaW5JZCA9IHBsdWdpbi5tYW5pZmVzdC5pZDtcclxuXHRcdFx0XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ29uZmlndXJpbmcgV0FTTSBwYXRocyBhdDogJHt3YXNtRW52UGF0aH1gKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBWYXVsdCBiYXNlOiAke3ZhdWx0QmFzZX1gKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBQbHVnaW4gSUQ6ICR7cGx1Z2luSWR9YCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBVc2Ugc3RyaW5nLWJhc2VkIHBhdGggKGJhc2UgZGlyZWN0b3J5KSBsaWtlIHRyYW5zZm9ybWVycy5qcyBkb2VzIGludGVybmFsbHlcclxuXHRcdFx0Y29uc3Qgd2FzbUJhc2VQYXRoID0gJy4vbGliLyc7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBDaGVjayBjdXJyZW50IHdhc21QYXRocyB2YWx1ZVxyXG5cdFx0XHRjb25zdCBjdXJyZW50UGF0aHMgPSB3YXNtRW52Lndhc21QYXRocztcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDdXJyZW50IHdhc21QYXRocyB2YWx1ZTpgLCBjdXJyZW50UGF0aHMpO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEN1cnJlbnQgd2FzbVBhdGhzIHR5cGU6YCwgdHlwZW9mIGN1cnJlbnRQYXRocyk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBTZXQgdGhlIGJhc2UgcGF0aCAodHJhbnNmb3JtZXJzLmpzIHVzZXMgc3RyaW5nLCBub3Qgb2JqZWN0IG1hcHBpbmcpXHJcblx0XHRcdHdhc21FbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBTZXQgd2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBWZXJpZmllZCB3YXNtUGF0aHMgYWZ0ZXIgc2V0dGluZzpgLCB3YXNtRW52Lndhc21QYXRocyk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gd2FzbUVudiBzdHJ1Y3R1cmUgYWZ0ZXIgY29uZmlnOmAsIGRlZXBJbnNwZWN0KHdhc21FbnYsIDIpKTtcclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJcgQ2Fubm90IGNvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gV0FTTSBlbnZpcm9ubWVudCBub3QgZm91bmRgKTtcclxuXHRcdH1cclxuXHR9IGVsc2Uge1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBPTk5YIGJhY2tlbmQgbm90IGZvdW5kYCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCBtb2QuZGVmYXVsdD8ucGlwZWxpbmU7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIHBpcGVsaW5lKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGlzIGZ1bmN0aW9uOmAsIHR5cGVvZiBwaXBlbGluZSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHJcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLnBpcGVsaW5lOmAsIG1vZD8ucGlwZWxpbmUpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5kZWZhdWx0LnBpcGVsaW5lOmAsIG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xyXG5cdH1cclxuXHRcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFBJUEVMSU5FIExPQUQgQ09NUExFVEUgPT09YCk7XHJcblx0cmV0dXJuIHBpcGVsaW5lO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XHJcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XHJcblx0bGV0IHN1bVNxID0gMDtcclxuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cclxuICovXHJcbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xyXG5cdHRpbWVzdGFtcDogc3RyaW5nO1xyXG5cdGxvY2F0aW9uOiBzdHJpbmc7XHJcblx0Y29udGV4dDogc3RyaW5nO1xyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcclxuXHRyZWFkb25seSBkaW0gPSAzODQ7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XHJcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBNb2RlbEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZCAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSksIHdhaXRpbmcuLi5gKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHRcdH1cclxuXHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBTVEFSVElORyBNT0RFTCBMT0FEID09PWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHMgKyAxfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0dGhpcy5sb2FkQXR0ZW1wdHMrKztcclxuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiBHZXR0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xyXG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSkge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG51bGwgb3IgdW5kZWZpbmVkJyk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRpZiAodHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24sIGdvdDogJHt0eXBlb2YgcGlwZWxpbmV9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWQgKHR5cGU6ICR7dHlwZW9mIHBpcGVsaW5lfSwgbmFtZTogJHtwaXBlbGluZS5uYW1lIHx8ICdhbm9ueW1vdXMnfSlgKTtcclxuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiDinJcgRmFpbGVkIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbmApO1xyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XHJcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHRyYW5zZm9ybWVycyBwaXBlbGluZTogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxyXG5cdFx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogTW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IENyZWF0aW5nIG1vZGVsIHBpcGVsaW5lICh0aGlzIG1heSB0YWtlIHRpbWUpLi4uYCk7XHJcblxyXG5cdFx0XHRcdGxldCBwaXBlVW5rbm93bjogdW5rbm93bjtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgcGlwZWxpbmVTdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXHJcblx0XHRcdFx0XHRwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKCdmZWF0dXJlLWV4dHJhY3Rpb24nLCAnWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjInLCB7XHJcblx0XHRcdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcclxuXHRcdFx0XHRcdFx0Y2FjaGVfZGlyOiBjYWNoZURpclxyXG5cdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZUR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHBpcGVsaW5lU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJMgUGlwZWxpbmUgY3JlYXRlZCBpbiAke3BpcGVsaW5lRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogUGlwZWxpbmUgb3V0cHV0IHR5cGU6ICR7dHlwZW9mIHBpcGVVbmtub3dufWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShwaXBlVW5rbm93bil9YCk7XHJcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkYCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgdHlwZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBwaXBlbGluZUVycn1gKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBtZXNzYWdlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5tZXNzYWdlIDogU3RyaW5nKHBpcGVsaW5lRXJyKX1gKTtcclxuXHRcdFx0XHRcdGlmIChwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yICYmIHBpcGVsaW5lRXJyLnN0YWNrKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBzdGFjayAoZmlyc3QgMTAgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKHBpcGVsaW5lRXJyLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxMCkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcclxuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IFdyYXBwaW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblxyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gU3RhcnRpbmcgZW1iZWRkaW5nIGdlbmVyYXRpb24gZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xyXG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBSYXcgb3V0cHV0IHJlY2VpdmVkIGluICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IHR5cGU6ICR7dHlwZW9mIG91dH1gKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XHJcblx0XHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdFx0XHRsZXQgcmVzdWx0OiBudW1iZXJbXTtcclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxBcnJheTxudW1iZXI+PiwgdXNpbmcgb3V0WzBdYCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxudW1iZXI+LCB1c2luZyBkaXJlY3RseWApO1xyXG5cdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcclxuXHRcdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtYXliZT8uZGF0YSkpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IE9iamVjdCB3aXRoIGRhdGEgYXJyYXksIHVzaW5nIGRhdGFgKTtcclxuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIOKclyBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXRgKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dDpgLCBvdXQpO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgc3VjY2Vzc2Z1bGx5ICgke3Jlc3VsdC5sZW5ndGh9IGRpbWVuc2lvbnMpYCk7XHJcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEVycm9yOmAsIGVycik7XHJcblx0XHRcdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiDinJMgUGlwZWxpbmUgd3JhcHBlciBjcmVhdGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgRlVMTFkgTE9BREVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0czogJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IE1PREVMIExPQUQgRkFJTEVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdDogIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycjtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgdHlwZTogJHtlcnJvclR5cGV9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIG1lc3NhZ2U6ICR7ZXJyb3JNc2d9YCk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciBzdGFjayAoZmlyc3QgMTUgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxNSkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgaXNSZWFkeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdHJldHVybiB0aGlzLnBpcGVsaW5lICE9PSBudWxsO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcclxuXHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcclxuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XHJcblx0fVxyXG5cclxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xyXG5cdFx0cmV0dXJuIHRoaXMubGFzdExvYWRFcnJvcjtcclxuXHR9XHJcblxyXG5cdGdldExvYWRBdHRlbXB0cygpOiBudW1iZXIge1xyXG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XHJcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcclxuXHRcdFxyXG5cdFx0Y29uc3QgZW50cnk6IE1vZGVsRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXHJcblx0XHRpZiAobG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQnIHx8IGxvY2F0aW9uID09PSAnaXNSZWFkeScpIHtcclxuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xyXG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHR9XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XHJcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBHZW5lcmF0ZWQgZW1iZWRkaW5nIGluICR7ZW1iZWREdXJhdGlvbn1tcyBmb3IgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCk7XHJcblx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignZW1iZWQnLCBgRW1iZWRkaW5nIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQ6YCwgZXJyKTtcclxuXHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==