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
        console.debug('[LocalEmbeddingModel] [ENV SNAPSHOT]', lastEnvSnapshot);
    }
    catch (e) {
        console.warn('[LocalEmbeddingModel] [ENV SNAPSHOT] Failed to capture env snapshot:', e);
    }
}
// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin) {
    console.debug(`[LocalEmbeddingModel] === STARTING PIPELINE LOAD ===`);
    console.debug(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
    // Import the vendored transformers library first
    console.debug(`[LocalEmbeddingModel] [STEP 1] Importing transformers.js module...`);
    let mod;
    try {
        mod = await import('../../lib/transformers.js');
        console.debug(`[LocalEmbeddingModel] [STEP 1] ✓ Module imported successfully`);
        console.debug(`[LocalEmbeddingModel] [STEP 1] Module type: ${typeof mod}`);
        console.debug(`[LocalEmbeddingModel] [STEP 1] Module is null: ${mod === null}`);
        console.debug(`[LocalEmbeddingModel] [STEP 1] Module is undefined: ${mod === undefined}`);
    }
    catch (importErr) {
        console.error(`[LocalEmbeddingModel] [STEP 1] ✗ Module import failed:`, importErr);
        throw new Error(`Failed to import transformers.js: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
    }
    // Deep inspection of module structure
    console.debug(`[LocalEmbeddingModel] [STEP 2] Inspecting module structure...`);
    console.debug(`[LocalEmbeddingModel] [STEP 2] Module keys (first 30):`, mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 30) : 'N/A');
    console.debug(`[LocalEmbeddingModel] [STEP 2] Has 'env' property:`, 'env' in (mod || {}));
    console.debug(`[LocalEmbeddingModel] [STEP 2] Has 'default' property:`, 'default' in (mod || {}));
    console.debug(`[LocalEmbeddingModel] [STEP 2] Has 'pipeline' property:`, 'pipeline' in (mod || {}));
    console.debug(`[LocalEmbeddingModel] [STEP 2] mod.env type:`, typeof mod?.env);
    console.debug(`[LocalEmbeddingModel] [STEP 2] mod.default type:`, typeof mod?.default);
    console.debug(`[LocalEmbeddingModel] [STEP 2] mod.pipeline type:`, typeof mod?.pipeline);
    // Try multiple ways to access the environment
    let env = null;
    let envSource = 'none';
    console.debug(`[LocalEmbeddingModel] [STEP 3] Attempting to locate environment structure...`);
    // Method 1: Direct mod.env (standard structure)
    if (mod?.env) {
        console.debug(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.env`);
        env = mod.env;
        envSource = 'mod.env';
    }
    // Method 2: mod.default.env (if default export)
    else if (mod?.default?.env) {
        console.debug(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.default.env`);
        env = mod.default.env;
        envSource = 'mod.default.env';
    }
    // Deep inspection of what we have
    if (env) {
        console.debug(`[LocalEmbeddingModel] [STEP 3] env type: ${typeof env}`);
        console.debug(`[LocalEmbeddingModel] [STEP 3] env keys (first 30):`, Object.keys(env).slice(0, 30));
        console.debug(`[LocalEmbeddingModel] [STEP 3] env.backends exists:`, 'backends' in env);
        console.debug(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx exists:`, env.backends?.onnx !== undefined);
        console.debug(`[LocalEmbeddingModel] [STEP 3] env.useWasm exists:`, typeof env.useWasm === 'function');
        if (env.backends) {
            console.debug(`[LocalEmbeddingModel] [STEP 3] env.backends keys:`, Object.keys(env.backends));
        }
        if (env.backends?.onnx) {
            console.debug(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
            console.debug(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, Object.keys(env.backends.onnx).slice(0, 20));
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
            console.debug(`[LocalEmbeddingModel] [STEP 3] mod.env structure (depth 3):`, deepInspect(mod.env, 3));
        }
        if (mod?.default?.env) {
            console.debug(`[LocalEmbeddingModel] [STEP 3] mod.default.env structure (depth 3):`, deepInspect(mod.default.env, 3));
        }
    }
    // Configure WASM paths - CRITICAL: Must be done BEFORE any ONNX backend initialization
    console.debug(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
    const wasmBasePath = './lib/';
    if (env) {
        // Approach 1: Try to access ONNX backend directly from the module
        // The ONNX backend is exported from transformers.js, we need to access it
        let onnxBackendEnv = null;
        let onnxBackendPath = 'none';
        // Try to find ONNX in the module exports
        if (mod?.ONNX) {
            console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX export in module`);
            const onnx = mod.ONNX;
            if (onnx?.env?.wasm) {
                onnxBackendEnv = onnx.env.wasm;
                onnxBackendPath = 'mod.ONNX.env.wasm';
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env.wasm via mod.ONNX`);
            }
            else if (onnx?.env) {
                onnxBackendEnv = onnx.env;
                onnxBackendPath = 'mod.ONNX.env';
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env via mod.ONNX`);
            }
        }
        // Approach 2: Try via env.backends.onnx (transformers.js structure)
        if (!onnxBackendEnv && env.backends?.onnx) {
            const onnxBackend = env.backends.onnx;
            console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via env.backends.onnx`);
            if (onnxBackend.env?.wasm) {
                onnxBackendEnv = onnxBackend.env.wasm;
                onnxBackendPath = 'env.backends.onnx.env.wasm';
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.env.wasm`);
            }
            else if (onnxBackend.wasm) {
                onnxBackendEnv = onnxBackend.wasm;
                onnxBackendPath = 'onnxBackend.wasm';
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.wasm`);
            }
            else if (onnxBackend.env) {
                onnxBackendEnv = onnxBackend.env;
                onnxBackendPath = 'onnxBackend.env';
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Found env at onnxBackend.env`);
            }
        }
        // Set wasmPaths on the ONNX backend environment
        if (onnxBackendEnv) {
            console.debug(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${onnxBackendPath}`);
            try {
                if ('wasmPaths' in onnxBackendEnv) {
                    const currentPaths = onnxBackendEnv.wasmPaths;
                    console.debug(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths: ${JSON.stringify(currentPaths)}`);
                    onnxBackendEnv.wasmPaths = wasmBasePath;
                    console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Updated wasmPaths to: ${wasmBasePath}`);
                    console.debug(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths: ${JSON.stringify(onnxBackendEnv.wasmPaths)}`);
                }
                else {
                    Object.defineProperty(onnxBackendEnv, 'wasmPaths', {
                        value: wasmBasePath,
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                    console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
                }
            }
            catch (pathErr) {
                console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set wasmPaths at ${onnxBackendPath}:`, pathErr);
            }
        }
        else {
            // ONNX backend environment not found - try fallback approaches
            console.warn(`[LocalEmbeddingModel] [STEP 4] ⚠ ONNX backend environment not found via standard paths`);
            console.warn(`[LocalEmbeddingModel] [STEP 4] Attempting fallback: setting on env.backends.onnx directly...`);
            // Try to create/access backends.onnx if it doesn't exist
            if (!env.backends) {
                try {
                    env.backends = {};
                    console.debug(`[LocalEmbeddingModel] [STEP 4] Created env.backends object`);
                }
                catch (e) {
                    console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to create env.backends:`, e);
                }
            }
            // Check if we can access ONNX after creating backends
            if (env.backends && !env.backends.onnx) {
                console.warn(`[LocalEmbeddingModel] [STEP 4] env.backends.onnx is still undefined - ONNX backend may not be initialized yet`);
                console.warn(`[LocalEmbeddingModel] [STEP 4] This is expected if ONNX backend initializes lazily`);
            }
            // Always capture snapshot for diagnostics
            captureEnvSnapshot(mod, env, 'wasm-config-attempt');
            if (lastEnvSnapshot) {
                console.debug('[LocalEmbeddingModel] [ENV SNAPSHOT]', JSON.stringify(lastEnvSnapshot, null, 2));
            }
        }
        // Approach 3: Also try setting at top-level env (some transformers.js versions use this)
        try {
            if ('wasmPaths' in env) {
                env.wasmPaths = wasmBasePath;
                console.debug(`[LocalEmbeddingModel] [STEP 4] ✓ Also set env.wasmPaths to: ${wasmBasePath}`);
            }
        }
        catch (envPathErr) {
            console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set top-level env.wasmPaths:`, envPathErr);
        }
    }
    else {
        console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - env not found`);
    }
    // Get pipeline function
    console.debug(`[LocalEmbeddingModel] [STEP 5] Locating pipeline function...`);
    const pipeline = mod.pipeline || mod.default?.pipeline;
    console.debug(`[LocalEmbeddingModel] [STEP 5] Pipeline found:`, pipeline !== undefined && pipeline !== null);
    console.debug(`[LocalEmbeddingModel] [STEP 5] Pipeline type:`, typeof pipeline);
    console.debug(`[LocalEmbeddingModel] [STEP 5] Pipeline is function:`, typeof pipeline === 'function');
    if (!pipeline || typeof pipeline !== 'function') {
        console.error(`[LocalEmbeddingModel] [STEP 5] ✗ Pipeline not found or not a function`);
        console.error(`[LocalEmbeddingModel] [STEP 5] mod.pipeline:`, mod?.pipeline);
        console.error(`[LocalEmbeddingModel] [STEP 5] mod.default.pipeline:`, mod?.default?.pipeline);
        throw new Error('Pipeline not found in transformers module');
    }
    console.debug(`[LocalEmbeddingModel] [STEP 5] ✓ Pipeline function found`);
    console.debug(`[LocalEmbeddingModel] === PIPELINE LOAD COMPLETE ===`);
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
            console.debug(`[LocalEmbeddingModel] Pipeline already loaded (attempt #${this.loadAttempts})`);
            return;
        }
        if (this.loading !== null) {
            console.debug(`[LocalEmbeddingModel] Pipeline loading in progress (attempt #${this.loadAttempts}), waiting...`);
            return this.loading;
        }
        console.debug(`[LocalEmbeddingModel] === STARTING MODEL LOAD ===`);
        console.debug(`[LocalEmbeddingModel] Load attempt #${this.loadAttempts + 1}`);
        console.debug(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
        this.loadAttempts++;
        const loadStart = Date.now();
        this.loading = (async () => {
            try {
                // Get pipeline function - using helper to ensure proper initialization
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 1: Getting pipeline function...`);
                let pipeline;
                try {
                    pipeline = await getPipeline(this.plugin);
                    if (!pipeline) {
                        throw new Error('Pipeline is null or undefined');
                    }
                    if (typeof pipeline !== 'function') {
                        throw new Error(`Pipeline is not a function, got: ${typeof pipeline}`);
                    }
                    console.debug(`[LocalEmbeddingModel] [LOAD] Step 1: ✓ Pipeline function loaded (type: ${typeof pipeline}, name: ${pipeline.name || 'anonymous'})`);
                }
                catch (importErr) {
                    console.error(`[LocalEmbeddingModel] [LOAD] Step 1: ✗ Failed to get pipeline function`);
                    this.logError('ensureLoaded.import', 'Loading vendored transformers pipeline', importErr);
                    throw new Error(`Failed to load transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
                }
                // Cache models inside plugin data to avoid re-downloading if possible.
                // Note: transformers uses its own caching strategy; this is a hint.
                const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 2: Preparing model cache...`);
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 2: Cache directory: ${cacheDir}`);
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 2: Model: Xenova/all-MiniLM-L6-v2`);
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 2: Quantized: true`);
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 3: Creating model pipeline (this may take time)...`);
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
                    console.debug(`[LocalEmbeddingModel] [LOAD] Step 3: ✓ Pipeline created in ${pipelineDuration}ms`);
                    console.debug(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output type: ${typeof pipeUnknown}`);
                    console.debug(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output is array: ${Array.isArray(pipeUnknown)}`);
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
                        catch (err) {
                            console.debug('[LocalEmbeddingModel] Secondary env snapshot capture failed:', err);
                        }
                    }
                    this.logError('ensureLoaded.createPipeline', `Creating pipeline with model Xenova/all-MiniLM-L6-v2, cache: ${cacheDir}`, pipelineErr);
                    throw pipelineErr;
                }
                const pipe = pipeUnknown;
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 4: Wrapping pipeline function...`);
                this.pipeline = async (text) => {
                    const embedStartTime = Date.now();
                    try {
                        console.debug(`[LocalEmbeddingModel] [EMBED] Starting embedding generation for text (${text.length} chars, ${text.split(/\s+/).length} words)...`);
                        const out = await pipe(text, { pooling: 'mean', normalize: true });
                        const embedDuration = Date.now() - embedStartTime;
                        console.debug(`[LocalEmbeddingModel] [EMBED] Raw output received in ${embedDuration}ms`);
                        console.debug(`[LocalEmbeddingModel] [EMBED] Output type: ${typeof out}`);
                        console.debug(`[LocalEmbeddingModel] [EMBED] Output is array: ${Array.isArray(out)}`);
                        // transformers output can vary; handle common cases.
                        let result;
                        if (Array.isArray(out) && Array.isArray(out[0])) {
                            console.debug(`[LocalEmbeddingModel] [EMBED] Format: Array<Array<number>>, using out[0]`);
                            result = l2Normalize(out[0]);
                        }
                        else if (Array.isArray(out)) {
                            console.debug(`[LocalEmbeddingModel] [EMBED] Format: Array<number>, using directly`);
                            result = l2Normalize(out);
                        }
                        else {
                            const maybe = out;
                            if (Array.isArray(maybe?.data)) {
                                console.debug(`[LocalEmbeddingModel] [EMBED] Format: Object with data array, using data`);
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
                        console.debug(`[LocalEmbeddingModel] [EMBED] ✓ Embedding generated successfully (${result.length} dimensions)`);
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
                console.debug(`[LocalEmbeddingModel] [LOAD] Step 4: ✓ Pipeline wrapper created`);
                console.debug(`[LocalEmbeddingModel] === MODEL FULLY LOADED ===`);
                console.debug(`[LocalEmbeddingModel] Total load time: ${loadDuration}ms`);
                console.debug(`[LocalEmbeddingModel] Load attempts: ${this.loadAttempts}`);
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
            console.debug(`[LocalEmbeddingModel] Generated embedding in ${embedDuration}ms for text (${t.length} chars, ${t.split(/\s+/).length} words)`);
            return result;
        }
        catch (err) {
            this.logError('embed', `Embedding text (${t.length} chars, ${t.split(/\s+/).length} words)`, err);
            console.error(`[LocalEmbeddingModel] Embedding generation failed:`, err);
            throw err;
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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QUFhLGdCQUFnQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQztZQUM5SSxPQUFPLE1BQU0sQ0FBQztRQUNmLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ2QsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLFNBQVMsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUNsRyxPQUFPLENBQUMsS0FBSyxDQUFDLG9EQUFvRCxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3pFLE1BQU0sR0FBRyxDQUFDO1FBQ1gsQ0FBQztJQUNGLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcblxuLy8gSGVscGVyIGZ1bmN0aW9uIHRvIHNhZmVseSBpbnNwZWN0IG9iamVjdCBzdHJ1Y3R1cmUgd2l0aG91dCBjYXVzaW5nIGVycm9yc1xuZnVuY3Rpb24gZGVlcEluc3BlY3Qob2JqOiBhbnksIG1heERlcHRoOiBudW1iZXIgPSAzLCBjdXJyZW50RGVwdGg6IG51bWJlciA9IDAsIHZpc2l0ZWQ6IFdlYWtTZXQ8YW55PiA9IG5ldyBXZWFrU2V0KCkpOiBhbnkge1xuXHRpZiAoY3VycmVudERlcHRoID49IG1heERlcHRoIHx8IG9iaiA9PT0gbnVsbCB8fCBvYmogPT09IHVuZGVmaW5lZCkge1xuXHRcdHJldHVybiB0eXBlb2Ygb2JqO1xuXHR9XG5cdGlmICh0eXBlb2Ygb2JqICE9PSAnb2JqZWN0Jykge1xuXHRcdHJldHVybiBvYmo7XG5cdH1cblx0aWYgKHZpc2l0ZWQuaGFzKG9iaikpIHtcblx0XHRyZXR1cm4gJ1tDaXJjdWxhcl0nO1xuXHR9XG5cdHZpc2l0ZWQuYWRkKG9iaik7XG5cdFxuXHRjb25zdCByZXN1bHQ6IGFueSA9IHt9O1xuXHR0cnkge1xuXHRcdGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyhvYmopLnNsaWNlKDAsIDIwKTsgLy8gTGltaXQga2V5cyB0byBhdm9pZCBodWdlIG91dHB1dFxuXHRcdGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHZhbCA9IG9ialtrZXldO1xuXHRcdFx0XHRpZiAodHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRcdHJlc3VsdFtrZXldID0gYFtGdW5jdGlvbjogJHt2YWwubmFtZSB8fCAnYW5vbnltb3VzJ31dYDtcblx0XHRcdFx0fSBlbHNlIGlmICh0eXBlb2YgdmFsID09PSAnb2JqZWN0JyAmJiB2YWwgIT09IG51bGwpIHtcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IGRlZXBJbnNwZWN0KHZhbCwgbWF4RGVwdGgsIGN1cnJlbnREZXB0aCArIDEsIHZpc2l0ZWQpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHJlc3VsdFtrZXldID0gdmFsO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlKSB7XG5cdFx0XHRcdHJlc3VsdFtrZXldID0gYFtFcnJvciBhY2Nlc3Npbmc6ICR7ZX1dYDtcblx0XHRcdH1cblx0XHR9XG5cdH0gY2F0Y2ggKGUpIHtcblx0XHRyZXR1cm4gYFtFcnJvciBpbnNwZWN0aW5nOiAke2V9XWA7XG5cdH1cblx0cmV0dXJuIHJlc3VsdDtcbn1cblxuLy8gQ2FwdHVyZSBhIG9uZS10aW1lIHNuYXBzaG90IG9mIHRoZSB0cmFuc2Zvcm1lcnMgZW52IC8gT05OWCBzdGF0ZSBmb3IgZGlhZ25vc3RpY3NcbmxldCBsYXN0RW52U25hcHNob3Q6IGFueSB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBjYXB0dXJlRW52U25hcHNob3QobW9kOiBhbnksIGVudjogYW55LCB3aGVyZTogc3RyaW5nKTogdm9pZCB7XG5cdHRyeSB7XG5cdFx0Y29uc3Qgb25ueCA9IGVudj8uYmFja2VuZHM/Lm9ubng7XG5cdFx0Y29uc3QgYmFja2VuZHMgPSBlbnY/LmJhY2tlbmRzO1xuXHRcdGxhc3RFbnZTbmFwc2hvdCA9IHtcblx0XHRcdHdoZXJlLFxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRtb2RLZXlzOiBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDIwKSA6IG51bGwsXG5cdFx0XHRoYXNEZWZhdWx0OiAhIW1vZD8uZGVmYXVsdCxcblx0XHRcdGhhc1BpcGVsaW5lOiB0eXBlb2YgKG1vZD8ucGlwZWxpbmUgfHwgbW9kPy5kZWZhdWx0Py5waXBlbGluZSkgPT09ICdmdW5jdGlvbicsXG5cdFx0XHRlbnZLZXlzOiBlbnYgPyBPYmplY3Qua2V5cyhlbnYpLnNsaWNlKDAsIDIwKSA6IG51bGwsXG5cdFx0XHRlbnZIYXNCYWNrZW5kczogISFiYWNrZW5kcyxcblx0XHRcdGJhY2tlbmRzS2V5czogYmFja2VuZHMgPyBPYmplY3Qua2V5cyhiYWNrZW5kcykgOiBudWxsLFxuXHRcdFx0b25ueEtleUV4aXN0czogYmFja2VuZHMgPyAnb25ueCcgaW4gYmFja2VuZHMgOiBmYWxzZSxcblx0XHRcdG9ubnhWYWx1ZUV4aXN0czogb25ueCAhPT0gdW5kZWZpbmVkLFxuXHRcdFx0b25ueFZhbHVlVHlwZTogdHlwZW9mIG9ubngsXG5cdFx0XHRvbm54S2V5czogb25ueCA/IE9iamVjdC5rZXlzKG9ubngpLnNsaWNlKDAsIDIwKSA6IG51bGwsXG5cdFx0XHRvbm54SGFzV2FzbTogISFvbm54Py53YXNtLFxuXHRcdFx0b25ueFdhc21LZXlzOiBvbm54Py53YXNtID8gT2JqZWN0LmtleXMob25ueC53YXNtKS5zbGljZSgwLCAyMCkgOiBudWxsLFxuXHRcdFx0b25ueFdhc21QYXRoczogb25ueD8ud2FzbT8ud2FzbVBhdGhzID8/IG51bGwsXG5cdFx0XHRlbnZIYXNVc2VXYXNtOiB0eXBlb2YgZW52Py51c2VXYXNtID09PSAnZnVuY3Rpb24nLFxuXHRcdH07XG5cdFx0Y29uc29sZS5kZWJ1ZygnW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdJywgbGFzdEVudlNuYXBzaG90KTtcblx0fSBjYXRjaCAoZSkge1xuXHRcdGNvbnNvbGUud2FybignW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdIEZhaWxlZCB0byBjYXB0dXJlIGVudiBzbmFwc2hvdDonLCBlKTtcblx0fVxufVxuXG4vLyBIZWxwZXIgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uIHdpdGggcHJvcGVyIGVycm9yIGhhbmRsaW5nXG4vLyBVc2VzIHZlbmRvcmVkIHRyYW5zZm9ybWVycy5qcyB0byBhdm9pZCBidW5kbGluZyBpc3N1ZXNcbmFzeW5jIGZ1bmN0aW9uIGdldFBpcGVsaW5lKHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IFByb21pc2U8YW55PiB7XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgUElQRUxJTkUgTE9BRCA9PT1gKTtcblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRpbWVzdGFtcDogJHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9YCk7XG5cdFxuXHQvLyBJbXBvcnQgdGhlIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBsaWJyYXJ5IGZpcnN0XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBJbXBvcnRpbmcgdHJhbnNmb3JtZXJzLmpzIG1vZHVsZS4uLmApO1xuXHRsZXQgbW9kOiBhbnk7XG5cdHRyeSB7XG5cdFx0bW9kID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKckyBNb2R1bGUgaW1wb3J0ZWQgc3VjY2Vzc2Z1bGx5YCk7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSB0eXBlOiAke3R5cGVvZiBtb2R9YCk7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSBpcyBudWxsOiAke21vZCA9PT0gbnVsbH1gKTtcblx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIHVuZGVmaW5lZDogJHttb2QgPT09IHVuZGVmaW5lZH1gKTtcblx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xuXHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGltcG9ydCB0cmFuc2Zvcm1lcnMuanM6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xuXHR9XG5cdFxuXHQvLyBEZWVwIGluc3BlY3Rpb24gb2YgbW9kdWxlIHN0cnVjdHVyZVxuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSW5zcGVjdGluZyBtb2R1bGUgc3RydWN0dXJlLi4uYCk7XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBNb2R1bGUga2V5cyAoZmlyc3QgMzApOmAsIG1vZCAmJiB0eXBlb2YgbW9kID09PSAnb2JqZWN0JyA/IE9iamVjdC5rZXlzKG1vZCkuc2xpY2UoMCwgMzApIDogJ04vQScpO1xuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdlbnYnIHByb3BlcnR5OmAsICdlbnYnIGluIChtb2QgfHwge30pKTtcblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAnZGVmYXVsdCcgcHJvcGVydHk6YCwgJ2RlZmF1bHQnIGluIChtb2QgfHwge30pKTtcblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAncGlwZWxpbmUnIHByb3BlcnR5OmAsICdwaXBlbGluZScgaW4gKG1vZCB8fCB7fSkpO1xuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmVudiB0eXBlOmAsIHR5cGVvZiBtb2Q/LmVudik7XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QuZGVmYXVsdCB0eXBlOmAsIHR5cGVvZiBtb2Q/LmRlZmF1bHQpO1xuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLnBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIG1vZD8ucGlwZWxpbmUpO1xuXHRcblx0Ly8gVHJ5IG11bHRpcGxlIHdheXMgdG8gYWNjZXNzIHRoZSBlbnZpcm9ubWVudFxuXHRsZXQgZW52OiBhbnkgPSBudWxsO1xuXHRsZXQgZW52U291cmNlID0gJ25vbmUnO1xuXHRcblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIEF0dGVtcHRpbmcgdG8gbG9jYXRlIGVudmlyb25tZW50IHN0cnVjdHVyZS4uLmApO1xuXHRcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXG5cdGlmIChtb2Q/LmVudikge1xuXHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSDinJMgRm91bmQgZW52IHZpYSBtb2QuZW52YCk7XG5cdFx0ZW52ID0gbW9kLmVudjtcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmVudic7XG5cdH1cblx0Ly8gTWV0aG9kIDI6IG1vZC5kZWZhdWx0LmVudiAoaWYgZGVmYXVsdCBleHBvcnQpXG5cdGVsc2UgaWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKckyBGb3VuZCBlbnYgdmlhIG1vZC5kZWZhdWx0LmVudmApO1xuXHRcdGVudiA9IG1vZC5kZWZhdWx0LmVudjtcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmRlZmF1bHQuZW52Jztcblx0fVxuXHRcblx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIHdoYXQgd2UgaGF2ZVxuXHRpZiAoZW52KSB7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiB0eXBlOiAke3R5cGVvZiBlbnZ9YCk7XG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiBrZXlzIChmaXJzdCAzMCk6YCwgT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAzMCkpO1xuXHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMgZXhpc3RzOmAsICdiYWNrZW5kcycgaW4gZW52KTtcblx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcblx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LnVzZVdhc20gZXhpc3RzOmAsIHR5cGVvZiBlbnYudXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyk7XG5cdFx0aWYgKGVudi5iYWNrZW5kcykge1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcyBrZXlzOmAsIE9iamVjdC5rZXlzKGVudi5iYWNrZW5kcykpO1xuXHRcdH1cblx0XHRpZiAoZW52LmJhY2tlbmRzPy5vbm54KSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcy5vbm54IGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzLm9ubngpLnNsaWNlKDAsIDIwKSk7XG5cdFx0fVxuXHRcdC8vIENhcHR1cmUgZW52IHNuYXBzaG90IGJlZm9yZSBXQVNNIGNvbmZpZ1xuXHRcdGlmICghbGFzdEVudlNuYXBzaG90KSB7XG5cdFx0XHRjYXB0dXJlRW52U25hcHNob3QobW9kLCBlbnYsICdiZWZvcmUtd2FzbS1jb25maWcnKTtcblx0XHR9XG5cdH0gZWxzZSB7XG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyXIENvdWxkIG5vdCBmaW5kIGVudiBzdHJ1Y3R1cmVgKTtcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZW52IGV4aXN0czpgLCBtb2Q/LmVudiAhPT0gdW5kZWZpbmVkKTtcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdCBleGlzdHM6YCwgbW9kPy5kZWZhdWx0ICE9PSB1bmRlZmluZWQpO1xuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudiBleGlzdHM6YCwgbW9kPy5kZWZhdWx0Py5lbnYgIT09IHVuZGVmaW5lZCk7XG5cdFx0aWYgKG1vZD8uZW52KSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5lbnYsIDMpKTtcblx0XHR9XG5cdFx0aWYgKG1vZD8uZGVmYXVsdD8uZW52KSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IHN0cnVjdHVyZSAoZGVwdGggMyk6YCwgZGVlcEluc3BlY3QobW9kLmRlZmF1bHQuZW52LCAzKSk7XG5cdFx0fVxuXHR9XG5cdFxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIENSSVRJQ0FMOiBNdXN0IGJlIGRvbmUgQkVGT1JFIGFueSBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6YXRpb25cblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcblx0XG5cdGNvbnN0IHdhc21CYXNlUGF0aCA9ICcuL2xpYi8nO1xuXHRcblx0aWYgKGVudikge1xuXHRcdC8vIEFwcHJvYWNoIDE6IFRyeSB0byBhY2Nlc3MgT05OWCBiYWNrZW5kIGRpcmVjdGx5IGZyb20gdGhlIG1vZHVsZVxuXHRcdC8vIFRoZSBPTk5YIGJhY2tlbmQgaXMgZXhwb3J0ZWQgZnJvbSB0cmFuc2Zvcm1lcnMuanMsIHdlIG5lZWQgdG8gYWNjZXNzIGl0XG5cdFx0bGV0IG9ubnhCYWNrZW5kRW52OiBhbnkgPSBudWxsO1xuXHRcdGxldCBvbm54QmFja2VuZFBhdGggPSAnbm9uZSc7XG5cdFx0XG5cdFx0Ly8gVHJ5IHRvIGZpbmQgT05OWCBpbiB0aGUgbW9kdWxlIGV4cG9ydHNcblx0XHRpZiAobW9kPy5PTk5YKSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIE9OTlggZXhwb3J0IGluIG1vZHVsZWApO1xuXHRcdFx0Y29uc3Qgb25ueCA9IG1vZC5PTk5YO1xuXHRcdFx0aWYgKG9ubng/LmVudj8ud2FzbSkge1xuXHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnguZW52Lndhc207XG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdtb2QuT05OWC5lbnYud2FzbSc7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgT05OWCBlbnYud2FzbSB2aWEgbW9kLk9OTlhgKTtcblx0XHRcdH0gZWxzZSBpZiAob25ueD8uZW52KSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueC5lbnY7XG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdtb2QuT05OWC5lbnYnO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIE9OTlggZW52IHZpYSBtb2QuT05OWGApO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRcblx0XHQvLyBBcHByb2FjaCAyOiBUcnkgdmlhIGVudi5iYWNrZW5kcy5vbm54ICh0cmFuc2Zvcm1lcnMuanMgc3RydWN0dXJlKVxuXHRcdGlmICghb25ueEJhY2tlbmRFbnYgJiYgZW52LmJhY2tlbmRzPy5vbm54KSB7XG5cdFx0XHRjb25zdCBvbm54QmFja2VuZCA9IGVudi5iYWNrZW5kcy5vbm54O1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhIGVudi5iYWNrZW5kcy5vbm54YCk7XG5cdFx0XHRcblx0XHRcdGlmIChvbm54QmFja2VuZC5lbnY/Lndhc20pIHtcblx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcblx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ2Vudi5iYWNrZW5kcy5vbm54LmVudi53YXNtJztcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC5lbnYud2FzbWApO1xuXHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC53YXNtKSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQud2FzbTtcblx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ29ubnhCYWNrZW5kLndhc20nO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLndhc21gKTtcblx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQuZW52KSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQuZW52O1xuXHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnb25ueEJhY2tlbmQuZW52Jztcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBlbnYgYXQgb25ueEJhY2tlbmQuZW52YCk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFNldCB3YXNtUGF0aHMgb24gdGhlIE9OTlggYmFja2VuZCBlbnZpcm9ubWVudFxuXHRcdGlmIChvbm54QmFja2VuZEVudikge1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENvbmZpZ3VyaW5nIFdBU00gcGF0aHMgYXQ6ICR7b25ueEJhY2tlbmRQYXRofWApO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIG9ubnhCYWNrZW5kRW52KSB7XG5cdFx0XHRcdFx0Y29uc3QgY3VycmVudFBhdGhzID0gb25ueEJhY2tlbmRFbnYud2FzbVBhdGhzO1xuXHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDdXJyZW50IHdhc21QYXRoczogJHtKU09OLnN0cmluZ2lmeShjdXJyZW50UGF0aHMpfWApO1xuXHRcdFx0XHRcdG9ubnhCYWNrZW5kRW52Lndhc21QYXRocyA9IHdhc21CYXNlUGF0aDtcblx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIFVwZGF0ZWQgd2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcblx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gVmVyaWZpZWQgd2FzbVBhdGhzOiAke0pTT04uc3RyaW5naWZ5KG9ubnhCYWNrZW5kRW52Lndhc21QYXRocyl9YCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KG9ubnhCYWNrZW5kRW52LCAnd2FzbVBhdGhzJywge1xuXHRcdFx0XHRcdFx0dmFsdWU6IHdhc21CYXNlUGF0aCxcblx0XHRcdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxuXHRcdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcblx0XHRcdFx0XHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgQ3JlYXRlZCBhbmQgc2V0IHdhc21QYXRocyB0bzogJHt3YXNtQmFzZVBhdGh9YCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKHBhdGhFcnIpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIHNldCB3YXNtUGF0aHMgYXQgJHtvbm54QmFja2VuZFBhdGh9OmAsIHBhdGhFcnIpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnQgbm90IGZvdW5kIC0gdHJ5IGZhbGxiYWNrIGFwcHJvYWNoZXNcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKaoCBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnQgbm90IGZvdW5kIHZpYSBzdGFuZGFyZCBwYXRoc2ApO1xuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQXR0ZW1wdGluZyBmYWxsYmFjazogc2V0dGluZyBvbiBlbnYuYmFja2VuZHMub25ueCBkaXJlY3RseS4uLmApO1xuXHRcdFx0XG5cdFx0XHQvLyBUcnkgdG8gY3JlYXRlL2FjY2VzcyBiYWNrZW5kcy5vbm54IGlmIGl0IGRvZXNuJ3QgZXhpc3Rcblx0XHRcdGlmICghZW52LmJhY2tlbmRzKSB7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0ZW52LmJhY2tlbmRzID0ge307XG5cdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENyZWF0ZWQgZW52LmJhY2tlbmRzIG9iamVjdGApO1xuXHRcdFx0XHR9IGNhdGNoIChlKSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gRmFpbGVkIHRvIGNyZWF0ZSBlbnYuYmFja2VuZHM6YCwgZSk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQ2hlY2sgaWYgd2UgY2FuIGFjY2VzcyBPTk5YIGFmdGVyIGNyZWF0aW5nIGJhY2tlbmRzXG5cdFx0XHRpZiAoZW52LmJhY2tlbmRzICYmICFlbnYuYmFja2VuZHMub25ueCkge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBlbnYuYmFja2VuZHMub25ueCBpcyBzdGlsbCB1bmRlZmluZWQgLSBPTk5YIGJhY2tlbmQgbWF5IG5vdCBiZSBpbml0aWFsaXplZCB5ZXRgKTtcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gVGhpcyBpcyBleHBlY3RlZCBpZiBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6ZXMgbGF6aWx5YCk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIEFsd2F5cyBjYXB0dXJlIHNuYXBzaG90IGZvciBkaWFnbm9zdGljc1xuXHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZCwgZW52LCAnd2FzbS1jb25maWctYXR0ZW1wdCcpO1xuXHRcdFx0aWYgKGxhc3RFbnZTbmFwc2hvdCkge1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0nLCBKU09OLnN0cmluZ2lmeShsYXN0RW52U25hcHNob3QsIG51bGwsIDIpKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0Ly8gQXBwcm9hY2ggMzogQWxzbyB0cnkgc2V0dGluZyBhdCB0b3AtbGV2ZWwgZW52IChzb21lIHRyYW5zZm9ybWVycy5qcyB2ZXJzaW9ucyB1c2UgdGhpcylcblx0XHR0cnkge1xuXHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIGVudikge1xuXHRcdFx0XHRlbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEFsc28gc2V0IGVudi53YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2ggKGVudlBhdGhFcnIpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBzZXQgdG9wLWxldmVsIGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XG5cdFx0fVxuXHR9IGVsc2Uge1xuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XG5cdH1cblx0XG5cdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcblx0Y29uc3QgcGlwZWxpbmUgPSBtb2QucGlwZWxpbmUgfHwgbW9kLmRlZmF1bHQ/LnBpcGVsaW5lO1xuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgZm91bmQ6YCwgcGlwZWxpbmUgIT09IHVuZGVmaW5lZCAmJiBwaXBlbGluZSAhPT0gbnVsbCk7XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSB0eXBlOmAsIHR5cGVvZiBwaXBlbGluZSk7XG5cdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSBpcyBmdW5jdGlvbjpgLCB0eXBlb2YgcGlwZWxpbmUgPT09ICdmdW5jdGlvbicpO1xuXHRcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0g4pyXIFBpcGVsaW5lIG5vdCBmb3VuZCBvciBub3QgYSBmdW5jdGlvbmApO1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBtb2QucGlwZWxpbmU6YCwgbW9kPy5waXBlbGluZSk7XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5kZWZhdWx0LnBpcGVsaW5lOmAsIG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpO1xuXHRcdHRocm93IG5ldyBFcnJvcignUGlwZWxpbmUgbm90IGZvdW5kIGluIHRyYW5zZm9ybWVycyBtb2R1bGUnKTtcblx0fVxuXHRcblx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xuXHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFBJUEVMSU5FIExPQUQgQ09NUExFVEUgPT09YCk7XG5cdHJldHVybiBwaXBlbGluZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBMb2NhbEVtYmVkZGluZ01vZGVsIHtcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XG5cdGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+O1xufVxuXG5mdW5jdGlvbiBsMk5vcm1hbGl6ZSh2ZWM6IG51bWJlcltdKTogbnVtYmVyW10ge1xuXHRsZXQgc3VtU3EgPSAwO1xuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcblx0Y29uc3Qgbm9ybSA9IE1hdGguc3FydChzdW1TcSkgfHwgMTtcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcbn1cblxuLyoqXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxuICogRmFsbHMgYmFjayB0byB0aHJvd2luZyBvbiBsb2FkIGZhaWx1cmU7IGNhbGxlcnMgc2hvdWxkIGNhdGNoIGFuZCB1c2UgaGV1cmlzdGljL2hhc2guXG4gKi9cbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xuXHR0aW1lc3RhbXA6IHN0cmluZztcblx0bG9jYXRpb246IHN0cmluZztcblx0Y29udGV4dDogc3RyaW5nO1xuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XG5cdHJlYWRvbmx5IGlkID0gJ21pbmlsbSc7XG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgbG9hZEF0dGVtcHRzID0gMDtcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogTW9kZWxFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSA1MDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgYWxyZWFkeSBsb2FkZWQgKGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHN9KWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAodGhpcy5sb2FkaW5nICE9PSBudWxsKSB7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgbG9hZGluZyBpbiBwcm9ncmVzcyAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pLCB3YWl0aW5nLi4uYCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xuXHRcdH1cblxuXHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgTU9ERUwgTE9BRCA9PT1gKTtcblx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzICsgMX1gKTtcblx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVGltZXN0YW1wOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiBHZXR0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XG5cdFx0XHRcdGxldCBwaXBlbGluZTogYW55O1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xuXHRcdFx0XHRcdGlmICghcGlwZWxpbmUpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignUGlwZWxpbmUgaXMgbnVsbCBvciB1bmRlZmluZWQnKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0aWYgKHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBQaXBlbGluZSBpcyBub3QgYSBmdW5jdGlvbiwgZ290OiAke3R5cGVvZiBwaXBlbGluZX1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWQgKHR5cGU6ICR7dHlwZW9mIHBpcGVsaW5lfSwgbmFtZTogJHtwaXBlbGluZS5uYW1lIHx8ICdhbm9ueW1vdXMnfSlgKTtcblx0XHRcdFx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKclyBGYWlsZWQgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uYCk7XG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gbG9hZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmU6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2FjaGUgbW9kZWxzIGluc2lkZSBwbHVnaW4gZGF0YSB0byBhdm9pZCByZS1kb3dubG9hZGluZyBpZiBwb3NzaWJsZS5cblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogTW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyYCk7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IENyZWF0aW5nIG1vZGVsIHBpcGVsaW5lICh0aGlzIG1heSB0YWtlIHRpbWUpLi4uYCk7XG5cblx0XHRcdFx0bGV0IHBpcGVVbmtub3duOiB1bmtub3duO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGNvbnN0IHBpcGVsaW5lU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0XHQvLyBDYWxsIHBpcGVsaW5lIGRpcmVjdGx5IGFzIGEgZnVuY3Rpb25cblx0XHRcdFx0XHRwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKCdmZWF0dXJlLWV4dHJhY3Rpb24nLCAnWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjInLCB7XG5cdFx0XHRcdFx0XHRxdWFudGl6ZWQ6IHRydWUsXG5cdFx0XHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxuXHRcdFx0XHRcdFx0Y2FjaGVfZGlyOiBjYWNoZURpclxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnN0IHBpcGVsaW5lRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gcGlwZWxpbmVTdGFydFRpbWU7XG5cdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKckyBQaXBlbGluZSBjcmVhdGVkIGluICR7cGlwZWxpbmVEdXJhdGlvbn1tc2ApO1xuXHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgdHlwZTogJHt0eXBlb2YgcGlwZVVua25vd259YCk7XG5cdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IFBpcGVsaW5lIG91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KHBpcGVVbmtub3duKX1gKTtcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzog4pyXIFBpcGVsaW5lIGNyZWF0aW9uIGZhaWxlZGApO1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciB0eXBlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIHBpcGVsaW5lRXJyfWApO1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBtZXNzYWdlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5tZXNzYWdlIDogU3RyaW5nKHBpcGVsaW5lRXJyKX1gKTtcblx0XHRcdFx0XHRpZiAocGlwZWxpbmVFcnIgaW5zdGFuY2VvZiBFcnJvciAmJiBwaXBlbGluZUVyci5zdGFjaykge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IEVycm9yIHN0YWNrIChmaXJzdCAxMCBsaW5lcyk6YCk7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKHBpcGVsaW5lRXJyLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxMCkuam9pbignXFxuJykpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBhdCBmYWlsdXJlIHRpbWUgaWYgd2UgZG9uJ3QgaGF2ZSBvbmVcblx0XHRcdFx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xuXHRcdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdFx0Y29uc3QgbW9kQXRFcnJvciA9IGF3YWl0IGltcG9ydCgnLi4vLi4vbGliL3RyYW5zZm9ybWVycy5qcycpO1xuXHRcdFx0XHRcdFx0XHRjb25zdCBlbnZBdEVycm9yID0gbW9kQXRFcnJvci5lbnYgfHwgbW9kQXRFcnJvci5kZWZhdWx0Py5lbnY7XG5cdFx0XHRcdFx0XHRcdGlmIChlbnZBdEVycm9yKSB7XG5cdFx0XHRcdFx0XHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZEF0RXJyb3IsIGVudkF0RXJyb3IsICdvbi1waXBlbGluZS1lcnJvcicpO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZygnW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFNlY29uZGFyeSBlbnYgc25hcHNob3QgY2FwdHVyZSBmYWlsZWQ6JywgZXJyKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcblx0XHRcdFx0XHR0aHJvdyBwaXBlbGluZUVycjtcblx0XHRcdFx0fVxuXHRcdFx0XHRcblx0XHRcdFx0Y29uc3QgcGlwZSA9IHBpcGVVbmtub3duIGFzIChpbnB1dDogc3RyaW5nLCBvcHRzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8dW5rbm93bj47XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiBXcmFwcGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xuXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0Y29uc3QgZW1iZWRTdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBTdGFydGluZyBlbWJlZGRpbmcgZ2VuZXJhdGlvbiBmb3IgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMsICR7dGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XG5cdFx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnRUaW1lO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gUmF3IG91dHB1dCByZWNlaXZlZCBpbiAke2VtYmVkRHVyYXRpb259bXNgKTtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCB0eXBlOiAke3R5cGVvZiBvdXR9YCk7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBPdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShvdXQpfWApO1xuXHRcdFx0XHRcdFx0XG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxuXHRcdFx0XHRcdFx0bGV0IHJlc3VsdDogbnVtYmVyW107XG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PEFycmF5PG51bWJlcj4+LCB1c2luZyBvdXRbMF1gKTtcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcblx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShvdXQpKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEZvcm1hdDogQXJyYXk8bnVtYmVyPiwgdXNpbmcgZGlyZWN0bHlgKTtcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0IGFzIG51bWJlcltdKTtcblx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG1heWJlID0gb3V0IGFzIHsgZGF0YT86IG51bWJlcltdIH07XG5cdFx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEZvcm1hdDogT2JqZWN0IHdpdGggZGF0YSBhcnJheSwgdXNpbmcgZGF0YWApO1xuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xuXHRcdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRcdGNvbnN0IGVyciA9IG5ldyBFcnJvcihgVW5leHBlY3RlZCBlbWJlZGRpbmdzIG91dHB1dCBmb3JtYXQ6ICR7dHlwZW9mIG91dH0sIGlzQXJyYXk6ICR7QXJyYXkuaXNBcnJheShvdXQpfWApO1xuXHRcdFx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJcgVW5leHBlY3RlZCBvdXRwdXQgZm9ybWF0YCk7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0OmAsIG91dCk7XG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJMgRW1iZWRkaW5nIGdlbmVyYXRlZCBzdWNjZXNzZnVsbHkgKCR7cmVzdWx0Lmxlbmd0aH0gZGltZW5zaW9ucylgKTtcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnRUaW1lO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycywgJHt0ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRXJyb3I6YCwgZXJyKTtcblx0XHRcdFx0XHRcdHRocm93IGVycjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiDinJMgUGlwZWxpbmUgd3JhcHBlciBjcmVhdGVkYCk7XG5cdFx0XHRcdGNvbnNvbGUuZGVidWcoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgRlVMTFkgTE9BREVEID09PWApO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xuXHRcdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0czogJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRjb25zdCBsb2FkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gbG9hZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IE1PREVMIExPQUQgRkFJTEVEID09PWApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0OiAjJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycjtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIHR5cGU6ICR7ZXJyb3JUeXBlfWApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgbWVzc2FnZTogJHtlcnJvck1zZ31gKTtcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3Igc3RhY2sgKGZpcnN0IDE1IGxpbmVzKTpgKTtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDE1KS5qb2luKCdcXG4nKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0fVxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcblx0fVxuXG5cdGFzeW5jIGlzUmVhZHkoKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5waXBlbGluZSAhPT0gbnVsbDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xuXHRcdHJldHVybiB0aGlzLmxhc3RMb2FkRXJyb3I7XG5cdH1cblxuXHRnZXRMb2FkQXR0ZW1wdHMoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XG5cdH1cblxuXHRnZXRFbnZTbmFwc2hvdCgpOiBhbnkgfCBudWxsIHtcblx0XHRyZXR1cm4gbGFzdEVudlNuYXBzaG90O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogTW9kZWxFcnJvckxvZ0VudHJ5ID0ge1xuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRsb2NhdGlvbixcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxuXHRcdFx0ZXJyb3JUeXBlXG5cdFx0fTtcblx0XHRcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFN0b3JlIGFzIGxhc3QgbG9hZCBlcnJvciBpZiBpdCdzIGEgbG9hZGluZyBlcnJvclxuXHRcdGlmIChsb2NhdGlvbiA9PT0gJ2Vuc3VyZUxvYWRlZCcgfHwgbG9jYXRpb24gPT09ICdpc1JlYWR5Jykge1xuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XG5cdFx0fVxuXHRcdFxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRjb25zdCB0ID0gKHRleHQgfHwgJycpLnRyaW0oKTtcblx0XHRpZiAoIXQpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xuXHRcdFx0cmV0dXJuIG5ldyBBcnJheTxudW1iZXI+KHRoaXMuZGltKS5maWxsKDApO1xuXHRcdH1cblx0XHR0cnkge1xuXHRcdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcblx0XHRcdGlmICghdGhpcy5waXBlbGluZSkge1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XG5cdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRjb25zb2xlLmRlYnVnKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gR2VuZXJhdGVkIGVtYmVkZGluZyBpbiAke2VtYmVkRHVyYXRpb259bXMgZm9yIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWApO1xuXHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2VtYmVkJywgYEVtYmVkZGluZyB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xuXHRcdFx0dGhyb3cgZXJyO1xuXHRcdH1cblx0fVxufVxuXG5cbiJdfQ==