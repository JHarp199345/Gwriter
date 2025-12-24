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
// Capture a one-time snapshot of the transformers env / ONNX state for diagnostics
let lastEnvSnapshot = null;
function captureEnvSnapshot(mod, env, where) {
    try {
        const onnx = env?.backends?.onnx;
        lastEnvSnapshot = {
            where,
            timestamp: new Date().toISOString(),
            modKeys: mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 20) : null,
            hasDefault: !!mod?.default,
            hasPipeline: typeof (mod?.pipeline || mod?.default?.pipeline) === 'function',
            envKeys: env ? Object.keys(env).slice(0, 20) : null,
            backendKeys: onnx ? Object.keys(onnx).slice(0, 20) : null,
            onnxHasWasm: !!onnx?.wasm,
            onnxWasmKeys: onnx?.wasm ? Object.keys(onnx.wasm).slice(0, 20) : null,
            onnxWasmPaths: onnx?.wasm?.wasmPaths ?? null,
            envHasUseWasm: typeof env?.useWasm === 'function',
            envHasBackends: !!env?.backends,
        };
        console.log('[LocalEmbeddingModel] [ENV SNAPSHOT]', lastEnvSnapshot);
    }
    catch (e) {
        console.warn('[LocalEmbeddingModel] [ENV SNAPSHOT] Failed to capture env snapshot:', e);
    }
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
        // Capture env snapshot before WASM config
        if (!lastEnvSnapshot) {
            captureEnvSnapshot(mod, env, 'before-wasm-config');
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
                    // Capture env snapshot at failure time if we don't have one
                    if (!lastEnvSnapshot) {
                        try {
                            const modAtError = await import('../../lib/transformers.js');
                            const envAtError = modAtError.env || modAtError.default?.env;
                            if (envAtError) {
                                captureEnvSnapshot(modAtError, envAtError, 'on-pipeline-error');
                            }
                        }
                        catch {
                            // ignore secondary failures
                        }
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
    getEnvSnapshot() {
        return lastEnvSnapshot;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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QyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM1QyxDQUFDO1FBQ0QsSUFBSSxDQUFDO1lBQ0osTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDMUIsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1lBQzFFLENBQUM7WUFDRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDOUIsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxVQUFVLENBQUM7WUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnREFBZ0QsYUFBYSxnQkFBZ0IsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUM7WUFDNUksT0FBTyxNQUFNLENBQUM7UUFDZixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLG1CQUFtQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbi8vIEhlbHBlciBmdW5jdGlvbiB0byBzYWZlbHkgaW5zcGVjdCBvYmplY3Qgc3RydWN0dXJlIHdpdGhvdXQgY2F1c2luZyBlcnJvcnNcclxuZnVuY3Rpb24gZGVlcEluc3BlY3Qob2JqOiBhbnksIG1heERlcHRoOiBudW1iZXIgPSAzLCBjdXJyZW50RGVwdGg6IG51bWJlciA9IDAsIHZpc2l0ZWQ6IFdlYWtTZXQ8YW55PiA9IG5ldyBXZWFrU2V0KCkpOiBhbnkge1xyXG5cdGlmIChjdXJyZW50RGVwdGggPj0gbWF4RGVwdGggfHwgb2JqID09PSBudWxsIHx8IG9iaiA9PT0gdW5kZWZpbmVkKSB7XHJcblx0XHRyZXR1cm4gdHlwZW9mIG9iajtcclxuXHR9XHJcblx0aWYgKHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSB7XHJcblx0XHRyZXR1cm4gb2JqO1xyXG5cdH1cclxuXHRpZiAodmlzaXRlZC5oYXMob2JqKSkge1xyXG5cdFx0cmV0dXJuICdbQ2lyY3VsYXJdJztcclxuXHR9XHJcblx0dmlzaXRlZC5hZGQob2JqKTtcclxuXHRcclxuXHRjb25zdCByZXN1bHQ6IGFueSA9IHt9O1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBrZXlzID0gT2JqZWN0LmtleXMob2JqKS5zbGljZSgwLCAyMCk7IC8vIExpbWl0IGtleXMgdG8gYXZvaWQgaHVnZSBvdXRwdXRcclxuXHRcdGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCB2YWwgPSBvYmpba2V5XTtcclxuXHRcdFx0XHRpZiAodHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Z1bmN0aW9uOiAke3ZhbC5uYW1lIHx8ICdhbm9ueW1vdXMnfV1gO1xyXG5cdFx0XHRcdH0gZWxzZSBpZiAodHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgJiYgdmFsICE9PSBudWxsKSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IGRlZXBJbnNwZWN0KHZhbCwgbWF4RGVwdGgsIGN1cnJlbnREZXB0aCArIDEsIHZpc2l0ZWQpO1xyXG5cdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IHZhbDtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gY2F0Y2ggKGUpIHtcclxuXHRcdFx0XHRyZXN1bHRba2V5XSA9IGBbRXJyb3IgYWNjZXNzaW5nOiAke2V9XWA7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9IGNhdGNoIChlKSB7XHJcblx0XHRyZXR1cm4gYFtFcnJvciBpbnNwZWN0aW5nOiAke2V9XWA7XHJcblx0fVxyXG5cdHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8vIENhcHR1cmUgYSBvbmUtdGltZSBzbmFwc2hvdCBvZiB0aGUgdHJhbnNmb3JtZXJzIGVudiAvIE9OTlggc3RhdGUgZm9yIGRpYWdub3N0aWNzXHJcbmxldCBsYXN0RW52U25hcHNob3Q6IGFueSB8IG51bGwgPSBudWxsO1xyXG5cclxuZnVuY3Rpb24gY2FwdHVyZUVudlNuYXBzaG90KG1vZDogYW55LCBlbnY6IGFueSwgd2hlcmU6IHN0cmluZyk6IHZvaWQge1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBvbm54ID0gZW52Py5iYWNrZW5kcz8ub25ueDtcclxuXHRcdGxhc3RFbnZTbmFwc2hvdCA9IHtcclxuXHRcdFx0d2hlcmUsXHJcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG5cdFx0XHRtb2RLZXlzOiBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdGhhc0RlZmF1bHQ6ICEhbW9kPy5kZWZhdWx0LFxyXG5cdFx0XHRoYXNQaXBlbGluZTogdHlwZW9mIChtb2Q/LnBpcGVsaW5lIHx8IG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpID09PSAnZnVuY3Rpb24nLFxyXG5cdFx0XHRlbnZLZXlzOiBlbnYgPyBPYmplY3Qua2V5cyhlbnYpLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdGJhY2tlbmRLZXlzOiBvbm54ID8gT2JqZWN0LmtleXMob25ueCkuc2xpY2UoMCwgMjApIDogbnVsbCxcclxuXHRcdFx0b25ueEhhc1dhc206ICEhb25ueD8ud2FzbSxcclxuXHRcdFx0b25ueFdhc21LZXlzOiBvbm54Py53YXNtID8gT2JqZWN0LmtleXMob25ueC53YXNtKS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRvbm54V2FzbVBhdGhzOiBvbm54Py53YXNtPy53YXNtUGF0aHMgPz8gbnVsbCxcclxuXHRcdFx0ZW52SGFzVXNlV2FzbTogdHlwZW9mIGVudj8udXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyxcclxuXHRcdFx0ZW52SGFzQmFja2VuZHM6ICEhZW52Py5iYWNrZW5kcyxcclxuXHRcdH07XHJcblx0XHRjb25zb2xlLmxvZygnW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdJywgbGFzdEVudlNuYXBzaG90KTtcclxuXHR9IGNhdGNoIChlKSB7XHJcblx0XHRjb25zb2xlLndhcm4oJ1tMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU5WIFNOQVBTSE9UXSBGYWlsZWQgdG8gY2FwdHVyZSBlbnYgc25hcHNob3Q6JywgZSk7XHJcblx0fVxyXG59XHJcblxyXG4vLyBIZWxwZXIgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uIHdpdGggcHJvcGVyIGVycm9yIGhhbmRsaW5nXHJcbi8vIFVzZXMgdmVuZG9yZWQgdHJhbnNmb3JtZXJzLmpzIHRvIGF2b2lkIGJ1bmRsaW5nIGlzc3Vlc1xyXG5hc3luYyBmdW5jdGlvbiBnZXRQaXBlbGluZShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiBQcm9taXNlPGFueT4ge1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFNUQVJUSU5HIFBJUEVMSU5FIExPQUQgPT09YCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFxyXG5cdC8vIEltcG9ydCB0aGUgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIGxpYnJhcnkgZmlyc3RcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIEltcG9ydGluZyB0cmFuc2Zvcm1lcnMuanMgbW9kdWxlLi4uYCk7XHJcblx0bGV0IG1vZDogYW55O1xyXG5cdHRyeSB7XHJcblx0XHRtb2QgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0g4pyTIE1vZHVsZSBpbXBvcnRlZCBzdWNjZXNzZnVsbHlgKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIHR5cGU6ICR7dHlwZW9mIG1vZH1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIG51bGw6ICR7bW9kID09PSBudWxsfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgaXMgdW5kZWZpbmVkOiAke21vZCA9PT0gdW5kZWZpbmVkfWApO1xyXG5cdH0gY2F0Y2ggKGltcG9ydEVycikge1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gaW1wb3J0IHRyYW5zZm9ybWVycy5qczogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIERlZXAgaW5zcGVjdGlvbiBvZiBtb2R1bGUgc3RydWN0dXJlXHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBJbnNwZWN0aW5nIG1vZHVsZSBzdHJ1Y3R1cmUuLi5gKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIE1vZHVsZSBrZXlzIChmaXJzdCAzMCk6YCwgbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAzMCkgOiAnTi9BJyk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2VudicgcHJvcGVydHk6YCwgJ2VudicgaW4gKG1vZCB8fCB7fSkpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdkZWZhdWx0JyBwcm9wZXJ0eTpgLCAnZGVmYXVsdCcgaW4gKG1vZCB8fCB7fSkpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdwaXBlbGluZScgcHJvcGVydHk6YCwgJ3BpcGVsaW5lJyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QuZW52IHR5cGU6YCwgdHlwZW9mIG1vZD8uZW52KTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5kZWZhdWx0IHR5cGU6YCwgdHlwZW9mIG1vZD8uZGVmYXVsdCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QucGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgbW9kPy5waXBlbGluZSk7XHJcblx0XHJcblx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudFxyXG5cdGxldCBlbnY6IGFueSA9IG51bGw7XHJcblx0bGV0IGVudlNvdXJjZSA9ICdub25lJztcclxuXHRcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIEF0dGVtcHRpbmcgdG8gbG9jYXRlIGVudmlyb25tZW50IHN0cnVjdHVyZS4uLmApO1xyXG5cdFxyXG5cdC8vIE1ldGhvZCAxOiBEaXJlY3QgbW9kLmVudiAoc3RhbmRhcmQgc3RydWN0dXJlKVxyXG5cdGlmIChtb2Q/LmVudikge1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJMgRm91bmQgZW52IHZpYSBtb2QuZW52YCk7XHJcblx0XHRlbnYgPSBtb2QuZW52O1xyXG5cdFx0ZW52U291cmNlID0gJ21vZC5lbnYnO1xyXG5cdH1cclxuXHQvLyBNZXRob2QgMjogbW9kLmRlZmF1bHQuZW52IChpZiBkZWZhdWx0IGV4cG9ydClcclxuXHRlbHNlIGlmIChtb2Q/LmRlZmF1bHQ/LmVudikge1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJMgRm91bmQgZW52IHZpYSBtb2QuZGVmYXVsdC5lbnZgKTtcclxuXHRcdGVudiA9IG1vZC5kZWZhdWx0LmVudjtcclxuXHRcdGVudlNvdXJjZSA9ICdtb2QuZGVmYXVsdC5lbnYnO1xyXG5cdH1cclxuXHRcclxuXHQvLyBEZWVwIGluc3BlY3Rpb24gb2Ygd2hhdCB3ZSBoYXZlXHJcblx0aWYgKGVudikge1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYgdHlwZTogJHt0eXBlb2YgZW52fWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYga2V5cyAoZmlyc3QgMzApOmAsIE9iamVjdC5rZXlzKGVudikuc2xpY2UoMCwgMzApKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzIGV4aXN0czpgLCAnYmFja2VuZHMnIGluIGVudik7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IGV4aXN0czpgLCBlbnYuYmFja2VuZHM/Lm9ubnggIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi51c2VXYXNtIGV4aXN0czpgLCB0eXBlb2YgZW52LnVzZVdhc20gPT09ICdmdW5jdGlvbicpO1xyXG5cdFx0aWYgKGVudi5iYWNrZW5kcykge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcyBrZXlzOmAsIE9iamVjdC5rZXlzKGVudi5iYWNrZW5kcykpO1xyXG5cdFx0fVxyXG5cdFx0aWYgKGVudi5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IHR5cGU6YCwgdHlwZW9mIGVudi5iYWNrZW5kcy5vbm54KTtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueCBrZXlzOmAsIE9iamVjdC5rZXlzKGVudi5iYWNrZW5kcy5vbm54KS5zbGljZSgwLCAyMCkpO1xyXG5cdFx0fVxyXG5cdFx0Ly8gQ2FwdHVyZSBlbnYgc25hcHNob3QgYmVmb3JlIFdBU00gY29uZmlnXHJcblx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xyXG5cdFx0XHRjYXB0dXJlRW52U25hcHNob3QobW9kLCBlbnYsICdiZWZvcmUtd2FzbS1jb25maWcnKTtcclxuXHRcdH1cclxuXHR9IGVsc2Uge1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyXIENvdWxkIG5vdCBmaW5kIGVudiBzdHJ1Y3R1cmVgKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5lbnYgZXhpc3RzOmAsIG1vZD8uZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQgZXhpc3RzOmAsIG1vZD8uZGVmYXVsdCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudiBleGlzdHM6YCwgbW9kPy5kZWZhdWx0Py5lbnYgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRpZiAobW9kPy5lbnYpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZW52IHN0cnVjdHVyZSAoZGVwdGggMyk6YCwgZGVlcEluc3BlY3QobW9kLmVudiwgMykpO1xyXG5cdFx0fVxyXG5cdFx0aWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IHN0cnVjdHVyZSAoZGVwdGggMyk6YCwgZGVlcEluc3BlY3QobW9kLmRlZmF1bHQuZW52LCAzKSk7XHJcblx0XHR9XHJcblx0fVxyXG5cdFxyXG5cdC8vIENvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gdHJ5IG11bHRpcGxlIGFwcHJvYWNoZXNcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcclxuXHRcclxuXHRpZiAoZW52KSB7XHJcblx0XHQvLyBBcHByb2FjaCAxOiBUcnkgZW52LnVzZVdhc20oKSBpZiBhdmFpbGFibGUgKHRyYW5zZm9ybWVycy5qcyBBUEkpXHJcblx0XHRpZiAodHlwZW9mIGVudi51c2VXYXNtID09PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBdHRlbXB0aW5nIGVudi51c2VXYXNtKCkuLi5gKTtcclxuXHRcdFx0XHRlbnYudXNlV2FzbSgpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENhbGxlZCBlbnYudXNlV2FzbSgpYCk7XHJcblx0XHRcdH0gY2F0Y2ggKHVzZVdhc21FcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYudXNlV2FzbSgpIGZhaWxlZDpgLCB1c2VXYXNtRXJyKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBBcHByb2FjaCAyOiBUcnkgdG8gY29uZmlndXJlIFdBU00gcGF0aHMgdmlhIGJhY2tlbmRzLm9ubnguZW52Lndhc21cclxuXHRcdGlmIChlbnYuYmFja2VuZHM/Lm9ubngpIHtcclxuXHRcdFx0Y29uc3Qgb25ueEJhY2tlbmQgPSBlbnYuYmFja2VuZHMub25ueDtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgT05OWCBiYWNrZW5kIGZvdW5kIHZpYSAke2VudlNvdXJjZX1gKTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIFRyeSB0byBmaW5kIHRoZSBhY3R1YWwgT05OWCBSdW50aW1lIGVudmlyb25tZW50XHJcblx0XHRcdC8vIEl0IG1pZ2h0IGJlIGF0OiBvbm54QmFja2VuZC5lbnYud2FzbSBPUiBvbm54QmFja2VuZC53YXNtIE9SIG9ubnhCYWNrZW5kLmVudlxyXG5cdFx0XHRsZXQgd2FzbUVudjogYW55ID0gbnVsbDtcclxuXHRcdFx0bGV0IHdhc21FbnZQYXRoID0gJ25vbmUnO1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKG9ubnhCYWNrZW5kLmVudj8ud2FzbSkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLmVudi53YXNtYCk7XHJcblx0XHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLmVudi53YXNtO1xyXG5cdFx0XHRcdHdhc21FbnZQYXRoID0gJ29ubnhCYWNrZW5kLmVudi53YXNtJztcclxuXHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC53YXNtKSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgV0FTTSBlbnYgYXQgb25ueEJhY2tlbmQud2FzbWApO1xyXG5cdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC53YXNtO1xyXG5cdFx0XHRcdHdhc21FbnZQYXRoID0gJ29ubnhCYWNrZW5kLndhc20nO1xyXG5cdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLmVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIGVudiBhdCBvbm54QmFja2VuZC5lbnYgKHRyeWluZyBhcyBXQVNNIGVudilgKTtcclxuXHRcdFx0XHR3YXNtRW52ID0gb25ueEJhY2tlbmQuZW52O1xyXG5cdFx0XHRcdHdhc21FbnZQYXRoID0gJ29ubnhCYWNrZW5kLmVudic7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyXIFdBU00gZW52aXJvbm1lbnQgbm90IGZvdW5kIGF0IGV4cGVjdGVkIHBhdGhzYCk7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQuZW52IGV4aXN0czpgLCBvbm54QmFja2VuZC5lbnYgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQud2FzbSBleGlzdHM6YCwgb25ueEJhY2tlbmQud2FzbSAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54QmFja2VuZCBrZXlzOmAsIE9iamVjdC5rZXlzKG9ubnhCYWNrZW5kKS5zbGljZSgwLCAzMCkpO1xyXG5cdFx0XHRcdGlmIChvbm54QmFja2VuZC5lbnYpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQuZW52IHN0cnVjdHVyZTpgLCBkZWVwSW5zcGVjdChvbm54QmFja2VuZC5lbnYsIDIpKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdGlmICh3YXNtRW52KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDb25maWd1cmluZyBXQVNNIHBhdGhzIGF0OiAke3dhc21FbnZQYXRofWApO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIFVzZSBzdHJpbmctYmFzZWQgcGF0aCAoYmFzZSBkaXJlY3RvcnkpIGxpa2UgdHJhbnNmb3JtZXJzLmpzIGRvZXMgaW50ZXJuYWxseVxyXG5cdFx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIENoZWNrIGN1cnJlbnQgd2FzbVBhdGhzIHZhbHVlXHJcblx0XHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIHdhc21FbnYpIHtcclxuXHRcdFx0XHRcdGNvbnN0IGN1cnJlbnRQYXRocyA9IHdhc21FbnYud2FzbVBhdGhzO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDdXJyZW50IHdhc21QYXRocyB2YWx1ZTpgLCBjdXJyZW50UGF0aHMpO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDdXJyZW50IHdhc21QYXRocyB0eXBlOmAsIHR5cGVvZiBjdXJyZW50UGF0aHMpO1xyXG5cdFx0XHRcdFx0XHJcblx0XHRcdFx0XHQvLyBTZXQgdGhlIGJhc2UgcGF0aCAodHJhbnNmb3JtZXJzLmpzIHVzZXMgc3RyaW5nLCBub3Qgb2JqZWN0IG1hcHBpbmcpXHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHR3YXNtRW52Lndhc21QYXRocyA9IHdhc21CYXNlUGF0aDtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgU2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gVmVyaWZpZWQgd2FzbVBhdGhzIGFmdGVyIHNldHRpbmc6YCwgd2FzbUVudi53YXNtUGF0aHMpO1xyXG5cdFx0XHRcdFx0fSBjYXRjaCAocGF0aEVycikge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gc2V0IHdhc21QYXRoczpgLCBwYXRoRXJyKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0Ly8gVHJ5IHRvIGNyZWF0ZSB3YXNtUGF0aHMgcHJvcGVydHkgaWYgaXQgZG9lc24ndCBleGlzdFxyXG5cdFx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KHdhc21FbnYsICd3YXNtUGF0aHMnLCB7XHJcblx0XHRcdFx0XHRcdFx0dmFsdWU6IHdhc21CYXNlUGF0aCxcclxuXHRcdFx0XHRcdFx0XHR3cml0YWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0XHRlbnVtZXJhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxyXG5cdFx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgQ3JlYXRlZCBhbmQgc2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChkZWZpbmVFcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIGRlZmluZSB3YXNtUGF0aHM6YCwgZGVmaW5lRXJyKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQXBwcm9hY2ggMzogVHJ5IHRvIHNldCBlbnYud2FzbVBhdGhzIGRpcmVjdGx5IGlmIGF2YWlsYWJsZVxyXG5cdFx0aWYgKCd3YXNtUGF0aHMnIGluIGVudikge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRm91bmQgZW52Lndhc21QYXRocywgc2V0dGluZyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0ZW52Lndhc21QYXRocyA9IHdhc21CYXNlUGF0aDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBTZXQgZW52Lndhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdH0gY2F0Y2ggKGVudlBhdGhFcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gc2V0IGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9IGVsc2Uge1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyXIENhbm5vdCBjb25maWd1cmUgV0FTTSBwYXRocyAtIGVudiBub3QgZm91bmRgKTtcclxuXHR9XHJcblx0XHJcblx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uXHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBMb2NhdGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xyXG5cdGNvbnN0IHBpcGVsaW5lID0gbW9kLnBpcGVsaW5lIHx8IG1vZC5kZWZhdWx0Py5waXBlbGluZTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGZvdW5kOmAsIHBpcGVsaW5lICE9PSB1bmRlZmluZWQgJiYgcGlwZWxpbmUgIT09IG51bGwpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgaXMgZnVuY3Rpb246YCwgdHlwZW9mIHBpcGVsaW5lID09PSAnZnVuY3Rpb24nKTtcclxuXHRcclxuXHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKclyBQaXBlbGluZSBub3QgZm91bmQgb3Igbm90IGEgZnVuY3Rpb25gKTtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBtb2QucGlwZWxpbmU6YCwgbW9kPy5waXBlbGluZSk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLmRlZmF1bHQucGlwZWxpbmU6YCwgbW9kPy5kZWZhdWx0Py5waXBlbGluZSk7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIG5vdCBmb3VuZCBpbiB0cmFuc2Zvcm1lcnMgbW9kdWxlJyk7XHJcblx0fVxyXG5cdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0g4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGZvdW5kYCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gUElQRUxJTkUgTE9BRCBDT01QTEVURSA9PT1gKTtcclxuXHRyZXR1cm4gcGlwZWxpbmU7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcclxuXHRyZWFkb25seSBkaW06IG51bWJlcjtcclxuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcclxufVxyXG5cclxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcclxuXHRsZXQgc3VtU3EgPSAwO1xyXG5cdGZvciAoY29uc3QgdiBvZiB2ZWMpIHN1bVNxICs9IHYgKiB2O1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRydWUgbG9jYWwgZW1iZWRkaW5ncyB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxyXG4gKi9cclxuaW50ZXJmYWNlIE1vZGVsRXJyb3JMb2dFbnRyeSB7XHJcblx0dGltZXN0YW1wOiBzdHJpbmc7XHJcblx0bG9jYXRpb246IHN0cmluZztcclxuXHRjb250ZXh0OiBzdHJpbmc7XHJcblx0bWVzc2FnZTogc3RyaW5nO1xyXG5cdHN0YWNrPzogc3RyaW5nO1xyXG5cdGVycm9yVHlwZT86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwgaW1wbGVtZW50cyBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xyXG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSBwaXBlbGluZTogbnVsbCB8ICgodGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcltdPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZEF0dGVtcHRzID0gMDtcclxuXHRwcml2YXRlIGxhc3RMb2FkRXJyb3I6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IE1vZGVsRXJyb3JMb2dFbnRyeVtdID0gW107XHJcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSA1MDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGFscmVhZHkgbG9hZGVkIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSlgKTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGxvYWRpbmcgaW4gcHJvZ3Jlc3MgKGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHN9KSwgd2FpdGluZy4uLmApO1xyXG5cdFx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFNUQVJUSU5HIE1PREVMIExPQUQgPT09YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0cyArIDF9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xyXG5cdFx0Y29uc3QgbG9hZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uIC0gdXNpbmcgaGVscGVyIHRvIGVuc3VyZSBwcm9wZXIgaW5pdGlhbGl6YXRpb25cclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IEdldHRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRcdFx0XHRsZXQgcGlwZWxpbmU6IGFueTtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0cGlwZWxpbmUgPSBhd2FpdCBnZXRQaXBlbGluZSh0aGlzLnBsdWdpbik7XHJcblx0XHRcdFx0XHRpZiAoIXBpcGVsaW5lKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignUGlwZWxpbmUgaXMgbnVsbCBvciB1bmRlZmluZWQnKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdGlmICh0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBQaXBlbGluZSBpcyBub3QgYSBmdW5jdGlvbiwgZ290OiAke3R5cGVvZiBwaXBlbGluZX1gKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMTog4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGxvYWRlZCAodHlwZTogJHt0eXBlb2YgcGlwZWxpbmV9LCBuYW1lOiAke3BpcGVsaW5lLm5hbWUgfHwgJ2Fub255bW91cyd9KWApO1xyXG5cdFx0XHRcdH0gY2F0Y2ggKGltcG9ydEVycikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKclyBGYWlsZWQgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uYCk7XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuaW1wb3J0JywgJ0xvYWRpbmcgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lJywgaW1wb3J0RXJyKTtcclxuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXHJcblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cclxuXHRcdFx0XHRjb25zdCBjYWNoZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9tb2RlbHNgO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogUHJlcGFyaW5nIG1vZGVsIGNhY2hlLi4uYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBDYWNoZSBkaXJlY3Rvcnk6ICR7Y2FjaGVEaXJ9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBNb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjJgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFF1YW50aXplZDogdHJ1ZWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogQ3JlYXRpbmcgbW9kZWwgcGlwZWxpbmUgKHRoaXMgbWF5IHRha2UgdGltZSkuLi5gKTtcclxuXHJcblx0XHRcdFx0bGV0IHBpcGVVbmtub3duOiB1bmtub3duO1xyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZVN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHQvLyBDYWxsIHBpcGVsaW5lIGRpcmVjdGx5IGFzIGEgZnVuY3Rpb25cclxuXHRcdFx0XHRcdHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoJ2ZlYXR1cmUtZXh0cmFjdGlvbicsICdYZW5vdmEvYWxsLU1pbmlMTS1MNi12MicsIHtcclxuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdFx0XHRjYWNoZV9kaXI6IGNhY2hlRGlyXHJcblx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdGNvbnN0IHBpcGVsaW5lRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gcGlwZWxpbmVTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKckyBQaXBlbGluZSBjcmVhdGVkIGluICR7cGlwZWxpbmVEdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgdHlwZTogJHt0eXBlb2YgcGlwZVVua25vd259YCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IFBpcGVsaW5lIG91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KHBpcGVVbmtub3duKX1gKTtcclxuXHRcdFx0XHR9IGNhdGNoIChwaXBlbGluZUVycikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKclyBQaXBlbGluZSBjcmVhdGlvbiBmYWlsZWRgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciB0eXBlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIHBpcGVsaW5lRXJyfWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IEVycm9yIG1lc3NhZ2U6ICR7cGlwZWxpbmVFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHBpcGVsaW5lRXJyLm1lc3NhZ2UgOiBTdHJpbmcocGlwZWxpbmVFcnIpfWApO1xyXG5cdFx0XHRcdFx0aWYgKHBpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgcGlwZWxpbmVFcnIuc3RhY2spIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IEVycm9yIHN0YWNrIChmaXJzdCAxMCBsaW5lcyk6YCk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IocGlwZWxpbmVFcnIuc3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDEwKS5qb2luKCdcXG4nKSk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBhdCBmYWlsdXJlIHRpbWUgaWYgd2UgZG9uJ3QgaGF2ZSBvbmVcclxuXHRcdFx0XHRcdGlmICghbGFzdEVudlNuYXBzaG90KSB7XHJcblx0XHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbW9kQXRFcnJvciA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGVudkF0RXJyb3IgPSBtb2RBdEVycm9yLmVudiB8fCBtb2RBdEVycm9yLmRlZmF1bHQ/LmVudjtcclxuXHRcdFx0XHRcdFx0XHRpZiAoZW52QXRFcnJvcikge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZEF0RXJyb3IsIGVudkF0RXJyb3IsICdvbi1waXBlbGluZS1lcnJvcicpO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XHJcblx0XHRcdFx0XHRcdFx0Ly8gaWdub3JlIHNlY29uZGFyeSBmYWlsdXJlc1xyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnLCBgQ3JlYXRpbmcgcGlwZWxpbmUgd2l0aCBtb2RlbCBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiwgY2FjaGU6ICR7Y2FjaGVEaXJ9YCwgcGlwZWxpbmVFcnIpO1xyXG5cdFx0XHRcdFx0dGhyb3cgcGlwZWxpbmVFcnI7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGNvbnN0IHBpcGUgPSBwaXBlVW5rbm93biBhcyAoaW5wdXQ6IHN0cmluZywgb3B0cz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgNDogV3JhcHBpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHJcblx0XHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jICh0ZXh0OiBzdHJpbmcpID0+IHtcclxuXHRcdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBTdGFydGluZyBlbWJlZGRpbmcgZ2VuZXJhdGlvbiBmb3IgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMsICR7dGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIFJhdyBvdXRwdXQgcmVjZWl2ZWQgaW4gJHtlbWJlZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBPdXRwdXQgdHlwZTogJHt0eXBlb2Ygb3V0fWApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IGlzIGFycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHJcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXHJcblx0XHRcdFx0XHRcdGxldCByZXN1bHQ6IG51bWJlcltdO1xyXG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PEFycmF5PG51bWJlcj4+LCB1c2luZyBvdXRbMF1gKTtcclxuXHRcdFx0XHRcdFx0XHRyZXN1bHQgPSBsMk5vcm1hbGl6ZShvdXRbMF0gYXMgbnVtYmVyW10pO1xyXG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkob3V0KSkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PG51bWJlcj4sIHVzaW5nIGRpcmVjdGx5YCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0IGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xyXG5cdFx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEZvcm1hdDogT2JqZWN0IHdpdGggZGF0YSBhcnJheSwgdXNpbmcgZGF0YWApO1xyXG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XHJcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGVyciA9IG5ldyBFcnJvcihgVW5leHBlY3RlZCBlbWJlZGRpbmdzIG91dHB1dCBmb3JtYXQ6ICR7dHlwZW9mIG91dH0sIGlzQXJyYXk6ICR7QXJyYXkuaXNBcnJheShvdXQpfWApO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgUHJvY2Vzc2luZyB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycylgLCBlcnIpO1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIFVuZXhwZWN0ZWQgb3V0cHV0IGZvcm1hdGApO1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0OmAsIG91dCk7XHJcblx0XHRcdFx0XHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJMgRW1iZWRkaW5nIGdlbmVyYXRlZCBzdWNjZXNzZnVsbHkgKCR7cmVzdWx0Lmxlbmd0aH0gZGltZW5zaW9ucylgKTtcclxuXHRcdFx0XHRcdFx0cmV0dXJuIHJlc3VsdDtcclxuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGFmdGVyICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdwaXBlbGluZS5lbWJlZCcsIGBHZW5lcmF0aW5nIGVtYmVkZGluZyBmb3IgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMsICR7dGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRXJyb3I6YCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH07XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IOKckyBQaXBlbGluZSB3cmFwcGVyIGNyZWF0ZWRgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBNT0RFTCBGVUxMWSBMT0FERUQgPT09YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHRzOiAke3RoaXMubG9hZEF0dGVtcHRzfWApO1xyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRjb25zdCBsb2FkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gbG9hZFN0YXJ0O1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgTE9BRCBGQUlMRUQgPT09YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRvdGFsIGxvYWQgdGltZTogJHtsb2FkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0OiAjJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQnLCBgTW9kZWwgbG9hZGluZyBhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfWAsIGVycik7XHJcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XHJcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yVHlwZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciB0eXBlOiAke2Vycm9yVHlwZX1gKTtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgbWVzc2FnZTogJHtlcnJvck1zZ31gKTtcclxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIHN0YWNrIChmaXJzdCAxNSBsaW5lcyk6YCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDE1KS5qb2luKCdcXG4nKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5maW5hbGx5KCgpID0+IHtcclxuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcclxuXHRcdH0pO1xyXG5cclxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0fVxyXG5cclxuXHRhc3luYyBpc1JlYWR5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMucGlwZWxpbmUgIT09IG51bGw7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignaXNSZWFkeScsICdDaGVja2luZyBtb2RlbCByZWFkaW5lc3MnLCBlcnIpO1xyXG5cdFx0XHRyZXR1cm4gZmFsc2U7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xyXG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcclxuXHR9XHJcblxyXG5cdGdldExhc3RMb2FkRXJyb3IoKTogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCB7XHJcblx0XHRyZXR1cm4gdGhpcy5sYXN0TG9hZEVycm9yO1xyXG5cdH1cclxuXHJcblx0Z2V0TG9hZEF0dGVtcHRzKCk6IG51bWJlciB7XHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XHJcblx0fVxyXG5cclxuXHRnZXRFbnZTbmFwc2hvdCgpOiBhbnkgfCBudWxsIHtcclxuXHRcdHJldHVybiBsYXN0RW52U25hcHNob3Q7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcclxuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbnRyeTogTW9kZWxFcnJvckxvZ0VudHJ5ID0ge1xyXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuXHRcdFx0bG9jYXRpb24sXHJcblx0XHRcdGNvbnRleHQsXHJcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxyXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcclxuXHRcdFx0ZXJyb3JUeXBlXHJcblx0XHR9O1xyXG5cdFx0XHJcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xyXG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcclxuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBTdG9yZSBhcyBsYXN0IGxvYWQgZXJyb3IgaWYgaXQncyBhIGxvYWRpbmcgZXJyb3JcclxuXHRcdGlmIChsb2NhdGlvbiA9PT0gJ2Vuc3VyZUxvYWRlZCcgfHwgbG9jYXRpb24gPT09ICdpc1JlYWR5Jykge1xyXG5cdFx0XHR0aGlzLmxhc3RMb2FkRXJyb3IgPSBlbnRyeTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XHJcblx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0YXN5bmMgZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Y29uc3QgdCA9ICh0ZXh0IHx8ICcnKS50cmltKCk7XHJcblx0XHRpZiAoIXQpIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1wdHkgdGV4dCBwcm92aWRlZCwgcmV0dXJuaW5nIHplcm8gdmVjdG9yYCk7XHJcblx0XHRcdHJldHVybiBuZXcgQXJyYXk8bnVtYmVyPih0aGlzLmRpbSkuZmlsbCgwKTtcclxuXHRcdH1cclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdGlmICghdGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5ncyBwaXBlbGluZSB1bmF2YWlsYWJsZSBhZnRlciBsb2FkaW5nIGF0dGVtcHQnKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcclxuXHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEdlbmVyYXRlZCBlbWJlZGRpbmcgaW4gJHtlbWJlZER1cmF0aW9ufW1zIGZvciB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgKTtcclxuXHRcdFx0cmV0dXJuIHJlc3VsdDtcclxuXHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbWJlZCcsIGBFbWJlZGRpbmcgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xyXG5cdFx0XHR0aHJvdyBlcnI7XHJcblx0XHR9XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19