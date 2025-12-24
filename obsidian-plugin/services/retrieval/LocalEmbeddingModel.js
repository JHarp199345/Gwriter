// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin) {
    // Import the vendored transformers library first
    const mod = await import('../../lib/transformers.js');
    // Configure WASM paths - the library needs to know where to find WASM files
    // In Obsidian, plugin files are served from .obsidian/plugins/plugin-name/
    // We need to use the full path to the plugin's lib directory
    if (mod.env) {
        // Initialize env structure if needed
        if (!mod.env.backends)
            mod.env.backends = {};
        if (!mod.env.backends.onnx)
            mod.env.backends.onnx = {};
        if (!mod.env.backends.onnx.wasm)
            mod.env.backends.onnx.wasm = {};
        // Get the plugin's base path - Obsidian serves files from the plugin directory
        // @ts-ignore - basePath is not in the type definitions but exists
        const pluginBasePath = plugin.app.vault.adapter.basePath || '';
        const wasmPath = pluginBasePath
            ? `${pluginBasePath}/.obsidian/plugins/${plugin.manifest.id}/lib/`
            : `./lib/`; // Fallback to relative path
        mod.env.backends.onnx.wasm.wasmPaths = wasmPath;
        console.log(`[LocalEmbeddingModel] Configured WASM path: ${wasmPath}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNkRBQTZEO0FBQzdELHlEQUF5RDtBQUN6RCxLQUFLLFVBQVUsV0FBVyxDQUFDLE1BQThCO0lBQ3hELGlEQUFpRDtJQUNqRCxNQUFNLEdBQUcsR0FBUSxNQUFNLE1BQU0sQ0FBQywyQkFBMkIsQ0FBQyxDQUFDO0lBRTNELDRFQUE0RTtJQUM1RSwyRUFBMkU7SUFDM0UsNkRBQTZEO0lBQzdELElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ2IscUNBQXFDO1FBQ3JDLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLFFBQVE7WUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLFFBQVEsR0FBRyxFQUFFLENBQUM7UUFDN0MsSUFBSSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUk7WUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ3ZELElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSTtZQUFFLEdBQUcsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBRWpFLCtFQUErRTtRQUMvRSxrRUFBa0U7UUFDbEUsTUFBTSxjQUFjLEdBQUksTUFBTSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsT0FBZSxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUM7UUFDeEUsTUFBTSxRQUFRLEdBQUcsY0FBYztZQUM5QixDQUFDLENBQUMsR0FBRyxjQUFjLHNCQUFzQixNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsT0FBTztZQUNsRSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsNEJBQTRCO1FBRXpDLEdBQUcsQ0FBQyxH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QUFJLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzVDLENBQUM7UUFDRCxJQUFJLENBQUM7WUFDSixNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztZQUMxQixJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNwQixNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7WUFDMUUsQ0FBQztZQUNELE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUM5QixNQUFNLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDdEMsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLEdBQUcsRUFBRSxHQUFHLFVBQVUsQ0FBQztZQUM5QyxPQUFPLENBQUMsR0FBRyxDQUFDLGdEQUFnRCxhQUFhLGdCQUFnQixDQUFDLENBQUMsTUFBTSxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLENBQUMsQ0FBQztZQUM1SSxPQUFPLE1BQU0sQ0FBQztRQUNmLENBQUM7UUFBQyxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ2QsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLEVBQUUsbUJBQW1CLENBQUMsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLFNBQVMsRUFBRSxHQUFHLENBQUMsQ0FBQztZQUNsRyxPQUFPLENBQUMsS0FBSyxDQUFDLG9EQUFvRCxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ3pFLE1BQU0sR0FBRyxDQUFDO1FBQ1gsQ0FBQztJQUNGLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcblxuLy8gSGVscGVyIHRvIGdldCBwaXBlbGluZSBmdW5jdGlvbiB3aXRoIHByb3BlciBlcnJvciBoYW5kbGluZ1xuLy8gVXNlcyB2ZW5kb3JlZCB0cmFuc2Zvcm1lcnMuanMgdG8gYXZvaWQgYnVuZGxpbmcgaXNzdWVzXG5hc3luYyBmdW5jdGlvbiBnZXRQaXBlbGluZShwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pOiBQcm9taXNlPGFueT4ge1xuXHQvLyBJbXBvcnQgdGhlIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBsaWJyYXJ5IGZpcnN0XG5cdGNvbnN0IG1vZDogYW55ID0gYXdhaXQgaW1wb3J0KCcuLi8uLi9saWIvdHJhbnNmb3JtZXJzLmpzJyk7XG5cdFxuXHQvLyBDb25maWd1cmUgV0FTTSBwYXRocyAtIHRoZSBsaWJyYXJ5IG5lZWRzIHRvIGtub3cgd2hlcmUgdG8gZmluZCBXQVNNIGZpbGVzXG5cdC8vIEluIE9ic2lkaWFuLCBwbHVnaW4gZmlsZXMgYXJlIHNlcnZlZCBmcm9tIC5vYnNpZGlhbi9wbHVnaW5zL3BsdWdpbi1uYW1lL1xuXHQvLyBXZSBuZWVkIHRvIHVzZSB0aGUgZnVsbCBwYXRoIHRvIHRoZSBwbHVnaW4ncyBsaWIgZGlyZWN0b3J5XG5cdGlmIChtb2QuZW52KSB7XG5cdFx0Ly8gSW5pdGlhbGl6ZSBlbnYgc3RydWN0dXJlIGlmIG5lZWRlZFxuXHRcdGlmICghbW9kLmVudi5iYWNrZW5kcykgbW9kLmVudi5iYWNrZW5kcyA9IHt9O1xuXHRcdGlmICghbW9kLmVudi5iYWNrZW5kcy5vbm54KSBtb2QuZW52LmJhY2tlbmRzLm9ubnggPSB7fTtcblx0XHRpZiAoIW1vZC5lbnYuYmFja2VuZHMub25ueC53YXNtKSBtb2QuZW52LmJhY2tlbmRzLm9ubngud2FzbSA9IHt9O1xuXHRcdFxuXHRcdC8vIEdldCB0aGUgcGx1Z2luJ3MgYmFzZSBwYXRoIC0gT2JzaWRpYW4gc2VydmVzIGZpbGVzIGZyb20gdGhlIHBsdWdpbiBkaXJlY3Rvcnlcblx0XHQvLyBAdHMtaWdub3JlIC0gYmFzZVBhdGggaXMgbm90IGluIHRoZSB0eXBlIGRlZmluaXRpb25zIGJ1dCBleGlzdHNcblx0XHRjb25zdCBwbHVnaW5CYXNlUGF0aCA9IChwbHVnaW4uYXBwLnZhdWx0LmFkYXB0ZXIgYXMgYW55KS5iYXNlUGF0aCB8fCAnJztcblx0XHRjb25zdCB3YXNtUGF0aCA9IHBsdWdpbkJhc2VQYXRoIFxuXHRcdFx0PyBgJHtwbHVnaW5CYXNlUGF0aH0vLm9ic2lkaWFuL3BsdWdpbnMvJHtwbHVnaW4ubWFuaWZlc3QuaWR9L2xpYi9gXG5cdFx0XHQ6IGAuL2xpYi9gOyAvLyBGYWxsYmFjayB0byByZWxhdGl2ZSBwYXRoXG5cdFx0XG5cdFx0bW9kLmVudi5iYWNrZW5kcy5vbm54Lndhc20ud2FzbVBhdGhzID0gd2FzbVBhdGg7XG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBDb25maWd1cmVkIFdBU00gcGF0aDogJHt3YXNtUGF0aH1gKTtcblx0fVxuXHRcblx0Y29uc3QgcGlwZWxpbmUgPSBtb2QucGlwZWxpbmUgfHwgKG1vZC5kZWZhdWx0ICYmIG1vZC5kZWZhdWx0LnBpcGVsaW5lKTtcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIG5vdCBmb3VuZCBpbiB0cmFuc2Zvcm1lcnMgbW9kdWxlJyk7XG5cdH1cblx0cmV0dXJuIHBpcGVsaW5lO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xuXHRyZWFkb25seSBpZDogc3RyaW5nO1xuXHRyZWFkb25seSBkaW06IG51bWJlcjtcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XG59XG5cbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XG5cdGxldCBzdW1TcSA9IDA7XG5cdGZvciAoY29uc3QgdiBvZiB2ZWMpIHN1bVNxICs9IHYgKiB2O1xuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xuXHRyZXR1cm4gdmVjLm1hcCgodikgPT4gdiAvIG5vcm0pO1xufVxuXG4vKipcbiAqIFRydWUgbG9jYWwgZW1iZWRkaW5ncyB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cbiAqL1xuaW50ZXJmYWNlIE1vZGVsRXJyb3JMb2dFbnRyeSB7XG5cdHRpbWVzdGFtcDogc3RyaW5nO1xuXHRsb2NhdGlvbjogc3RyaW5nO1xuXHRjb250ZXh0OiBzdHJpbmc7XG5cdG1lc3NhZ2U6IHN0cmluZztcblx0c3RhY2s/OiBzdHJpbmc7XG5cdGVycm9yVHlwZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwgaW1wbGVtZW50cyBMb2NhbEVtYmVkZGluZ01vZGVsIHtcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcblx0cmVhZG9ubHkgZGltID0gMzg0O1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSBwaXBlbGluZTogbnVsbCB8ICgodGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcltdPikgPSBudWxsO1xuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBsb2FkQXR0ZW1wdHMgPSAwO1xuXHRwcml2YXRlIGxhc3RMb2FkRXJyb3I6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBNb2RlbEVycm9yTG9nRW50cnlbXSA9IFtdO1xuXHRwcml2YXRlIHJlYWRvbmx5IG1heFN0b3JlZEVycm9ycyA9IDUwO1xuXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gUGlwZWxpbmUgYWxyZWFkeSBsb2FkZWRgKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBsb2FkaW5nIGluIHByb2dyZXNzLCB3YWl0aW5nLi4uYCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5sb2FkaW5nO1xuXHRcdH1cblxuXHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gU3RhcnRpbmcgbW9kZWwgbG9hZC4uLmApO1xuXHRcdHRoaXMubG9hZEF0dGVtcHRzKys7XG5cdFx0Y29uc3QgbG9hZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Ly8gR2V0IHBpcGVsaW5lIGZ1bmN0aW9uIC0gdXNpbmcgaGVscGVyIHRvIGVuc3VyZSBwcm9wZXIgaW5pdGlhbGl6YXRpb25cblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZS4uLmApO1xuXHRcdFx0XHRsZXQgcGlwZWxpbmU6IGFueTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRwaXBlbGluZSA9IGF3YWl0IGdldFBpcGVsaW5lKHRoaXMucGx1Z2luKTtcblx0XHRcdFx0XHRpZiAoIXBpcGVsaW5lIHx8IHR5cGVvZiBwaXBlbGluZSAhPT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdQaXBlbGluZSBpcyBub3QgYSBmdW5jdGlvbicpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBQaXBlbGluZSBmdW5jdGlvbiBsb2FkZWRgKTtcblx0XHRcdFx0fSBjYXRjaCAoaW1wb3J0RXJyKSB7XG5cdFx0XHRcdFx0dGhpcy5sb2dFcnJvcignZW5zdXJlTG9hZGVkLmltcG9ydCcsICdMb2FkaW5nIHZlbmRvcmVkIHRyYW5zZm9ybWVycyBwaXBlbGluZScsIGltcG9ydEVycik7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gbG9hZCB0cmFuc2Zvcm1lcnMgcGlwZWxpbmU6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2FjaGUgbW9kZWxzIGluc2lkZSBwbHVnaW4gZGF0YSB0byBhdm9pZCByZS1kb3dubG9hZGluZyBpZiBwb3NzaWJsZS5cblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBDYWNoZSBkaXJlY3Rvcnk6ICR7Y2FjaGVEaXJ9YCk7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZGluZyBtb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIgKHF1YW50aXplZCkuLi5gKTtcblxuXHRcdFx0XHRsZXQgcGlwZVVua25vd246IHVua25vd247XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXG5cdFx0XHRcdFx0cGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnLCBgQ3JlYXRpbmcgcGlwZWxpbmUgd2l0aCBtb2RlbCBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiwgY2FjaGU6ICR7Y2FjaGVEaXJ9YCwgcGlwZWxpbmVFcnIpO1xuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xuXHRcdFx0XHR9XG5cdFx0XHRcdFxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgTW9kZWwgcGlwZWxpbmUgY3JlYXRlZGApO1xuXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkobWF5YmU/LmRhdGEpKSByZXR1cm4gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XG5cdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXQ6YCwgdHlwZW9mIG91dCwgQXJyYXkuaXNBcnJheShvdXQpLCBvdXQpO1xuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgZHVyaW5nIGVtYmVkZGluZyBnZW5lcmF0aW9uOmAsIGVycik7XG5cdFx0XHRcdFx0XHR0aHJvdyBlcnI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHRjb25zdCBsb2FkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gbG9hZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBNb2RlbCBmdWxseSBsb2FkZWQgaW4gJHtsb2FkRHVyYXRpb259bXNgKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQnLCBgTW9kZWwgbG9hZGluZyBhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfWAsIGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJcgTW9kZWwgbG9hZGluZyBmYWlsZWQ6YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCA1KS5qb2luKCdcXG4nKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0fVxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcblx0fVxuXG5cdGFzeW5jIGlzUmVhZHkoKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5waXBlbGluZSAhPT0gbnVsbDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xuXHRcdHJldHVybiB0aGlzLmxhc3RMb2FkRXJyb3I7XG5cdH1cblxuXHRnZXRMb2FkQXR0ZW1wdHMoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXHRcdFxuXHRcdGNvbnN0IGVudHJ5OiBNb2RlbEVycm9yTG9nRW50cnkgPSB7XG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGxvY2F0aW9uLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXG5cdFx0XHRlcnJvclR5cGVcblx0XHR9O1xuXHRcdFxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXG5cdFx0aWYgKGxvY2F0aW9uID09PSAnZW5zdXJlTG9hZGVkJyB8fCBsb2NhdGlvbiA9PT0gJ2lzUmVhZHknKSB7XG5cdFx0XHR0aGlzLmxhc3RMb2FkRXJyb3IgPSBlbnRyeTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xuXHRcdGlmICghdCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1wdHkgdGV4dCBwcm92aWRlZCwgcmV0dXJuaW5nIHplcm8gdmVjdG9yYCk7XG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XG5cdFx0fVxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5ncyBwaXBlbGluZSB1bmF2YWlsYWJsZSBhZnRlciBsb2FkaW5nIGF0dGVtcHQnKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gR2VuZXJhdGVkIGVtYmVkZGluZyBpbiAke2VtYmVkRHVyYXRpb259bXMgZm9yIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWApO1xuXHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2VtYmVkJywgYEVtYmVkZGluZyB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xuXHRcdFx0dGhyb3cgZXJyO1xuXHRcdH1cblx0fVxufVxuXG5cbiJdfQ==