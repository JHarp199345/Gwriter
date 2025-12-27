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
    // Configure WASM paths - CRITICAL: Must be done BEFORE any ONNX backend initialization
    console.log(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
    const wasmBasePath = './lib/';
    if (env) {
        // Approach 1: Try to access ONNX backend directly from the module
        // The ONNX backend is exported from transformers.js, we need to access it
        let onnxBackendEnv = null;
        let onnxBackendPath = 'none';
        // Try to find ONNX in the module exports
        if (mod?.ONNX) {
            console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX export in module`);
            const onnx = mod.ONNX;
            if (onnx?.env?.wasm) {
                onnxBackendEnv = onnx.env.wasm;
                onnxBackendPath = 'mod.ONNX.env.wasm';
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env.wasm via mod.ONNX`);
            }
            else if (onnx?.env) {
                onnxBackendEnv = onnx.env;
                onnxBackendPath = 'mod.ONNX.env';
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env via mod.ONNX`);
            }
        }
        // Approach 2: Try via env.backends.onnx (transformers.js structure)
        if (!onnxBackendEnv && env.backends?.onnx) {
            const onnxBackend = env.backends.onnx;
            console.log(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via env.backends.onnx`);
            if (onnxBackend.env?.wasm) {
                onnxBackendEnv = onnxBackend.env.wasm;
                onnxBackendPath = 'env.backends.onnx.env.wasm';
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.env.wasm`);
            }
            else if (onnxBackend.wasm) {
                onnxBackendEnv = onnxBackend.wasm;
                onnxBackendPath = 'onnxBackend.wasm';
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.wasm`);
            }
            else if (onnxBackend.env) {
                onnxBackendEnv = onnxBackend.env;
                onnxBackendPath = 'onnxBackend.env';
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found env at onnxBackend.env`);
            }
        }
        // Set wasmPaths on the ONNX backend environment
        if (onnxBackendEnv) {
            console.log(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${onnxBackendPath}`);
            try {
                if ('wasmPaths' in onnxBackendEnv) {
                    const currentPaths = onnxBackendEnv.wasmPaths;
                    console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths: ${JSON.stringify(currentPaths)}`);
                    onnxBackendEnv.wasmPaths = wasmBasePath;
                    console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Updated wasmPaths to: ${wasmBasePath}`);
                    console.log(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths: ${JSON.stringify(onnxBackendEnv.wasmPaths)}`);
                }
                else {
                    Object.defineProperty(onnxBackendEnv, 'wasmPaths', {
                        value: wasmBasePath,
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                    console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
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
                    console.log(`[LocalEmbeddingModel] [STEP 4] Created env.backends object`);
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
                console.log('[LocalEmbeddingModel] [ENV SNAPSHOT]', JSON.stringify(lastEnvSnapshot, null, 2));
            }
        }
        // Approach 3: Also try setting at top-level env (some transformers.js versions use this)
        try {
            if ('wasmPaths' in env) {
                env.wasmPaths = wasmBasePath;
                console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Also set env.wasmPaths to: ${wasmBasePath}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFDO3FCQUFNLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxJQUFJLEdBQUcsS0FBSyxJQUFJLEVBQUUsQ0FBQztvQkFDcEQsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLFdBQVcsQ0FBQyxHQUFHLEVBQUUsUUFBUSxFQUFFLFlBQVksR0FBRyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUM7Z0JBQ3JFLENBQUM7cUJBQU0sQ0FBQztvQkFDUCxNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsR0FBRyxDQUFDO2dCQUNuQixDQUFDO1lBQ0YsQ0FBQztZQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7Z0JBQ1osTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLHFCQUFxQixDQUFDLEdBQUcsQ0FBQztZQUN6QyxDQUFDO1FBQ0YsQ0FBQztJQUNGLENBQUM7SUFBQyxPQUFPLENBQUMsRUFBRSxDQUFDO1FBQ1osT0FBTyxzQkFBc0IsQ0FBQyxHQUFHLENBQUM7SUFDbkMsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDO0FBQ2YsQ0FBQztBQUVELG1GQUFtRjtBQUNuRixJQUFJLGVBQWUsR0FBZSxJQUFJLENBQUM7QUFFdkMsU0FBUyxrQkFBa0IsQ0FBQyxHQUFRLEVBQUUsR0FBUSxFQUFFLEtBQWE7SUFDNUQsSUFBSSxDQUFDO1FBQ0osTUFBTSxJQUFJLEdBQUcsR0FBRyxFQUFFLFFBQVEsRUFBRSxJQUFJLENBQUM7UUFDakMsTUFBTSxRQUFRLEdBQUcsR0FBRyxFQUFFLFFBQVEsQ0FBQztRQUMvQixlQUFlLEdBQUc7WUFDakIsS0FBSztZQUNMLFNBQVMsRUFBRSxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRTtZQUNuQyxPQUFPLEVBQUUsR0FBRyxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJO1lBQzlFLFVBQVUsRUFBRSxDQUFDLENBQUMsR0FBRyxFQUFFLE9BQU87WUFDMUIsV0FBVyxFQUFFLE9BQU8sQ0FBQyxHQUFHLEVBQUUsUUFBUSxJQUFJLEdBQUcsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLEtBQUssVUFBVTtZQUM1RSxPQUFPLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUk7WUFDbkQsY0FBYyxFQUFFLENBQUMsQ0FBQyxRQUFRO1lBQzFCLFlBQVksRUFBRSxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUk7WUFDckQsYUFBYSxFQUFFLFFBQVEsQ0FBQyxDQUFDLENBQUMsTUFBTSxJQUFJLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSztZQUNwRCxlQUFlLEVBQUUsSUFBSSxLQUFLLFNBQVM7WUFDbkMsYUFBYSxFQUFFLE9BQU8sSUFBSTtZQUMxQixRQUFRLEVBQUUsSUFBSSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUk7WUFDdEQsV0FBVyxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSTtZQUN6QixZQUFZLEVBQUUsSUFBSSxFQUFFLElBQUksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSTtZQUNyRSxhQUFhLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxTQUFTLElBQUksSUFBSTtZQUM1QyxhQUFhLEVBQUUsT0FBTyxHQUFHLEVBQUUsT0FBTyxLQUFLLFVBQVU7U0FDakQsQ0FBQztRQUNGLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0NBQXNDLEVBQUUsZUFBZSxDQUFDLENBQUM7SUFDdEUsQ0FBQztJQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7UUFDWixPQUFPLENBQUMsSUFBSSxDQUFDLHNFQUFzRSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3pGLENBQUM7QUFDRixDQUFDO0FBRUQsNkRBQTZEO0FBQzdELHlEQUF5RDtBQUN6RCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQThCO0lBQ3hELE9BQU8sQ0FBQyxHQUFHLENBQUMsc0RBQXNELENBQUMsQ0FBQztJQUNwRSxPQUFPLENBQUMsR0FBRyxDQUFDLG9DQUFvQyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxFQUFFLENBQUMsQ0FBQztJQUU1RSxpREFBaUQ7SUFDakQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvRUFBb0UsQ0FBQyxDQUFDO0lBQ2xGLElBQUksR0FBUSxDQUFDO0lBQ2IsSUFBSSxDQUFDO1FBQ0osR0FBRyxHQUFHLE1BQU0sTUFBTSxDQUFDLDJCQUEyQixDQUFDLENBQUM7UUFDaEQsT0FBTyxDQUFDLEdBQUcsQ0FBQywrREFBK0QsQ0FBQyxDQUFDO1FBQzdFLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0NBQStDLE9BQU8sR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN6RSxPQUFPLENBQUMsR0FBRyxDQUFDLGtEQUFrRCxHQUFHLEtBQUssSUFBSSxFQUFFLENBQUMsQ0FBQztRQUM5RSxPQUFPLENBQUMsR0FBRyxDQUFDLHVEQUF1RCxHQUFHLEtBQUssU0FBUyxFQUFFLENBQUMsQ0FBQztJQUN6RixDQUFDO0lBQUMsT0FBTyxTQUFTLEVBQUUsQ0FBQztRQUNwQixPQUFPLENBQUMsS0FBSyxDQUFDLHdEQUF3RCxFQUFFLFNBQVMsQ0FBQyxDQUFDO1FBQ25GLE1BQU0sSUFBSSxLQUFLLENBQUMscUNBQXFDLFNBQVMsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDNUgsQ0FBQztJQUVELHNDQUFzQztJQUN0QyxPQUFPLENBQUMsR0FBRyxDQUFDLCtEQUErRCxDQUFDLENBQUM7SUFDN0UsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3REFBd0QsRUFBRSxHQUFHLElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlJLE9BQU8sQ0FBQyxHQUFHLENBQUMsb0RBQW9ELEVBQUUsS0FBSyxJQUFJLENBQUMsR0FBRyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDeEYsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3REFBd0QsRUFBRSxTQUFTLElBQUksQ0FBQyxHQUFHLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztJQUNoRyxPQUFPLENBQUMsR0FBRyxDQUFDLHlEQUF5RCxFQUFFLFVBQVUsSUFBSSxDQUFDLEdBQUcsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ2xHLE9BQU8sQ0FBQyxHQUFHLENBQUMsOENBQThDLEVBQUUsT0FBTyxHQUFHLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDN0UsT0FBTyxDQUFDLEdBQUcsQ0FBQyxrREFBa0QsRUFBRSxPQUFPLEdBQUcsRUFBRSxPQUFPLENBQUMsQ0FBQztJQUNyRixPQUFPLENBQUMsR0FBRyxDQUFDLG1EQUFtRCxFQUFFLE9BQU8sR0FBRyxFQUFFLFFBQVEsQ0FBQyxDQUFDO0lBRXZGLDhDQUE4QztJQUM5QyxJQUFJLEdBQUcsR0FBUSxJQUFJLENBQUM7SUFDcEIsSUFBSSxTQUFTLEdBQUcsTUFBTSxDQUFDO0lBRXZCLE9BQU8sQ0FBQyxHQUFHLENBQUMsOEVBQThFLENBQUMsQ0FBQztJQUU1RixnREFBZ0Q7SUFDaEQsSUFBSSxHQUFHLEVBQUUsR0FBRyxFQUFFLENBQUM7UUFDZCxPQUFPLENBQUMsR0FBRyxDQUFDLHdEQUF3RCxDQUFDLENBQUM7UUFDdEUsR0FBRyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUM7UUFDZCxTQUFTLEdBQUcsU0FBUyxDQUFDO0lBQ3ZCLENBQUM7SUFDRCxnREFBZ0Q7U0FDM0MsSUFBSSxHQUFHLEVBQUUsT0FBTyxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQzVCLE9BQU8sQ0FBQyxHQUFHLENBQUMsZ0VBQWdFLENBQUMsQ0FBQztRQUM5RSxHQUFHLEdBQUcsR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7UUFDdEIsU0FBUyxHQUFHLGlCQUFpQixDQUFDO0lBQy9CLENBQUM7SUFFRCxrQ0FBa0M7SUFDbEMsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUNULE9BQU8sQ0FBQyxHQUFHLENBQUMsNENBQTRDLE9BQU8sR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN0RSxPQUFPLENBQUMsR0FBRyxDQUFDLHFEQUFxRCxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ2xHLE9BQU8sQ0FBQyxHQUFHLENBQUMscURBQXFELEVBQUUsVUFBVSxJQUFJLEdBQUcsQ0FBQyxDQUFDO1FBQ3RGLE9BQU8sQ0FBQyxHQUFHLENBQUMsMERBQTBELEVBQUUsR0FBRyxDQUFDLFFBQVEsRUFBRSxJQUFJLEtBQUssU0FBUyxDQUFDLENBQUM7UUFDMUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvREFBb0QsRUFBRSxPQUFPLEdBQUcsQ0FBQyxPQUFPLEtBQUssVUFBVSxDQUFDLENBQUM7UUFDckcsSUFBSSxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtREFBbUQsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO1FBQzdGLENBQUM7UUFDRCxJQUFJLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLENBQUM7WUFDeEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3REFBd0QsRUFBRSxPQUFPLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDaEcsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3REFBd0QsRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3BILENBQUM7UUFDRCwwQ0FBMEM7UUFDMUMsSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1lBQ3RCLGtCQUFrQixDQUFDLEdBQUcsRUFBRSxHQUFHLEVBQUUsb0JBQW9CLENBQUMsQ0FBQztRQUNwRCxDQUFDO0lBQ0YsQ0FBQztTQUFNLENBQUM7UUFDUCxPQUFPLENBQUMsSUFBSSxDQUFDLCtEQUErRCxDQUFDLENBQUM7UUFDOUUsT0FBTyxDQUFDLElBQUksQ0FBQyxnREFBZ0QsRUFBRSxHQUFHLEVBQUUsR0FBRyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBQ3ZGLE9BQU8sQ0FBQyxJQUFJLENBQUMsb0RBQW9ELEVBQUUsR0FBRyxFQUFFLE9BQU8sS0FBSyxTQUFTLENBQUMsQ0FBQztRQUMvRixPQUFPLENBQUMsSUFBSSxDQUFDLHdEQUF3RCxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsR0FBRyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBQ3hHLElBQUksR0FBRyxFQUFFLEdBQUcsRUFBRSxDQUFDO1lBQ2QsT0FBTyxDQUFDLEdBQUcsQ0FBQyw2REFBNkQsRUFBRSxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ3JHLENBQUM7UUFDRCxJQUFJLEdBQUcsRUFBRSxPQUFPLEVBQUUsR0FBRyxFQUFFLENBQUM7WUFDdkIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxRUFBcUUsRUFBRSxXQUFXLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNySCxDQUFDO0lBQ0YsQ0FBQztJQUVELHVGQUF1RjtJQUN2RixPQUFPLENBQUMsR0FBRyxDQUFDLHNFQUFzRSxDQUFDLENBQUM7SUFFcEYsTUFBTSxZQUFZLEdBQUcsUUFBUSxDQUFDO0lBRTlCLElBQUksR0FBRyxFQUFFLENBQUM7UUFDVCxrRUFBa0U7UUFDbEUsMEVBQTBFO1FBQzFFLElBQUksY0FBYyxHQUFRLElBQUksQ0FBQztRQUMvQixJQUFJLGVBQWUsR0FBRyxNQUFNLENBQUM7UUFFN0IseUNBQXlDO1FBQ3pDLElBQUksR0FBRyxFQUFFLElBQUksRUFBRSxDQUFDO1lBQ2YsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO1lBQzVFLE1BQU0sSUFBSSxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUM7WUFDdEIsSUFBSSxJQUFJLEVBQUUsR0FBRyxFQUFFLElBQUksRUFBRSxDQUFDO2dCQUNyQixjQUFjLEdBQUcsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7Z0JBQy9CLGVBQWUsR0FBRyxtQkFBbUIsQ0FBQztnQkFDdEMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtRUFBbUUsQ0FBQyxDQUFDO1lBQ2xGLENBQUM7aUJBQU0sSUFBSSxJQUFJLEVBQUUsR0FBRyxFQUFFLENBQUM7Z0JBQ3RCLGNBQWMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDO2dCQUMxQixlQUFlLEdBQUcsY0FBYyxDQUFDO2dCQUNqQyxPQUFPLENBQUMsR0FBRyxDQUFDLDhEQUE4RCxDQUFDLENBQUM7WUFDN0UsQ0FBQztRQUNGLENBQUM7UUFFRCxvRUFBb0U7UUFDcEUsSUFBSSxDQUFDLGNBQWMsSUFBSSxHQUFHLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDO1lBQzNDLE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDO1lBQ3RDLE9BQU8sQ0FBQyxHQUFHLENBQUMsMkVBQTJFLENBQUMsQ0FBQztZQUV6RixJQUFJLFdBQVcsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLENBQUM7Z0JBQzNCLGNBQWMsR0FBRyxXQUFXLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztnQkFDdEMsZUFBZSxHQUFHLDRCQUE0QixDQUFDO2dCQUMvQyxPQUFPLENBQUMsR0FBRyxDQUFDLHlFQUF5RSxDQUFDLENBQUM7WUFDeEYsQ0FBQztpQkFBTSxJQUFJLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDN0IsY0FBYyxHQUFHLFdBQVcsQ0FBQyxJQUFJLENBQUM7Z0JBQ2xDLGVBQWUsR0FBRyxrQkFBa0IsQ0FBQztnQkFDckMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxRUFBcUUsQ0FBQyxDQUFDO1lBQ3BGLENBQUM7aUJBQU0sSUFBSSxXQUFXLENBQUMsR0FBRyxFQUFFLENBQUM7Z0JBQzVCLGNBQWMsR0FBRyxXQUFXLENBQUMsR0FBRyxDQUFDO2dCQUNqQyxlQUFlLEdBQUcsaUJBQWlCLENBQUM7Z0JBQ3BDLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0RBQStELENBQUMsQ0FBQztZQUM5RSxDQUFDO1FBQ0YsQ0FBQztRQUVELGdEQUFnRDtRQUNoRCxJQUFJLGNBQWMsRUFBRSxDQUFDO1lBQ3BCLE9BQU8sQ0FBQyxHQUFHLENBQUMsNkRBQTZELGVBQWUsRUFBRSxDQUFDLENBQUM7WUFDNUYsSUFBSSxDQUFDO2dCQUNKLElBQUksV0FBVyxJQUFJLGNBQWMsRUFBRSxDQUFDO29CQUNuQyxNQUFNLFlBQVksR0FBRyxjQUFjLENBQUMsU0FBUyxDQUFDO29CQUM5QyxPQUFPLENBQUMsR0FBRyxDQUFDLHFEQUFxRCxJQUFJLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxFQUFFLENBQUMsQ0FBQztvQkFDakcsY0FBYyxDQUFDLFNBQVMsR0FBRyxZQUFZLENBQUM7b0JBQ3hDLE9BQU8sQ0FBQyxHQUFHLENBQUMsMERBQTBELFlBQVksRUFBRSxDQUFDLENBQUM7b0JBQ3RGLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0RBQXNELElBQUksQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDL0csQ0FBQztxQkFBTSxDQUFDO29CQUNQLE1BQU0sQ0FBQyxjQUFjLENBQUMsY0FBYyxFQUFFLFdBQVcsRUFBRTt3QkFDbEQsS0FBSyxFQUFFLFlBQVk7d0JBQ25CLFFBQVEsRUFBRSxJQUFJO3dCQUNkLFVBQVUsRUFBRSxJQUFJO3dCQUNoQixZQUFZLEVBQUUsSUFBSTtxQkFDbEIsQ0FBQyxDQUFDO29CQUNILE9BQU8sQ0FBQyxHQUFHLENBQUMsa0VBQWtFLFlBQVksRUFBRSxDQUFDLENBQUM7Z0JBQy9GLENBQUM7WUFDRixDQUFDO1lBQUMsT0FBTyxPQUFPLEVBQUUsQ0FBQztnQkFDbEIsT0FBTyxDQUFDLElBQUksQ0FBQyw2REFBNkQsZUFBZSxHQUFHLEVBQUUsT0FBTyxDQUFDLENBQUM7WUFDeEcsQ0FBQztRQUNGLENBQUM7YUFBTSxDQUFDO1lBQ1AsK0RBQStEO1lBQy9ELE9BQU8sQ0FBQyxJQUFJLENBQUMsd0ZBQXdGLENBQUMsQ0FBQztZQUN2RyxPQUFPLENBQUMsSUFBSSxDQUFDLDhGQUE4RixDQUFDLENBQUM7WUFFN0cseURBQXlEO1lBQ3pELElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLENBQUM7Z0JBQ25CLElBQUksQ0FBQztvQkFDSixHQUFHLENBQUMsUUFBUSxHQUFHLEVBQUUsQ0FBQztvQkFDbEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw0REFBNEQsQ0FBQyxDQUFDO2dCQUMzRSxDQUFDO2dCQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQ1osT0FBTyxDQUFDLElBQUksQ0FBQywrREFBK0QsRUFBRSxDQUFDLENBQUMsQ0FBQztnQkFDbEYsQ0FBQztZQUNGLENBQUM7WUFFRCxzREFBc0Q7WUFDdEQsSUFBSSxHQUFHLENBQUMsUUFBUSxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDeEMsT0FBTyxDQUFDLElBQUksQ0FBQywrR0FBK0csQ0FBQyxDQUFDO2dCQUM5SCxPQUFPLENBQUMsSUFBSSxDQUFDLG9GQUFvRixDQUFDLENBQUM7WUFDcEcsQ0FBQztZQUVELDBDQUEwQztZQUMxQyxrQkFBa0IsQ0FBQyxHQUFHLEVBQUUsR0FBRyxFQUFFLHFCQUFxQixDQUFDLENBQUM7WUFDcEQsSUFBSSxlQUFlLEVBQUUsQ0FBQztnQkFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzQ0FBc0MsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLGVBQWUsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUMvRixDQUFDO1FBQ0YsQ0FBQztRQUVELHlGQUF5RjtRQUN6RixJQUFJLENBQUM7WUFDSixJQUFJLFdBQVcsSUFBSSxHQUFHLEVBQUUsQ0FBQztnQkFDeEIsR0FBRyxDQUFDLFNBQVMsR0FBRyxZQUFZLENBQUM7Z0JBQzdCLE9BQU8sQ0FBQyxHQUFHLENBQUMsK0RBQStELFlBQVksRUFBRSxDQUFDLENBQUM7WUFDNUYsQ0FBQztRQUNGLENBQUM7UUFBQyxPQUFPLFVBQVUsRUFBRSxDQUFDO1lBQ3JCLE9BQU8sQ0FBQyxJQUFJLENBQUMsdUVBQXVFLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDbkcsQ0FBQztJQUNGLENBQUM7U0FBTSxDQUFDO1FBQ1AsT0FBTyxDQUFDLElBQUksQ0FBQyw4RUFBOEUsQ0FBQyxDQUFDO0lBQzlGLENBQUM7SUFFRCx3QkFBd0I7SUFDeEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO0lBQzVFLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxRQUFRLElBQUksR0FBRyxDQUFDLE9BQU8sRUFBRSxRQUFRLENBQUM7SUFDdkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnREFBZ0QsRUFBRSxRQUFRLEtBQUssU0FBUyxJQUFJLFFBQVEsS0FBSyxJQUFJLENBQUMsQ0FBQztJQUMzRyxPQUFPLENBQUMsR0FBRyxDQUFDLCtDQUErQyxFQUFFLE9BQU8sUUFBUSxDQUFDLENBQUM7SUFDOUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzREFBc0QsRUFBRSxPQUFPLFFBQVEsS0FBSyxVQUFVLENBQUMsQ0FBQztJQUVwRyxJQUFJLENBQUMsUUFBUSxJQUFJLE9BQU8sUUFBUSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ2pELE9BQU8sQ0FBQyxLQUFLLENBQUMsdUVBQXVFLENBQUMsQ0FBQztRQUN2RixPQUFPLENBQUMsS0FBSyxDQUFDLDhDQUE4QyxFQUFFLEdBQUcsRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM3RSxPQUFPLENBQUMsS0FBSyxDQUFDLHNEQUFzRCxFQUFFLEdBQUcsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDOUYsTUFBTSxJQUFJLEtBQUssQ0FBQywyQ0FBMkMsQ0FBQyxDQUFDO0lBQzlELENBQUM7SUFFRCxPQUFPLENBQUMsR0FBRyxDQUFDLDBEQUEwRCxDQUFDLENBQUM7SUFDeEUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzREFBc0QsQ0FBQyxDQUFDO0lBQ3BFLE9BQU8sUUFBUSxDQUFDO0FBQ2pCLENBQUM7QUFRRCxTQUFTLFdBQVcsQ0FBQyxHQUFhO0lBQ2pDLElBQUksS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNkLEtBQUssTUFBTSxDQUFDLElBQUksR0FBRztRQUFFLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3BDLE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ25DLE9BQU8sR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQ2pDLENBQUM7QUFlRCxNQUFNLE9BQU8seUJBQXlCO0lBYXJDLFlBQVksS0FBWSxFQUFFLE1BQThCO1FBWi9DLE9BQUUsR0FBRyxRQUFRLENBQUM7UUFDZCxRQUFHLEdBQUcsR0FBRyxDQUFDO1FBSVgsYUFBUSxHQUFpRCxJQUFJLENBQUM7UUFDOUQsWUFBTyxHQUF5QixJQUFJLENBQUM7UUFDckMsaUJBQVksR0FBRyxDQUFDLENBQUM7UUFDakIsa0JBQWEsR0FBOEIsSUFBSSxDQUFDO1FBQ3ZDLGFBQVEsR0FBeUIsRUFBRSxDQUFDO1FBQ3BDLG9CQUFlLEdBQUcsRUFBRSxDQUFDO1FBR3JDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFTyxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNuQixPQUFPLENBQUMsR0FBRyxDQUFDLDJEQUEyRCxJQUFJLENBQUMsWUFBWSxHQUFHLENBQUMsQ0FBQztZQUM3RixPQUFPO1FBQ1IsQ0FBQztRQUNELElBQUksSUFBSSxDQUFDLE9BQU8sS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUMzQixPQUFPLENBQUMsR0FBRyxDQUFDLGdFQUFnRSxJQUFJLENBQUMsWUFBWSxlQUFlLENBQUMsQ0FBQztZQUM5RyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUM7UUFDckIsQ0FBQztRQUVELE9BQU8sQ0FBQyxHQUFHLENBQUMsbURBQW1ELENBQUMsQ0FBQztRQUNqRSxPQUFPLENBQUMsR0FBRyxDQUFDLHVDQUF1QyxJQUFJLENBQUMsWUFBWSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDNUUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxvQ0FBb0MsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDNUUsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQ3BCLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUM3QixJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsSUFBSSxDQUFDO2dCQUNKLHVFQUF1RTtnQkFDdkUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtRUFBbUUsQ0FBQyxDQUFDO2dCQUNqRixJQUFJLFFBQWEsQ0FBQztnQkFDbEIsSUFBSSxDQUFDO29CQUNKLFFBQVEsR0FBRyxNQUFNLFdBQVcsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7b0JBQzFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQzt3QkFDZixNQUFNLElBQUksS0FBSyxDQUFDLCtCQUErQixDQUFDLENBQUM7b0JBQ2xELENBQUM7b0JBQ0QsSUFBSSxPQUFPLFFBQVEsS0FBSyxVQUFVLEVBQUUsQ0FBQzt3QkFDcEMsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQ0FBb0MsT0FBTyxRQUFRLEVBQUUsQ0FBQyxDQUFDO29CQUN4RSxDQUFDO29CQUNELE9BQU8sQ0FBQyxHQUFHLENBQUMsMEVBQTBFLE9BQU8sUUFBUSxXQUFXLFFBQVEsQ0FBQyxJQUFJLElBQUksV0FBVyxHQUFHLENBQUMsQ0FBQztnQkFDbEosQ0FBQztnQkFBQyxPQUFPLFNBQVMsRUFBRSxDQUFDO29CQUNwQixPQUFPLENBQUMsS0FBSyxDQUFDLHdFQUF3RSxDQUFDLENBQUM7b0JBQ3hGLElBQUksQ0FBQyxRQUFRLENBQUMscUJBQXFCLEVBQUUsd0NBQXdDLEVBQUUsU0FBUyxDQUFDLENBQUM7b0JBQzFGLE1BQU0sSUFBSSxLQUFLLENBQUMseUNBQXlDLFNBQVMsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ2hJLENBQUM7Z0JBRUQsdUVBQXVFO2dCQUN2RSxvRUFBb0U7Z0JBQ3BFLE1BQU0sUUFBUSxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLFlBQVksSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsRUFBRSxtQkFBbUIsQ0FBQztnQkFDL0YsT0FBTyxDQUFDLEdBQUcsQ0FBQywrREFBK0QsQ0FBQyxDQUFDO2dCQUM3RSxPQUFPLENBQUMsR0FBRyxDQUFDLHlEQUF5RCxRQUFRLEVBQUUsQ0FBQyxDQUFDO2dCQUNqRixPQUFPLENBQUMsR0FBRyxDQUFDLHFFQUFxRSxDQUFDLENBQUM7Z0JBQ25GLE9BQU8sQ0FBQyxHQUFHLENBQUMsc0RBQXNELENBQUMsQ0FBQztnQkFDcEUsT0FBTyxDQUFDLEdBQUcsQ0FBQyxzRkFBc0YsQ0FBQyxDQUFDO2dCQUVwRyxJQUFJLFdBQW9CLENBQUM7Z0JBQ3pCLElBQUksQ0FBQztvQkFDSixNQUFNLGlCQUFpQixHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztvQkFDckMsdUNBQXVDO29CQUN2QyxXQUFXLEdBQUcsTUFBTSxRQUFRLENBQUMsb0JBQW9CLEVBQUUseUJBQXlCLEVBQUU7d0JBQzdFLFNBQVMsRUFBRSxJQUFJO3dCQUNmLGlCQUFpQixFQUFFLFNBQVM7d0JBQzVCLFNBQVMsRUFBRSxRQUFRO3FCQUNuQixDQUFDLENBQUM7b0JBQ0gsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsaUJBQWlCLENBQUM7b0JBQ3hELE9BQU8sQ0FBQyxHQUFHLENBQUMsOERBQThELGdCQUFnQixJQUFJLENBQUMsQ0FBQztvQkFDaEcsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4REFBOEQsT0FBTyxXQUFXLEVBQUUsQ0FBQyxDQUFDO29CQUNoRyxPQUFPLENBQUMsR0FBRyxDQUFDLGtFQUFrRSxLQUFLLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxFQUFFLENBQUMsQ0FBQztnQkFDN0csQ0FBQztnQkFBQyxPQUFPLFdBQVcsRUFBRSxDQUFDO29CQUN0QixPQUFPLENBQUMsS0FBSyxDQUFDLGlFQUFpRSxDQUFDLENBQUM7b0JBQ2pGLE9BQU8sQ0FBQyxLQUFLLENBQUMsb0RBQW9ELFdBQVcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLFdBQVcsRUFBRSxDQUFDLENBQUM7b0JBQ3RKLE9BQU8sQ0FBQyxLQUFLLENBQUMsdURBQXVELFdBQVcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLENBQUM7b0JBQ2pKLElBQUksV0FBVyxZQUFZLEtBQUssSUFBSSxXQUFXLENBQUMsS0FBSyxFQUFFLENBQUM7d0JBQ3ZELE9BQU8sQ0FBQyxLQUFLLENBQUMsb0VBQW9FLENBQUMsQ0FBQzt3QkFDcEYsT0FBTyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO29CQUN0RSxDQUFDO29CQUNELDREQUE0RDtvQkFDNUQsSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO3dCQUN0QixJQUFJLENBQUM7NEJBQ0osTUFBTSxVQUFVLEdBQUcsTUFBTSxNQUFNLENBQUMsMkJBQTJCLENBQUMsQ0FBQzs0QkFDN0QsTUFBTSxVQUFVLEdBQUcsVUFBVSxDQUFDLEdBQUcsSUFBSSxVQUFVLENBQUMsT0FBTyxFQUFFLEdBQUcsQ0FBQzs0QkFDN0QsSUFBSSxVQUFVLEVBQUUsQ0FBQztnQ0FDaEIsa0JBQWtCLENBQUMsVUFBVSxFQUFFLFVBQVUsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDOzRCQUNqRSxDQUFDO3dCQUNGLENBQUM7d0JBQUMsTUFBTSxDQUFDOzRCQUNSLDRCQUE0Qjt3QkFDN0IsQ0FBQztvQkFDRixDQUFDO29CQUNELElBQUksQ0FBQyxRQUFRLENBQUMsNkJBQTZCLEVBQUUsZ0VBQWdFLFFBQVEsRUFBRSxFQUFFLFdBQVcsQ0FBQyxDQUFDO29CQUN0SSxNQUFNLFdBQVcsQ0FBQztnQkFDbkIsQ0FBQztnQkFFRCxNQUFNLElBQUksR0FBRyxXQUFrRixDQUFDO2dCQUNoRyxPQUFPLENBQUMsR0FBRyxDQUFDLG9FQUFvRSxDQUFDLENBQUM7Z0JBRWxGLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxFQUFFLElBQVksRUFBRSxFQUFFO29CQUN0QyxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7b0JBQ2xDLElBQUksQ0FBQzt3QkFDSixPQUFPLENBQUMsR0FBRyxDQUFDLHlFQUF5RSxJQUFJLENBQUMsTUFBTSxXQUFXLElBQUksQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxZQUFZLENBQUMsQ0FBQzt3QkFDakosTUFBTSxHQUFHLEdBQUcsTUFBTSxJQUFJLENBQUMsSUFBSSxFQUFFLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQzt3QkFDbkUsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLGNBQWMsQ0FBQzt3QkFDbEQsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3REFBd0QsYUFBYSxJQUFJLENBQUMsQ0FBQzt3QkFDdkYsT0FBTyxDQUFDLEdBQUcsQ0FBQyw4Q0FBOEMsT0FBTyxHQUFHLEVBQUUsQ0FBQyxDQUFDO3dCQUN4RSxPQUFPLENBQUMsR0FBRyxDQUFDLGtEQUFrRCxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQzt3QkFFcEYscURBQXFEO3dCQUNyRCxJQUFJLE1BQWdCLENBQUM7d0JBQ3JCLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7NEJBQ2pELE9BQU8sQ0FBQyxHQUFHLENBQUMsMEVBQTBFLENBQUMsQ0FBQzs0QkFDeEYsTUFBTSxHQUFHLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFhLENBQUMsQ0FBQzt3QkFDMUMsQ0FBQzs2QkFBTSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQzs0QkFDL0IsT0FBTyxDQUFDLEdBQUcsQ0FBQyxxRUFBcUUsQ0FBQyxDQUFDOzRCQUNuRixNQUFNLEdBQUcsV0FBVyxDQUFDLEdBQWUsQ0FBQyxDQUFDO3dCQUN2QyxDQUFDOzZCQUFNLENBQUM7NEJBQ1AsTUFBTSxLQUFLLEdBQUcsR0FBMEIsQ0FBQzs0QkFDekMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsRUFBRSxDQUFDO2dDQUNoQyxPQUFPLENBQUMsR0FBRyxDQUFDLDBFQUEwRSxDQUFDLENBQUM7Z0NBQ3hGLE1BQU0sR0FBRyxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDOzRCQUNsQyxDQUFDO2lDQUFNLENBQUM7Z0NBQ1AsTUFBTSxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsd0NBQXdDLE9BQU8sR0FBRyxjQUFjLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dDQUM1RyxJQUFJLENBQUMsUUFBUSxDQUFDLGdCQUFnQixFQUFFLG9CQUFvQixJQUFJLENBQUMsTUFBTSxTQUFTLEVBQUUsR0FBRyxDQUFDLENBQUM7Z0NBQy9FLE9BQU8sQ0FBQyxLQUFLLENBQUMsMERBQTBELENBQUMsQ0FBQztnQ0FDMUUsT0FBTyxDQUFDLEtBQUssQ0FBQyx1Q0FBdUMsRUFBRSxHQUFHLENBQUMsQ0FBQztnQ0FDNUQsTUFBTSxHQUFHLENBQUM7NEJBQ1gsQ0FBQzt3QkFDRixDQUFDO3dCQUNELE9BQU8sQ0FBQyxHQUFHLENBQUMscUVBQXFFLE1BQU0sQ0FBQyxNQUFNLGNBQWMsQ0FBQyxDQUFDO3dCQUM5RyxPQUFPLE1BQU0sQ0FBQztvQkFDZixDQUFDO29CQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7d0JBQ2QsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLGNBQWMsQ0FBQzt3QkFDbEQsT0FBTyxDQUFDLEtBQUssQ0FBQyxxRUFBcUUsYUFBYSxJQUFJLENBQUMsQ0FBQzt3QkFDdEcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxnQkFBZ0IsRUFBRSxrQ0FBa0MsSUFBSSxDQUFDLE1BQU0sV0FBVyxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDO3dCQUNoSSxPQUFPLENBQUMsS0FBSyxDQUFDLHNDQUFzQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO3dCQUMzRCxNQUFNLEdBQUcsQ0FBQztvQkFDWCxDQUFDO2dCQUNGLENBQUMsQ0FBQztnQkFDRixNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsU0FBUyxDQUFDO2dCQUM1QyxPQUFPLENBQUMsR0FBRyxDQUFDLGlFQUFpRSxDQUFDLENBQUM7Z0JBQy9FLE9BQU8sQ0FBQyxHQUFHLENBQUMsa0RBQWtELENBQUMsQ0FBQztnQkFDaEUsT0FBTyxDQUFDLEdBQUcsQ0FBQywwQ0FBMEMsWUFBWSxJQUFJLENBQUMsQ0FBQztnQkFDeEUsT0FBTyxDQUFDLEdBQUcsQ0FBQyx3Q0FBd0MsSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUM7WUFDMUUsQ0FBQztZQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7Z0JBQ2QsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFNBQVMsQ0FBQztnQkFDNUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO2dCQUNqRSxPQUFPLENBQUMsS0FBSyxDQUFDLDBDQUEwQyxZQUFZLElBQUksQ0FBQyxDQUFDO2dCQUMxRSxPQUFPLENBQUMsS0FBSyxDQUFDLHdDQUF3QyxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUMsQ0FBQztnQkFDM0UsSUFBSSxDQUFDLFFBQVEsQ0FBQyxjQUFjLEVBQUUsMEJBQTBCLElBQUksQ0FBQyxZQUFZLEVBQUUsRUFBRSxHQUFHLENBQUMsQ0FBQztnQkFDbEYsTUFBTSxRQUFRLEdBQUcsR0FBRyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNsRSxNQUFNLFVBQVUsR0FBRyxHQUFHLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7Z0JBQ2hFLE1BQU0sU0FBUyxHQUFHLEdBQUcsWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLEdBQUcsQ0FBQztnQkFDM0UsT0FBTyxDQUFDLEtBQUssQ0FBQyxxQ0FBcUMsU0FBUyxFQUFFLENBQUMsQ0FBQztnQkFDaEUsT0FBTyxDQUFDLEtBQUssQ0FBQyx3Q0FBd0MsUUFBUSxFQUFFLENBQUMsQ0FBQztnQkFDbEUsSUFBSSxVQUFVLEVBQUUsQ0FBQztvQkFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO29CQUNyRSxPQUFPLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztnQkFDL0QsQ0FBQztnQkFDRCxNQUFNLEdBQUcsQ0FBQztZQUNYLENBQUM7UUFDRixDQUFDLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUU7WUFDakIsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUM7UUFDckIsQ0FBQyxDQUFDLENBQUM7UUFFSCxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDckIsQ0FBQztJQUVELEtBQUssQ0FBQyxPQUFPO1FBQ1osSUFBSSxDQUFDO1lBQ0osTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDMUIsT0FBTyxJQUFJLENBQUMsUUFBUSxLQUFLLElBQUksQ0FBQztRQUMvQixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxRQUFRLENBQUMsU0FBUyxFQUFFLDBCQUEwQixFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQzFELE9BQU8sS0FBSyxDQUFDO1FBQ2QsQ0FBQztJQUNGLENBQUM7SUFFRCxlQUFlLENBQUMsUUFBZ0IsRUFBRTtRQUNqQyxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDcEMsQ0FBQztJQUVELGdCQUFnQjtRQUNmLE9BQU8sSUFBSSxDQUFDLGFBQWEsQ0FBQztJQUMzQixDQUFDO0lBRUQsZUFBZTtRQUNkLE9BQU8sSUFBSSxDQUFDLFlBQVksQ0FBQztJQUMxQixDQUFDO0lBRUQsY0FBYztRQUNiLE9BQU8sZUFBZSxDQUFDO0lBQ3hCLENBQUM7SUFFTyxRQUFRLENBQUMsUUFBZ0IsRUFBRSxPQUFlLEVBQUUsS0FBYztRQUNqRSxNQUFNLFFBQVEsR0FBRyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDeEUsTUFBTSxVQUFVLEdBQUcsS0FBSyxZQUFZLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQ3BFLE1BQU0sU0FBUyxHQUFHLEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLEtBQUssQ0FBQztRQUVqRixNQUFNLEtBQUssR0FBdUI7WUFDakMsU0FBUyxFQUFFLElBQUksSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFO1lBQ25DLFFBQVE7WUFDUixPQUFPO1lBQ1AsT0FBTyxFQUFFLFFBQVE7WUFDakIsS0FBSyxFQUFFLFVBQVU7WUFDakIsU0FBUztTQUNULENBQUM7UUFFRixJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUMxQixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztZQUNqRCxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3ZCLENBQUM7UUFFRCxtREFBbUQ7UUFDbkQsSUFBSSxRQUFRLEtBQUssY0FBYyxJQUFJLFFBQVEsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUMzRCxJQUFJLENBQUMsYUFBYSxHQUFHLEtBQUssQ0FBQztRQUM1QixDQUFDO1FBRUQsT0FBTyxDQUFDLEtBQUssQ0FBQyxnQ0FBZ0MsUUFBUSxLQUFLLE9BQU8sR0FBRyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBQ2pGLElBQUksVUFBVSxFQUFFLENBQUM7WUFDaEIsT0FBTyxDQUFDLEtBQUssQ0FBQyw4QkFBOEIsRUFBRSxVQUFVLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDOUYsQ0FBQztJQUNGLENBQUM7SUFFRCxLQUFLLENBQUMsS0FBSyxDQUFDLElBQVk7UUFDdkIsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDOUIsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ1IsT0FBTyxDQUFDLElBQUksQ0FBQyxrRUFBa0UsQ0FBQyxDQUFDO1lBQ2pGLE9BQU8sSUFBSSxLQUFLLENBQVMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM1QyxDQUFDO1FBQ0QsSUFBSSxDQUFDO1lBQ0osTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7WUFDMUIsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDcEIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1lBQzFFLENBQUM7WUFDRCxNQUFNLFVBQVUsR0FBRyxJQUFJLENBQUMsR0FBRyxFQUFFLENBQUM7WUFDOUIsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsR0FBRyxVQUFVLENBQUM7WUFDOUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxnREFBZ0QsYUFBYSxnQkFBZ0IsQ0FBQyxDQUFDLE1BQU0sV0FBVyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUM7WUFDNUksT0FBTyxNQUFNLENBQUM7UUFDZixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLG1CQUFtQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbi8vIEhlbHBlciBmdW5jdGlvbiB0byBzYWZlbHkgaW5zcGVjdCBvYmplY3Qgc3RydWN0dXJlIHdpdGhvdXQgY2F1c2luZyBlcnJvcnNcclxuZnVuY3Rpb24gZGVlcEluc3BlY3Qob2JqOiBhbnksIG1heERlcHRoOiBudW1iZXIgPSAzLCBjdXJyZW50RGVwdGg6IG51bWJlciA9IDAsIHZpc2l0ZWQ6IFdlYWtTZXQ8YW55PiA9IG5ldyBXZWFrU2V0KCkpOiBhbnkge1xyXG5cdGlmIChjdXJyZW50RGVwdGggPj0gbWF4RGVwdGggfHwgb2JqID09PSBudWxsIHx8IG9iaiA9PT0gdW5kZWZpbmVkKSB7XHJcblx0XHRyZXR1cm4gdHlwZW9mIG9iajtcclxuXHR9XHJcblx0aWYgKHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSB7XHJcblx0XHRyZXR1cm4gb2JqO1xyXG5cdH1cclxuXHRpZiAodmlzaXRlZC5oYXMob2JqKSkge1xyXG5cdFx0cmV0dXJuICdbQ2lyY3VsYXJdJztcclxuXHR9XHJcblx0dmlzaXRlZC5hZGQob2JqKTtcclxuXHRcclxuXHRjb25zdCByZXN1bHQ6IGFueSA9IHt9O1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBrZXlzID0gT2JqZWN0LmtleXMob2JqKS5zbGljZSgwLCAyMCk7IC8vIExpbWl0IGtleXMgdG8gYXZvaWQgaHVnZSBvdXRwdXRcclxuXHRcdGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcclxuXHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRjb25zdCB2YWwgPSBvYmpba2V5XTtcclxuXHRcdFx0XHRpZiAodHlwZW9mIHZhbCA9PT0gJ2Z1bmN0aW9uJykge1xyXG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBgW0Z1bmN0aW9uOiAke3ZhbC5uYW1lIHx8ICdhbm9ueW1vdXMnfV1gO1xyXG5cdFx0XHRcdH0gZWxzZSBpZiAodHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgJiYgdmFsICE9PSBudWxsKSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IGRlZXBJbnNwZWN0KHZhbCwgbWF4RGVwdGgsIGN1cnJlbnREZXB0aCArIDEsIHZpc2l0ZWQpO1xyXG5cdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IHZhbDtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH0gY2F0Y2ggKGUpIHtcclxuXHRcdFx0XHRyZXN1bHRba2V5XSA9IGBbRXJyb3IgYWNjZXNzaW5nOiAke2V9XWA7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHR9IGNhdGNoIChlKSB7XHJcblx0XHRyZXR1cm4gYFtFcnJvciBpbnNwZWN0aW5nOiAke2V9XWA7XHJcblx0fVxyXG5cdHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8vIENhcHR1cmUgYSBvbmUtdGltZSBzbmFwc2hvdCBvZiB0aGUgdHJhbnNmb3JtZXJzIGVudiAvIE9OTlggc3RhdGUgZm9yIGRpYWdub3N0aWNzXHJcbmxldCBsYXN0RW52U25hcHNob3Q6IGFueSB8IG51bGwgPSBudWxsO1xyXG5cclxuZnVuY3Rpb24gY2FwdHVyZUVudlNuYXBzaG90KG1vZDogYW55LCBlbnY6IGFueSwgd2hlcmU6IHN0cmluZyk6IHZvaWQge1xyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBvbm54ID0gZW52Py5iYWNrZW5kcz8ub25ueDtcclxuXHRcdGNvbnN0IGJhY2tlbmRzID0gZW52Py5iYWNrZW5kcztcclxuXHRcdGxhc3RFbnZTbmFwc2hvdCA9IHtcclxuXHRcdFx0d2hlcmUsXHJcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxyXG5cdFx0XHRtb2RLZXlzOiBtb2QgJiYgdHlwZW9mIG1vZCA9PT0gJ29iamVjdCcgPyBPYmplY3Qua2V5cyhtb2QpLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdGhhc0RlZmF1bHQ6ICEhbW9kPy5kZWZhdWx0LFxyXG5cdFx0XHRoYXNQaXBlbGluZTogdHlwZW9mIChtb2Q/LnBpcGVsaW5lIHx8IG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpID09PSAnZnVuY3Rpb24nLFxyXG5cdFx0XHRlbnZLZXlzOiBlbnYgPyBPYmplY3Qua2V5cyhlbnYpLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdGVudkhhc0JhY2tlbmRzOiAhIWJhY2tlbmRzLFxyXG5cdFx0XHRiYWNrZW5kc0tleXM6IGJhY2tlbmRzID8gT2JqZWN0LmtleXMoYmFja2VuZHMpIDogbnVsbCxcclxuXHRcdFx0b25ueEtleUV4aXN0czogYmFja2VuZHMgPyAnb25ueCcgaW4gYmFja2VuZHMgOiBmYWxzZSxcclxuXHRcdFx0b25ueFZhbHVlRXhpc3RzOiBvbm54ICE9PSB1bmRlZmluZWQsXHJcblx0XHRcdG9ubnhWYWx1ZVR5cGU6IHR5cGVvZiBvbm54LFxyXG5cdFx0XHRvbm54S2V5czogb25ueCA/IE9iamVjdC5rZXlzKG9ubngpLnNsaWNlKDAsIDIwKSA6IG51bGwsXHJcblx0XHRcdG9ubnhIYXNXYXNtOiAhIW9ubng/Lndhc20sXHJcblx0XHRcdG9ubnhXYXNtS2V5czogb25ueD8ud2FzbSA/IE9iamVjdC5rZXlzKG9ubngud2FzbSkuc2xpY2UoMCwgMjApIDogbnVsbCxcclxuXHRcdFx0b25ueFdhc21QYXRoczogb25ueD8ud2FzbT8ud2FzbVBhdGhzID8/IG51bGwsXHJcblx0XHRcdGVudkhhc1VzZVdhc206IHR5cGVvZiBlbnY/LnVzZVdhc20gPT09ICdmdW5jdGlvbicsXHJcblx0XHR9O1xyXG5cdFx0Y29uc29sZS5sb2coJ1tMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU5WIFNOQVBTSE9UXScsIGxhc3RFbnZTbmFwc2hvdCk7XHJcblx0fSBjYXRjaCAoZSkge1xyXG5cdFx0Y29uc29sZS53YXJuKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0gRmFpbGVkIHRvIGNhcHR1cmUgZW52IHNuYXBzaG90OicsIGUpO1xyXG5cdH1cclxufVxyXG5cclxuLy8gSGVscGVyIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbiB3aXRoIHByb3BlciBlcnJvciBoYW5kbGluZ1xyXG4vLyBVc2VzIHZlbmRvcmVkIHRyYW5zZm9ybWVycy5qcyB0byBhdm9pZCBidW5kbGluZyBpc3N1ZXNcclxuYXN5bmMgZnVuY3Rpb24gZ2V0UGlwZWxpbmUocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogUHJvbWlzZTxhbnk+IHtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBTVEFSVElORyBQSVBFTElORSBMT0FEID09PWApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVGltZXN0YW1wOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcclxuXHRcclxuXHQvLyBJbXBvcnQgdGhlIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBsaWJyYXJ5IGZpcnN0XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBJbXBvcnRpbmcgdHJhbnNmb3JtZXJzLmpzIG1vZHVsZS4uLmApO1xyXG5cdGxldCBtb2Q6IGFueTtcclxuXHR0cnkge1xyXG5cdFx0bW9kID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKckyBNb2R1bGUgaW1wb3J0ZWQgc3VjY2Vzc2Z1bGx5YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSB0eXBlOiAke3R5cGVvZiBtb2R9YCk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIE1vZHVsZSBpcyBudWxsOiAke21vZCA9PT0gbnVsbH1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIHVuZGVmaW5lZDogJHttb2QgPT09IHVuZGVmaW5lZH1gKTtcclxuXHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSDinJcgTW9kdWxlIGltcG9ydCBmYWlsZWQ6YCwgaW1wb3J0RXJyKTtcclxuXHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGltcG9ydCB0cmFuc2Zvcm1lcnMuanM6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xyXG5cdH1cclxuXHRcclxuXHQvLyBEZWVwIGluc3BlY3Rpb24gb2YgbW9kdWxlIHN0cnVjdHVyZVxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSW5zcGVjdGluZyBtb2R1bGUgc3RydWN0dXJlLi4uYCk7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBNb2R1bGUga2V5cyAoZmlyc3QgMzApOmAsIG1vZCAmJiB0eXBlb2YgbW9kID09PSAnb2JqZWN0JyA/IE9iamVjdC5rZXlzKG1vZCkuc2xpY2UoMCwgMzApIDogJ04vQScpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdlbnYnIHByb3BlcnR5OmAsICdlbnYnIGluIChtb2QgfHwge30pKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAnZGVmYXVsdCcgcHJvcGVydHk6YCwgJ2RlZmF1bHQnIGluIChtb2QgfHwge30pKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEhhcyAncGlwZWxpbmUnIHByb3BlcnR5OmAsICdwaXBlbGluZScgaW4gKG1vZCB8fCB7fSkpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmVudiB0eXBlOmAsIHR5cGVvZiBtb2Q/LmVudik7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QuZGVmYXVsdCB0eXBlOmAsIHR5cGVvZiBtb2Q/LmRlZmF1bHQpO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLnBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIG1vZD8ucGlwZWxpbmUpO1xyXG5cdFxyXG5cdC8vIFRyeSBtdWx0aXBsZSB3YXlzIHRvIGFjY2VzcyB0aGUgZW52aXJvbm1lbnRcclxuXHRsZXQgZW52OiBhbnkgPSBudWxsO1xyXG5cdGxldCBlbnZTb3VyY2UgPSAnbm9uZSc7XHJcblx0XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBBdHRlbXB0aW5nIHRvIGxvY2F0ZSBlbnZpcm9ubWVudCBzdHJ1Y3R1cmUuLi5gKTtcclxuXHRcclxuXHQvLyBNZXRob2QgMTogRGlyZWN0IG1vZC5lbnYgKHN0YW5kYXJkIHN0cnVjdHVyZSlcclxuXHRpZiAobW9kPy5lbnYpIHtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyTIEZvdW5kIGVudiB2aWEgbW9kLmVudmApO1xyXG5cdFx0ZW52ID0gbW9kLmVudjtcclxuXHRcdGVudlNvdXJjZSA9ICdtb2QuZW52JztcclxuXHR9XHJcblx0Ly8gTWV0aG9kIDI6IG1vZC5kZWZhdWx0LmVudiAoaWYgZGVmYXVsdCBleHBvcnQpXHJcblx0ZWxzZSBpZiAobW9kPy5kZWZhdWx0Py5lbnYpIHtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyTIEZvdW5kIGVudiB2aWEgbW9kLmRlZmF1bHQuZW52YCk7XHJcblx0XHRlbnYgPSBtb2QuZGVmYXVsdC5lbnY7XHJcblx0XHRlbnZTb3VyY2UgPSAnbW9kLmRlZmF1bHQuZW52JztcclxuXHR9XHJcblx0XHJcblx0Ly8gRGVlcCBpbnNwZWN0aW9uIG9mIHdoYXQgd2UgaGF2ZVxyXG5cdGlmIChlbnYpIHtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52IHR5cGU6ICR7dHlwZW9mIGVudn1gKTtcclxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52IGtleXMgKGZpcnN0IDMwKTpgLCBPYmplY3Qua2V5cyhlbnYpLnNsaWNlKDAsIDMwKSk7XHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcyBleGlzdHM6YCwgJ2JhY2tlbmRzJyBpbiBlbnYpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueCBleGlzdHM6YCwgZW52LmJhY2tlbmRzPy5vbm54ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYudXNlV2FzbSBleGlzdHM6YCwgdHlwZW9mIGVudi51c2VXYXNtID09PSAnZnVuY3Rpb24nKTtcclxuXHRcdGlmIChlbnYuYmFja2VuZHMpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMga2V5czpgLCBPYmplY3Qua2V5cyhlbnYuYmFja2VuZHMpKTtcclxuXHRcdH1cclxuXHRcdGlmIChlbnYuYmFja2VuZHM/Lm9ubngpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueCB0eXBlOmAsIHR5cGVvZiBlbnYuYmFja2VuZHMub25ueCk7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubngga2V5czpgLCBPYmplY3Qua2V5cyhlbnYuYmFja2VuZHMub25ueCkuc2xpY2UoMCwgMjApKTtcclxuXHRcdH1cclxuXHRcdC8vIENhcHR1cmUgZW52IHNuYXBzaG90IGJlZm9yZSBXQVNNIGNvbmZpZ1xyXG5cdFx0aWYgKCFsYXN0RW52U25hcHNob3QpIHtcclxuXHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZCwgZW52LCAnYmVmb3JlLXdhc20tY29uZmlnJyk7XHJcblx0XHR9XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKclyBDb3VsZCBub3QgZmluZCBlbnYgc3RydWN0dXJlYCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZW52IGV4aXN0czpgLCBtb2Q/LmVudiAhPT0gdW5kZWZpbmVkKTtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0IGV4aXN0czpgLCBtb2Q/LmRlZmF1bHQgIT09IHVuZGVmaW5lZCk7XHJcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdC5lbnYgZXhpc3RzOmAsIG1vZD8uZGVmYXVsdD8uZW52ICE9PSB1bmRlZmluZWQpO1xyXG5cdFx0aWYgKG1vZD8uZW52KSB7XHJcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5lbnYsIDMpKTtcclxuXHRcdH1cclxuXHRcdGlmIChtb2Q/LmRlZmF1bHQ/LmVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIG1vZC5kZWZhdWx0LmVudiBzdHJ1Y3R1cmUgKGRlcHRoIDMpOmAsIGRlZXBJbnNwZWN0KG1vZC5kZWZhdWx0LmVudiwgMykpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHRcclxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIENSSVRJQ0FMOiBNdXN0IGJlIGRvbmUgQkVGT1JFIGFueSBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6YXRpb25cclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgdG8gY29uZmlndXJlIFdBU00gcGF0aHMuLi5gKTtcclxuXHRcclxuXHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcclxuXHRcclxuXHRpZiAoZW52KSB7XHJcblx0XHQvLyBBcHByb2FjaCAxOiBUcnkgdG8gYWNjZXNzIE9OTlggYmFja2VuZCBkaXJlY3RseSBmcm9tIHRoZSBtb2R1bGVcclxuXHRcdC8vIFRoZSBPTk5YIGJhY2tlbmQgaXMgZXhwb3J0ZWQgZnJvbSB0cmFuc2Zvcm1lcnMuanMsIHdlIG5lZWQgdG8gYWNjZXNzIGl0XHJcblx0XHRsZXQgb25ueEJhY2tlbmRFbnY6IGFueSA9IG51bGw7XHJcblx0XHRsZXQgb25ueEJhY2tlbmRQYXRoID0gJ25vbmUnO1xyXG5cdFx0XHJcblx0XHQvLyBUcnkgdG8gZmluZCBPTk5YIGluIHRoZSBtb2R1bGUgZXhwb3J0c1xyXG5cdFx0aWYgKG1vZD8uT05OWCkge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBPTk5YIGV4cG9ydCBpbiBtb2R1bGVgKTtcclxuXHRcdFx0Y29uc3Qgb25ueCA9IG1vZC5PTk5YO1xyXG5cdFx0XHRpZiAob25ueD8uZW52Py53YXNtKSB7XHJcblx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54LmVudi53YXNtO1xyXG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdtb2QuT05OWC5lbnYud2FzbSc7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgT05OWCBlbnYud2FzbSB2aWEgbW9kLk9OTlhgKTtcclxuXHRcdFx0fSBlbHNlIGlmIChvbm54Py5lbnYpIHtcclxuXHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnguZW52O1xyXG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdtb2QuT05OWC5lbnYnO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIE9OTlggZW52IHZpYSBtb2QuT05OWGApO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIEFwcHJvYWNoIDI6IFRyeSB2aWEgZW52LmJhY2tlbmRzLm9ubnggKHRyYW5zZm9ybWVycy5qcyBzdHJ1Y3R1cmUpXHJcblx0XHRpZiAoIW9ubnhCYWNrZW5kRW52ICYmIGVudi5iYWNrZW5kcz8ub25ueCkge1xyXG5cdFx0XHRjb25zdCBvbm54QmFja2VuZCA9IGVudi5iYWNrZW5kcy5vbm54O1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBPTk5YIGJhY2tlbmQgZm91bmQgdmlhIGVudi5iYWNrZW5kcy5vbm54YCk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAob25ueEJhY2tlbmQuZW52Py53YXNtKSB7XHJcblx0XHRcdFx0b25ueEJhY2tlbmRFbnYgPSBvbm54QmFja2VuZC5lbnYud2FzbTtcclxuXHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnZW52LmJhY2tlbmRzLm9ubnguZW52Lndhc20nO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIFdBU00gZW52IGF0IG9ubnhCYWNrZW5kLmVudi53YXNtYCk7XHJcblx0XHRcdH0gZWxzZSBpZiAob25ueEJhY2tlbmQud2FzbSkge1xyXG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQud2FzbTtcclxuXHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnb25ueEJhY2tlbmQud2FzbSc7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgV0FTTSBlbnYgYXQgb25ueEJhY2tlbmQud2FzbWApO1xyXG5cdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLmVudikge1xyXG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQuZW52O1xyXG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdvbm54QmFja2VuZC5lbnYnO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIGVudiBhdCBvbm54QmFja2VuZC5lbnZgKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBTZXQgd2FzbVBhdGhzIG9uIHRoZSBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnRcclxuXHRcdGlmIChvbm54QmFja2VuZEVudikge1xyXG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENvbmZpZ3VyaW5nIFdBU00gcGF0aHMgYXQ6ICR7b25ueEJhY2tlbmRQYXRofWApO1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiBvbm54QmFja2VuZEVudikge1xyXG5cdFx0XHRcdFx0Y29uc3QgY3VycmVudFBhdGhzID0gb25ueEJhY2tlbmRFbnYud2FzbVBhdGhzO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBDdXJyZW50IHdhc21QYXRoczogJHtKU09OLnN0cmluZ2lmeShjdXJyZW50UGF0aHMpfWApO1xyXG5cdFx0XHRcdFx0b25ueEJhY2tlbmRFbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgVXBkYXRlZCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBWZXJpZmllZCB3YXNtUGF0aHM6ICR7SlNPTi5zdHJpbmdpZnkob25ueEJhY2tlbmRFbnYud2FzbVBhdGhzKX1gKTtcclxuXHRcdFx0XHR9IGVsc2Uge1xyXG5cdFx0XHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KG9ubnhCYWNrZW5kRW52LCAnd2FzbVBhdGhzJywge1xyXG5cdFx0XHRcdFx0XHR2YWx1ZTogd2FzbUJhc2VQYXRoLFxyXG5cdFx0XHRcdFx0XHR3cml0YWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0Y29uZmlndXJhYmxlOiB0cnVlXHJcblx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fSBjYXRjaCAocGF0aEVycikge1xyXG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzIGF0ICR7b25ueEJhY2tlbmRQYXRofTpgLCBwYXRoRXJyKTtcclxuXHRcdFx0fVxyXG5cdFx0fSBlbHNlIHtcclxuXHRcdFx0Ly8gT05OWCBiYWNrZW5kIGVudmlyb25tZW50IG5vdCBmb3VuZCAtIHRyeSBmYWxsYmFjayBhcHByb2FjaGVzXHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKaoCBPTk5YIGJhY2tlbmQgZW52aXJvbm1lbnQgbm90IGZvdW5kIHZpYSBzdGFuZGFyZCBwYXRoc2ApO1xyXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBdHRlbXB0aW5nIGZhbGxiYWNrOiBzZXR0aW5nIG9uIGVudi5iYWNrZW5kcy5vbm54IGRpcmVjdGx5Li4uYCk7XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBUcnkgdG8gY3JlYXRlL2FjY2VzcyBiYWNrZW5kcy5vbm54IGlmIGl0IGRvZXNuJ3QgZXhpc3RcclxuXHRcdFx0aWYgKCFlbnYuYmFja2VuZHMpIHtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0ZW52LmJhY2tlbmRzID0ge307XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENyZWF0ZWQgZW52LmJhY2tlbmRzIG9iamVjdGApO1xyXG5cdFx0XHRcdH0gY2F0Y2ggKGUpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBjcmVhdGUgZW52LmJhY2tlbmRzOmAsIGUpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQ2hlY2sgaWYgd2UgY2FuIGFjY2VzcyBPTk5YIGFmdGVyIGNyZWF0aW5nIGJhY2tlbmRzXHJcblx0XHRcdGlmIChlbnYuYmFja2VuZHMgJiYgIWVudi5iYWNrZW5kcy5vbm54KSB7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gZW52LmJhY2tlbmRzLm9ubnggaXMgc3RpbGwgdW5kZWZpbmVkIC0gT05OWCBiYWNrZW5kIG1heSBub3QgYmUgaW5pdGlhbGl6ZWQgeWV0YCk7XHJcblx0XHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gVGhpcyBpcyBleHBlY3RlZCBpZiBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6ZXMgbGF6aWx5YCk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIEFsd2F5cyBjYXB0dXJlIHNuYXBzaG90IGZvciBkaWFnbm9zdGljc1xyXG5cdFx0XHRjYXB0dXJlRW52U25hcHNob3QobW9kLCBlbnYsICd3YXNtLWNvbmZpZy1hdHRlbXB0Jyk7XHJcblx0XHRcdGlmIChsYXN0RW52U25hcHNob3QpIHtcclxuXHRcdFx0XHRjb25zb2xlLmxvZygnW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTlYgU05BUFNIT1RdJywgSlNPTi5zdHJpbmdpZnkobGFzdEVudlNuYXBzaG90LCBudWxsLCAyKSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQXBwcm9hY2ggMzogQWxzbyB0cnkgc2V0dGluZyBhdCB0b3AtbGV2ZWwgZW52IChzb21lIHRyYW5zZm9ybWVycy5qcyB2ZXJzaW9ucyB1c2UgdGhpcylcclxuXHRcdHRyeSB7XHJcblx0XHRcdGlmICgnd2FzbVBhdGhzJyBpbiBlbnYpIHtcclxuXHRcdFx0XHRlbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEFsc28gc2V0IGVudi53YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xyXG5cdFx0XHR9XHJcblx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBzZXQgdG9wLWxldmVsIGVudi53YXNtUGF0aHM6YCwgZW52UGF0aEVycik7XHJcblx0XHR9XHJcblx0fSBlbHNlIHtcclxuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKclyBDYW5ub3QgY29uZmlndXJlIFdBU00gcGF0aHMgLSBlbnYgbm90IGZvdW5kYCk7XHJcblx0fVxyXG5cdFxyXG5cdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvblxyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gTG9jYXRpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcclxuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCBtb2QuZGVmYXVsdD8ucGlwZWxpbmU7XHJcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBQaXBlbGluZSBmb3VuZDpgLCBwaXBlbGluZSAhPT0gdW5kZWZpbmVkICYmIHBpcGVsaW5lICE9PSBudWxsKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIHR5cGU6YCwgdHlwZW9mIHBpcGVsaW5lKTtcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGlzIGZ1bmN0aW9uOmAsIHR5cGVvZiBwaXBlbGluZSA9PT0gJ2Z1bmN0aW9uJyk7XHJcblx0XHJcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XHJcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLnBpcGVsaW5lOmAsIG1vZD8ucGlwZWxpbmUpO1xyXG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5kZWZhdWx0LnBpcGVsaW5lOmAsIG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpO1xyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xyXG5cdH1cclxuXHRcclxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xyXG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFBJUEVMSU5FIExPQUQgQ09NUExFVEUgPT09YCk7XHJcblx0cmV0dXJuIHBpcGVsaW5lO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XHJcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XHJcblx0bGV0IHN1bVNxID0gMDtcclxuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cclxuICovXHJcbmludGVyZmFjZSBNb2RlbEVycm9yTG9nRW50cnkge1xyXG5cdHRpbWVzdGFtcDogc3RyaW5nO1xyXG5cdGxvY2F0aW9uOiBzdHJpbmc7XHJcblx0Y29udGV4dDogc3RyaW5nO1xyXG5cdG1lc3NhZ2U6IHN0cmluZztcclxuXHRzdGFjaz86IHN0cmluZztcclxuXHRlcnJvclR5cGU/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcclxuXHRyZWFkb25seSBkaW0gPSAzODQ7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XHJcblx0cHJpdmF0ZSBsYXN0TG9hZEVycm9yOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsID0gbnVsbDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBNb2RlbEVycm9yTG9nRW50cnlbXSA9IFtdO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZCAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pYCk7XHJcblx0XHRcdHJldHVybjtcclxuXHRcdH1cclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzIChhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfSksIHdhaXRpbmcuLi5gKTtcclxuXHRcdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHRcdH1cclxuXHJcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBTVEFSVElORyBNT0RFTCBMT0FEID09PWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHMgKyAxfWApO1xyXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xyXG5cdFx0dGhpcy5sb2FkQXR0ZW1wdHMrKztcclxuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHR0cnkge1xyXG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiBHZXR0aW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XHJcblx0XHRcdFx0dHJ5IHtcclxuXHRcdFx0XHRcdHBpcGVsaW5lID0gYXdhaXQgZ2V0UGlwZWxpbmUodGhpcy5wbHVnaW4pO1xyXG5cdFx0XHRcdFx0aWYgKCFwaXBlbGluZSkge1xyXG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG51bGwgb3IgdW5kZWZpbmVkJyk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRpZiAodHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XHJcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24sIGdvdDogJHt0eXBlb2YgcGlwZWxpbmV9YCk7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDE6IOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWQgKHR5cGU6ICR7dHlwZW9mIHBpcGVsaW5lfSwgbmFtZTogJHtwaXBlbGluZS5uYW1lIHx8ICdhbm9ueW1vdXMnfSlgKTtcclxuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAxOiDinJcgRmFpbGVkIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbmApO1xyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XHJcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHRyYW5zZm9ybWVycyBwaXBlbGluZTogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XHJcblx0XHRcdFx0fVxyXG5cclxuXHRcdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxyXG5cdFx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogQ2FjaGUgZGlyZWN0b3J5OiAke2NhY2hlRGlyfWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMjogTW9kZWw6IFhlbm92YS9hbGwtTWluaUxNLUw2LXYyYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IENyZWF0aW5nIG1vZGVsIHBpcGVsaW5lICh0aGlzIG1heSB0YWtlIHRpbWUpLi4uYCk7XHJcblxyXG5cdFx0XHRcdGxldCBwaXBlVW5rbm93bjogdW5rbm93bjtcclxuXHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0Y29uc3QgcGlwZWxpbmVTdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXHJcblx0XHRcdFx0XHRwaXBlVW5rbm93biA9IGF3YWl0IHBpcGVsaW5lKCdmZWF0dXJlLWV4dHJhY3Rpb24nLCAnWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjInLCB7XHJcblx0XHRcdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcclxuXHRcdFx0XHRcdFx0Y2FjaGVfZGlyOiBjYWNoZURpclxyXG5cdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZUR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHBpcGVsaW5lU3RhcnRUaW1lO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJMgUGlwZWxpbmUgY3JlYXRlZCBpbiAke3BpcGVsaW5lRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogUGlwZWxpbmUgb3V0cHV0IHR5cGU6ICR7dHlwZW9mIHBpcGVVbmtub3dufWApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShwaXBlVW5rbm93bil9YCk7XHJcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiDinJcgUGlwZWxpbmUgY3JlYXRpb24gZmFpbGVkYCk7XHJcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgdHlwZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBwaXBlbGluZUVycn1gKTtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBtZXNzYWdlOiAke3BpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgPyBwaXBlbGluZUVyci5tZXNzYWdlIDogU3RyaW5nKHBpcGVsaW5lRXJyKX1gKTtcclxuXHRcdFx0XHRcdGlmIChwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yICYmIHBpcGVsaW5lRXJyLnN0YWNrKSB7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBzdGFjayAoZmlyc3QgMTAgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKHBpcGVsaW5lRXJyLnN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxMCkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0Ly8gQ2FwdHVyZSBlbnYgc25hcHNob3QgYXQgZmFpbHVyZSB0aW1lIGlmIHdlIGRvbid0IGhhdmUgb25lXHJcblx0XHRcdFx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xyXG5cdFx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRcdGNvbnN0IG1vZEF0RXJyb3IgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcclxuXHRcdFx0XHRcdFx0XHRjb25zdCBlbnZBdEVycm9yID0gbW9kQXRFcnJvci5lbnYgfHwgbW9kQXRFcnJvci5kZWZhdWx0Py5lbnY7XHJcblx0XHRcdFx0XHRcdFx0aWYgKGVudkF0RXJyb3IpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2RBdEVycm9yLCBlbnZBdEVycm9yLCAnb24tcGlwZWxpbmUtZXJyb3InKTtcclxuXHRcdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHRcdH0gY2F0Y2gge1xyXG5cdFx0XHRcdFx0XHRcdC8vIGlnbm9yZSBzZWNvbmRhcnkgZmFpbHVyZXNcclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcclxuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDQ6IFdyYXBwaW5nIHBpcGVsaW5lIGZ1bmN0aW9uLi4uYCk7XHJcblxyXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblx0XHRcdFx0XHR0cnkge1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gU3RhcnRpbmcgZW1iZWRkaW5nIGdlbmVyYXRpb24gZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xyXG5cdFx0XHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydFRpbWU7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBSYXcgb3V0cHV0IHJlY2VpdmVkIGluICR7ZW1iZWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gT3V0cHV0IHR5cGU6ICR7dHlwZW9mIG91dH1gKTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XHJcblx0XHRcdFx0XHRcdFxyXG5cdFx0XHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdFx0XHRsZXQgcmVzdWx0OiBudW1iZXJbXTtcclxuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSAmJiBBcnJheS5pc0FycmF5KG91dFswXSkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxBcnJheTxudW1iZXI+PiwgdXNpbmcgb3V0WzBdYCk7XHJcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHRcdFx0fSBlbHNlIGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcclxuXHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBBcnJheTxudW1iZXI+LCB1c2luZyBkaXJlY3RseWApO1xyXG5cdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0Y29uc3QgbWF5YmUgPSBvdXQgYXMgeyBkYXRhPzogbnVtYmVyW10gfTtcclxuXHRcdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtYXliZT8uZGF0YSkpIHtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IE9iamVjdCB3aXRoIGRhdGEgYXJyYXksIHVzaW5nIGRhdGFgKTtcclxuXHRcdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcclxuXHRcdFx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIOKclyBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXRgKTtcclxuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dDpgLCBvdXQpO1xyXG5cdFx0XHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyTIEVtYmVkZGluZyBnZW5lcmF0ZWQgc3VjY2Vzc2Z1bGx5ICgke3Jlc3VsdC5sZW5ndGh9IGRpbWVuc2lvbnMpYCk7XHJcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHRcdFx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0VGltZTtcclxuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcclxuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIEVycm9yOmAsIGVycik7XHJcblx0XHRcdFx0XHRcdHRocm93IGVycjtcclxuXHRcdFx0XHRcdH1cclxuXHRcdFx0XHR9O1xyXG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCA0OiDinJMgUGlwZWxpbmUgd3JhcHBlciBjcmVhdGVkYCk7XHJcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gTU9ERUwgRlVMTFkgTE9BREVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xyXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZCBhdHRlbXB0czogJHt0aGlzLmxvYWRBdHRlbXB0c31gKTtcclxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IE1PREVMIExPQUQgRkFJTEVEID09PWApO1xyXG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUb3RhbCBsb2FkIHRpbWU6ICR7bG9hZER1cmF0aW9ufW1zYCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdDogIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XHJcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkJywgYE1vZGVsIGxvYWRpbmcgYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c31gLCBlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xyXG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcclxuXHRcdFx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycjtcclxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgdHlwZTogJHtlcnJvclR5cGV9YCk7XHJcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIG1lc3NhZ2U6ICR7ZXJyb3JNc2d9YCk7XHJcblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciBzdGFjayAoZmlyc3QgMTUgbGluZXMpOmApO1xyXG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxNSkuam9pbignXFxuJykpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHR0aHJvdyBlcnI7XHJcblx0XHRcdH1cclxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XHJcblx0XHRcdHRoaXMubG9hZGluZyA9IG51bGw7XHJcblx0XHR9KTtcclxuXHJcblx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgaXNSZWFkeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuXHRcdHRyeSB7XHJcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XHJcblx0XHRcdHJldHVybiB0aGlzLnBpcGVsaW5lICE9PSBudWxsO1xyXG5cdFx0fSBjYXRjaCAoZXJyKSB7XHJcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcclxuXHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcclxuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XHJcblx0fVxyXG5cclxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xyXG5cdFx0cmV0dXJuIHRoaXMubGFzdExvYWRFcnJvcjtcclxuXHR9XHJcblxyXG5cdGdldExvYWRBdHRlbXB0cygpOiBudW1iZXIge1xyXG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xyXG5cdH1cclxuXHJcblx0Z2V0RW52U25hcHNob3QoKTogYW55IHwgbnVsbCB7XHJcblx0XHRyZXR1cm4gbGFzdEVudlNuYXBzaG90O1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XHJcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcclxuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XHJcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcclxuXHRcdFxyXG5cdFx0Y29uc3QgZW50cnk6IE1vZGVsRXJyb3JMb2dFbnRyeSA9IHtcclxuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXHJcblx0XHRcdGxvY2F0aW9uLFxyXG5cdFx0XHRjb250ZXh0LFxyXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcclxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXHJcblx0XHRcdGVycm9yVHlwZVxyXG5cdFx0fTtcclxuXHRcdFxyXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcclxuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XHJcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXHJcblx0XHRpZiAobG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQnIHx8IGxvY2F0aW9uID09PSAnaXNSZWFkeScpIHtcclxuXHRcdFx0dGhpcy5sYXN0TG9hZEVycm9yID0gZW50cnk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xyXG5cdFx0aWYgKGVycm9yU3RhY2spIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSB7XHJcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtcHR5IHRleHQgcHJvdmlkZWQsIHJldHVybmluZyB6ZXJvIHZlY3RvcmApO1xyXG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHR9XHJcblx0XHR0cnkge1xyXG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUgYWZ0ZXIgbG9hZGluZyBhdHRlbXB0Jyk7XHJcblx0XHRcdH1cclxuXHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XHJcblx0XHRcdGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMucGlwZWxpbmUodCk7XHJcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcclxuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBHZW5lcmF0ZWQgZW1iZWRkaW5nIGluICR7ZW1iZWREdXJhdGlvbn1tcyBmb3IgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCk7XHJcblx0XHRcdHJldHVybiByZXN1bHQ7XHJcblx0XHR9IGNhdGNoIChlcnIpIHtcclxuXHRcdFx0dGhpcy5sb2dFcnJvcignZW1iZWQnLCBgRW1iZWRkaW5nIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XHJcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQ6YCwgZXJyKTtcclxuXHRcdFx0dGhyb3cgZXJyO1xyXG5cdFx0fVxyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==