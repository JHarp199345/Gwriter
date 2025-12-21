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
        if (this.loading)
            return this.loading;
        this.loading = (async () => {
            // Dynamic import to avoid bundling weight unless enabled.
            const transformers = (await import('@xenova/transformers'));
            // Cache models inside plugin data to avoid re-downloading if possible.
            // Note: transformers uses its own caching strategy; this is a hint.
            const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
            const pipe = (await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                quantized: true,
                progress_callback: undefined,
                cache_dir: cacheDir
            }));
            this.pipeline = async (text) => {
                const out = (await pipe(text, { pooling: 'mean', normalize: true }));
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBU0EsU0FBUyxXQUFXLENBQUMsR0FBYTtJQUNqQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDZCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEdBQUc7UUFBRSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNwQyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuQyxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztBQUNqQyxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLHlCQUF5QjtJQVNyQyxZQUFZLEtBQVksRUFBRSxNQUE4QjtRQVIvQyxPQUFFLEdBQUcsUUFBUSxDQUFDO1FBQ2QsUUFBRyxHQUFHLEdBQUcsQ0FBQztRQUlYLGFBQVEsR0FBaUQsSUFBSSxDQUFDO1FBQzlELFlBQU8sR0FBeUIsSUFBSSxDQUFDO1FBRzVDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFTyxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPO1lBQUUsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDO1FBRXRDLElBQUksQ0FBQyxPQUFPLEdBQUcsQ0FBQyxLQUFLLElBQUksRUFBRTtZQUMxQiwwREFBMEQ7WUFDMUQsTUFBTSxZQUFZLEdBQUcsQ0FBQyxNQUFNLE1BQU0sQ0FBQyxzQkFBc0IsQ0FBQyxDQUV6RCxDQUFDO1lBRUYsdUVBQXVFO1lBQ3ZFLG9FQUFvRTtZQUNwRSxNQUFNLFFBQVEsR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsbUJBQW1CLENBQUM7WUFFL0YsTUFBTSxJQUFJLEdBQUcsQ0FBQyxNQUFNLFlBQVksQ0FBQyxRQUFRLENBQUMsb0JBQW9CLEVBQUUseUJBQXlCLEVBQUU7Z0JBQzFGLFNBQVMsRUFBRSxJQUFJO2dCQUNmLGlCQUFpQixFQUFFLFNBQVM7Z0JBQzVCLFNBQVMsRUFBRSxRQUFRO2FBQ25CLENBQUMsQ0FBbUYsQ0FBQztZQUV0RixJQUFJLENBQUMsUUFBUSxHQUFHLEtBQUssRUFBRSxJQUFZLEVBQUUsRUFBRTtnQkFDdEMsTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLEVBQUUsRUFBRSxPQUFPLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFZLENBQUM7Z0JBQ2hGLHFEQUFxRDtnQkFDckQsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztvQkFDakQsT0FBTyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBYSxDQUFDLENBQUM7Z0JBQ3hDLENBQUM7Z0JBQ0QsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7b0JBQ3hCLE9BQU8sV0FBVyxDQUFDLEdBQWUsQ0FBQyxDQUFDO2dCQUNyQyxDQUFDO2dCQUNELE1BQU0sS0FBSyxHQUFHLEdBQTBCLENBQUM7Z0JBQ3pDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDO29CQUFFLE9BQU8sV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztnQkFDL0QsTUFBTSxJQUFJLEtBQUssQ0FBQyw4QkFBOEIsQ0FBQyxDQUFDO1lBQ2pELENBQUMsQ0FBQztRQUNILENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLEdBQUcsRUFBRTtZQUNqQixJQUFJLENBQUMsT0FBTyxHQUFHLElBQUksQ0FBQztRQUNyQixDQUFDLENBQUMsQ0FBQztRQUVILE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztJQUNyQixDQUFDO0lBRUQsS0FBSyxDQUFDLEtBQUssQ0FBQyxJQUFZO1FBQ3ZCLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQzlCLElBQUksQ0FBQyxDQUFDO1lBQUUsT0FBTyxJQUFJLEtBQUssQ0FBUyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ25ELE1BQU0sSUFBSSxDQUFDLFlBQVksRUFBRSxDQUFDO1FBQzFCLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUTtZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsaUNBQWlDLENBQUMsQ0FBQztRQUN2RSxPQUFPLE1BQU0sSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvQixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTG9jYWxFbWJlZGRpbmdNb2RlbCB7XHJcblx0cmVhZG9ubHkgaWQ6IHN0cmluZztcclxuXHRyZWFkb25seSBkaW06IG51bWJlcjtcclxuXHRlbWJlZCh0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPjtcclxufVxyXG5cclxuZnVuY3Rpb24gbDJOb3JtYWxpemUodmVjOiBudW1iZXJbXSk6IG51bWJlcltdIHtcclxuXHRsZXQgc3VtU3EgPSAwO1xyXG5cdGZvciAoY29uc3QgdiBvZiB2ZWMpIHN1bVNxICs9IHYgKiB2O1xyXG5cdGNvbnN0IG5vcm0gPSBNYXRoLnNxcnQoc3VtU3EpIHx8IDE7XHJcblx0cmV0dXJuIHZlYy5tYXAoKHYpID0+IHYgLyBub3JtKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRydWUgbG9jYWwgZW1iZWRkaW5ncyB1c2luZyBAeGVub3ZhL3RyYW5zZm9ybWVycyAoV0FTTSkuIExvYWRlZCBsYXppbHkuXHJcbiAqIEZhbGxzIGJhY2sgdG8gdGhyb3dpbmcgb24gbG9hZCBmYWlsdXJlOyBjYWxsZXJzIHNob3VsZCBjYXRjaCBhbmQgdXNlIGhldXJpc3RpYy9oYXNoLlxyXG4gKi9cclxuZXhwb3J0IGNsYXNzIE1pbmlMbUxvY2FsRW1iZWRkaW5nTW9kZWwgaW1wbGVtZW50cyBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZCA9ICdtaW5pbG0nO1xyXG5cdHJlYWRvbmx5IGRpbSA9IDM4NDtcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSBwaXBlbGluZTogbnVsbCB8ICgodGV4dDogc3RyaW5nKSA9PiBQcm9taXNlPG51bWJlcltdPikgPSBudWxsO1xyXG5cdHByaXZhdGUgbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xyXG5cclxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbikge1xyXG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGlmICh0aGlzLnBpcGVsaW5lKSByZXR1cm47XHJcblx0XHRpZiAodGhpcy5sb2FkaW5nKSByZXR1cm4gdGhpcy5sb2FkaW5nO1xyXG5cclxuXHRcdHRoaXMubG9hZGluZyA9IChhc3luYyAoKSA9PiB7XHJcblx0XHRcdC8vIER5bmFtaWMgaW1wb3J0IHRvIGF2b2lkIGJ1bmRsaW5nIHdlaWdodCB1bmxlc3MgZW5hYmxlZC5cclxuXHRcdFx0Y29uc3QgdHJhbnNmb3JtZXJzID0gKGF3YWl0IGltcG9ydCgnQHhlbm92YS90cmFuc2Zvcm1lcnMnKSkgYXMgdW5rbm93biBhcyB7XHJcblx0XHRcdFx0cGlwZWxpbmU6ICh0YXNrOiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0fTtcclxuXHJcblx0XHRcdC8vIENhY2hlIG1vZGVscyBpbnNpZGUgcGx1Z2luIGRhdGEgdG8gYXZvaWQgcmUtZG93bmxvYWRpbmcgaWYgcG9zc2libGUuXHJcblx0XHRcdC8vIE5vdGU6IHRyYW5zZm9ybWVycyB1c2VzIGl0cyBvd24gY2FjaGluZyBzdHJhdGVneTsgdGhpcyBpcyBhIGhpbnQuXHJcblx0XHRcdGNvbnN0IGNhY2hlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4L21vZGVsc2A7XHJcblxyXG5cdFx0XHRjb25zdCBwaXBlID0gKGF3YWl0IHRyYW5zZm9ybWVycy5waXBlbGluZSgnZmVhdHVyZS1leHRyYWN0aW9uJywgJ1hlbm92YS9hbGwtTWluaUxNLUw2LXYyJywge1xyXG5cdFx0XHRcdHF1YW50aXplZDogdHJ1ZSxcclxuXHRcdFx0XHRwcm9ncmVzc19jYWxsYmFjazogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdGNhY2hlX2RpcjogY2FjaGVEaXJcclxuXHRcdFx0fSkpIGFzIHVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHJcblx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0Y29uc3Qgb3V0ID0gKGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KSkgYXMgdW5rbm93bjtcclxuXHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkgJiYgQXJyYXkuaXNBcnJheShvdXRbMF0pKSB7XHJcblx0XHRcdFx0XHRyZXR1cm4gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSkge1xyXG5cdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGNvbnN0IG1heWJlID0gb3V0IGFzIHsgZGF0YT86IG51bWJlcltdIH07XHJcblx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkobWF5YmU/LmRhdGEpKSByZXR1cm4gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIGVtYmVkZGluZ3Mgb3V0cHV0Jyk7XHJcblx0XHRcdH07XHJcblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xyXG5cdFx0fSk7XHJcblxyXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSByZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUnKTtcclxuXHRcdHJldHVybiBhd2FpdCB0aGlzLnBpcGVsaW5lKHQpO1xyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==