// Helper to get pipeline function with proper error handling
async function getPipeline() {
    const mod = await import('@xenova/transformers');
    const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
    if (!pipeline || typeof pipeline !== 'function') {
        throw new Error('Pipeline not found in @xenova/transformers module');
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
                console.log(`[LocalEmbeddingModel] Loading @xenova/transformers pipeline...`);
                let pipeline;
                try {
                    pipeline = await getPipeline();
                    if (!pipeline || typeof pipeline !== 'function') {
                        throw new Error('Pipeline is not a function');
                    }
                    console.log(`[LocalEmbeddingModel] ✓ Pipeline function loaded`);
                }
                catch (importErr) {
                    this.logError('ensureLoaded.import', 'Loading @xenova/transformers pipeline', importErr);
                    throw new Error(`Failed to load @xenova/transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBR0EsNkRBQTZEO0FBQzdELEtBQUssVUFBVSxXQUFXO0lBQ3pCLE1BQU0sR0FBRyxHQUFRLE1BQU0sTUFBTSxDQUFDLHNCQUFzQixDQUFDLENBQUM7SUFDdEQsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLFFBQVEsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUSxJQUFJLE9BQU8sUUFBUSxLQUFLLFVBQVUsRUFBRSxDQUFDO1FBQ2pELE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztJQUN0RSxDQUFDO0lBQ0QsT0FBTyxRQUFRLENBQUM7QUFDakIsQ0FBQztBQVFELFNBQVMsV0FBVyxDQUFDLEdBQWE7SUFDakMsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxNQUFNLENBQUMsSUFBSSxHQUFHO1FBQUUsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDcEMsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDbkMsT0FBTyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDLENBQUM7QUFDakMsQ0FBQztBQWVELE1BQU0sT0FBTyx5QkFBeUI7SUFhckMsWUFBWSxLQUFZLEVBQUUsTUFBOEI7UUFaL0MsT0FBRSxHQUFHLFFBQVEsQ0FBQztRQUNkLFFBQUcsR0FBRyxHQUFHLENBQUM7UUFJWCxhQUFRLEdBQWlELElBQUksQ0FBQztRQUM5RCxZQUFPLEdBQXlCLElBQUksQ0FBQztRQUNyQyxpQkFBWSxHQUFHLENB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dCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xuXG4vLyBIZWxwZXIgdG8gZ2V0IHBpcGVsaW5lIGZ1bmN0aW9uIHdpdGggcHJvcGVyIGVycm9yIGhhbmRsaW5nXG5hc3luYyBmdW5jdGlvbiBnZXRQaXBlbGluZSgpOiBQcm9taXNlPGFueT4ge1xuXHRjb25zdCBtb2Q6IGFueSA9IGF3YWl0IGltcG9ydCgnQHhlbm92YS90cmFuc2Zvcm1lcnMnKTtcblx0Y29uc3QgcGlwZWxpbmUgPSBtb2QucGlwZWxpbmUgfHwgKG1vZC5kZWZhdWx0ICYmIG1vZC5kZWZhdWx0LnBpcGVsaW5lKTtcblx0aWYgKCFwaXBlbGluZSB8fCB0eXBlb2YgcGlwZWxpbmUgIT09ICdmdW5jdGlvbicpIHtcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIG5vdCBmb3VuZCBpbiBAeGVub3ZhL3RyYW5zZm9ybWVycyBtb2R1bGUnKTtcblx0fVxuXHRyZXR1cm4gcGlwZWxpbmU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XG5cdHJlYWRvbmx5IGRpbTogbnVtYmVyO1xuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcbn1cblxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcblx0bGV0IHN1bVNxID0gMDtcblx0Zm9yIChjb25zdCB2IG9mIHZlYykgc3VtU3EgKz0gdiAqIHY7XG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XG59XG5cbi8qKlxuICogVHJ1ZSBsb2NhbCBlbWJlZGRpbmdzIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxuICovXG5pbnRlcmZhY2UgTW9kZWxFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7XG5cdGNvbnRleHQ6IHN0cmluZztcblx0bWVzc2FnZTogc3RyaW5nO1xuXHRzdGFjaz86IHN0cmluZztcblx0ZXJyb3JUeXBlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCBpbXBsZW1lbnRzIExvY2FsRW1iZWRkaW5nTW9kZWwge1xuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xuXHRyZWFkb25seSBkaW0gPSAzODQ7XG5cblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xuXHRwcml2YXRlIHBpcGVsaW5lOiBudWxsIHwgKCh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyW10+KSA9IG51bGw7XG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxvYWRBdHRlbXB0cyA9IDA7XG5cdHByaXZhdGUgbGFzdExvYWRFcnJvcjogTW9kZWxFcnJvckxvZ0VudHJ5IHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IE1vZGVsRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gNTA7XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5waXBlbGluZSkge1xuXHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBQaXBlbGluZSBhbHJlYWR5IGxvYWRlZGApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpZiAodGhpcy5sb2FkaW5nICE9PSBudWxsKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIFBpcGVsaW5lIGxvYWRpbmcgaW4gcHJvZ3Jlc3MsIHdhaXRpbmcuLi5gKTtcblx0XHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XG5cdFx0fVxuXG5cdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFydGluZyBtb2RlbCBsb2FkLi4uYCk7XG5cdFx0dGhpcy5sb2FkQXR0ZW1wdHMrKztcblx0XHRjb25zdCBsb2FkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHQvLyBHZXQgcGlwZWxpbmUgZnVuY3Rpb24gLSB1c2luZyBoZWxwZXIgdG8gZW5zdXJlIHByb3BlciBpbml0aWFsaXphdGlvblxuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIExvYWRpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgcGlwZWxpbmUuLi5gKTtcblx0XHRcdFx0bGV0IHBpcGVsaW5lOiBhbnk7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0cGlwZWxpbmUgPSBhd2FpdCBnZXRQaXBlbGluZSgpO1xuXHRcdFx0XHRcdGlmICghcGlwZWxpbmUgfHwgdHlwZW9mIHBpcGVsaW5lICE9PSAnZnVuY3Rpb24nKSB7XG5cdFx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ1BpcGVsaW5lIGlzIG5vdCBhIGZ1bmN0aW9uJyk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0g4pyTIFBpcGVsaW5lIGZ1bmN0aW9uIGxvYWRlZGApO1xuXHRcdFx0XHR9IGNhdGNoIChpbXBvcnRFcnIpIHtcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuaW1wb3J0JywgJ0xvYWRpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgcGlwZWxpbmUnLCBpbXBvcnRFcnIpO1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgRmFpbGVkIHRvIGxvYWQgQHhlbm92YS90cmFuc2Zvcm1lcnMgcGlwZWxpbmU6ICR7aW1wb3J0RXJyIGluc3RhbmNlb2YgRXJyb3IgPyBpbXBvcnRFcnIubWVzc2FnZSA6IFN0cmluZyhpbXBvcnRFcnIpfWApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2FjaGUgbW9kZWxzIGluc2lkZSBwbHVnaW4gZGF0YSB0byBhdm9pZCByZS1kb3dubG9hZGluZyBpZiBwb3NzaWJsZS5cblx0XHRcdFx0Ly8gTm90ZTogdHJhbnNmb3JtZXJzIHVzZXMgaXRzIG93biBjYWNoaW5nIHN0cmF0ZWd5OyB0aGlzIGlzIGEgaGludC5cblx0XHRcdFx0Y29uc3QgY2FjaGVEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXgvbW9kZWxzYDtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBDYWNoZSBkaXJlY3Rvcnk6ICR7Y2FjaGVEaXJ9YCk7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gTG9hZGluZyBtb2RlbDogWGVub3ZhL2FsbC1NaW5pTE0tTDYtdjIgKHF1YW50aXplZCkuLi5gKTtcblxuXHRcdFx0XHRsZXQgcGlwZVVua25vd246IHVua25vd247XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Ly8gQ2FsbCBwaXBlbGluZSBkaXJlY3RseSBhcyBhIGZ1bmN0aW9uXG5cdFx0XHRcdFx0cGlwZVVua25vd24gPSBhd2FpdCBwaXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xuXHRcdFx0XHRcdFx0cXVhbnRpemVkOiB0cnVlLFxuXHRcdFx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcblx0XHRcdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcblx0XHRcdFx0XHR9KTtcblx0XHRcdFx0fSBjYXRjaCAocGlwZWxpbmVFcnIpIHtcblx0XHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQuY3JlYXRlUGlwZWxpbmUnLCBgQ3JlYXRpbmcgcGlwZWxpbmUgd2l0aCBtb2RlbCBYZW5vdmEvYWxsLU1pbmlMTS1MNi12MiwgY2FjaGU6ICR7Y2FjaGVEaXJ9YCwgcGlwZWxpbmVFcnIpO1xuXHRcdFx0XHRcdHRocm93IHBpcGVsaW5lRXJyO1xuXHRcdFx0XHR9XG5cdFx0XHRcdFxuXHRcdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcblx0XHRcdFx0Y29uc29sZS5sb2coYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJMgTW9kZWwgcGlwZWxpbmUgY3JlYXRlZGApO1xuXG5cdFx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRcdGNvbnN0IG91dCA9IGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KTtcblx0XHRcdFx0XHRcdC8vIHRyYW5zZm9ybWVycyBvdXRwdXQgY2FuIHZhcnk7IGhhbmRsZSBjb21tb24gY2FzZXMuXG5cdFx0XHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xuXHRcdFx0XHRcdFx0XHRyZXR1cm4gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcblx0XHRcdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xuXHRcdFx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkobWF5YmU/LmRhdGEpKSByZXR1cm4gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XG5cdFx0XHRcdFx0XHRjb25zdCBlcnIgPSBuZXcgRXJyb3IoYFVuZXhwZWN0ZWQgZW1iZWRkaW5ncyBvdXRwdXQgZm9ybWF0OiAke3R5cGVvZiBvdXR9LCBpc0FycmF5OiAke0FycmF5LmlzQXJyYXkob3V0KX1gKTtcblx0XHRcdFx0XHRcdHRoaXMubG9nRXJyb3IoJ3BpcGVsaW5lLmVtYmVkJywgYFByb2Nlc3NpbmcgdGV4dCAoJHt0ZXh0Lmxlbmd0aH0gY2hhcnMpYCwgZXJyKTtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBVbmV4cGVjdGVkIG91dHB1dCBmb3JtYXQ6YCwgdHlwZW9mIG91dCwgQXJyYXkuaXNBcnJheShvdXQpLCBvdXQpO1xuXHRcdFx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRcdFx0dGhpcy5sb2dFcnJvcigncGlwZWxpbmUuZW1iZWQnLCBgR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIHRleHQgKCR7dGV4dC5sZW5ndGh9IGNoYXJzLCAke3RleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWAsIGVycik7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRXJyb3IgZHVyaW5nIGVtYmVkZGluZyBnZW5lcmF0aW9uOmAsIGVycik7XG5cdFx0XHRcdFx0XHR0aHJvdyBlcnI7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHRjb25zdCBsb2FkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gbG9hZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIOKckyBNb2RlbCBmdWxseSBsb2FkZWQgaW4gJHtsb2FkRHVyYXRpb259bXNgKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdlbnN1cmVMb2FkZWQnLCBgTW9kZWwgbG9hZGluZyBhdHRlbXB0ICMke3RoaXMubG9hZEF0dGVtcHRzfWAsIGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSDinJcgTW9kZWwgbG9hZGluZyBmYWlsZWQ6YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCA1KS5qb2luKCdcXG4nKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0dGhyb3cgZXJyO1xuXHRcdFx0fVxuXHRcdH0pKCkuZmluYWxseSgoKSA9PiB7XG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xuXHRcdH0pO1xuXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcblx0fVxuXG5cdGFzeW5jIGlzUmVhZHkoKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0dHJ5IHtcblx0XHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cdFx0XHRyZXR1cm4gdGhpcy5waXBlbGluZSAhPT0gbnVsbDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2lzUmVhZHknLCAnQ2hlY2tpbmcgbW9kZWwgcmVhZGluZXNzJywgZXJyKTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogTW9kZWxFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRMYXN0TG9hZEVycm9yKCk6IE1vZGVsRXJyb3JMb2dFbnRyeSB8IG51bGwge1xuXHRcdHJldHVybiB0aGlzLmxhc3RMb2FkRXJyb3I7XG5cdH1cblxuXHRnZXRMb2FkQXR0ZW1wdHMoKTogbnVtYmVyIHtcblx0XHRyZXR1cm4gdGhpcy5sb2FkQXR0ZW1wdHM7XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXHRcdFxuXHRcdGNvbnN0IGVudHJ5OiBNb2RlbEVycm9yTG9nRW50cnkgPSB7XG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGxvY2F0aW9uLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXG5cdFx0XHRlcnJvclR5cGVcblx0XHR9O1xuXHRcdFxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gU3RvcmUgYXMgbGFzdCBsb2FkIGVycm9yIGlmIGl0J3MgYSBsb2FkaW5nIGVycm9yXG5cdFx0aWYgKGxvY2F0aW9uID09PSAnZW5zdXJlTG9hZGVkJyB8fCBsb2NhdGlvbiA9PT0gJ2lzUmVhZHknKSB7XG5cdFx0XHR0aGlzLmxhc3RMb2FkRXJyb3IgPSBlbnRyeTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtMb2NhbEVtYmVkZGluZ01vZGVsXSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xuXHRcdGlmICghdCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gRW1wdHkgdGV4dCBwcm92aWRlZCwgcmV0dXJuaW5nIHplcm8gdmVjdG9yYCk7XG5cdFx0XHRyZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XG5cdFx0fVxuXHRcdHRyeSB7XG5cdFx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXHRcdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB7XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5ncyBwaXBlbGluZSB1bmF2YWlsYWJsZSBhZnRlciBsb2FkaW5nIGF0dGVtcHQnKTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0Y29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcblx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcblx0XHRcdGNvbnNvbGUubG9nKGBbTG9jYWxFbWJlZGRpbmdNb2RlbF0gR2VuZXJhdGVkIGVtYmVkZGluZyBpbiAke2VtYmVkRHVyYXRpb259bXMgZm9yIHRleHQgKCR7dC5sZW5ndGh9IGNoYXJzLCAke3Quc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKWApO1xuXHRcdFx0cmV0dXJuIHJlc3VsdDtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdHRoaXMubG9nRXJyb3IoJ2VtYmVkJywgYEVtYmVkZGluZyB0ZXh0ICgke3QubGVuZ3RofSBjaGFycywgJHt0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcylgLCBlcnIpO1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0xvY2FsRW1iZWRkaW5nTW9kZWxdIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZDpgLCBlcnIpO1xuXHRcdFx0dGhyb3cgZXJyO1xuXHRcdH1cblx0fVxufVxuXG5cbiJdfQ==