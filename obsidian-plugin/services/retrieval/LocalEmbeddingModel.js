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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNEVBQTRFO0FBQzVFLFNBQVMsV0FBVyxDQUFDLEdBQVEsRUFBRSxXQUFtQixDQUFDLEVBQUUsZUFBdUIsQ0FBQyxFQUFFLFVBQXdCLElBQUksT0FBTyxFQUFFO0lBQ25ILElBQUksWUFBWSxJQUFJLFFBQVEsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLEdBQUcsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNuRSxPQUFPLE9BQU8sR0FBRyxDQUFDO0lBQ25CLENBQUM7SUFDRCxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzdCLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE9BQU8sWUFBWSxDQUFDO0lBQ3JCLENBQUM7SUFDRCxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRWpCLE1BQU0sTUFBTSxHQUFRLEVBQUUsQ0FBQztJQUN2QixJQUFJLENBQUM7UUFDSixNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxrQ0FBa0M7UUFDOUUsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN4QixJQUFJLENBQUM7Z0JBQ0osTUFBTSxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQixJQUFJLE9BQU8sR0FBRyxLQUFLLFVBQVUsRUFBRSxDQUFDO29CQUMvQixNQUFNLENBQUMsR0FBRyxDQUFDLEdBQUcsY0FBYyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVcsR0FBRyxDQUFDO2dCQUN4RCxDQUFD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LEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUM7WUFDNUksT0FBTyxNQUFNLENBQUM7UUFDZixDQUFDO1FBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztZQUNkLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTyxFQUFFLG1CQUFtQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLEVBQUUsR0FBRyxDQUFDLENBQUM7WUFDbEcsT0FBTyxDQUFDLEtBQUssQ0FBQyxvREFBb0QsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUN6RSxNQUFNLEdBQUcsQ0FBQztRQUNYLENBQUM7SUFDRixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5cbi8vIEhlbHBlciBmdW5jdGlvbiB0byBzYWZlbHkgaW5zcGVjdCBvYmplY3Qgc3RydWN0dXJlIHdpdGhvdXQgY2F1c2luZyBlcnJvcnNcbmZ1bmN0aW9uIGRlZXBJbnNwZWN0KG9iajogYW55LCBtYXhEZXB0aDogbnVtYmVyID0gMywgY3VycmVudERlcHRoOiBudW1iZXIgPSAwLCB2aXNpdGVkOiBXZWFrU2V0PGFueT4gPSBuZXcgV2Vha1NldCgpKTogYW55IHtcblx0aWYgKGN1cnJlbnREZXB0aCA+PSBtYXhEZXB0aCB8fCBvYmogPT09IG51bGwgfHwgb2JqID09PSB1bmRlZmluZWQpIHtcblx0XHRyZXR1cm4gdHlwZW9mIG9iajtcblx0fVxuXHRpZiAodHlwZW9mIG9iaiAhPT0gJ29iamVjdCcpIHtcblx0XHRyZXR1cm4gb2JqO1xuXHR9XG5cdGlmICh2aXNpdGVkLmhhcyhvYmopKSB7XG5cdFx0cmV0dXJuICdbQ2lyY3VsYXJdJztcblx0fVxuXHR2aXNpdGVkLmFkZChvYmopO1xuXHRcblx0Y29uc3QgcmVzdWx0OiBhbnkgPSB7fTtcblx0dHJ5IHtcblx0XHRjb25zdCBrZXlzID0gT2JqZWN0LmtleXMob2JqKS5zbGljZSgwLCAyMCk7IC8vIExpbWl0IGtleXMgdG8gYXZvaWQgaHVnZSBvdXRwdXRcblx0XHRmb3IgKGNvbnN0IGtleSBvZiBrZXlzKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCB2YWwgPSBvYmpba2V5XTtcblx0XHRcdFx0aWYgKHR5cGVvZiB2YWwgPT09ICdmdW5jdGlvbicpIHtcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IGBbRnVuY3Rpb246ICR7dmFsLm5hbWUgfHwgJ2Fub255bW91cyd9XWA7XG5cdFx0XHRcdH0gZWxzZSBpZiAodHlwZW9mIHZhbCA9PT0gJ29iamVjdCcgJiYgdmFsICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0cmVzdWx0W2tleV0gPSBkZWVwSW5zcGVjdCh2YWwsIG1heERlcHRoLCBjdXJyZW50RGVwdGggKyAxLCB2aXNpdGVkKTtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRyZXN1bHRba2V5XSA9IHZhbDtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZSkge1xuXHRcdFx0XHRyZXN1bHRba2V5XSA9IGBbRXJyb3IgYWNjZXNzaW5nOiAke2V9XWA7XG5cdFx0XHR9XG5cdFx0fVxuXHR9IGNhdGNoIChlKSB7XG5cdFx0cmV0dXJuIGBbRXJyb3IgaW5zcGVjdGluZzogJHtlfV1gO1xuXHR9XG5cdHJldHVybiByZXN1bHQ7XG59XG5cbi8vIENhcHR1cmUgYSBvbmUtdGltZSBzbmFwc2hvdCBvZiB0aGUgdHJhbnNmb3JtZXJzIGVudiAvIE9OTlggc3RhdGUgZm9yIGRpYWdub3N0aWNzXG5sZXQgbGFzdEVudlNuYXBzaG90OiBhbnkgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gY2FwdHVyZUVudlNuYXBzaG90KG1vZDogYW55LCBlbnY6IGFueSwgd2hlcmU6IHN0cmluZyk6IHZvaWQge1xuXHR0cnkge1xuXHRcdGNvbnN0IG9ubnggPSBlbnY/LmJhY2tlbmRzPy5vbm54O1xuXHRcdGNvbnN0IGJhY2tlbmRzID0gZW52Py5iYWNrZW5kcztcblx0XHRsYXN0RW52U25hcHNob3QgPSB7XG5cdFx0XHR3aGVyZSxcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bW9kS2V5czogbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAyMCkgOiBudWxsLFxuXHRcdFx0aGFzRGVmYXVsdDogISFtb2Q/LmRlZmF1bHQsXG5cdFx0XHRoYXNQaXBlbGluZTogdHlwZW9mIChtb2Q/LnBpcGVsaW5lIHx8IG1vZD8uZGVmYXVsdD8ucGlwZWxpbmUpID09PSAnZnVuY3Rpb24nLFxuXHRcdFx0ZW52S2V5czogZW52ID8gT2JqZWN0LmtleXMoZW52KS5zbGljZSgwLCAyMCkgOiBudWxsLFxuXHRcdFx0ZW52SGFzQmFja2VuZHM6ICEhYmFja2VuZHMsXG5cdFx0XHRiYWNrZW5kc0tleXM6IGJhY2tlbmRzID8gT2JqZWN0LmtleXMoYmFja2VuZHMpIDogbnVsbCxcblx0XHRcdG9ubnhLZXlFeGlzdHM6IGJhY2tlbmRzID8gJ29ubngnIGluIGJhY2tlbmRzIDogZmFsc2UsXG5cdFx0XHRvbm54VmFsdWVFeGlzdHM6IG9ubnggIT09IHVuZGVmaW5lZCxcblx0XHRcdG9ubnhWYWx1ZVR5cGU6IHR5cGVvZiBvbm54LFxuXHRcdFx0b25ueEtleXM6IG9ubnggPyBPYmplY3Qua2V5cyhvbm54KS5zbGljZSgwLCAyMCkgOiBudWxsLFxuXHRcdFx0b25ueEhhc1dhc206ICEhb25ueD8ud2FzbSxcblx0XHRcdG9ubnhXYXNtS2V5czogb25ueD8ud2FzbSA/IE9iamVjdC5rZXlzKG9ubngud2FzbSkuc2xpY2UoMCwgMjApIDogbnVsbCxcblx0XHRcdG9ubnhXYXNtUGF0aHM6IG9ubng/Lndhc20/Lndhc21QYXRocyA/PyBudWxsLFxuXHRcdFx0ZW52SGFzVXNlV2FzbTogdHlwZW9mIGVudj8udXNlV2FzbSA9PT0gJ2Z1bmN0aW9uJyxcblx0XHR9O1xuXHRcdGNvbnNvbGUubG9nKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0nLCBsYXN0RW52U25hcHNob3QpO1xuXHR9IGNhdGNoIChlKSB7XG5cdFx0Y29uc29sZS53YXJuKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0gRmFpbGVkIHRvIGNhcHR1cmUgZW52IHNuYXBzaG90OicsIGUpO1xuXHR9XG59XG5cbi8vIEhlbHBlciB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb24gd2l0aCBwcm9wZXIgZXJyb3IgaGFuZGxpbmdcbi8vIFVzZXMgdmVuZG9yZWQgdHJhbnNmb3JtZXJzLmpzIHRvIGF2b2lkIGJ1bmRsaW5nIGlzc3Vlc1xuYXN5bmMgZnVuY3Rpb24gZ2V0UGlwZWxpbmUocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogUHJvbWlzZTxhbnk+IHtcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSA9PT0gU1RBUlRJTkcgUElQRUxJTkUgTE9BRCA9PT1gKTtcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBUaW1lc3RhbXA6ICR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfWApO1xuXHRcblx0Ly8gSW1wb3J0IHRoZSB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMgbGlicmFyeSBmaXJzdFxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIEltcG9ydGluZyB0cmFuc2Zvcm1lcnMuanMgbW9kdWxlLi4uYCk7XG5cdGxldCBtb2Q6IGFueTtcblx0dHJ5IHtcblx0XHRtb2QgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKckyBNb2R1bGUgaW1wb3J0ZWQgc3VjY2Vzc2Z1bGx5YCk7XG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAxXSBNb2R1bGUgdHlwZTogJHt0eXBlb2YgbW9kfWApO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIG51bGw6ICR7bW9kID09PSBudWxsfWApO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMV0gTW9kdWxlIGlzIHVuZGVmaW5lZDogJHttb2QgPT09IHVuZGVmaW5lZH1gKTtcblx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDFdIOKclyBNb2R1bGUgaW1wb3J0IGZhaWxlZDpgLCBpbXBvcnRFcnIpO1xuXHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGltcG9ydCB0cmFuc2Zvcm1lcnMuanM6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xuXHR9XG5cdFxuXHQvLyBEZWVwIGluc3BlY3Rpb24gb2YgbW9kdWxlIHN0cnVjdHVyZVxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIEluc3BlY3RpbmcgbW9kdWxlIHN0cnVjdHVyZS4uLmApO1xuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDJdIE1vZHVsZSBrZXlzIChmaXJzdCAzMCk6YCwgbW9kICYmIHR5cGVvZiBtb2QgPT09ICdvYmplY3QnID8gT2JqZWN0LmtleXMobW9kKS5zbGljZSgwLCAzMCkgOiAnTi9BJyk7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdlbnYnIHByb3BlcnR5OmAsICdlbnYnIGluIChtb2QgfHwge30pKTtcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBIYXMgJ2RlZmF1bHQnIHByb3BlcnR5OmAsICdkZWZhdWx0JyBpbiAobW9kIHx8IHt9KSk7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gSGFzICdwaXBlbGluZScgcHJvcGVydHk6YCwgJ3BpcGVsaW5lJyBpbiAobW9kIHx8IHt9KSk7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmVudiB0eXBlOmAsIHR5cGVvZiBtb2Q/LmVudik7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgMl0gbW9kLmRlZmF1bHQgdHlwZTpgLCB0eXBlb2YgbW9kPy5kZWZhdWx0KTtcblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAyXSBtb2QucGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgbW9kPy5waXBlbGluZSk7XG5cdFxuXHQvLyBUcnkgbXVsdGlwbGUgd2F5cyB0byBhY2Nlc3MgdGhlIGVudmlyb25tZW50XG5cdGxldCBlbnY6IGFueSA9IG51bGw7XG5cdGxldCBlbnZTb3VyY2UgPSAnbm9uZSc7XG5cdFxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIEF0dGVtcHRpbmcgdG8gbG9jYXRlIGVudmlyb25tZW50IHN0cnVjdHVyZS4uLmApO1xuXHRcblx0Ly8gTWV0aG9kIDE6IERpcmVjdCBtb2QuZW52IChzdGFuZGFyZCBzdHJ1Y3R1cmUpXG5cdGlmIChtb2Q/LmVudikge1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyTIEZvdW5kIGVudiB2aWEgbW9kLmVudmApO1xuXHRcdGVudiA9IG1vZC5lbnY7XG5cdFx0ZW52U291cmNlID0gJ21vZC5lbnYnO1xuXHR9XG5cdC8vIE1ldGhvZCAyOiBtb2QuZGVmYXVsdC5lbnYgKGlmIGRlZmF1bHQgZXhwb3J0KVxuXHRlbHNlIGlmIChtb2Q/LmRlZmF1bHQ/LmVudikge1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10g4pyTIEZvdW5kIGVudiB2aWEgbW9kLmRlZmF1bHQuZW52YCk7XG5cdFx0ZW52ID0gbW9kLmRlZmF1bHQuZW52O1xuXHRcdGVudlNvdXJjZSA9ICdtb2QuZGVmYXVsdC5lbnYnO1xuXHR9XG5cdFxuXHQvLyBEZWVwIGluc3BlY3Rpb24gb2Ygd2hhdCB3ZSBoYXZlXG5cdGlmIChlbnYpIHtcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudiB0eXBlOiAke3R5cGVvZiBlbnZ9YCk7XG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYga2V5cyAoZmlyc3QgMzApOmAsIE9iamVjdC5rZXlzKGVudikuc2xpY2UoMCwgMzApKTtcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi5iYWNrZW5kcyBleGlzdHM6YCwgJ2JhY2tlbmRzJyBpbiBlbnYpO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggZXhpc3RzOmAsIGVudi5iYWNrZW5kcz8ub25ueCAhPT0gdW5kZWZpbmVkKTtcblx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIGVudi51c2VXYXNtIGV4aXN0czpgLCB0eXBlb2YgZW52LnVzZVdhc20gPT09ICdmdW5jdGlvbicpO1xuXHRcdGlmIChlbnYuYmFja2VuZHMpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzIGtleXM6YCwgT2JqZWN0LmtleXMoZW52LmJhY2tlbmRzKSk7XG5cdFx0fVxuXHRcdGlmIChlbnYuYmFja2VuZHM/Lm9ubngpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gZW52LmJhY2tlbmRzLm9ubnggdHlwZTpgLCB0eXBlb2YgZW52LmJhY2tlbmRzLm9ubngpO1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBlbnYuYmFja2VuZHMub25ueCBrZXlzOmAsIE9iamVjdC5rZXlzKGVudi5iYWNrZW5kcy5vbm54KS5zbGljZSgwLCAyMCkpO1xuXHRcdH1cblx0XHQvLyBDYXB0dXJlIGVudiBzbmFwc2hvdCBiZWZvcmUgV0FTTSBjb25maWdcblx0XHRpZiAoIWxhc3RFbnZTbmFwc2hvdCkge1xuXHRcdFx0Y2FwdHVyZUVudlNuYXBzaG90KG1vZCwgZW52LCAnYmVmb3JlLXdhc20tY29uZmlnJyk7XG5cdFx0fVxuXHR9IGVsc2Uge1xuXHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDNdIOKclyBDb3VsZCBub3QgZmluZCBlbnYgc3RydWN0dXJlYCk7XG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmVudiBleGlzdHM6YCwgbW9kPy5lbnYgIT09IHVuZGVmaW5lZCk7XG5cdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQgZXhpc3RzOmAsIG1vZD8uZGVmYXVsdCAhPT0gdW5kZWZpbmVkKTtcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZGVmYXVsdC5lbnYgZXhpc3RzOmAsIG1vZD8uZGVmYXVsdD8uZW52ICE9PSB1bmRlZmluZWQpO1xuXHRcdGlmIChtb2Q/LmVudikge1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCAzXSBtb2QuZW52IHN0cnVjdHVyZSAoZGVwdGggMyk6YCwgZGVlcEluc3BlY3QobW9kLmVudiwgMykpO1xuXHRcdH1cblx0XHRpZiAobW9kPy5kZWZhdWx0Py5lbnYpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgM10gbW9kLmRlZmF1bHQuZW52IHN0cnVjdHVyZSAoZGVwdGggMyk6YCwgZGVlcEluc3BlY3QobW9kLmRlZmF1bHQuZW52LCAzKSk7XG5cdFx0fVxuXHR9XG5cdFxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIENSSVRJQ0FMOiBNdXN0IGJlIGRvbmUgQkVGT1JFIGFueSBPTk5YIGJhY2tlbmQgaW5pdGlhbGl6YXRpb25cblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBBdHRlbXB0aW5nIHRvIGNvbmZpZ3VyZSBXQVNNIHBhdGhzLi4uYCk7XG5cdFxuXHRjb25zdCB3YXNtQmFzZVBhdGggPSAnLi9saWIvJztcblx0XG5cdGlmIChlbnYpIHtcblx0XHQvLyBBcHByb2FjaCAxOiBUcnkgdG8gYWNjZXNzIE9OTlggYmFja2VuZCBkaXJlY3RseSBmcm9tIHRoZSBtb2R1bGVcblx0XHQvLyBUaGUgT05OWCBiYWNrZW5kIGlzIGV4cG9ydGVkIGZyb20gdHJhbnNmb3JtZXJzLmpzLCB3ZSBuZWVkIHRvIGFjY2VzcyBpdFxuXHRcdGxldCBvbm54QmFja2VuZEVudjogYW55ID0gbnVsbDtcblx0XHRsZXQgb25ueEJhY2tlbmRQYXRoID0gJ25vbmUnO1xuXHRcdFxuXHRcdC8vIFRyeSB0byBmaW5kIE9OTlggaW4gdGhlIG1vZHVsZSBleHBvcnRzXG5cdFx0aWYgKG1vZD8uT05OWCkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgT05OWCBleHBvcnQgaW4gbW9kdWxlYCk7XG5cdFx0XHRjb25zdCBvbm54ID0gbW9kLk9OTlg7XG5cdFx0XHRpZiAob25ueD8uZW52Py53YXNtKSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueC5lbnYud2FzbTtcblx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ21vZC5PTk5YLmVudi53YXNtJztcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgRm91bmQgT05OWCBlbnYud2FzbSB2aWEgbW9kLk9OTlhgKTtcblx0XHRcdH0gZWxzZSBpZiAob25ueD8uZW52KSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueC5lbnY7XG5cdFx0XHRcdG9ubnhCYWNrZW5kUGF0aCA9ICdtb2QuT05OWC5lbnYnO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBPTk5YIGVudiB2aWEgbW9kLk9OTlhgKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0Ly8gQXBwcm9hY2ggMjogVHJ5IHZpYSBlbnYuYmFja2VuZHMub25ueCAodHJhbnNmb3JtZXJzLmpzIHN0cnVjdHVyZSlcblx0XHRpZiAoIW9ubnhCYWNrZW5kRW52ICYmIGVudi5iYWNrZW5kcz8ub25ueCkge1xuXHRcdFx0Y29uc3Qgb25ueEJhY2tlbmQgPSBlbnYuYmFja2VuZHMub25ueDtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIE9OTlggYmFja2VuZCBmb3VuZCB2aWEgZW52LmJhY2tlbmRzLm9ubnhgKTtcblx0XHRcdFxuXHRcdFx0aWYgKG9ubnhCYWNrZW5kLmVudj8ud2FzbSkge1xuXHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnhCYWNrZW5kLmVudi53YXNtO1xuXHRcdFx0XHRvbm54QmFja2VuZFBhdGggPSAnZW52LmJhY2tlbmRzLm9ubnguZW52Lndhc20nO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC5lbnYud2FzbWApO1xuXHRcdFx0fSBlbHNlIGlmIChvbm54QmFja2VuZC53YXNtKSB7XG5cdFx0XHRcdG9ubnhCYWNrZW5kRW52ID0gb25ueEJhY2tlbmQud2FzbTtcblx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ29ubnhCYWNrZW5kLndhc20nO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBGb3VuZCBXQVNNIGVudiBhdCBvbm54QmFja2VuZC53YXNtYCk7XG5cdFx0XHR9IGVsc2UgaWYgKG9ubnhCYWNrZW5kLmVudikge1xuXHRcdFx0XHRvbm54QmFja2VuZEVudiA9IG9ubnhCYWNrZW5kLmVudjtcblx0XHRcdFx0b25ueEJhY2tlbmRQYXRoID0gJ29ubnhCYWNrZW5kLmVudic7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIEZvdW5kIGVudiBhdCBvbm54QmFja2VuZC5lbnZgKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0Ly8gU2V0IHdhc21QYXRocyBvbiB0aGUgT05OWCBiYWNrZW5kIGVudmlyb25tZW50XG5cdFx0aWYgKG9ubnhCYWNrZW5kRW52KSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIENvbmZpZ3VyaW5nIFdBU00gcGF0aHMgYXQ6ICR7b25ueEJhY2tlbmRQYXRofWApO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIG9ubnhCYWNrZW5kRW52KSB7XG5cdFx0XHRcdFx0Y29uc3QgY3VycmVudFBhdGhzID0gb25ueEJhY2tlbmRFbnYud2FzbVBhdGhzO1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3VycmVudCB3YXNtUGF0aHM6ICR7SlNPTi5zdHJpbmdpZnkoY3VycmVudFBhdGhzKX1gKTtcblx0XHRcdFx0XHRvbm54QmFja2VuZEVudi53YXNtUGF0aHMgPSB3YXNtQmFzZVBhdGg7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJMgVXBkYXRlZCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gVmVyaWZpZWQgd2FzbVBhdGhzOiAke0pTT04uc3RyaW5naWZ5KG9ubnhCYWNrZW5kRW52Lndhc21QYXRocyl9YCk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0T2JqZWN0LmRlZmluZVByb3BlcnR5KG9ubnhCYWNrZW5kRW52LCAnd2FzbVBhdGhzJywge1xuXHRcdFx0XHRcdFx0dmFsdWU6IHdhc21CYXNlUGF0aCxcblx0XHRcdFx0XHRcdHdyaXRhYmxlOiB0cnVlLFxuXHRcdFx0XHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcblx0XHRcdFx0XHRcdGNvbmZpZ3VyYWJsZTogdHJ1ZVxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0g4pyTIENyZWF0ZWQgYW5kIHNldCB3YXNtUGF0aHMgdG86ICR7d2FzbUJhc2VQYXRofWApO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChwYXRoRXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEZhaWxlZCB0byBzZXQgd2FzbVBhdGhzIGF0ICR7b25ueEJhY2tlbmRQYXRofTpgLCBwYXRoRXJyKTtcblx0XHRcdH1cblx0XHR9IGVsc2Uge1xuXHRcdFx0Ly8gT05OWCBiYWNrZW5kIGVudmlyb25tZW50IG5vdCBmb3VuZCAtIHRyeSBmYWxsYmFjayBhcHByb2FjaGVzXG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDimqAgT05OWCBiYWNrZW5kIGVudmlyb25tZW50IG5vdCBmb3VuZCB2aWEgc3RhbmRhcmQgcGF0aHNgKTtcblx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIEF0dGVtcHRpbmcgZmFsbGJhY2s6IHNldHRpbmcgb24gZW52LmJhY2tlbmRzLm9ubnggZGlyZWN0bHkuLi5gKTtcblx0XHRcdFxuXHRcdFx0Ly8gVHJ5IHRvIGNyZWF0ZS9hY2Nlc3MgYmFja2VuZHMub25ueCBpZiBpdCBkb2Vzbid0IGV4aXN0XG5cdFx0XHRpZiAoIWVudi5iYWNrZW5kcykge1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGVudi5iYWNrZW5kcyA9IHt9O1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNF0gQ3JlYXRlZCBlbnYuYmFja2VuZHMgb2JqZWN0YCk7XG5cdFx0XHRcdH0gY2F0Y2ggKGUpIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gY3JlYXRlIGVudi5iYWNrZW5kczpgLCBlKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBDaGVjayBpZiB3ZSBjYW4gYWNjZXNzIE9OTlggYWZ0ZXIgY3JlYXRpbmcgYmFja2VuZHNcblx0XHRcdGlmIChlbnYuYmFja2VuZHMgJiYgIWVudi5iYWNrZW5kcy5vbm54KSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIGVudi5iYWNrZW5kcy5vbm54IGlzIHN0aWxsIHVuZGVmaW5lZCAtIE9OTlggYmFja2VuZCBtYXkgbm90IGJlIGluaXRpYWxpemVkIHlldGApO1xuXHRcdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBUaGlzIGlzIGV4cGVjdGVkIGlmIE9OTlggYmFja2VuZCBpbml0aWFsaXplcyBsYXppbHlgKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQWx3YXlzIGNhcHR1cmUgc25hcHNob3QgZm9yIGRpYWdub3N0aWNzXG5cdFx0XHRjYXB0dXJlRW52U25hcHNob3QobW9kLCBlbnYsICd3YXNtLWNvbmZpZy1hdHRlbXB0Jyk7XG5cdFx0XHRpZiAobGFzdEVudlNuYXBzaG90KSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKCdbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VOViBTTkFQU0hPVF0nLCBKU09OLnN0cmluZ2lmeShsYXN0RW52U25hcHNob3QsIG51bGwsIDIpKTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0Ly8gQXBwcm9hY2ggMzogQWxzbyB0cnkgc2V0dGluZyBhdCB0b3AtbGV2ZWwgZW52IChzb21lIHRyYW5zZm9ybWVycy5qcyB2ZXJzaW9ucyB1c2UgdGhpcylcblx0XHR0cnkge1xuXHRcdFx0aWYgKCd3YXNtUGF0aHMnIGluIGVudikge1xuXHRcdFx0XHRlbnYud2FzbVBhdGhzID0gd2FzbUJhc2VQYXRoO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDRdIOKckyBBbHNvIHNldCBlbnYud2FzbVBhdGhzIHRvOiAke3dhc21CYXNlUGF0aH1gKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIChlbnZQYXRoRXJyKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSBGYWlsZWQgdG8gc2V0IHRvcC1sZXZlbCBlbnYud2FzbVBhdGhzOmAsIGVudlBhdGhFcnIpO1xuXHRcdH1cblx0fSBlbHNlIHtcblx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA0XSDinJcgQ2Fubm90IGNvbmZpZ3VyZSBXQVNNIHBhdGhzIC0gZW52IG5vdCBmb3VuZGApO1xuXHR9XG5cdFxuXHQvLyBHZXQgcGlwZWxpbmUgZnVuY3Rpb25cblx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSBMb2NhdGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xuXHRjb25zdCBwaXBlbGluZSA9IG1vZC5waXBlbGluZSB8fCBtb2QuZGVmYXVsdD8ucGlwZWxpbmU7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgZm91bmQ6YCwgcGlwZWxpbmUgIT09IHVuZGVmaW5lZCAmJiBwaXBlbGluZSAhPT0gbnVsbCk7XG5cdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gUGlwZWxpbmUgdHlwZTpgLCB0eXBlb2YgcGlwZWxpbmUpO1xuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIFBpcGVsaW5lIGlzIGZ1bmN0aW9uOmAsIHR5cGVvZiBwaXBlbGluZSA9PT0gJ2Z1bmN0aW9uJyk7XG5cdFxuXHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbU1RFUCA1XSDinJcgUGlwZWxpbmUgbm90IGZvdW5kIG9yIG5vdCBhIGZ1bmN0aW9uYCk7XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIG1vZC5waXBlbGluZTpgLCBtb2Q/LnBpcGVsaW5lKTtcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW1NURVAgNV0gbW9kLmRlZmF1bHQucGlwZWxpbmU6YCwgbW9kPy5kZWZhdWx0Py5waXBlbGluZSk7XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBub3QgZm91bmQgaW4gdHJhbnNmb3JtZXJzIG1vZHVsZScpO1xuXHR9XG5cdFxuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtTVEVQIDVdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBmb3VuZGApO1xuXHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBQSVBFTElORSBMT0FEIENPTVBMRVRFID09PWApO1xuXHRyZXR1cm4gcGlwZWxpbmU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XG5cdHJlYWRvbmx5IGRpbTogbnVtYmVyO1xuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcbn1cblxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcblx0bGV0IHN1bVNxID0gMDtcblx0Zm9yIChjb25zdCB2IG9mIHZlYykgc3VtU3EgKz0gdiAqIHY7XG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XG59XG5cbi8qKlxuICogVHJ1ZSBsb2NhbCBlbWJlZGRpbmdzIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxuICovXG5pbnRlcmZhY2UgTW9kZWxFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7XG5cdGNvbnRleHQ6IHN0cmluZztcblx0bWVzc2FnZTogc3RyaW5nO1xuXHRzdGFjaz86IHN0cmluZztcblx0ZXJyb3JUeXBlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCBpbXBsZW1lbnRzIExvY2FsRW1iZWRkaW5nTW9kZWwge1xuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xuXHRyZWFkb25seSBkaW0gPSAzODQ7XG5cblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xuXHRwcml2YXRlIHBpcGVsaW5lOiBudWxsIHwgKCh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyW10+KSA9IG51bGw7XG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XG5cdHByaXZhdGUgbGFzdExvYWRFcnJvcjogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IE1vZGVsRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5waXBlbGluZSkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZCAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgbG9hZGluZyBpbiBwcm9ncmVzcyAoYXR0ZW1wdCAjJHt0aGlzLmxvYWRBdHRlbXB0c30pLCB3YWl0aW5nLi4uYCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xuXHRcdH1cblxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gPT09IFNUQVJUSU5HIE1PREVMIExPQUQgPT09YCk7XG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHMgKyAxfWApO1xuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVGltZXN0YW1wOiAke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gKTtcblx0XHR0aGlzLmxvYWRBdHRlbXB0cysrO1xuXHRcdGNvbnN0IGxvYWRTdGFydCA9IERhdGUubm93KCk7XG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdC8vIEdldCBwaXBlbGluZSBmdW5jdGlvbiAtIHVzaW5nIGhlbHBlciB0byBlbnN1cmUgcHJvcGVyIGluaXRpYWxpemF0aW9uXG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMTogR2V0dGluZyBwaXBlbGluZSBmdW5jdGlvbi4uLmApO1xuXHRcdFx0XHRsZXQgcGlwZWxpbmU6IGFueTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRwaXBlbGluZSA9IGF3YWl0IGdldFBpcGVsaW5lKHRoaXMucGx1Z2luKTtcblx0XHRcdFx0XHRpZiAoIXBpcGVsaW5lKSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG51bGwgb3IgdW5kZWZpbmVkJyk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGlmICh0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcblx0XHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgUGlwZWxpbmUgaXMgbm90IGEgZnVuY3Rpb24sIGdvdDogJHt0eXBlb2YgcGlwZWxpbmV9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMTog4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGxvYWRlZCAodHlwZTogJHt0eXBlb2YgcGlwZWxpbmV9LCBuYW1lOiAke3BpcGVsaW5lLm5hbWUgfHwgJ2Fub255bW91cyd9KWApO1xuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMTog4pyXIEZhaWxlZCB0byBnZXQgcGlwZWxpbmUgZnVuY3Rpb25gKTtcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuaW1wb3J0JywgJ0xvYWRpbmcgdmVuZG9yZWQgdHJhbnNmb3JtZXJzIHBpcGVsaW5lJywgaW1wb3J0RXJyKTtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBsb2FkIHRyYW5zZm9ybWVycyBwaXBlbGluZTogJHtpbXBvcnRFcnIgaW5zdGFuY2VvZiBFcnJvciA/IGltcG9ydEVyci5tZXNzYWdlIDogU3RyaW5nKGltcG9ydEVycil9YCk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxuXHRcdFx0XHQvLyBOb3RlOiB0cmFuc2Zvcm1lcnMgdXNlcyBpdHMgb3duIGNhY2hpbmcgc3RyYXRlZ3k7IHRoaXMgaXMgYSBoaW50LlxuXHRcdFx0XHRjb25zdCBjYWNoZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9tb2RlbHNgO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IFByZXBhcmluZyBtb2RlbCBjYWNoZS4uLmApO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDI6IENhY2hlIGRpcmVjdG9yeTogJHtjYWNoZURpcn1gKTtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBNb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjJgKTtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAyOiBRdWFudGl6ZWQ6IHRydWVgKTtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBDcmVhdGluZyBtb2RlbCBwaXBlbGluZSAodGhpcyBtYXkgdGFrZSB0aW1lKS4uLmApO1xuXG5cdFx0XHRcdGxldCBwaXBlVW5rbm93bjogdW5rbm93bjtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZVN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXG5cdFx0XHRcdFx0cGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0XHRjb25zdCBwaXBlbGluZUR1cmF0aW9uID0gRGF0ZS5ub3coKSAtIHBpcGVsaW5lU3RhcnRUaW1lO1xuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzog4pyTIFBpcGVsaW5lIGNyZWF0ZWQgaW4gJHtwaXBlbGluZUR1cmF0aW9ufW1zYCk7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgdHlwZTogJHt0eXBlb2YgcGlwZVVua25vd259YCk7XG5cdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBQaXBlbGluZSBvdXRwdXQgaXMgYXJyYXk6ICR7QXJyYXkuaXNBcnJheShwaXBlVW5rbm93bil9YCk7XG5cdFx0XHRcdH0gY2F0Y2ggKHBpcGVsaW5lRXJyKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtMT0FEXSBTdGVwIDM6IOKclyBQaXBlbGluZSBjcmVhdGlvbiBmYWlsZWRgKTtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgdHlwZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBwaXBlbGluZUVycn1gKTtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgMzogRXJyb3IgbWVzc2FnZTogJHtwaXBlbGluZUVyciBpbnN0YW5jZW9mIEVycm9yID8gcGlwZWxpbmVFcnIubWVzc2FnZSA6IFN0cmluZyhwaXBlbGluZUVycil9YCk7XG5cdFx0XHRcdFx0aWYgKHBpcGVsaW5lRXJyIGluc3RhbmNlb2YgRXJyb3IgJiYgcGlwZWxpbmVFcnIuc3RhY2spIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbTE9BRF0gU3RlcCAzOiBFcnJvciBzdGFjayAoZmlyc3QgMTAgbGluZXMpOmApO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihwaXBlbGluZUVyci5zdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMTApLmpvaW4oJ1xcbicpKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0Ly8gQ2FwdHVyZSBlbnYgc25hcHNob3QgYXQgZmFpbHVyZSB0aW1lIGlmIHdlIGRvbid0IGhhdmUgb25lXG5cdFx0XHRcdFx0aWYgKCFsYXN0RW52U25hcHNob3QpIHtcblx0XHRcdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0XHRcdGNvbnN0IG1vZEF0RXJyb3IgPSBhd2FpdCBpbXBvcnQoJy4uLy4uL2xpYi90cmFuc2Zvcm1lcnMuanMnKTtcblx0XHRcdFx0XHRcdFx0Y29uc3QgZW52QXRFcnJvciA9IG1vZEF0RXJyb3IuZW52IHx8IG1vZEF0RXJyb3IuZGVmYXVsdD8uZW52O1xuXHRcdFx0XHRcdFx0XHRpZiAoZW52QXRFcnJvcikge1xuXHRcdFx0XHRcdFx0XHRcdGNhcHR1cmVFbnZTbmFwc2hvdChtb2RBdEVycm9yLCBlbnZBdEVycm9yLCAnb24tcGlwZWxpbmUtZXJyb3InKTtcblx0XHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0XHRcdC8vIGlnbm9yZSBzZWNvbmRhcnkgZmFpbHVyZXNcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmNyZWF0ZVBpcGVsaW5lJywgYENyZWF0aW5nIHBpcGVsaW5lIHdpdGggbW9kZWwgWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIsIGNhY2hlOiAke2NhY2hlRGlyfWAsIHBpcGVsaW5lRXJyKTtcblx0XHRcdFx0XHR0aHJvdyBwaXBlbGluZUVycjtcblx0XHRcdFx0fVxuXHRcdFx0XHRcblx0XHRcdFx0Y29uc3QgcGlwZSA9IHBpcGVVbmtub3duIGFzIChpbnB1dDogc3RyaW5nLCBvcHRzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IFByb21pc2U8dW5rbm93bj47XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgNDogV3JhcHBpbmcgcGlwZWxpbmUgZnVuY3Rpb24uLi5gKTtcblxuXHRcdFx0XHR0aGlzLnBpcGVsaW5lID0gYXN5bmMgKHRleHQ6IHN0cmluZykgPT4ge1xuXHRcdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIFN0YXJ0aW5nIGVtYmVkZGluZyBnZW5lcmF0aW9uIGZvciB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycywgJHt0ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcykuLi5gKTtcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydFRpbWU7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gUmF3IG91dHB1dCByZWNlaXZlZCBpbiAke2VtYmVkRHVyYXRpb259bXNgKTtcblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBPdXRwdXQgdHlwZTogJHt0eXBlb2Ygb3V0fWApO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIE91dHB1dCBpcyBhcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XG5cdFx0XHRcdFx0XHRcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXG5cdFx0XHRcdFx0XHRsZXQgcmVzdWx0OiBudW1iZXJbXTtcblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkgJiYgQXJyYXkuaXNBcnJheShvdXRbMF0pKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PEFycmF5PG51bWJlcj4+LCB1c2luZyBvdXRbMF1gKTtcblx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcblx0XHRcdFx0XHRcdH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShvdXQpKSB7XG5cdFx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBGb3JtYXQ6IEFycmF5PG51bWJlcj4sIHVzaW5nIGRpcmVjdGx5YCk7XG5cdFx0XHRcdFx0XHRcdHJlc3VsdCA9IGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XG5cdFx0XHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xuXHRcdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShtYXliZT8uZGF0YSkpIHtcblx0XHRcdFx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRm9ybWF0OiBPYmplY3Qgd2l0aCBkYXRhIGFycmF5LCB1c2luZyBkYXRhYCk7XG5cdFx0XHRcdFx0XHRcdFx0cmVzdWx0ID0gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XG5cdFx0XHRcdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0XHRcdFx0Y29uc3QgZXJyID0gbmV3IEVycm9yKGBVbmV4cGVjdGVkIGVtYmVkZGluZ3Mgb3V0cHV0IGZvcm1hdDogJHt0eXBlb2Ygb3V0fSwgaXNBcnJheTogJHtBcnJheS5pc0FycmF5KG91dCl9YCk7XG5cdFx0XHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgUHJvY2Vzc2luZyB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycylgLCBlcnIpO1xuXHRcdFx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBbRU1CRURdIOKclyBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXRgKTtcblx0XHRcdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSBPdXRwdXQ6YCwgb3V0KTtcblx0XHRcdFx0XHRcdFx0XHR0aHJvdyBlcnI7XG5cdFx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0VNQkVEXSDinJMgRW1iZWRkaW5nIGdlbmVyYXRlZCBzdWNjZXNzZnVsbHkgKCR7cmVzdWx0Lmxlbmd0aH0gZGltZW5zaW9ucylgKTtcblx0XHRcdFx0XHRcdHJldHVybiByZXN1bHQ7XG5cdFx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnRUaW1lO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBhZnRlciAke2VtYmVkRHVyYXRpb259bXNgKTtcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciB0ZXh0ICgke3RleHQubGVuZ3RofSBjaGFycywgJHt0ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFtFTUJFRF0gRXJyb3I6YCwgZXJyKTtcblx0XHRcdFx0XHRcdHRocm93IGVycjtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cdFx0XHRcdGNvbnN0IGxvYWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBsb2FkU3RhcnQ7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gW0xPQURdIFN0ZXAgNDog4pyTIFBpcGVsaW5lIHdyYXBwZXIgY3JlYXRlZGApO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBNT0RFTCBGVUxMWSBMT0FERUQgPT09YCk7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gVG90YWwgbG9hZCB0aW1lOiAke2xvYWREdXJhdGlvbn1tc2ApO1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdHM6ICR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc3QgbG9hZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGxvYWRTdGFydDtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdID09PSBNT0RFTCBMT0FEIEZBSUxFRCA9PT1gKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFRvdGFsIGxvYWQgdGltZTogJHtsb2FkRHVyYXRpb259bXNgKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWQgYXR0ZW1wdDogIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCk7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ2Vuc3VyZUxvYWRlZCcsIGBNb2RlbCBsb2FkaW5nIGF0dGVtcHQgIyR7dGhpcy5sb2FkQXR0ZW1wdHN9YCwgZXJyKTtcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgZXJyb3JUeXBlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnI7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFcnJvciB0eXBlOiAke2Vycm9yVHlwZX1gKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIG1lc3NhZ2U6ICR7ZXJyb3JNc2d9YCk7XG5cdFx0XHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVycm9yIHN0YWNrIChmaXJzdCAxNSBsaW5lcyk6YCk7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAxNSkuam9pbignXFxuJykpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRocm93IGVycjtcblx0XHRcdH1cblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcblx0XHR9KTtcblxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XG5cdH1cblxuXHRhc3luYyBpc1JlYWR5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdFx0cmV0dXJuIHRoaXMucGlwZWxpbmUgIT09IG51bGw7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHR0aGlzLmxvZ0Vycm9yKCdpc1JlYWR5JywgJ0NoZWNraW5nIG1vZGVsIHJlYWRpbmVzcycsIGVycik7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IE1vZGVsRXJyb3JMb2dFbnRyeVtdIHtcblx0XHRyZXR1cm4gdGhpcy5lcnJvckxvZy5zbGljZSgtbGltaXQpO1xuXHR9XG5cblx0Z2V0TGFzdExvYWRFcnJvcigpOiBNb2RlbEVycm9yTG9nRW50cnkgfCBudWxsIHtcblx0XHRyZXR1cm4gdGhpcy5sYXN0TG9hZEVycm9yO1xuXHR9XG5cblx0Z2V0TG9hZEF0dGVtcHRzKCk6IG51bWJlciB7XG5cdFx0cmV0dXJuIHRoaXMubG9hZEF0dGVtcHRzO1xuXHR9XG5cblx0Z2V0RW52U25hcHNob3QoKTogYW55IHwgbnVsbCB7XG5cdFx0cmV0dXJuIGxhc3RFbnZTbmFwc2hvdDtcblx0fVxuXG5cdHByaXZhdGUgbG9nRXJyb3IobG9jYXRpb246IHN0cmluZywgY29udGV4dDogc3RyaW5nLCBlcnJvcjogdW5rbm93bik6IHZvaWQge1xuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgZXJyb3JUeXBlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyb3I7XG5cdFx0XG5cdFx0Y29uc3QgZW50cnk6IE1vZGVsRXJyb3JMb2dFbnRyeSA9IHtcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bG9jYXRpb24sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcblx0XHRcdGVycm9yVHlwZVxuXHRcdH07XG5cdFx0XG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblx0XHRcblx0XHQvLyBTdG9yZSBhcyBsYXN0IGxvYWQgZXJyb3IgaWYgaXQncyBhIGxvYWRpbmcgZXJyb3Jcblx0XHRpZiAobG9jYXRpb24gPT09ICdlbnN1cmVMb2FkZWQnIHx8IGxvY2F0aW9uID09PSAnaXNSZWFkeScpIHtcblx0XHRcdHRoaXMubGFzdExvYWRFcnJvciA9IGVudHJ5O1xuXHRcdH1cblx0XHRcblx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRVJST1IgWyR7bG9jYXRpb259XSAke2NvbnRleHR9OmAsIGVycm9yTXNnKTtcblx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgdCA9ICh0ZXh0IHx8ICcnKS50cmltKCk7XG5cdFx0aWYgKCF0KSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBFbXB0eSB0ZXh0IHByb3ZpZGVkLCByZXR1cm5pbmcgemVybyB2ZWN0b3JgKTtcblx0XHRcdHJldHVybiBuZXcgQXJyYXk8bnVtYmVyPih0aGlzLmRpbSkuZmlsbCgwKTtcblx0XHR9XG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cdFx0XHRpZiAoIXRoaXMucGlwZWxpbmUpIHtcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbWJlZGRpbmdzIHBpcGVsaW5lIHVuYXZhaWxhYmxlIGFmdGVyIGxvYWRpbmcgYXR0ZW1wdCcpO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XG5cdFx0XHRjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLnBpcGVsaW5lKHQpO1xuXHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBHZW5lcmF0ZWQgZW1iZWRkaW5nIGluICR7ZW1iZWREdXJhdGlvbn1tcyBmb3IgdGV4dCAoJHt0Lmxlbmd0aH0gY2hhcnMsICR7dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpYCk7XG5cdFx0XHRyZXR1cm4gcmVzdWx0O1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0dGhpcy5sb2dFcnJvcignZW1iZWQnLCBgRW1iZWRkaW5nIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkOmAsIGVycik7XG5cdFx0XHR0aHJvdyBlcnI7XG5cdFx0fVxuXHR9XG59XG5cblxuIl19