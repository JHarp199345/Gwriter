function l2Normalize(vec) {
    let sumSq = 0;
    for (const v of vec)
        sumSq += v * v;
    const norm = Math.sqrt(sumSq) || 1;
    return vec.map((v) => v / norm);
}
/**
 * True local embeddings using @xenova/transformers (WASM). Loaded lazily.
 * Falls back to throwing on load failure; callers should catch and use heuristic/hash.
 */
export class MiniLmLocalEmbeddingModel {
    constructor(vault, plugin) {
        this.id = 'minilm';
        this.dim = 384;
        this.pipeline = null;
        this.loading = null;
        this.vault = vault;
        this.plugin = plugin;
    }
    async ensureLoaded() {
        if (this.pipeline)
            return;
        if (this.loading !== null)
            return this.loading;
        this.loading = (async () => {
            // Dynamic import to avoid bundling weight unless enabled.
            const transformersUnknown = await import('@xenova/transformers');
            const transformers = transformersUnknown;
            if (!transformers.pipeline)
                throw new Error('Transformers pipeline is unavailable');
            // Cache models inside plugin data to avoid re-downloading if possible.
            // Note: transformers uses its own caching strategy; this is a hint.
            const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
            const pipeUnknown = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                quantized: true,
                progress_callback: undefined,
                cache_dir: cacheDir
            });
            const pipe = pipeUnknown;
            this.pipeline = async (text) => {
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
                throw new Error('Unexpected embeddings output');
            };
        })().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }
    async embed(text) {
        const t = (text || '').trim();
        if (!t)
            return new Array(this.dim).fill(0);
        await this.ensureLoaded();
        if (!this.pipeline)
            throw new Error('Embeddings pipeline unavailable');
        return await this.pipeline(t);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBU0EsU0FBUyxXQUFXLENBQUMsR0FBYTtJQUNqQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDZCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEdBQUc7UUFBRSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNwQyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuQyxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztBQUNqQyxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLHlCQUF5QjtJQVNyQyxZQUFZLEtBQVksRUFBRSxNQUE4QjtRQVIvQyxPQUFFLEdBQUcsUUFBUSxDQUFDO1FBQ2QsUUFBRyxHQUFHLEdBQUcsQ0FBQztRQUlYLGFBQVEsR0FBaUQsSUFBSSxDQUFDO1FBQzlELFlBQU8sR0FBeUIsSUFBSSxDQUFDO1FBRzVDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFTyxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsMERBQTBEO1lBQzFELE1BQU0sbUJBQW1CLEdBQVksTUFBTSxNQUFNLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUMxRSxNQUFNLFlBQVksR0FBRyxtQkFFcEIsQ0FBQztZQUNGLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxDQUFDLENBQUM7WUFFcEYsdUVBQXVFO1lBQ3ZFLG9FQUFvRTtZQUNwRSxNQUFNLFFBQVEsR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsbUJBQW1CLENBQUM7WUFFL0YsTUFBTSxXQUFXLEdBQUcsTUFBTSxZQUFZLENBQUMsUUFBUSxDQUFDLG9CQUFvQixFQUFFLHlCQUF5QixFQUFFO2dCQUNoRyxTQUFTLEVBQUUsSUFBSTtnQkFDZixpQkFBaUIsRUFBRSxTQUFTO2dCQUM1QixTQUFTLEVBQUUsUUFBUTthQUNuQixDQUFDLENBQUM7WUFDSCxNQUFNLElBQUksR0FBRyxXQUFrRixDQUFDO1lBRWhHLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxFQUFFLElBQVksRUFBRSxFQUFFO2dCQUN0QyxNQUFNLEdBQUcsR0FBRyxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO2dCQUNuRSxxREFBcUQ7Z0JBQ3JELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7b0JBQ2pELE9BQU8sV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQWEsQ0FBQyxDQUFDO2dCQUN4QyxDQUFDO2dCQUNELElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO29CQUN4QixPQUFPLFdBQVcsQ0FBQyxHQUFlLENBQUMsQ0FBQztnQkFDckMsQ0FBQztnQkFDRCxNQUFNLEtBQUssR0FBRyxHQUEwQixDQUFDO2dCQUN6QyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztvQkFBRSxPQUFPLFdBQVcsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUM7Z0JBQy9ELE1BQU0sSUFBSSxLQUFLLENBQUMsOEJBQThCLENBQUMsQ0FBQztZQUNqRCxDQUFDLENBQUM7UUFDSCxDQUFDLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxHQUFHLEVBQUU7WUFDakIsSUFBSSxDQUFDLE9BQU8sR0FBRyxJQUFJLENBQUM7UUFDckIsQ0FBQyxDQUFDLENBQUM7UUFFSCxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUM7SUFDckIsQ0FBQztJQUVELEtBQUssQ0FBQyxLQUFLLENBQUMsSUFBWTtRQUN2QixNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUM5QixJQUFJLENBQUMsQ0FBQztZQUFFLE9BQU8sSUFBSSxLQUFLLENBQVMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNuRCxNQUFNLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUMxQixJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVE7WUFBRSxNQUFNLElBQUksS0FBSyxDQUFDLGlDQUFpQyxDQUFDLENBQUM7UUFDdkUsT0FBTyxNQUFNLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDL0IsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkOiBzdHJpbmc7XHJcblx0cmVhZG9ubHkgZGltOiBudW1iZXI7XHJcblx0ZW1iZWQodGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT47XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGwyTm9ybWFsaXplKHZlYzogbnVtYmVyW10pOiBudW1iZXJbXSB7XHJcblx0bGV0IHN1bVNxID0gMDtcclxuXHRmb3IgKGNvbnN0IHYgb2YgdmVjKSBzdW1TcSArPSB2ICogdjtcclxuXHRjb25zdCBub3JtID0gTWF0aC5zcXJ0KHN1bVNxKSB8fCAxO1xyXG5cdHJldHVybiB2ZWMubWFwKCh2KSA9PiB2IC8gbm9ybSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUcnVlIGxvY2FsIGVtYmVkZGluZ3MgdXNpbmcgQHhlbm92YS90cmFuc2Zvcm1lcnMgKFdBU00pLiBMb2FkZWQgbGF6aWx5LlxyXG4gKiBGYWxscyBiYWNrIHRvIHRocm93aW5nIG9uIGxvYWQgZmFpbHVyZTsgY2FsbGVycyBzaG91bGQgY2F0Y2ggYW5kIHVzZSBoZXVyaXN0aWMvaGFzaC5cclxuICovXHJcbmV4cG9ydCBjbGFzcyBNaW5pTG1Mb2NhbEVtYmVkZGluZ01vZGVsIGltcGxlbWVudHMgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQgPSAnbWluaWxtJztcclxuXHRyZWFkb25seSBkaW0gPSAzODQ7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcGlwZWxpbmU6IG51bGwgfCAoKHRleHQ6IHN0cmluZykgPT4gUHJvbWlzZTxudW1iZXJbXT4pID0gbnVsbDtcclxuXHRwcml2YXRlIGxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4pIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRpZiAodGhpcy5waXBlbGluZSkgcmV0dXJuO1xyXG5cdFx0aWYgKHRoaXMubG9hZGluZyAhPT0gbnVsbCkgcmV0dXJuIHRoaXMubG9hZGluZztcclxuXHJcblx0XHR0aGlzLmxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xyXG5cdFx0XHQvLyBEeW5hbWljIGltcG9ydCB0byBhdm9pZCBidW5kbGluZyB3ZWlnaHQgdW5sZXNzIGVuYWJsZWQuXHJcblx0XHRcdGNvbnN0IHRyYW5zZm9ybWVyc1Vua25vd246IHVua25vd24gPSBhd2FpdCBpbXBvcnQoJ0B4ZW5vdmEvdHJhbnNmb3JtZXJzJyk7XHJcblx0XHRcdGNvbnN0IHRyYW5zZm9ybWVycyA9IHRyYW5zZm9ybWVyc1Vua25vd24gYXMge1xyXG5cdFx0XHRcdHBpcGVsaW5lPzogKHRhc2s6IHN0cmluZywgbW9kZWw6IHN0cmluZywgb3B0cz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cdFx0XHR9O1xyXG5cdFx0XHRpZiAoIXRyYW5zZm9ybWVycy5waXBlbGluZSkgdGhyb3cgbmV3IEVycm9yKCdUcmFuc2Zvcm1lcnMgcGlwZWxpbmUgaXMgdW5hdmFpbGFibGUnKTtcclxuXHJcblx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXHJcblx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdGNvbnN0IGNhY2hlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L21vZGVsc2A7XHJcblxyXG5cdFx0XHRjb25zdCBwaXBlVW5rbm93biA9IGF3YWl0IHRyYW5zZm9ybWVycy5waXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xyXG5cdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcclxuXHRcdFx0fSk7XHJcblx0XHRcdGNvbnN0IHBpcGUgPSBwaXBlVW5rbm93biBhcyAoaW5wdXQ6IHN0cmluZywgb3B0cz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBQcm9taXNlPHVua25vd24+O1xyXG5cclxuXHRcdFx0dGhpcy5waXBlbGluZSA9IGFzeW5jICh0ZXh0OiBzdHJpbmcpID0+IHtcclxuXHRcdFx0XHRjb25zdCBvdXQgPSBhd2FpdCBwaXBlKHRleHQsIHsgcG9vbGluZzogJ21lYW4nLCBub3JtYWxpemU6IHRydWUgfSk7XHJcblx0XHRcdFx0Ly8gdHJhbnNmb3JtZXJzIG91dHB1dCBjYW4gdmFyeTsgaGFuZGxlIGNvbW1vbiBjYXNlcy5cclxuXHRcdFx0XHRpZiAoQXJyYXkuaXNBcnJheShvdXQpICYmIEFycmF5LmlzQXJyYXkob3V0WzBdKSkge1xyXG5cdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dFswXSBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkpIHtcclxuXHRcdFx0XHRcdHJldHVybiBsMk5vcm1hbGl6ZShvdXQgYXMgbnVtYmVyW10pO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRjb25zdCBtYXliZSA9IG91dCBhcyB7IGRhdGE/OiBudW1iZXJbXSB9O1xyXG5cdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG1heWJlPy5kYXRhKSkgcmV0dXJuIGwyTm9ybWFsaXplKG1heWJlLmRhdGEpO1xyXG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBlbWJlZGRpbmdzIG91dHB1dCcpO1xyXG5cdFx0XHR9O1xyXG5cdFx0fSkoKS5maW5hbGx5KCgpID0+IHtcclxuXHRcdFx0dGhpcy5sb2FkaW5nID0gbnVsbDtcclxuXHRcdH0pO1xyXG5cclxuXHRcdHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblx0fVxyXG5cclxuXHRhc3luYyBlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCB0ID0gKHRleHQgfHwgJycpLnRyaW0oKTtcclxuXHRcdGlmICghdCkgcmV0dXJuIG5ldyBBcnJheTxudW1iZXI+KHRoaXMuZGltKS5maWxsKDApO1xyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcclxuXHRcdGlmICghdGhpcy5waXBlbGluZSkgdGhyb3cgbmV3IEVycm9yKCdFbWJlZGRpbmdzIHBpcGVsaW5lIHVuYXZhaWxhYmxlJyk7XHJcblx0XHRyZXR1cm4gYXdhaXQgdGhpcy5waXBlbGluZSh0KTtcclxuXHR9XHJcbn1cclxuXHJcblxyXG4iXX0=