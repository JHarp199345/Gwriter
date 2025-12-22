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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTG9jYWxFbWJlZGRpbmdNb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxvY2FsRW1iZWRkaW5nTW9kZWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBU0EsU0FBUyxXQUFXLENBQUMsR0FBYTtJQUNqQyxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDZCxLQUFLLE1BQU0sQ0FBQyxJQUFJLEdBQUc7UUFBRSxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNwQyxNQUFNLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUNuQyxPQUFPLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQztBQUNqQyxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLHlCQUF5QjtJQVNyQyxZQUFZLEtBQVksRUFBRSxNQUE4QjtRQVIvQyxPQUFFLEdBQUcsUUFBUSxDQUFDO1FBQ2QsUUFBRyxHQUFHLEdBQUcsQ0FBQztRQUlYLGFBQVEsR0FBaUQsSUFBSSxDQUFDO1FBQzlELFlBQU8sR0FBeUIsSUFBSSxDQUFDO1FBRzVDLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO1FBQ25CLElBQUksQ0FBQyxNQUFNLEdBQUcsTUFBTSxDQUFDO0lBQ3RCLENBQUM7SUFFTyxLQUFLLENBQUMsWUFBWTtRQUN6QixJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTztRQUMxQixJQUFJLElBQUksQ0FBQyxPQUFPLEtBQUssSUFBSTtZQUFFLE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztRQUUvQyxJQUFJLENBQUMsT0FBTyxHQUFHLENBQUMsS0FBSyxJQUFJLEVBQUU7WUFDMUIsMERBQTBEO1lBQzFELE1BQU0sbUJBQW1CLEdBQVksTUFBTSxNQUFNLENBQUMsc0JBQXNCLENBQUMsQ0FBQztZQUMxRSxNQUFNLFlBQVksR0FBRyxtQkFFcEIsQ0FBQztZQUNGLElBQUksQ0FBQyxZQUFZLENBQUMsUUFBUTtnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxDQUFDLENBQUM7WUFFcEYsdUVBQXVFO1lBQ3ZFLG9FQUFvRTtZQUNwRSxNQUFNLFFBQVEsR0FBRyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxZQUFZLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEVBQUUsbUJBQW1CLENBQUM7WUFFL0YsTUFBTSxXQUFXLEdBQUcsTUFBTSxZQUFZLENBQUMsUUFBUSxDQUFDLG9CQUFvQixFQUFFLHlCQUF5QixFQUFFO2dCQUNoRyxTQUFTLEVBQUUsSUFBSTtnQkFDZixpQkFBaUIsRUFBRSxTQUFTO2dCQUM1QixTQUFTLEVBQUUsUUFBUTthQUNuQixDQUFDLENBQUM7WUFDSCxNQUFNLElBQUksR0FBRyxXQUFrRixDQUFDO1lBRWhHLElBQUksQ0FBQyxRQUFRLEdBQUcsS0FBSyxFQUFFLElBQVksRUFBRSxFQUFFO2dCQUN0QyxNQUFNLEdBQUcsR0FBRyxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksRUFBRSxFQUFFLE9BQU8sRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQUksRUFBRSxDQUFDLENBQVksQ0FBQztnQkFDaEYscURBQXFEO2dCQUNyRCxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO29CQUNqRCxPQUFPLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFhLENBQUMsQ0FBQztnQkFDeEMsQ0FBQztnQkFDRCxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztvQkFDeEIsT0FBTyxXQUFXLENBQUMsR0FBZSxDQUFDLENBQUM7Z0JBQ3JDLENBQUM7Z0JBQ0QsTUFBTSxLQUFLLEdBQUcsR0FBMEIsQ0FBQztnQkFDekMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUM7b0JBQUUsT0FBTyxXQUFXLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUMvRCxNQUFNLElBQUksS0FBSyxDQUFDLDhCQUE4QixDQUFDLENBQUM7WUFDakQsQ0FBQyxDQUFDO1FBQ0gsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxPQUFPLENBQUMsR0FBRyxFQUFFO1lBQ2pCLElBQUksQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDO1FBQ3JCLENBQUMsQ0FBQyxDQUFDO1FBRUgsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDO0lBQ3JCLENBQUM7SUFFRCxLQUFLLENBQUMsS0FBSyxDQUFDLElBQVk7UUFDdkIsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDOUIsSUFBSSxDQUFDLENBQUM7WUFBRSxPQUFPLElBQUksS0FBSyxDQUFTLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7UUFDbkQsTUFBTSxJQUFJLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDMUIsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRO1lBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxpQ0FBaUMsQ0FBQyxDQUFDO1FBQ3ZFLE9BQU8sTUFBTSxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQy9CLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBMb2NhbEVtYmVkZGluZ01vZGVsIHtcclxuXHRyZWFkb25seSBpZDogc3RyaW5nO1xyXG5cdHJlYWRvbmx5IGRpbTogbnVtYmVyO1xyXG5cdGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+O1xyXG59XHJcblxyXG5mdW5jdGlvbiBsMk5vcm1hbGl6ZSh2ZWM6IG51bWJlcltdKTogbnVtYmVyW10ge1xyXG5cdGxldCBzdW1TcSA9IDA7XHJcblx0Zm9yIChjb25zdCB2IG9mIHZlYykgc3VtU3EgKz0gdiAqIHY7XHJcblx0Y29uc3Qgbm9ybSA9IE1hdGguc3FydChzdW1TcSkgfHwgMTtcclxuXHRyZXR1cm4gdmVjLm1hcCgodikgPT4gdiAvIG5vcm0pO1xyXG59XHJcblxyXG4vKipcclxuICogVHJ1ZSBsb2NhbCBlbWJlZGRpbmdzIHVzaW5nIEB4ZW5vdmEvdHJhbnNmb3JtZXJzIChXQVNNKS4gTG9hZGVkIGxhemlseS5cclxuICogRmFsbHMgYmFjayB0byB0aHJvd2luZyBvbiBsb2FkIGZhaWx1cmU7IGNhbGxlcnMgc2hvdWxkIGNhdGNoIGFuZCB1c2UgaGV1cmlzdGljL2hhc2guXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgTWluaUxtTG9jYWxFbWJlZGRpbmdNb2RlbCBpbXBsZW1lbnRzIExvY2FsRW1iZWRkaW5nTW9kZWwge1xyXG5cdHJlYWRvbmx5IGlkID0gJ21pbmlsbSc7XHJcblx0cmVhZG9ubHkgZGltID0gMzg0O1xyXG5cclxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcclxuXHRwcml2YXRlIHBpcGVsaW5lOiBudWxsIHwgKCh0ZXh0OiBzdHJpbmcpID0+IFByb21pc2U8bnVtYmVyW10+KSA9IG51bGw7XHJcblx0cHJpdmF0ZSBsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0aWYgKHRoaXMucGlwZWxpbmUpIHJldHVybjtcclxuXHRcdGlmICh0aGlzLmxvYWRpbmcgIT09IG51bGwpIHJldHVybiB0aGlzLmxvYWRpbmc7XHJcblxyXG5cdFx0dGhpcy5sb2FkaW5nID0gKGFzeW5jICgpID0+IHtcclxuXHRcdFx0Ly8gRHluYW1pYyBpbXBvcnQgdG8gYXZvaWQgYnVuZGxpbmcgd2VpZ2h0IHVubGVzcyBlbmFibGVkLlxyXG5cdFx0XHRjb25zdCB0cmFuc2Zvcm1lcnNVbmtub3duOiB1bmtub3duID0gYXdhaXQgaW1wb3J0KCdAeGVub3ZhL3RyYW5zZm9ybWVycycpO1xyXG5cdFx0XHRjb25zdCB0cmFuc2Zvcm1lcnMgPSB0cmFuc2Zvcm1lcnNVbmtub3duIGFzIHtcclxuXHRcdFx0XHRwaXBlbGluZT86ICh0YXNrOiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHRcdFx0fTtcclxuXHRcdFx0aWYgKCF0cmFuc2Zvcm1lcnMucGlwZWxpbmUpIHRocm93IG5ldyBFcnJvcignVHJhbnNmb3JtZXJzIHBpcGVsaW5lIGlzIHVuYXZhaWxhYmxlJyk7XHJcblxyXG5cdFx0XHQvLyBDYWNoZSBtb2RlbHMgaW5zaWRlIHBsdWdpbiBkYXRhIHRvIGF2b2lkIHJlLWRvd25sb2FkaW5nIGlmIHBvc3NpYmxlLlxyXG5cdFx0XHQvLyBOb3RlOiB0cmFuc2Zvcm1lcnMgdXNlcyBpdHMgb3duIGNhY2hpbmcgc3RyYXRlZ3k7IHRoaXMgaXMgYSBoaW50LlxyXG5cdFx0XHRjb25zdCBjYWNoZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleC9tb2RlbHNgO1xyXG5cclxuXHRcdFx0Y29uc3QgcGlwZVVua25vd24gPSBhd2FpdCB0cmFuc2Zvcm1lcnMucGlwZWxpbmUoJ2ZlYXR1cmUtZXh0cmFjdGlvbicsICdYZW5vdmEvYWxsLU1pbmlMTS1MNi12MicsIHtcclxuXHRcdFx0XHRxdWFudGl6ZWQ6IHRydWUsXHJcblx0XHRcdFx0cHJvZ3Jlc3NfY2FsbGJhY2s6IHVuZGVmaW5lZCxcclxuXHRcdFx0XHRjYWNoZV9kaXI6IGNhY2hlRGlyXHJcblx0XHRcdH0pO1xyXG5cdFx0XHRjb25zdCBwaXBlID0gcGlwZVVua25vd24gYXMgKGlucHV0OiBzdHJpbmcsIG9wdHM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gUHJvbWlzZTx1bmtub3duPjtcclxuXHJcblx0XHRcdHRoaXMucGlwZWxpbmUgPSBhc3luYyAodGV4dDogc3RyaW5nKSA9PiB7XHJcblx0XHRcdFx0Y29uc3Qgb3V0ID0gKGF3YWl0IHBpcGUodGV4dCwgeyBwb29saW5nOiAnbWVhbicsIG5vcm1hbGl6ZTogdHJ1ZSB9KSkgYXMgdW5rbm93bjtcclxuXHRcdFx0XHQvLyB0cmFuc2Zvcm1lcnMgb3V0cHV0IGNhbiB2YXJ5OyBoYW5kbGUgY29tbW9uIGNhc2VzLlxyXG5cdFx0XHRcdGlmIChBcnJheS5pc0FycmF5KG91dCkgJiYgQXJyYXkuaXNBcnJheShvdXRbMF0pKSB7XHJcblx0XHRcdFx0XHRyZXR1cm4gbDJOb3JtYWxpemUob3V0WzBdIGFzIG51bWJlcltdKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkob3V0KSkge1xyXG5cdFx0XHRcdFx0cmV0dXJuIGwyTm9ybWFsaXplKG91dCBhcyBudW1iZXJbXSk7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHRcdGNvbnN0IG1heWJlID0gb3V0IGFzIHsgZGF0YT86IG51bWJlcltdIH07XHJcblx0XHRcdFx0aWYgKEFycmF5LmlzQXJyYXkobWF5YmU/LmRhdGEpKSByZXR1cm4gbDJOb3JtYWxpemUobWF5YmUuZGF0YSk7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIGVtYmVkZGluZ3Mgb3V0cHV0Jyk7XHJcblx0XHRcdH07XHJcblx0XHR9KSgpLmZpbmFsbHkoKCkgPT4ge1xyXG5cdFx0XHR0aGlzLmxvYWRpbmcgPSBudWxsO1xyXG5cdFx0fSk7XHJcblxyXG5cdFx0cmV0dXJuIHRoaXMubG9hZGluZztcclxuXHR9XHJcblxyXG5cdGFzeW5jIGVtYmVkKHRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHQgPSAodGV4dCB8fCAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCF0KSByZXR1cm4gbmV3IEFycmF5PG51bWJlcj4odGhpcy5kaW0pLmZpbGwoMCk7XHJcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xyXG5cdFx0aWYgKCF0aGlzLnBpcGVsaW5lKSB0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZ3MgcGlwZWxpbmUgdW5hdmFpbGFibGUnKTtcclxuXHRcdHJldHVybiBhd2FpdCB0aGlzLnBpcGVsaW5lKHQpO1xyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==