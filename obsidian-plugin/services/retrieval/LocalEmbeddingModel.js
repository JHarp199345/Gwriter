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
        // CRITICAL: Set WASM paths at env level FIRST, before backend initialization
        // This ensures transformers.js can find WASM files when it needs them
        const wasmBasePath = './lib/';
        try {
            if (!('wasmPaths' in env)) {
                Object.defineProperty(env, 'wasmPaths', {
                    value: wasmBasePath,
                    writable: true,
                    enumerable: true,
                    configurable: true
                });
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Set env.wasmPaths to: ${wasmBasePath}`);
            }
            else {
                env.wasmPaths = wasmBasePath;
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Updated env.wasmPaths to: ${wasmBasePath}`);
            }
        }
        catch (envPathErr) {
            console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set env.wasmPaths:`, envPathErr);
        }
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
            // Always capture and log snapshot for diagnostics (even if previously captured)
            captureEnvSnapshot(mod, env, 'onnx-backend-unavailable');
            // Force log even if it was captured before
            if (lastEnvSnapshot) {
                console.log('[LocalEmbeddingModel] [ENV SNAPSHOT - FORCED LOG]', JSON.stringify(lastEnvSnapshot, null, 2));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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WUFDekUsTUFBTSxHQUFHLENBQUM7UUFDWCxDQUFDO0lBQ0YsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG4vLyBIZWxwZXIgZnVuY3Rpb24gdG8gc2FmZWx5IGluc3BlY3Qgb2JqZWN0IHN0cnVjdHVyZSB3aXRob3V0IGNhdXNpbmcgZXJyb3JzXHJcbmZ1bmN0aW9uIGRlZXBJbnNwZWN0KG9iajogYW55LCBtYXhEZXB0aDogbnVtYmVyID0gMywgY3VycmVudERlcHRoOiBudW1iZXIgPSAwLCB2aXNpdGVkOiBXZWFrU2V0PGFueT4gPSBuZXcgV2Vha1NldCgpKTogYW55IHtcclxuXHRpZiAoY3VycmVudERlcHRoID49IG1heERlcHRoIHx8IG9iaiA9PT0gbnVsbCB8fCBvYmogPT09IHVuZGVmaW5lZCkge1xyXG5cdFx0cmV0dXJuIHR5cGVvZiBvYmo7XHJcblx0fVxyXG5cdGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0Jykge1xyXG5cdFx0cmV0dXJuIG9iajtcclxuXHR9XHJcblx0aWYgKHZpc2l0ZWQuaGFzKG9iaikpIHtcclxuXHRcdHJldHVybiAnW0NpcmN1bGFyXSc7XHJcblx0fVxyXG5cdHZpc2l0ZWQuYWRkKG9iaik7XHJcblx0XHJcblx0Y29uc3QgcmVzdWx0OiBhbnkgPSB7fTtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3Qga2V5cyA9IE9iamVjdC5rZXlzKG9iaikuc2xpY2UoMCwgMjApOyAvLyBMaW1pdCBrZXlzIHRvIGF2b2lkIGh1Z2Ugb3V0cHV0XHJcblx0XHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgdmFsID0gb2JqW2tleV07XHJcblx0XHRcdFx0aWYgKHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdHJlc3VsdFtrZXldID0gYFtGdW5jdGlvbjogJHt2YWwubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcclxuXHRcdFx0XHR9IGVsc2UgaWYgKHR5cGVvZiB2YWwgPT09ICdvYmplY3QnICYmIHZhbCAhPT0gbnVsbCkge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBkZWVwSW5zcGVjdCh2YWwsIG1heERlcHRoLCBjdXJyZW50RGVwdGggKyAxLCB2aXNpdGVkKTtcclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSB2YWw7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGNhdGNoIChlKSB7XHJcblx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Vycm9yIGFjY2Vzc2luZzogJHtlfV1gO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0fSBjYXRjaCAoZSkge1xyXG5cdFx0cmV0dXJuIGBbRXJyb3IgaW5zcGVjdGluZzogJHtlfV1gO1xyXG5cdH1cclxuXHRyZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vLyBDYXB0dXJlIGEgb25lLXRpbWUgc25hcHNob3Qgb2YgdGhlIHRyYW5zZm9ybWVycyBlbnYgLyBPTk5YIHN0YXRlIGZvciBkaWFnbm9zdGljc1xyXG5sZXQgbGFzdEVudlNuYXBzaG90OiBhbnkgfCBudWxsID0gbnVsbDtcclxuXHJcbmZ1bmN0aW9uIGNhcHR1cmVFbnZTbmFwc2hvdChtb2Q6IGFueSwgZW52OiBhbnksIHdoZXJlOiBzdHJpbmcpOiB2b2lkIHtcclxuXHR0cnkge1xyXG5cdFx0Y29uc3Qgb25ueCA9IGVudj8uYmFja2VuZHM/Lm9ubng7XHJcblx0XHRjb25zdCBiYWNrZW5kcyA9IGVudj8uYmFja2VuZHM7XHJcblx0XHRsYXN0RW52U25hcHNob3QgPSB7XHJcblx0XHRcdHdoZXJlLFxyXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuXHRcdFx0bW9kS2V5czogbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRoYXNEZWZhdWx0OiAhIW1vZD8uZGVmYXVsdCxcclxuXHRcdFx0aGFzUGlwZWxpbmU6IHR5cGVvZiAobW9kPy5waXBlbGluZSB8fCBtb2Q/LmRlZmF1bHQ/LnBpcGVsaW5lKSA9PT0gJ2Z1bmN0aW9uJyxcclxuXHRcdFx0ZW52S2V5czogZW52ID8gT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRlbnZIYXNCYWNrZW5kczogISFiYWNrZW5kcyxcclxuXHRcdFx0YmFja2VuZHNLZXlzOiBiYWNrZW5kcyA/IE9iamVjdC5rZXlzKGJhY2tlbmRzKSA6IG51bGwsXHJcblx0XHRcdG9ubnhLZXlFeGlzdHM6IGJhY2tlbmRzID8gJ29ubngnIGluIGJhY2tlbmRzIDogZmFsc2UsXHJcblx0XHRcdG9ubnhWYWx1ZUV4aXN0czogb25ueCAhPT0gdW5kZWZpbmVkLFxyXG5cdFx0XHRvbm54VmFsdWVUeXBlOiB0eXBlb2Ygb25ueCxcclxuXHRcdFx0b25ueEtleXM6IG9ubnggPyBPYmplY3Qua2V5cyhvbm54KS5zbGljZSgwLCAyMCkgOiBudWxsLFxyXG5cdFx0XHRvbm54SGFzV2FzbTogISFvbm54Py53YXNtLFxyXG5cdFx0XHRvbm54V2FzbUtleXM6IG9ubng/Lndhc20gPyBPYmplY3Qua2V5cyhvbm54Lndhc20pLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdG9ubnhXYXNtUGF0aHM6IG9ubng/Lndhc20/Lndhc21QYXRocyA/PyBudWxsLFxyXG5cdFx0XHRlbnZIYXNVc2VXYXNtOiB0eXBlb2YgZW52Py51c2VXYXNtID09PSAnZnVuY3Rpb24nLFxyXG5cdFx0fTtcclxuXHRcdGNvbnNvbGUubG9nKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0nLCBsYXN0RW52U25hcHNob3QpO1xyXG5cdH0gY2F0Y2ggKGUpIHtcclxuXHRcdGNvbnNvbGUud2FybignW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdIEZhaWxlZCB0byBjYXB0dXJlIGVudiBzbmFwc2hvdDonLCBlKTtcclxuXHR9XHJcbn1cclxuXHJcbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcclxuLy8gVXNlcyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMuanMgdG8gYXZvaWQgYnVuZGxpbmcgaXNzdWVzXHJcbmFzeW5jIGZ1bmN0aW9uIGdldFBpcGVsaW5lKHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IFByb21pc2U8YW55PiB7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgUElQRUxJTkUgTE9BRCA9PT1gKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHJcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gSW1wb3J0aW5nIHRyYW5zZm9ybWVycy5qcyBtb2R1bGUuLi5gKTtcclxuXHRsZXQgbW9kOiBhbnk7XHJcblx0dHJ5IHtcclxuXHRcdG1vZCA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSDinJMgTW9kdWxlIGltcG9ydGVkIHN1Y2Nlc3NmdWxseWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgdHlwZTogJHt0eXBlb2YgbW9kfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgaXMgbnVsbDogJHttb2QgPT09IG51bGx9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSBpcyB1bmRlZmluZWQ6ICR7bW9kID09PSB1bmRlZmluZWR9YCk7XHJcblx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0g4pyXIE1vZHVsZSBpbXBvcnQgZmFpbGVkOmAsIGltcG9ydEVycik7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBpbXBvcnQgdHJhbnNmb3JtZXJzLmpzOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHR9XHJcblx0XHJcblx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIG1vZHVsZSBzdHJ1Y3R1cmVcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEluc3BlY3RpbmcgbW9kdWxlIHN0cnVjdHVyZS4uLmApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gTW9kdWxlIGtleXMgKGZpcnN0IDMwKTpgLCBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDMwKSA6ICdOL0EnKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAnZW52JyBwcm9wZXJ0eTpgLCAnZW52JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2RlZmF1bHQnIHByb3BlcnR5OmAsICdkZWZhdWx0JyBpbiAobW9kIHx8IHt9KSk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ3BpcGVsaW5lJyBwcm9wZXJ0eTpgLCAncGlwZWxpbmUnIGluIChtb2QgfHwge30pKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5lbnYgdHlwZTpgLCB0eXBlb2YgbW9kPy5lbnYpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmRlZmF1bHQgdHlwZTpgLCB0eXBlb2YgbW9kPy5kZWZhdWx0KTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIG1vZC5waXBlbGluZSB0eXBlOmAsIHR5cGVvZiBtb2Q/LnBpcGVsaW5lKTtcclxuXHRcclxuXHQvLyBUcnkgbXVsdGlwbGUgd2F5cyB0byBhY2Nlc3MgdGhlIGVudmlyb25tZW50XHJcblx0bGV0IGVudjogYW55ID0gbnVsbDtcclxuXHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xyXG5cdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gQXR0ZW1wdGluZyB0byBsb2NhdGUgZW52aXJvbm1lbnQgc3RydWN0dXJlLi4uYCk7XHJcblx0XHJcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXHJcblx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5lbnZgKTtcclxuXHRcdGVudiA9IG1vZC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmVudic7XHJcblx0fVxyXG5cdC8vIE1ldGhvZCAyOiBtb2QuZGVmYXVsdC5lbnYgKGlmIGRlZmF1bHQgZXhwb3J0KVxyXG5cdGVsc2UgaWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5kZWZhdWx0LmVudmApO1xyXG5cdFx0ZW52ID0gbW9kLmRlZmF1bHQuZW52O1xyXG5cdFx0ZW52U291cmNlID0gJ21vZC5kZWZhdWx0LmVudic7XHJcblx0fVxyXG5cdFxyXG5cdC8vIERlZXAgaW5zcGVjdGlvbiBvZiB3aGF0IHdlIGhhdmVcclxuXHRpZiAoZW52KSB7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiB0eXBlOiAke3R5cGVvZiBlbnZ9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiBrZXlzIChmaXJzdCAzMCk6YCwgT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAzMCkpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMgZXhpc3RzOmAsICdiYWNrZW5kcycgaW4gZW52KTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzKSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzIGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzKSk7XHJcblx0XHR9XHJcblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzLm9ubngpLnNsaWNlKDAsIDIwKSk7XHJcblx0XHR9XHJcblx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBiZWZvcmUgV0FTTSBjb25maWdcclxuXHRcdGlmICghbGFzdEVudlNuYXBzaG90KSB7XHJcblx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2QsIGVudiwgJ2JlZm9yZS13YXNtLWNvbmZpZycpO1xyXG5cdFx0fVxyXG5cdH0gZWxzZSB7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJcgQ291bGQgbm90IGZpbmQgZW52IHN0cnVjdHVyZWApO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBleGlzdHM6YCwgbW9kPy5lbnYgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdCBleGlzdHM6YCwgbW9kPy5kZWZhdWx0ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IGV4aXN0czpgLCBtb2Q/LmRlZmF1bHQ/LmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGlmIChtb2Q/LmVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5lbnYgc3RydWN0dXJlIChkZXB0aCAzKTpgLCBkZWVwSW5zcGVjdChtb2QuZW52LCAzKSk7XHJcblx0XHR9XHJcblx0XHRpZiAobW9kPy5kZWZhdWx0Py5lbnYpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdC5lbnYgc3RydWN0dXJlIChkZXB0aCAzKTpgLCBkZWVwSW5zcGVjdChtb2QuZGVmYXVsdC5lbnYsIDMpKTtcclxuXHRcdH1cclxuXHR9XHJcblx0XHJcblx0Ly8gQ29uZmlndXJlIFdBU00gcGF0aHMgLSB0cnkgbXVsdGlwbGUgYXBwcm9hY2hlc1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQXR0ZW1wdGluZyB0byBjb25maWd1cmUgV0FTTSBwYXRocy4uLmApO1xyXG5cdFxyXG5cdGlmIChlbnYpIHtcclxuXHRcdC8vIENSSVRJQ0FMOiBTZXQgV0FTTSBwYXRocyBhdCBlbnYgbGV2ZWwgRklSU1QsIGJlZm9yZSBiYWNrZW5kIGluaXRpYWxpemF0aW9uXHJcblx0XHQvLyBUaGlzIGVuc3VyZXMgdHJhbnNmb3JtZXJzLmpzIGNhbiBmaW5kIFdBU00gZmlsZXMgd2hlbiBpdCBuZWVkcyB0aGVtXHJcblx0XHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcdHRyeSB7XHJcblx0XHRcdGlmICghKCd3YXNtUGF0aHMnIGluIGVudikpIHtcclxuXHRcdFx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkoZW52LCAnd2FzbVBhdGhzJywge1xyXG5cdFx0XHRcdFx0dmFsdWU6IHdhc21CYXNlUGF0aCxcclxuXHRcdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIFNldCBlbnYud2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRlbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIFVwZGF0ZWQgZW52Lndhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdH1cclxuXHRcdH0gY2F0Y2ggKGVudlBhdGhFcnIpIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCBlbnYud2FzbVBhdGhzOmAsIGVudlBhdGhFcnIpO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBDaGVjayBpZiBvbm54IGtleSBleGlzdHMgYnV0IHZhbHVlIGlzIHVuZGVmaW5lZFxyXG5cdFx0Y29uc3Qgb25ueEtleUV4aXN0cyA9IGVudi5iYWNrZW5kcyAmJiAnb25ueCcgaW4gZW52LmJhY2tlbmRzO1xyXG5cdFx0Y29uc3Qgb25ueFZhbHVlID0gZW52LmJhY2tlbmRzPy5vbm54O1xyXG5cdFx0XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubngga2V5IGV4aXN0czogJHtvbm54S2V5RXhpc3RzfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54IHZhbHVlIGlzOiAke29ubnhWYWx1ZSAhPT0gdW5kZWZpbmVkID8gJ2RlZmluZWQnIDogJ3VuZGVmaW5lZCd9YCk7XHJcblx0XHRcclxuXHRcdC8vIEFwcHJvYWNoIDE6IFRyeSBlbnYudXNlV2FzbSgpIGlmIGF2YWlsYWJsZSAodHJhbnNmb3JtZXJzLmpzIEFQSSlcclxuXHRcdC8vIFRoaXMgbWlnaHQgaW5pdGlhbGl6ZSB0aGUgT05OWCBiYWNrZW5kXHJcblx0XHRpZiAodHlwZW9mIGVudi51c2VXYXNtID09PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBdHRlbXB0aW5nIGVudi51c2VXYXNtKCkuLi5gKTtcclxuXHRcdFx0XHRlbnYudXNlV2FzbSgpO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENhbGxlZCBlbnYudXNlV2FzbSgpYCk7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gQ2hlY2sgaWYgb25ueCBiYWNrZW5kIGlzIG5vdyBhdmFpbGFibGUgYWZ0ZXIgdXNlV2FzbVxyXG5cdFx0XHRcdGNvbnN0IG9ubnhBZnRlclVzZVdhc20gPSBlbnYuYmFja2VuZHM/Lm9ubng7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBZnRlciB1c2VXYXNtKCksIG9ubnggYmFja2VuZDogJHtvbm54QWZ0ZXJVc2VXYXNtICE9PSB1bmRlZmluZWQgPyAnZXhpc3RzJyA6ICdzdGlsbCB1bmRlZmluZWQnfWApO1xyXG5cdFx0XHR9IGNhdGNoICh1c2VXYXNtRXJyKSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gZW52LnVzZVdhc20oKSBmYWlsZWQ6YCwgdXNlV2FzbUVycik7XHJcblx0XHRcdH1cclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gZW52LnVzZVdhc20gaXMgbm90IGF2YWlsYWJsZSAodHlwZTogJHt0eXBlb2YgZW52LnVzZVdhc219KWApO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBBcHByb2FjaCAyOiBUcnkgdG8gY29uZmlndXJlIFdBU00gcGF0aHMgdmlhIGJhY2tlbmRzLm9ubnguZW52Lndhc21cclxuXHRcdC8vIENoZWNrIGFnYWluIGFmdGVyIHBvdGVudGlhbGx5IGNhbGxpbmcgdXNlV2FzbVxyXG5cdFx0aWYgKGVudi5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0XHRjb25zdCBvbm54QmFja2VuZCA9IGVudi5iYWNrZW5kcy5vbm54O1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhICR7ZW52U291cmNlfWApO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gVHJ5IHRvIGZpbmQgdGhlIGFjdHVhbCBPTk5YIFJ1bnRpbWUgZW52aXJvbm1lbnRcclxuXHRcdFx0Ly8gSXQgbWlnaHQgYmUgYXQ6IG9ubnhCYWNrZW5kLmVudi53YXNtIE9SIG9ubnhCYWNrZW5kLndhc20gT1Igb25ueEJhY2tlbmQuZW52XHJcblx0XHRcdGxldCB3YXNtRW52OiBhbnkgPSBudWxsO1xyXG5cdFx0XHRsZXQgd2FzbUVudlBhdGggPSAnbm9uZSc7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAob25ueEJhY2tlbmQuZW52Py53YXNtKSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgV0FTTSBlbnYgYXQgb25ueEJhY2tlbmQuZW52Lndhc21gKTtcclxuXHRcdFx0XHR3YXNtRW52ID0gb25ueEJhY2tlbmQuZW52Lndhc207XHJcblx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQuZW52Lndhc20nO1xyXG5cdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLndhc20pIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC53YXNtYCk7XHJcblx0XHRcdFx0d2FzbUVudiA9IG9ubnhCYWNrZW5kLndhc207XHJcblx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQud2FzbSc7XHJcblx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQuZW52KSB7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgZW52IGF0IG9ubnhCYWNrZW5kLmVudiAodHJ5aW5nIGFzIFdBU00gZW52KWApO1xyXG5cdFx0XHRcdHdhc21FbnYgPSBvbm54QmFja2VuZC5lbnY7XHJcblx0XHRcdFx0d2FzbUVudlBhdGggPSAnb25ueEJhY2tlbmQuZW52JztcclxuXHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJcgV0FTTSBlbnZpcm9ubWVudCBub3QgZm91bmQgYXQgZXhwZWN0ZWQgcGF0aHNgKTtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54QmFja2VuZC5lbnYgZXhpc3RzOmAsIG9ubnhCYWNrZW5kLmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54QmFja2VuZC53YXNtIGV4aXN0czpgLCBvbm54QmFja2VuZC53YXNtICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIG9ubnhCYWNrZW5kIGtleXM6YCwgT2JqZWN0LmtleXMob25ueEJhY2tlbmQpLnNsaWNlKDAsIDMwKSk7XHJcblx0XHRcdFx0aWYgKG9ubnhCYWNrZW5kLmVudikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54QmFja2VuZC5lbnYgc3RydWN0dXJlOmAsIGRlZXBJbnNwZWN0KG9ubnhCYWNrZW5kLmVudiwgMikpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0aWYgKHdhc21FbnYpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENvbmZpZ3VyaW5nIFdBU00gcGF0aHMgYXQ6ICR7d2FzbUVudlBhdGh9YCk7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gVXNlIHN0cmluZy1iYXNlZCBwYXRoIChiYXNlIGRpcmVjdG9yeSkgbGlrZSB0cmFuc2Zvcm1lcnMuanMgZG9lcyBpbnRlcm5hbGx5XHJcblx0XHRcdFx0Y29uc3Qgd2FzbUJhc2VQYXRoID0gJy4vbGliLyc7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gQ2hlY2sgY3VycmVudCB3YXNtUGF0aHMgdmFsdWVcclxuXHRcdFx0XHRpZiAoJ3dhc21QYXRocycgaW4gd2FzbUVudikge1xyXG5cdFx0XHRcdFx0Y29uc3QgY3VycmVudFBhdGhzID0gd2FzbUVudi53YXNtUGF0aHM7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEN1cnJlbnQgd2FzbVBhdGhzIHZhbHVlOmAsIGN1cnJlbnRQYXRocyk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEN1cnJlbnQgd2FzbVBhdGhzIHR5cGU6YCwgdHlwZW9mIGN1cnJlbnRQYXRocyk7XHJcblx0XHRcdFx0XHRcclxuXHRcdFx0XHRcdC8vIFNldCB0aGUgYmFzZSBwYXRoICh0cmFuc2Zvcm1lcnMuanMgdXNlcyBzdHJpbmcsIG5vdCBvYmplY3QgbWFwcGluZylcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdHdhc21FbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBTZXQgd2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBWZXJpZmllZCB3YXNtUGF0aHMgYWZ0ZXIgc2V0dGluZzpgLCB3YXNtRW52Lndhc21QYXRocyk7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChwYXRoRXJyKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzOmAsIHBhdGhFcnIpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHQvLyBUcnkgdG8gY3JlYXRlIHdhc21QYXRocyBwcm9wZXJ0eSBpZiBpdCBkb2Vzbid0IGV4aXN0XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkod2FzbUVudiwgJ3dhc21QYXRocycsIHtcclxuXHRcdFx0XHRcdFx0XHR2YWx1ZTogd2FzbUJhc2VQYXRoLFxyXG5cdFx0XHRcdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRcdGVudW1lcmFibGU6IHRydWUsXHJcblx0XHRcdFx0XHRcdFx0Y29uZmlndXJhYmxlOiB0cnVlXHJcblx0XHRcdFx0XHRcdH0pO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBDcmVhdGVkIGFuZCBzZXQgd2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcclxuXHRcdFx0XHRcdH0gY2F0Y2ggKGRlZmluZUVycikge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gZGVmaW5lIHdhc21QYXRoczpgLCBkZWZpbmVFcnIpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0Ly8gT05OWCBiYWNrZW5kIGlzIG5vdCBhdmFpbGFibGUgLSB0aGlzIHdpbGwgY2F1c2UgY29uc3RydWN0U2Vzc2lvbiB0byBmYWlsXHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBPTk5YIGJhY2tlbmQgbm90IGF2YWlsYWJsZWApO1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYuYmFja2VuZHMgZXhpc3RzOiAkeyEhZW52LmJhY2tlbmRzfWApO1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYuYmFja2VuZHMga2V5czpgLCBlbnYuYmFja2VuZHMgPyBPYmplY3Qua2V5cyhlbnYuYmFja2VuZHMpIDogJ04vQScpO1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBvbm54IGtleSBleGlzdHMgYnV0IHZhbHVlIHVuZGVmaW5lZDogJHtvbm54S2V5RXhpc3RzICYmIG9ubnhWYWx1ZSA9PT0gdW5kZWZpbmVkfWApO1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBUaGlzIHdpbGwgY2F1c2UgY29uc3RydWN0U2Vzc2lvbiB0byBmYWlsIC0gT05OWCBSdW50aW1lIG5vdCBpbml0aWFsaXplZGApO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQWx3YXlzIGNhcHR1cmUgYW5kIGxvZyBzbmFwc2hvdCBmb3IgZGlhZ25vc3RpY3MgKGV2ZW4gaWYgcHJldmlvdXNseSBjYXB0dXJlZClcclxuXHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZCwgZW52LCAnb25ueC1iYWNrZW5kLXVuYXZhaWxhYmxlJyk7XHJcblx0XHRcdC8vIEZvcmNlIGxvZyBldmVuIGlmIGl0IHdhcyBjYXB0dXJlZCBiZWZvcmVcclxuXHRcdFx0aWYgKGxhc3RFbnZTbmFwc2hvdCkge1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVCAtIEZPUkNFRCBMT0ddJywgSlNPTi5zdHJpbmdpZnkobGFzdEVudlNuYXBzaG90LCBudWxsLCAyKSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQXBwcm9hY2ggMzogVHJ5IHRvIHNldCBlbnYud2FzbVBhdGhzIGRpcmVjdGx5IGlmIGF2YWlsYWJsZVxyXG5cdFx0aWYgKCd3YXNtUGF0aHMnIGluIGVudikge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRm91bmQgZW52Lndhc21QYXRocywgc2V0dGluZyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdFx0ZW52Lndhc21QYXRocyA9IHdhc21CYXNlUGF0aDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBTZXQgZW52Lndhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XHJcblx0XHRcdH0gY2F0Y2ggKGVudlBhdGhFcnIpIHtcclxuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gc2V0IGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9IGVsc2Uge1xyXG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyXIENhbm5vdCBjb25maWd1cmUgV0FTTSBwYXRocyAtIGVudiBub3QgZm91bmRgKTtcclxuXHR9XHJcblx0XHJcblx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uXHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBMb2NhdGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xyXG5cdGNvbnN0IHBpcGVsaW5lID0gbW9kLnBpcGVsaW5lIHx8IG1vZC5kZWZhdWx0Py5waXBlbGluZTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGZvdW5kOmAsIHBpcGVsaW5lICE9PSB1bmRlZmluZWQgJiYgcGlwZWxpbmUgIT09IG51bGwpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgaXMgZnVuY3Rpb246YCwgdHlwZW9mIHBpcGVsaW5lID09PSAnZnVuY3Rpb24nKTtcclxuXHRcclxuXHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKclyBQaXBlbGluZSBub3QgZm91bmQgb3Igbm90IGEgZnVuY3Rpb25gKTtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBtb2QucGlwZWxpbmU6YCwgbW9kPy5waXBlbGluZSk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLmRlZmF1bHQucGlwZWxpbmU6YCwgbW9kPy5kZWZhdWx0Py5waXBlbGluZSk7XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIG5vdCBmb3VuZCBpbiB0cmFuc2Zvcm1lcnMgbW9kdWxlJyk7XHJcblx0fVxyXG5cdFxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0g4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGZvdW5kYCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gUElQRUxJTkUgTE9BRCBDT01QTEVURSA9PT1gKTtcclxuXHRyZXR1cm4gcGlwZWxpbmU7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcclxuXHRyZWFkb25seSBkaW06IG51bWJlcjtcclxuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcclxufVxyXG5cclxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcclxuXHRsZXQgc3VtU3EgPSAwO1xyXG5cdGZvciAoY29uc3QgdiBvZiB2ZWMpIHN1bVNxICs9IHYgKiB2O1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRydWUgbG9jYWwgZW1iZWRkaW5ncyB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxyXG4gKi9cclxuaW50ZXJmYWNlIE1vZGVsRXJyb3JMb2dFbnRyeSB7XHJcblx0dGltZXN0YW1wOiBzdHJpbmc7XHJcblx0bG9jYXRpb246IHN0cmluZztcclxuXHRjb250ZXh0OiBzdHJpbmc7XHJcblx0bWVzc2FnZTogc3RyaW5nO1xyXG5cdHN0YWNrPzogc3RyaW5nO1xyXG5cdGVycm9yVHlwZT86IHN0cmluZztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwgaW1wbGVtZW50cyBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xyXG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSBwaXBlbGluZTogbnVsbCB8ICgodGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcltdPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZEF0dGVtcHRzID0gMDtcclxuXHRwcml2YXRlIGxhc3RMb2FkRXJyb3I6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwgPSBudWxsO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IE1vZGVsRXJyb3JMb2dFbnRyeVtdID0gW107XHJcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSA1MDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGFscmVhZHkgbG9hZGVkIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSlgKTtcclxuXHRcdFx0cmV0dXJuO1xyXG5cdFx0fVxyXG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGxvYWRpbmcgaW4gcHJvZ3Jlc3MgKGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHN9KSwgd2FpdGluZy4uLmApO1xyXG5cdFx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFNUQVJUSU5HIE1PREVMIExPQUQgPT09YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0cyArIDF9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XHJcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xyXG5cdFx0Y29uc3QgbG9hZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uIC0gdXNpbmcgaGVscGVyIHRvIGVuc3VyZSBwcm9wZXIgaW5pdGlhbGl6YXRpb25cclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IEdldHRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRcdFx0XHRsZXQgcGlwZWxpbmU6IGFueTtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0cGlwZWxpbmUgPSBhd2FpdCBnZXRQaXBlbGluZSh0aGlzLnBsdWdpbik7XHJcblx0XHRcdFx0XHRpZiAoIXBpcGVsaW5lKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignUGlwZWxpbmUgaXMgbnVsbCBvciB1bmRlZmluZWQnKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdGlmICh0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBQaXBlbGluZSBpcyBub3QgYSBmdW5jdGlvbiwgZ290OiAke3R5cGVvZiBwaXBlbGluZX1gKTtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMTog4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGxvYWRlZCAodHlwZTogJHt0eXBlb2YgcGlwZWxpbmV9LCBuYW1lOiAke3BpcGVsaW5lLm5hbWUgfHwgJ2Fub255bW91cyd9KWApO1xyXG5cdFx0XHRcdH0gY2F0Y2ggKGltcG9ydEVycikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKclyBGYWlsZWQgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uYCk7XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuaW1wb3J0JywgJ0xvYWRpbmcgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lJywgaW1wb3J0RXJyKTtcclxuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lOiAke2ltcG9ydEVyciBpbnN0YW5jZW9mIEVycm9yID8gaW1wb3J0RXJyLm1lc3NhZ2UgOiBTdHJpbmcoaW1wb3J0RXJyKX1gKTtcclxuXHRcdFx0XHR9XHJcblxyXG5cdFx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXHJcblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cclxuXHRcdFx0XHRjb25zdCBjYWNoZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9tb2RlbHNgO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogUHJlcGFyaW5nIG1vZGVsIGNhY2hlLi4uYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBDYWNoZSBkaXJlY3Rvcnk6ICR7Y2FjaGVEaXJ9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBNb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjJgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFF1YW50aXplZDogdHJ1ZWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogQ3JlYXRpbmcgbW9kZWwgcGlwZWxpbmUgKHRoaXMgbWF5IHRha2UgdGltZSkuLi5gKTtcclxuXHJcblx0XHRcdFx0bGV0IHBpcGVVbmtub3duOiB1bmtub3duO1xyXG5cdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZVN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHQvLyBDYWxsIHBpcGVsaW5lIGRpcmVjdGx5IGFzIGEgZnVuY3Rpb25cclxuXHRcdFx0XHRcdHBpcGVVbmtub3duID0gYXdhaXQgcGlwZWxpbmUoJ2ZlYXR1cmUtZXh0cmFjdGlvbicsICdYZW5vdmEvYWxsLU1pbmlMTS1MNi12MicsIHtcclxuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxyXG5cdFx0XHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdFx0XHRjYWNoZV9kaXI6IGNhY2hlRGlyXHJcblx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdGNvbnN0IHBpcGVsaW5lRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gcGlwZWxpbmVTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKckyBQaXBlbGluZSBjcmVhdGVkIGluICR7cGlwZWxpbmVEdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgdHlwZTogJHt0eXBlb2YgcGlwZVVua25vd259YCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IFBpcGVsaW5lIG91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KHBpcGVVbmtub3duKX1gKTtcclxuXHRcdFx0XHR9IGNhdGNoIChwaXBlbGluZUVycikge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKclyBQaXBlbGluZSBjcmVhdGlvbiBmYWlsZWRgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciB0eXBlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIHBpcGVsaW5lRXJyfWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IEVycm9yIG1lc3NhZ2U6ICR7cGlwZWxpbmVFcnIgaW5zdGFuY2VvZiBFcnJvciA/IHBpcGVsaW5lRXJyLm1lc3NhZ2UgOiBTdHJpbmcocGlwZWxpbmVFcnIpfWApO1xyXG5cdFx0XHRcdFx0aWYgKHBpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgcGlwZWxpbmVFcnIuc3RhY2spIHtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IEVycm9yIHN0YWNrIChmaXJzdCAxMCBsaW5lcyk6YCk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IocGlwZWxpbmVFcnIuc3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDEwKS5qb2luKCdcXG4nKSk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBhdCBmYWlsdXJlIHRpbWUgaWYgd2UgZG9uJ3QgaGF2ZSBvbmVcclxuXHRcdFx0XHRcdGlmICghbGFzdEVudlNuYXBzaG90KSB7XHJcblx0XHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbW9kQXRFcnJvciA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xyXG5cdFx0XHRcdFx0XHRcdGNvbnN0IGVudkF0RXJyb3IgPSBtb2RBdEVycm9yLmVudiB8fCBtb2RBdEVycm9yLmRlZmF1bHQ/LmVudjtcclxuXHRcdFx0XHRcdFx0XHRpZiAoZW52QXRFcnJvcikge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZEF0RXJyb3IsIGVudkF0RXJyb3IsICdvbi1waXBlbGluZS1lcnJvcicpO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XHJcblx0XHRcdFx0XHRcdFx0Ly8gaWdub3JlIHNlY29uZGFyeSBmYWlsdXJlc1xyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnLCBgQ3JlYXRpbmcgcGlwZWxpbmUgd2l0aCBtb2RlbCBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiwgY2FjaGU6ICR7Y2FjaGVEaXJ9YCwgcGlwZWxpbmVFcnIpO1xyXG5cdFx0XHRcdFx0dGhyb3cgcGlwZWxpbmVFcnI7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGNvbnN0IHBpcGUgPSBwaXBlVW5rbm93biBhcyAoaW5wdXQ6IHN0cmluZywgb3B0cz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgNDogV3JhcHBpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHJcblx0XHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jICh0ZXh0OiBzdHJpbmcpID0+IHtcclxuXHRcdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0XHRcdHRyeSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBTdGFydGluZyBlbWJlZGRpbmcgZ2VuZXJhdGlvbiBmb3IgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMsICR7dGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIFJhdyBvdXRwdXQgcmVjZWl2ZWQgaW4gJHtlbWJlZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBPdXRwdXQgdHlwZTogJHt0eXBlb2Ygb3V0fWApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IGlzIGFycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHJcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXHJcblx0XHRcdFx0XHRcdGxldCByZXN1bHQ6IG51bWJlcltdO1xyXG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PEFycmF5PG51bWJlcj4+LCB1c2luZyBvdXRbMF1gKTtcclxuXHRcdFx0XHRcdFx0XHRyZXN1bHQgPSBsMk5vcm1hbGl6ZShvdXRbMF0gYXMgbnVtYmVyW10pO1xyXG5cdFx0XHRcdFx0XHR9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkob3V0KSkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PG51bWJlcj4sIHVzaW5nIGRpcmVjdGx5YCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0IGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xyXG5cdFx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkge1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEZvcm1hdDogT2JqZWN0IHdpdGggZGF0YSBhcnJheSwgdXNpbmcgZGF0YWApO1xyXG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XHJcblx0XHRcdFx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGVyciA9IG5ldyBFcnJvcihgVW5leHBlY3RlZCBlbWJlZGRpbmdzIG91dHB1dCBmb3JtYXQ6ICR7dHlwZW9mIG91dH0sIGlzQXJyYXk6ICR7QXJyYXkuaXNBcnJheShvdXQpfWApO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgUHJvY2Vzc2luZyB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycylgLCBlcnIpO1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIFVuZXhwZWN0ZWQgb3V0cHV0IGZvcm1hdGApO1xyXG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0OmAsIG91dCk7XHJcblx0XHRcdFx0XHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJMgRW1iZWRkaW5nIGdlbmVyYXRlZCBzdWNjZXNzZnVsbHkgKCR7cmVzdWx0Lmxlbmd0aH0gZGltZW5zaW9ucylgKTtcclxuXHRcdFx0XHRcdFx0cmV0dXJuIHJlc3VsdDtcclxuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGFmdGVyICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdwaXBlbGluZS5lbWJlZCcsIGBHZW5lcmF0aW5nIGVtYmVkZGluZyBmb3IgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMsICR7dGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRXJyb3I6YCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdH07XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IOKckyBQaXBlbGluZSB3cmFwcGVyIGNyZWF0ZWRgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBNT0RFTCBGVUxMWSBMT0FERUQgPT09YCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHRzOiAke3RoaXMubG9hZEF0dGVtcHRzfWApO1xyXG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRjb25zdCBsb2FkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gbG9hZFN0YXJ0O1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgTE9BRCBGQUlMRUQgPT09YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRvdGFsIGxvYWQgdGltZTogJHtsb2FkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0OiAjJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQnLCBgTW9kZWwgbG9hZGluZyBhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfWAsIGVycik7XHJcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XHJcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yVHlwZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciB0eXBlOiAke2Vycm9yVHlwZX1gKTtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgbWVzc2FnZTogJHtlcnJvck1zZ31gKTtcclxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIHN0YWNrIChmaXJzdCAxNSBsaW5lcyk6YCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDE1KS5qb2luKCdcXG4nKSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0fVxyXG5cdFx0fSkoKS5maW5hbGx5KCgpID0+IHtcclxuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcclxuXHRcdH0pO1xyXG5cclxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0fVxyXG5cclxuXHRhc3luYyBpc1JlYWR5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMucGlwZWxpbmUgIT09IG51bGw7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignaXNSZWFkeScsICdDaGVja2luZyBtb2RlbCByZWFkaW5lc3MnLCBlcnIpO1xyXG5cdFx0XHRyZXR1cm4gZmFsc2U7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xyXG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcclxuXHR9XHJcblxyXG5cdGdldExhc3RMb2FkRXJyb3IoKTogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCB7XHJcblx0XHRyZXR1cm4gdGhpcy5sYXN0TG9hZEVycm9yO1xyXG5cdH1cclxuXHJcblx0Z2V0TG9hZEF0dGVtcHRzKCk6IG51bWJlciB7XHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XHJcblx0fVxyXG5cclxuXHRnZXRFbnZTbmFwc2hvdCgpOiBhbnkgfCBudWxsIHtcclxuXHRcdHJldHVybiBsYXN0RW52U25hcHNob3Q7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcclxuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbnRyeTogTW9kZWxFcnJvckxvZ0VudHJ5ID0ge1xyXG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcclxuXHRcdFx0bG9jYXRpb24sXHJcblx0XHRcdGNvbnRleHQsXHJcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxyXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcclxuXHRcdFx0ZXJyb3JUeXBlXHJcblx0XHR9O1xyXG5cdFx0XHJcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xyXG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcclxuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBTdG9yZSBhcyBsYXN0IGxvYWQgZXJyb3IgaWYgaXQncyBhIGxvYWRpbmcgZXJyb3JcclxuXHRcdGlmIChsb2NhdGlvbiA9PT0gJ2Vuc3VyZUxvYWRlZCcgfHwgbG9jYXRpb24gPT09ICdpc1JlYWR5Jykge1xyXG5cdFx0XHR0aGlzLmxhc3RMb2FkRXJyb3IgPSBlbnRyeTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XHJcblx0XHRpZiAoZXJyb3JTdGFjaykge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0YXN5bmMgZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Y29uc3QgdCA9ICh0ZXh0IHx8ICcnKS50cmltKCk7XHJcblx0XHRpZiAoIXQpIHtcclxuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1wdHkgdGV4dCBwcm92aWRlZCwgcmV0dXJuaW5nIHplcm8gdmVjdG9yYCk7XHJcblx0XHRcdHJldHVybiBuZXcgQXJyYXk8bnVtYmVyPih0aGlzLmRpbSkuZmlsbCgwKTtcclxuXHRcdH1cclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdGlmICghdGhpcy5waXBlbGluZSkge1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5ncyBwaXBlbGluZSB1bmF2YWlsYWJsZSBhZnRlciBsb2FkaW5nIGF0dGVtcHQnKTtcclxuXHRcdFx0fVxyXG5cdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcclxuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcclxuXHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEdlbmVyYXRlZCBlbWJlZGRpbmcgaW4gJHtlbWJlZER1cmF0aW9ufW1zIGZvciB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgKTtcclxuXHRcdFx0cmV0dXJuIHJlc3VsdDtcclxuXHRcdH0gY2F0Y2ggKGVycikge1xyXG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbWJlZCcsIGBFbWJlZGRpbmcgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCwgZXJyKTtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xyXG5cdFx0XHR0aHJvdyBlcnI7XHJcblx0XHR9XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19