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
        const backends = env?.backends;
        lastEnvSnapshot = {
            where,
            timestamp: new Date().toISOString(),
            modKeys: mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 20) : null,
            hasDefault: !!mod?.default,
            hasPipeline: typeof (mod?.pipeline || mod?.default?.pipeline) === 'function',
            envKeys: env ? Object.keys(env).slice(0, 20) : null,
            envHasBackends: !!backends,
            backendsKeys: backends ? Object.keys(backends) : null,
            onnxKeyExists: backends ? 'onnx' in backends : false,
            onnxValueExists: onnx !== undefined,
            onnxValueType: typeof onnx,
            onnxKeys: onnx ? Object.keys(onnx).slice(0, 20) : null,
            onnxHasWasm: !!onnx?.wasm,
            onnxWasmKeys: onnx?.wasm ? Object.keys(onnx.wasm).slice(0, 20) : null,
            onnxWasmPaths: onnx?.wasm?.wasmPaths ?? null,
            envHasUseWasm: typeof env?.useWasm === 'function',
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
        // Check if onnx key exists but value is undefined
        const onnxKeyExists = env.backends && 'onnx' in env.backends;
        const onnxValue = env.backends?.onnx;
        console.log(`[LocalEmbeddingModel] [STEP 4] onnx key exists: ${onnxKeyExists}`);
        console.log(`[LocalEmbeddingModel] [STEP 4] onnx value is: ${onnxValue !== undefined ? 'defined' : 'undefined'}`);
        // Approach 1: Try env.useWasm() if available (transformers.js API)
        // This might initialize the ONNX backend
        if (typeof env.useWasm === 'function') {
            try {
                console.log(`[LocalEmbeddingModel] [STEP 4] Attempting env.useWasm()...`);
                env.useWasm();
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Called env.useWasm()`);
                // Check if onnx backend is now available after useWasm
                const onnxAfterUseWasm = env.backends?.onnx;
                console.log(`[LocalEmbeddingModel] [STEP 4] After useWasm(), onnx backend: ${onnxAfterUseWasm !== undefined ? 'exists' : 'still undefined'}`);
            }
            catch (useWasmErr) {
                console.warn(`[LocalEmbeddingModel] [STEP 4] env.useWasm() failed:`, useWasmErr);
            }
        }
        else {
            console.log(`[LocalEmbeddingModel] [STEP 4] env.useWasm is not available (type: ${typeof env.useWasm})`);
        }
        // Approach 2: Try to configure WASM paths via backends.onnx.env.wasm
        // Check again after potentially calling useWasm
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
        else {
            // ONNX backend is not available - this will cause constructSession to fail
            console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ ONNX backend not available`);
            console.warn(`[LocalEmbeddingModel] [STEP 4] env.backends exists: ${!!env.backends}`);
            console.warn(`[LocalEmbeddingModel] [STEP 4] env.backends keys:`, env.backends ? Object.keys(env.backends) : 'N/A');
            console.warn(`[LocalEmbeddingModel] [STEP 4] onnx key exists but value undefined: ${onnxKeyExists && onnxValue === undefined}`);
            console.warn(`[LocalEmbeddingModel] [STEP 4] This will cause constructSession to fail - ONNX Runtime not initialized`);
            // Capture snapshot for diagnostics
            if (!lastEnvSnapshot) {
                captureEnvSnapshot(mod, env, 'onnx-backend-unavailable');
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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Q0FBQyxDQUFDO1lBQzVJLE9BQU8sTUFBTSxDQUFDO1FBQ2YsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDZCxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sRUFBRSxtQkFBbUIsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ2xHLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0RBQW9ELEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDekUsTUFBTSxHQUFHLENBQUM7UUFDWCxDQUFDO0lBQ0YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG4vLyBIZWxwZXIgZnVuY3Rpb24gdG8gc2FmZWx5IGluc3BlY3Qgb2JqZWN0IHN0cnVjdHVyZSB3aXRob3V0IGNhdXNpbmcgZXJyb3JzXHJcbmZ1bmN0aW9uIGRlZXBJbnNwZWN0KG9iajogYW55LCBtYXhEZXB0aDogbnVtYmVyID0gMywgY3VycmVudERlcHRoOiBudW1iZXIgPSAwLCB2aXNpdGVkOiBXZWFrU2V0PGFueT4gPSBuZXcgV2Vha1NldCgpKTogYW55IHtcclxuXHRpZiAoY3VycmVudERlcHRoID49IG1heERlcHRoIHx8IG9iaiA9PT0gbnVsbCB8fCBvYmogPT09IHVuZGVmaW5lZCkge1xyXG5cdFx0cmV0dXJuIHR5cGVvZiBvYmo7XHJcblx0fVxyXG5cdGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0Jykge1xyXG5cdFx0cmV0dXJuIG9iajtcclxuXHR9XHJcblx0aWYgKHZpc2l0ZWQuaGFzKG9iaikpIHtcclxuXHRcdHJldHVybiAnW0NpcmN1bGFyXSc7XHJcblx0fVxyXG5cdHZpc2l0ZWQuYWRkKG9iaik7XHJcblx0XHJcblx0Y29uc3QgcmVzdWx0OiBhbnkgPSB7fTtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iaikuc2xpY2UoMCwgMjApOyAvLyBMaW1pdCBrZXlzIHRvIGF2b2lkIGh1Z2Ugb3V0cHV0XHJcblx0XHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgdmFsID0gb2JqW2tleV07XHJcblx0XHRcdFx0aWYgKHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdHJlc3VsdFtrZXldID0gYFtGdW5jdGlvbjogJHt2YWwubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcclxuXHRcdFx0XHR9IGVsc2UgaWYgKHR5cGVvZiB2YWwgPT09ICdvYmplY3QnICYmIHZhbCAhPT0gbnVsbCkge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBkZWVwSW5zcGVjdCh2YWwsIG1heERlcHRoLCBjdXJyZW50RGVwdGggKyAxLCB2aXNpdGVkKTtcclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSB2YWw7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlKSB7XHJcblx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Vycm9yIGFjY2Vzc2luZzogJHtlfV1gO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fSBjYXRjaCAoZSkge1xyXG5cdFx0cmV0dXJuIGBbRXJyb3IgaW5zcGVjdGluZzogJHtlfV1gO1xyXG5cdH1cclxuXHRyZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vLyBDYXB0dXJlIGEgb25lLXRpbWUgc25hcHNob3Qgb2YgdGhlIHRyYW5zZm9ybWVycyBlbnYgLyBPTk5YIHN0YXRlIGZvciBkaWFnbm9zdGljc1xyXG5sZXQgbGFzdEVudlNuYXBzaG90OiBhbnkgfCBudWxsID0gbnVsbDtcclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVFbnZTbmFwc2hvdChtb2Q6IGFueSwgZW52OiBhbnksIHdoZXJlOiBzdHJpbmcpOiB2b2lkIHtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3Qgb25ueCA9IGVudj8uYmFja2VuZHM/Lm9ubng7XHJcblx0XHRjb25zdCBiYWNrZW5kcyA9IGVudj8uYmFja2VuZHM7XHJcblx0XHRsYXN0RW52U25hcHNob3QgPSB7XHJcblx0XHRcdHdoZXJlLFxyXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuXHRcdFx0bW9kS2V5czogbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRoYXNEZWZhdWx0OiAhIW1vZD8uZGVmYXVsdCxcclxuXHRcdFx0aGFzUGlwZWxpbmU6IHR5cGVvZiAobW9kPy5waXBlbGluZSB8fCBtb2Q/LmRlZmF1bHQ/LnBpcGVsaW5lKSA9PT0gJ2Z1bmN0aW9uJyxcclxuXHRcdFx0ZW52S2V5czogZW52ID8gT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRlbnZIYXNCYWNrZW5kczogISFiYWNrZW5kcyxcclxuXHRcdFx0YmFja2VuZHNLZXlzOiBiYWNrZW5kcyA/IE9iamVjdC5rZXlzKGJhY2tlbmRzKSA6IG51bGwsXHJcblx0XHRcdG9ubnhLZXlFeGlzdHM6IGJhY2tlbmRzID8gJ29ubngnIGluIGJhY2tlbmRzIDogZmFsc2UsXHJcblx0XHRcdG9ubnhWYWx1ZUV4aXN0czogb25ueCAhPT0gdW5kZWZpbmVkLFxyXG5cdFx0XHRvbm54VmFsdWVUeXBlOiB0eXBlb2Ygb25ueCxcclxuXHRcdFx0b25ueEtleXM6IG9ubnggPyBPYmplY3Qua2V5cyhvbm54KS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRvbm54SGFzV2FzbTogISFvbm54Py53YXNtLFxyXG5cdFx0XHRvbm54V2FzbUtleXM6IG9ubng/Lndhc20gPyBPYmplY3Qua2V5cyhvbm54Lndhc20pLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdG9ubnhXYXNtUGF0aHM6IG9ubng/Lndhc20/Lndhc21QYXRocyA/PyBudWxsLFxyXG5cdFx0XHRlbnZIYXNVc2VXYXNtOiB0eXBlb2YgZW52Py51c2VXYXNtID09PSAnZnVuY3Rpb24nLFxyXG5cdFx0fTtcclxuXHRcdGNvbnNvbGUubG9nKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0nLCBsYXN0RW52U25hcHNob3QpO1xyXG5cdH0gY2F0Y2ggKGUpIHtcclxuXHRcdGNvbnNvbGUud2FybignW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdIEZhaWxlZCB0byBjYXB0dXJlIGVudiBzbmFwc2hvdDonLCBlKTtcclxuXHR9XHJcbn1cclxuXHJcbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcclxuLy8gVXNlcyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMuanMgdG8gYXZvaWQgYnVuZGxpbmcgaXNzdWVzXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBpcGVsaW5lKHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IFByb21pc2U8YW55PiB7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgUElQRUxJTkUgTE9BRCA9PT1gKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHJcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gSW1wb3J0aW5nIHRyYW5zZm9ybWVycy5qcyBtb2R1bGUuLi5gKTtcclxuXHRsZXQgbW9kOiBhbnk7XHJcblx0dHJ5IHtcclxuXHRcdG1vZCA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSDinJMgTW9kdWxlIGltcG9ydGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgdHlwZTogJHt0eXBlb2YgbW9kfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgaXMgbnVsbDogJHttb2QgPT09IG51bGx9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSBpcyB1bmRlZmluZWQ6ICR7bW9kID09PSB1bmRlZmluZWR9YCk7XHJcblx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0g4pyXIE1vZHVsZSBpbXBvcnQgZmFpbGVkOmAsIGltcG9ydEVycik7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHR9XHJcblx0XHJcblx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIG1vZHVsZSBzdHJ1Y3R1cmVcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEluc3BlY3RpbmcgbW9kdWxlIHN0cnVjdHVyZS4uLmApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gTW9kdWxlIGtleXMgKGZpcnN0IDMwKTpgLCBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDMwKSA6ICdOL0EnKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAnZW52JyBwcm9wZXJ0eTpgLCAnZW52JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2RlZmF1bHQnIHByb3BlcnR5OmAsICdkZWZhdWx0JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ3BpcGVsaW5lJyBwcm9wZXJ0eTpgLCAncGlwZWxpbmUnIGluIChtb2QgfHwge30pKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5lbnYgdHlwZTpgLCB0eXBlb2YgbW9kPy5lbnYpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmRlZmF1bHQgdHlwZTpgLCB0eXBlb2YgbW9kPy5kZWZhdWx0KTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5waXBlbGluZSB0eXBlOmAsIHR5cGVvZiBtb2Q/LnBpcGVsaW5lKTtcclxuXHRcclxuXHQvLyBUcnkgbXVsdGlwbGUgd2F5cyB0byBhY2Nlc3MgdGhlIGVudmlyb25tZW50XHJcblx0bGV0IGVudjogYW55ID0gbnVsbDtcclxuXHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xyXG5cdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBsb2NhdGUgZW52aXJvbm1lbnQgc3RydWN0dXJlLi4uYCk7XHJcblx0XHJcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXHJcblx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5lbnZgKTtcclxuXHRcdGVudiA9IG1vZC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmVudic7XHJcblx0fVxyXG5cdC8vIE1ldGhvZCAyOiBtb2QuZGVmYXVsdC5lbnYgKGlmIGRlZmF1bHQgZXhwb3J0KVxyXG5cdGVsc2UgaWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5kZWZhdWx0LmVudmApO1xyXG5cdFx0ZW52ID0gbW9kLmRlZmF1bHQuZW52O1xyXG5cdFx0ZW52U291cmNlID0gJ21vZC5kZWZhdWx0LmVudic7XHJcblx0fVxyXG5cdFxyXG5cdC8vIERlZXAgaW5zcGVjdGlvbiBvZiB3aGF0IHdlIGhhdmVcclxuXHRpZiAoZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiB0eXBlOiAke3R5cGVvZiBlbnZ9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiBrZXlzIChmaXJzdCAzMCk6YCwgT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAzMCkpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMgZXhpc3RzOmAsICdiYWNrZW5kcycgaW4gZW52KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzIGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzKSk7XHJcblx0XHR9XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzLm9ubngpLnNsaWNlKDAsIDIwKSk7XHJcblx0XHR9XHJcblx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBiZWZvcmUgV0FTTSBjb25maWdcclxuXHRcdGlmICghbGFzdEVudlNuYXBzaG90KSB7XHJcblx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2QsIGVudiwgJ2JlZm9yZS13YXNtLWNvbmZpZycpO1xyXG5cdFx0fVxyXG5cdH0gZWxzZSB7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJcgQ291bGQgbm90IGZpbmQgZW52IHN0cnVjdHVyZWApO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBleGlzdHM6YCwgbW9kPy5lbnYgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdCBleGlzdHM6YCwgbW9kPy5kZWZhdWx0ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IGV4aXN0czpgLCBtb2Q/LmRlZmF1bHQ/LmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGlmIChtb2Q/LmVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5lbnYgc3RydWN0dXJlIChkZXB0aCAzKTpgLCBkZWVwSW5zcGVjdChtb2QuZW52LCAzKSk7XHJcblx0XHR9XHJcblx0XHRpZiAobW9kPy5kZWZhdWx0Py5lbnYpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdC5lbnYgc3RydWN0dXJlIChkZXB0aCAzKTpgLCBkZWVwSW5zcGVjdChtb2QuZGVmYXVsdC5lbnYsIDMpKTtcclxuXHRcdH1cclxuXHR9XHJcblx0XHJcblx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSB0cnkgbXVsdGlwbGUgYXBwcm9hY2hlc1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQXR0ZW1wdGluZyB0byBjb25maWd1cmUgV0FTTSBwYXRocy4uLmApO1xyXG5cdFxyXG5cdGlmIChlbnYpIHtcclxuXHRcdC8vIENoZWNrIGlmIG9ubngga2V5IGV4aXN0cyBidXQgdmFsdWUgaXMgdW5kZWZpbmVkXHJcblx0XHRjb25zdCBvbm54S2V5RXhpc3RzID0gZW52LmJhY2tlbmRzICYmICdvbm54JyBpbiBlbnYuYmFja2VuZHM7XHJcblx0XHRjb25zdCBvbm54VmFsdWUgPSBlbnYuYmFja2VuZHM/Lm9ubng7XHJcblx0XHRcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueCBrZXkgZXhpc3RzOiAke29ubnhLZXlFeGlzdHN9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnggdmFsdWUgaXM6ICR7b25ueFZhbHVlICE9PSB1bmRlZmluZWQgPyAnZGVmaW5lZCcgOiAndW5kZWZpbmVkJ31gKTtcclxuXHRcdFxyXG5cdFx0Ly8gQXBwcm9hY2ggMTogVHJ5IGVudi51c2VXYXNtKCkgaWYgYXZhaWxhYmxlICh0cmFuc2Zvcm1lcnMuanMgQVBJKVxyXG5cdFx0Ly8gVGhpcyBtaWdodCBpbml0aWFsaXplIHRoZSBPTk5YIGJhY2tlbmRcclxuXHRcdGlmICh0eXBlb2YgZW52LnVzZVdhc20gPT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgZW52LnVzZVdhc20oKS4uLmApO1xyXG5cdFx0XHRcdGVudi51c2VXYXNtKCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgQ2FsbGVkIGVudi51c2VXYXNtKClgKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBDaGVjayBpZiBvbm54IGJhY2tlbmQgaXMgbm93IGF2YWlsYWJsZSBhZnRlciB1c2VXYXNtXHJcblx0XHRcdFx0Y29uc3Qgb25ueEFmdGVyVXNlV2FzbSA9IGVudi5iYWNrZW5kcz8ub25ueDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEFmdGVyIHVzZVdhc20oKSwgb25ueCBiYWNrZW5kOiAke29ubnhBZnRlclVzZVdhc20gIT09IHVuZGVmaW5lZCA/ICdleGlzdHMnIDogJ3N0aWxsIHVuZGVmaW5lZCd9YCk7XHJcblx0XHRcdH0gY2F0Y2ggKHVzZVdhc21FcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYudXNlV2FzbSgpIGZhaWxlZDpgLCB1c2VXYXNtRXJyKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYudXNlV2FzbSBpcyBub3QgYXZhaWxhYmxlICh0eXBlOiAke3R5cGVvZiBlbnYudXNlV2FzbX0pYCk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIEFwcHJvYWNoIDI6IFRyeSB0byBjb25maWd1cmUgV0FTTSBwYXRocyB2aWEgYmFja2VuZHMub25ueC5lbnYud2FzbVxyXG5cdFx0Ly8gQ2hlY2sgYWdhaW4gYWZ0ZXIgcG90ZW50aWFsbHkgY2FsbGluZyB1c2VXYXNtXHJcblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdGNvbnN0IG9ubnhCYWNrZW5kID0gZW52LmJhY2tlbmRzLm9ubng7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIE9OTlggYmFja2VuZCBmb3VuZCB2aWEgJHtlbnZTb3VyY2V9YCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBUcnkgdG8gZmluZCB0aGUgYWN0dWFsIE9OTlggUnVudGltZSBlbnZpcm9ubWVudFxyXG5cdFx0XHQvLyBJdCBtaWdodCBiZSBhdDogb25ueEJhY2tlbmQuZW52Lndhc20gT1Igb25ueEJhY2tlbmQud2FzbSBPUiBvbm54QmFja2VuZC5lbnZcclxuXHRcdFx0bGV0IHdhc21FbnY6IGFueSA9IG51bGw7XHJcblx0XHRcdGxldCB3YXNtRW52UGF0aCA9ICdub25lJztcclxuXHRcdFx0XHJcblx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC5lbnYud2FzbWApO1xyXG5cdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC5lbnYud2FzbSc7XHJcblx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQud2FzbSkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLndhc21gKTtcclxuXHRcdFx0XHR3YXNtRW52ID0gb25ueEJhY2tlbmQud2FzbTtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC53YXNtJztcclxuXHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC5lbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBlbnYgYXQgb25ueEJhY2tlbmQuZW52ICh0cnlpbmcgYXMgV0FTTSBlbnYpYCk7XHJcblx0XHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLmVudjtcclxuXHRcdFx0XHR3YXNtRW52UGF0aCA9ICdvbm54QmFja2VuZC5lbnYnO1xyXG5cdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBXQVNNIGVudmlyb25tZW50IG5vdCBmb3VuZCBhdCBleHBlY3RlZCBwYXRoc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudiBleGlzdHM6YCwgb25ueEJhY2tlbmQuZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLndhc20gZXhpc3RzOmAsIG9ubnhCYWNrZW5kLndhc20gIT09IHVuZGVmaW5lZCk7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gb25ueEJhY2tlbmQga2V5czpgLCBPYmplY3Qua2V5cyhvbm54QmFja2VuZCkuc2xpY2UoMCwgMzApKTtcclxuXHRcdFx0XHRpZiAob25ueEJhY2tlbmQuZW52KSB7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kLmVudiBzdHJ1Y3R1cmU6YCwgZGVlcEluc3BlY3Qob25ueEJhY2tlbmQuZW52LCAyKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAod2FzbUVudikge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ29uZmlndXJpbmcgV0FTTSBwYXRocyBhdDogJHt3YXNtRW52UGF0aH1gKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBVc2Ugc3RyaW5nLWJhc2VkIHBhdGggKGJhc2UgZGlyZWN0b3J5KSBsaWtlIHRyYW5zZm9ybWVycy5qcyBkb2VzIGludGVybmFsbHlcclxuXHRcdFx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBDaGVjayBjdXJyZW50IHdhc21QYXRocyB2YWx1ZVxyXG5cdFx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiB3YXNtRW52KSB7XHJcblx0XHRcdFx0XHRjb25zdCBjdXJyZW50UGF0aHMgPSB3YXNtRW52Lndhc21QYXRocztcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3VycmVudCB3YXNtUGF0aHMgdmFsdWU6YCwgY3VycmVudFBhdGhzKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3VycmVudCB3YXNtUGF0aHMgdHlwZTpgLCB0eXBlb2YgY3VycmVudFBhdGhzKTtcclxuXHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0Ly8gU2V0IHRoZSBiYXNlIHBhdGggKHRyYW5zZm9ybWVycy5qcyB1c2VzIHN0cmluZywgbm90IG9iamVjdCBtYXBwaW5nKVxyXG5cdFx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdFx0d2FzbUVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIFNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIFZlcmlmaWVkIHdhc21QYXRocyBhZnRlciBzZXR0aW5nOmAsIHdhc21FbnYud2FzbVBhdGhzKTtcclxuXHRcdFx0XHRcdH0gY2F0Y2ggKHBhdGhFcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCB3YXNtUGF0aHM6YCwgcGF0aEVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdC8vIFRyeSB0byBjcmVhdGUgd2FzbVBhdGhzIHByb3BlcnR5IGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3YXNtRW52LCAnd2FzbVBhdGhzJywge1xyXG5cdFx0XHRcdFx0XHRcdHZhbHVlOiB3YXNtQmFzZVBhdGgsXHJcblx0XHRcdFx0XHRcdFx0d3JpdGFibGU6IHRydWUsXHJcblx0XHRcdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0XHRjb25maWd1cmFibGU6IHRydWVcclxuXHRcdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0fSBjYXRjaCAoZGVmaW5lRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBkZWZpbmUgd2FzbVBhdGhzOmAsIGRlZmluZUVycik7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHQvLyBPTk5YIGJhY2tlbmQgaXMgbm90IGF2YWlsYWJsZSAtIHRoaXMgd2lsbCBjYXVzZSBjb25zdHJ1Y3RTZXNzaW9uIHRvIGZhaWxcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyXIE9OTlggYmFja2VuZCBub3QgYXZhaWxhYmxlYCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIGVudi5iYWNrZW5kcyBleGlzdHM6ICR7ISFlbnYuYmFja2VuZHN9YCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIGVudi5iYWNrZW5kcyBrZXlzOmAsIGVudi5iYWNrZW5kcyA/IE9iamVjdC5rZXlzKGVudi5iYWNrZW5kcykgOiAnTi9BJyk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubngga2V5IGV4aXN0cyBidXQgdmFsdWUgdW5kZWZpbmVkOiAke29ubnhLZXlFeGlzdHMgJiYgb25ueFZhbHVlID09PSB1bmRlZmluZWR9YCk7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIFRoaXMgd2lsbCBjYXVzZSBjb25zdHJ1Y3RTZXNzaW9uIHRvIGZhaWwgLSBPTk5YIFJ1bnRpbWUgbm90IGluaXRpYWxpemVkYCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBDYXB0dXJlIHNuYXBzaG90IGZvciBkaWFnbm9zdGljc1xyXG5cdFx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xyXG5cdFx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2QsIGVudiwgJ29ubngtYmFja2VuZC11bmF2YWlsYWJsZScpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIEFwcHJvYWNoIDM6IFRyeSB0byBzZXQgZW52Lndhc21QYXRocyBkaXJlY3RseSBpZiBhdmFpbGFibGVcclxuXHRcdGlmICgnd2FzbVBhdGhzJyBpbiBlbnYpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZvdW5kIGVudi53YXNtUGF0aHMsIHNldHRpbmcgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdGVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgU2V0IGVudi53YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCBlbnYud2FzbVBhdGhzOmAsIGVudlBhdGhFcnIpO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCBtb2QuZGVmYXVsdD8ucGlwZWxpbmU7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIHBpcGVsaW5lKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGlzIGZ1bmN0aW9uOmAsIHR5cGVvZiBwaXBlbGluZSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHJcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLnBpcGVsaW5lOmAsIG1vZD8ucGlwZWxpbmUpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5kZWZhdWx0LnBpcGVsaW5lOmAsIG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xyXG5cdH1cclxuXHRcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFBJUEVMSU5FIExPQUQgQ09NUExFVEUgPT09YCk7XHJcblx0cmV0dXJuIHBpcGVsaW5lO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XHJcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XHJcblx0bGV0IHN1bVNxID0gMDtcclxuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cclxuICovXHJcbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xyXG5cdHRpbWVzdGFtcDogc3RyaW5nO1xyXG5cdGxvY2F0aW9uOiBzdHJpbmc7XHJcblx0Y29udGV4dDogc3RyaW5nO1xyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcclxuXHRyZWFkb25seSBkaW0gPSAzODQ7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XHJcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBNb2RlbEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZCAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSksIHdhaXRpbmcuLi5gKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHRcdH1cclxuXHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBTVEFSVElORyBNT0RFTCBMT0FEID09PWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHMgKyAxfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0dGhpcy5sb2FkQXR0ZW1wdHMrKztcclxuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiBHZXR0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xyXG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSkge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG51bGwgb3IgdW5kZWZpbmVkJyk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRpZiAodHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24sIGdvdDogJHt0eXBlb2YgcGlwZWxpbmV9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWQgKHR5cGU6ICR7dHlwZW9mIHBpcGVsaW5lfSwgbmFtZTogJHtwaXBlbGluZS5uYW1lIHx8ICdhbm9ueW1vdXMnfSlgKTtcclxuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiDinJcgRmFpbGVkIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbmApO1xyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XHJcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHRyYW5zZm9ybWVycyBwaXBlbGluZTogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxyXG5cdFx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogTW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IENyZWF0aW5nIG1vZGVsIHBpcGVsaW5lICh0aGlzIG1heSB0YWtlIHRpbWUpLi4uYCk7XHJcblxyXG5cdFx0XHRcdGxldCBwaXBlVW5rbm93bjogdW5rbm93bjtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgcGlwZWxpbmVTdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXHJcblx0XHRcdFx0XHRwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKCdmZWF0dXJlLWV4dHJhY3Rpb24nLCAnWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjInLCB7XHJcblx0XHRcdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcclxuXHRcdFx0XHRcdFx0Y2FjaGVfZGlyOiBjYWNoZURpclxyXG5cdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZUR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHBpcGVsaW5lU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJMgUGlwZWxpbmUgY3JlYXRlZCBpbiAke3BpcGVsaW5lRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogUGlwZWxpbmUgb3V0cHV0IHR5cGU6ICR7dHlwZW9mIHBpcGVVbmtub3dufWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShwaXBlVW5rbm93bil9YCk7XHJcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkYCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgdHlwZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBwaXBlbGluZUVycn1gKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBtZXNzYWdlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5tZXNzYWdlIDogU3RyaW5nKHBpcGVsaW5lRXJyKX1gKTtcclxuXHRcdFx0XHRcdGlmIChwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yICYmIHBpcGVsaW5lRXJyLnN0YWNrKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBzdGFjayAoZmlyc3QgMTAgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKHBpcGVsaW5lRXJyLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxMCkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0Ly8gQ2FwdHVyZSBlbnYgc25hcHNob3QgYXQgZmFpbHVyZSB0aW1lIGlmIHdlIGRvbid0IGhhdmUgb25lXHJcblx0XHRcdFx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xyXG5cdFx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnN0IG1vZEF0RXJyb3IgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcclxuXHRcdFx0XHRcdFx0XHRjb25zdCBlbnZBdEVycm9yID0gbW9kQXRFcnJvci5lbnYgfHwgbW9kQXRFcnJvci5kZWZhdWx0Py5lbnY7XHJcblx0XHRcdFx0XHRcdFx0aWYgKGVudkF0RXJyb3IpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2RBdEVycm9yLCBlbnZBdEVycm9yLCAnb24tcGlwZWxpbmUtZXJyb3InKTtcclxuXHRcdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRcdFx0XHRcdC8vIGlnbm9yZSBzZWNvbmRhcnkgZmFpbHVyZXNcclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcclxuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IFdyYXBwaW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblxyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gU3RhcnRpbmcgZW1iZWRkaW5nIGdlbmVyYXRpb24gZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xyXG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBSYXcgb3V0cHV0IHJlY2VpdmVkIGluICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IHR5cGU6ICR7dHlwZW9mIG91dH1gKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XHJcblx0XHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdFx0XHRsZXQgcmVzdWx0OiBudW1iZXJbXTtcclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxBcnJheTxudW1iZXI+PiwgdXNpbmcgb3V0WzBdYCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxudW1iZXI+LCB1c2luZyBkaXJlY3RseWApO1xyXG5cdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcclxuXHRcdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtYXliZT8uZGF0YSkpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IE9iamVjdCB3aXRoIGRhdGEgYXJyYXksIHVzaW5nIGRhdGFgKTtcclxuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIOKclyBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXRgKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dDpgLCBvdXQpO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgc3VjY2Vzc2Z1bGx5ICgke3Jlc3VsdC5sZW5ndGh9IGRpbWVuc2lvbnMpYCk7XHJcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEVycm9yOmAsIGVycik7XHJcblx0XHRcdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiDinJMgUGlwZWxpbmUgd3JhcHBlciBjcmVhdGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgRlVMTFkgTE9BREVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0czogJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IE1PREVMIExPQUQgRkFJTEVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdDogIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycjtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgdHlwZTogJHtlcnJvclR5cGV9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIG1lc3NhZ2U6ICR7ZXJyb3JNc2d9YCk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciBzdGFjayAoZmlyc3QgMTUgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxNSkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgaXNSZWFkeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdHJldHVybiB0aGlzLnBpcGVsaW5lICE9PSBudWxsO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcclxuXHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcclxuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XHJcblx0fVxyXG5cclxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xyXG5cdFx0cmV0dXJuIHRoaXMubGFzdExvYWRFcnJvcjtcclxuXHR9XHJcblxyXG5cdGdldExvYWRBdHRlbXB0cygpOiBudW1iZXIge1xyXG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xyXG5cdH1cclxuXHJcblx0Z2V0RW52U25hcHNob3QoKTogYW55IHwgbnVsbCB7XHJcblx0XHRyZXR1cm4gbGFzdEVudlNuYXBzaG90O1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XHJcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcclxuXHRcdFxyXG5cdFx0Y29uc3QgZW50cnk6IE1vZGVsRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXHJcblx0XHRpZiAobG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQnIHx8IGxvY2F0aW9uID09PSAnaXNSZWFkeScpIHtcclxuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xyXG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHR9XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XHJcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBHZW5lcmF0ZWQgZW1iZWRkaW5nIGluICR7ZW1iZWREdXJhdGlvbn1tcyBmb3IgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCk7XHJcblx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignZW1iZWQnLCBgRW1iZWRkaW5nIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQ6YCwgZXJyKTtcclxuXHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==