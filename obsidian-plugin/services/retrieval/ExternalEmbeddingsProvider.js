import { requestUrl } from 'obsidian';
function dot(a, b) {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++)
        s += a[i] * b[i];
    return s;
}
export class ExternalEmbeddingsProvider {
    constructor(plugin, embeddingsIndex, isEnabled, isAllowedPath) {
        this.id = 'external-embeddings';
        // Cache for embedding vectors (query text -> vector)
        this.embeddingCache = new Map();
        this.cacheTtl = 3600000; // 1 hour
        // Rate limiting infrastructure
        this.requestQueue = [];
        this.requestInFlight = false;
        this.maxConcurrentRequests = 1; // Serialize requests to avoid bursts
        this.minRequestInterval = 100; // Minimum 100ms between requests
        this.lastRequestTime = 0;
        this.retryConfig = {
            maxRetries: 3,
            baseDelay: 1000, // 1 second
            maxDelay: 10000, // 10 seconds
            backoffMultiplier: 2
        };
        this.plugin = plugin;
        this.embeddingsIndex = embeddingsIndex;
        this.isEnabled = isEnabled;
        this.isAllowedPath = isAllowedPath;
    }
    async getQueryEmbedding(query) {
        // Check cache first
        const cached = this.embeddingCache.get(query);
        if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
            return cached.vector;
        }
        // Rate limiting: ensure minimum interval between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minRequestInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
        }
        const settings = this.plugin.settings;
        const provider = settings.externalEmbeddingProvider;
        const apiKey = settings.externalEmbeddingApiKey;
        const model = settings.externalEmbeddingModel || this.getDefaultModel(provider);
        const apiUrl = settings.externalEmbeddingApiUrl;
        if (!provider || !apiKey) {
            throw new Error('External embedding provider or API key not configured');
        }
        // Retry logic with exponential backoff
        let lastError = null;
        for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
            try {
                this.lastRequestTime = Date.now();
                let vector;
                if (provider === 'openai') {
                    vector = await this.callOpenAIEmbedding(apiKey, model, query);
                }
                else if (provider === 'cohere') {
                    vector = await this.callCohereEmbedding(apiKey, model, query);
                }
                else if (provider === 'google') {
                    vector = await this.callGoogleEmbedding(apiKey, model, query, settings.externalEmbeddingUseBatch || false);
                }
                else if (provider === 'custom' && apiUrl) {
                    vector = await this.callCustomEmbedding(apiUrl, query);
                }
                else {
                    throw new Error(`Unsupported embedding provider: ${provider}`);
                }
                // Cache the result
                this.embeddingCache.set(query, { vector, timestamp: Date.now() });
                return vector;
            }
            catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                // Check if it's a 429 error
                const isRateLimit = lastError.message.includes('429') ||
                    lastError.message.includes('rate limit') ||
                    lastError.message.includes('too many requests');
                // If it's a 429 and we have retries left, wait and retry
                if (isRateLimit && attempt < this.retryConfig.maxRetries) {
                    const delay = Math.min(this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt), this.retryConfig.maxDelay);
                    console.warn(`[ExternalEmbeddingsProvider] Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                // If it's not a 429, or we're out of retries, throw immediately
                if (!isRateLimit || attempt >= this.retryConfig.maxRetries) {
                    break;
                }
            }
        }
        // All retries exhausted
        console.error(`[ExternalEmbeddingsProvider] Failed to get embedding after ${this.retryConfig.maxRetries + 1} attempts:`, lastError);
        throw lastError || new Error('Failed to get embedding');
    }
    getDefaultModel(provider) {
        switch (provider) {
            case 'openai':
                return 'text-embedding-3-small';
            case 'cohere':
                return 'embed-english-v3.0';
            case 'google':
                return 'gemini-embedding-001';
            default:
                return '';
        }
    }
    async callOpenAIEmbedding(apiKey, model, query) {
        const response = await requestUrl({
            url: 'https://api.openai.com/v1/embeddings',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                input: query
            })
        });
        if (response.status !== 200) {
            const errorText = response.text || '';
            // Check for 429 specifically
            if (response.status === 429) {
                const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
                throw new Error(`OpenAI rate limit (429). ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before retrying.'}`);
            }
            throw new Error(`OpenAI embedding API error: ${response.status} ${errorText}`);
        }
        const data = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
        if (data.data && data.data[0] && data.data[0].embedding) {
            return data.data[0].embedding;
        }
        throw new Error('Invalid OpenAI embedding response format');
    }
    async callCohereEmbedding(apiKey, model, query) {
        const response = await requestUrl({
            url: 'https://api.cohere.ai/v1/embed',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                texts: [query]
            })
        });
        if (response.status !== 200) {
            const errorText = response.text || '';
            // Check for 429 specifically
            if (response.status === 429) {
                const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
                throw new Error(`Cohere rate limit (429). ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before retrying.'}`);
            }
            throw new Error(`Cohere embedding API error: ${response.status} ${errorText}`);
        }
        const data = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
        if (data.embeddings && data.embeddings[0]) {
            return data.embeddings[0];
        }
        throw new Error('Invalid Cohere embedding response format');
    }
    async callGoogleEmbedding(apiKey, model, query, useBatch) {
        if (useBatch) {
            const response = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    requests: [{
                            content: {
                                parts: [{ text: query }]
                            }
                        }]
                })
            });
            if (response.status !== 200) {
                const errorText = response.text || '';
                // Check for 429 specifically
                if (response.status === 429) {
                    const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
                    throw new Error(`Google Gemini rate limit (429). ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before retrying.'}`);
                }
                throw new Error(`Google Gemini batch embedding API error: ${response.status} ${errorText}`);
            }
            const data = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
            if (data.embeddings && data.embeddings[0] && data.embeddings[0].values) {
                return data.embeddings[0].values;
            }
            throw new Error('Invalid Google Gemini batch embedding response format');
        }
        else {
            const response = await requestUrl({
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    content: {
                        parts: [{ text: query }]
                    }
                })
            });
            if (response.status !== 200) {
                const errorText = response.text || '';
                // Check for 429 specifically
                if (response.status === 429) {
                    const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
                    throw new Error(`Google Gemini rate limit (429). ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before retrying.'}`);
                }
                throw new Error(`Google Gemini embedding API error: ${response.status} ${errorText}`);
            }
            const data = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
            if (data.embedding && data.embedding.values) {
                return data.embedding.values;
            }
            throw new Error('Invalid Google Gemini embedding response format');
        }
    }
    async callCustomEmbedding(apiUrl, query) {
        const response = await requestUrl({
            url: apiUrl,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: query
            })
        });
        if (response.status !== 200) {
            const errorText = response.text || '';
            // Check for 429 specifically
            if (response.status === 429) {
                const retryAfter = response.headers['retry-after'] || response.headers['Retry-After'];
                throw new Error(`Custom embedding API rate limit (429). ${retryAfter ? `Retry after ${retryAfter} seconds.` : 'Please wait before retrying.'}`);
            }
            throw new Error(`Custom embedding API error: ${response.status} ${errorText}`);
        }
        const data = typeof response.json === 'object' ? response.json : JSON.parse(response.text);
        // Try common response formats
        if (Array.isArray(data)) {
            return data;
        }
        if (data.embedding && Array.isArray(data.embedding)) {
            return data.embedding;
        }
        if (data.vector && Array.isArray(data.vector)) {
            return data.vector;
        }
        if (data.values && Array.isArray(data.values)) {
            return data.values;
        }
        throw new Error('Invalid custom embedding API response format');
    }
    async search(query, opts) {
        if (!this.isEnabled())
            return [];
        const q = (query.text ?? '').trim();
        if (!q)
            return [];
        await this.embeddingsIndex.ensureLoaded();
        // Get query embedding from external API
        let qVec;
        try {
            qVec = await this.getQueryEmbedding(q);
        }
        catch (error) {
            console.error(`[ExternalEmbeddingsProvider] Failed to get query embedding:`, error);
            // Fall back to empty results rather than breaking retrieval
            return [];
        }
        // Get all chunks from local index (these have local hash vectors, but we'll use external query vector)
        // Note: This is a hybrid approach - external query vector with local chunk vectors
        // For true hybrid, we'd need to re-embed chunks with external API, but that's expensive
        // Instead, we use the external query vector with local hash vectors (dimension mismatch handled)
        const chunks = this.embeddingsIndex.getAllChunks().filter((c) => this.isAllowedPath(c.path));
        if (chunks.length === 0)
            return [];
        // Score chunks using external query vector against local hash vectors
        // Note: Dimension mismatch is handled by dot product (uses min length)
        const scored = chunks
            .map((c) => {
            const localVec = c.vector;
            // Normalize both vectors for better comparison across different embedding spaces
            const qNorm = Math.sqrt(qVec.reduce((sum, v) => sum + v * v, 0)) || 1;
            const localNorm = Math.sqrt(localVec.reduce((sum, v) => sum + v * v, 0)) || 1;
            const normalizedQ = qVec.map(v => v / qNorm);
            const normalizedLocal = localVec.map(v => v / localNorm);
            const score = dot(normalizedQ, normalizedLocal);
            return { chunk: c, score };
        })
            .sort((a, b) => b.score - a.score)
            .slice(0, Math.max(1, Math.min(200, opts.limit * 6)));
        const results = [];
        for (const { chunk, score } of scored) {
            results.push({
                key: chunk.key,
                path: chunk.path,
                title: chunk.path.split('/').pop(),
                excerpt: chunk.excerpt,
                score: Math.max(0, Math.min(1, (score + 1) / 2)),
                source: this.id,
                reasonTags: ['external-embeddings']
            });
        }
        return results.slice(0, opts.limit);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBR3RDLFNBQVMsR0FBRyxDQUFDLENBQVcsRUFBRSxDQUFXO0lBQ3BDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ1YsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUU7UUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM3QyxPQUFPLENBQUMsQ0FBQztBQUNWLENBQUM7QUFTRCxNQUFNLE9BQU8sMEJBQTBCO0lBeUJ0QyxZQUNDLE1BQThCLEVBQzlCLGVBQWdDLEVBQ2hDLFNBQXdCLEVBQ3hCLGFBQXdDO1FBNUJoQyxPQUFFLEdBQUcscUJBQXFCLENBQUM7UUFPcEMscURBQXFEO1FBQ3BDLG1CQUFjLEdBQUcsSUFBSSxHQUFHLEVBQW1ELENBQUM7UUFDNUUsYUFBUSxHQUFHLE9BQU8sQ0FBQyxDQUFDLFNBQVM7UUFFOUMsK0JBQStCO1FBQ2QsaUJBQVksR0FBaUcsRUFBRSxDQUFDO1FBQ3pILG9CQUFlLEdBQUcsS0FBSyxDQUFDO1FBQ2YsMEJBQXFCLEdBQUcsQ0FBQyxDQUFDLENBQUMscUNBQXFDO1FBQ2hFLHVCQUFrQixHQUFHLEdBQUcsQ0FBQyxDQUFDLGlDQUFpQztRQUNwRSxvQkFBZSxHQUFHLENBQUMsQ0FBQztRQUNYLGdCQUFXLEdBQUc7WUFDOUIsVUFBVSxFQUFFLENBQUM7WUFDYixTQUFT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LENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQzthQUNqQyxLQUFLLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRXZELE1BQU0sT0FBTyxHQUFrQixFQUFFLENBQUM7UUFDbEMsS0FBSyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ3ZDLE9BQU8sQ0FBQyxJQUFJLENBQUM7Z0JBQ1osR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO2dCQUNkLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtnQkFDaEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRTtnQkFDbEMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dCQUN0QixLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7Z0JBQ2hELE1BQU0sRUFBRSxJQUFJLENBQUMsRUFBRTtnQkFDZixVQUFVLEVBQUUsQ0FBQyxxQkFBcUIsQ0FBQzthQUNuQyxDQUFDLENBQUM7UUFDSixDQUFDO1FBRUQsT0FBTyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDckMsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb250ZXh0SXRlbSwgUmV0cmlldmFsT3B0aW9ucywgUmV0cmlldmFsUHJvdmlkZXIsIFJldHJpZXZhbFF1ZXJ5IH0gZnJvbSAnLi90eXBlcyc7XHJcbmltcG9ydCB0eXBlIHsgRW1iZWRkaW5nc0luZGV4IH0gZnJvbSAnLi9FbWJlZGRpbmdzSW5kZXgnO1xyXG5pbXBvcnQgeyByZXF1ZXN0VXJsIH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcclxuXHJcbmZ1bmN0aW9uIGRvdChhOiBudW1iZXJbXSwgYjogbnVtYmVyW10pOiBudW1iZXIge1xyXG5cdGNvbnN0IG4gPSBNYXRoLm1pbihhLmxlbmd0aCwgYi5sZW5ndGgpO1xyXG5cdGxldCBzID0gMDtcclxuXHRmb3IgKGxldCBpID0gMDsgaSA8IG47IGkrKykgcyArPSBhW2ldICogYltpXTtcclxuXHRyZXR1cm4gcztcclxufVxyXG5cclxuaW50ZXJmYWNlIEVtYmVkZGluZ0FwaVJlc3BvbnNlIHtcclxuXHRlbWJlZGRpbmc/OiBudW1iZXJbXTtcclxuXHR2YWx1ZXM/OiBudW1iZXJbXTtcclxuXHRkYXRhPzogQXJyYXk8eyBlbWJlZGRpbmc6IG51bWJlcltdIH0+O1xyXG5cdGVtYmVkZGluZ3M/OiBudW1iZXJbXVtdO1xyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXIgaW1wbGVtZW50cyBSZXRyaWV2YWxQcm92aWRlciB7XHJcblx0cmVhZG9ubHkgaWQgPSAnZXh0ZXJuYWwtZW1iZWRkaW5ncyc7XHJcblxyXG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgZW1iZWRkaW5nc0luZGV4OiBFbWJlZGRpbmdzSW5kZXg7XHJcblx0cHJpdmF0ZSByZWFkb25seSBpc0VuYWJsZWQ6ICgpID0+IGJvb2xlYW47XHJcblx0cHJpdmF0ZSByZWFkb25seSBpc0FsbG93ZWRQYXRoOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xyXG5cdFxyXG5cdC8vIENhY2hlIGZvciBlbWJlZGRpbmcgdmVjdG9ycyAocXVlcnkgdGV4dCAtPiB2ZWN0b3IpXHJcblx0cHJpdmF0ZSByZWFkb25seSBlbWJlZGRpbmdDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCB7IHZlY3RvcjogbnVtYmVyW107IHRpbWVzdGFtcDogbnVtYmVyIH0+KCk7XHJcblx0cHJpdmF0ZSByZWFkb25seSBjYWNoZVR0bCA9IDM2MDAwMDA7IC8vIDEgaG91clxyXG5cdFxyXG5cdC8vIFJhdGUgbGltaXRpbmcgaW5mcmFzdHJ1Y3R1cmVcclxuXHRwcml2YXRlIHJlYWRvbmx5IHJlcXVlc3RRdWV1ZTogQXJyYXk8eyByZXNvbHZlOiAodmFsdWU6IG51bWJlcltdKSA9PiB2b2lkOyByZWplY3Q6IChlcnJvcjogRXJyb3IpID0+IHZvaWQ7IHF1ZXJ5OiBzdHJpbmcgfT4gPSBbXTtcclxuXHRwcml2YXRlIHJlcXVlc3RJbkZsaWdodCA9IGZhbHNlO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4Q29uY3VycmVudFJlcXVlc3RzID0gMTsgLy8gU2VyaWFsaXplIHJlcXVlc3RzIHRvIGF2b2lkIGJ1cnN0c1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWluUmVxdWVzdEludGVydmFsID0gMTAwOyAvLyBNaW5pbXVtIDEwMG1zIGJldHdlZW4gcmVxdWVzdHNcclxuXHRwcml2YXRlIGxhc3RSZXF1ZXN0VGltZSA9IDA7XHJcblx0cHJpdmF0ZSByZWFkb25seSByZXRyeUNvbmZpZyA9IHtcclxuXHRcdG1heFJldHJpZXM6IDMsXHJcblx0XHRiYXNlRGVsYXk6IDEwMDAsIC8vIDEgc2Vjb25kXHJcblx0XHRtYXhEZWxheTogMTAwMDAsIC8vIDEwIHNlY29uZHNcclxuXHRcdGJhY2tvZmZNdWx0aXBsaWVyOiAyXHJcblx0fTtcclxuXHJcblx0Y29uc3RydWN0b3IoXHJcblx0XHRwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sXHJcblx0XHRlbWJlZGRpbmdzSW5kZXg6IEVtYmVkZGluZ3NJbmRleCxcclxuXHRcdGlzRW5hYmxlZDogKCkgPT4gYm9vbGVhbixcclxuXHRcdGlzQWxsb3dlZFBhdGg6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW5cclxuXHQpIHtcclxuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xyXG5cdFx0dGhpcy5lbWJlZGRpbmdzSW5kZXggPSBlbWJlZGRpbmdzSW5kZXg7XHJcblx0XHR0aGlzLmlzRW5hYmxlZCA9IGlzRW5hYmxlZDtcclxuXHRcdHRoaXMuaXNBbGxvd2VkUGF0aCA9IGlzQWxsb3dlZFBhdGg7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGdldFF1ZXJ5RW1iZWRkaW5nKHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHQvLyBDaGVjayBjYWNoZSBmaXJzdFxyXG5cdFx0Y29uc3QgY2FjaGVkID0gdGhpcy5lbWJlZGRpbmdDYWNoZS5nZXQocXVlcnkpO1xyXG5cdFx0aWYgKGNhY2hlZCAmJiBEYXRlLm5vdygpIC0gY2FjaGVkLnRpbWVzdGFtcCA8IHRoaXMuY2FjaGVUdGwpIHtcclxuXHRcdFx0cmV0dXJuIGNhY2hlZC52ZWN0b3I7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gUmF0ZSBsaW1pdGluZzogZW5zdXJlIG1pbmltdW0gaW50ZXJ2YWwgYmV0d2VlbiByZXF1ZXN0c1xyXG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuXHRcdGNvbnN0IHRpbWVTaW5jZUxhc3RSZXF1ZXN0ID0gbm93IC0gdGhpcy5sYXN0UmVxdWVzdFRpbWU7XHJcblx0XHRpZiAodGltZVNpbmNlTGFzdFJlcXVlc3QgPCB0aGlzLm1pblJlcXVlc3RJbnRlcnZhbCkge1xyXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgdGhpcy5taW5SZXF1ZXN0SW50ZXJ2YWwgLSB0aW1lU2luY2VMYXN0UmVxdWVzdCkpO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IHNldHRpbmdzID0gdGhpcy5wbHVnaW4uc2V0dGluZ3M7XHJcblx0XHRjb25zdCBwcm92aWRlciA9IHNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nUHJvdmlkZXI7XHJcblx0XHRjb25zdCBhcGlLZXkgPSBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaUtleTtcclxuXHRcdGNvbnN0IG1vZGVsID0gc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdNb2RlbCB8fCB0aGlzLmdldERlZmF1bHRNb2RlbChwcm92aWRlcik7XHJcblx0XHRjb25zdCBhcGlVcmwgPSBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaVVybDtcclxuXHJcblx0XHRpZiAoIXByb3ZpZGVyIHx8ICFhcGlLZXkpIHtcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFeHRlcm5hbCBlbWJlZGRpbmcgcHJvdmlkZXIgb3IgQVBJIGtleSBub3QgY29uZmlndXJlZCcpO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIFJldHJ5IGxvZ2ljIHdpdGggZXhwb25lbnRpYWwgYmFja29mZlxyXG5cdFx0bGV0IGxhc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcclxuXHRcdGZvciAobGV0IGF0dGVtcHQgPSAwOyBhdHRlbXB0IDw9IHRoaXMucmV0cnlDb25maWcubWF4UmV0cmllczsgYXR0ZW1wdCsrKSB7XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0dGhpcy5sYXN0UmVxdWVzdFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdGxldCB2ZWN0b3I6IG51bWJlcltdO1xyXG5cdFx0XHRcdGlmIChwcm92aWRlciA9PT0gJ29wZW5haScpIHtcclxuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuY2FsbE9wZW5BSUVtYmVkZGluZyhhcGlLZXksIG1vZGVsLCBxdWVyeSk7XHJcblx0XHRcdFx0fSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ2NvaGVyZScpIHtcclxuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuY2FsbENvaGVyZUVtYmVkZGluZyhhcGlLZXksIG1vZGVsLCBxdWVyeSk7XHJcblx0XHRcdFx0fSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ2dvb2dsZScpIHtcclxuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuY2FsbEdvb2dsZUVtYmVkZGluZyhhcGlLZXksIG1vZGVsLCBxdWVyeSwgc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdVc2VCYXRjaCB8fCBmYWxzZSk7XHJcblx0XHRcdFx0fSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ2N1c3RvbScgJiYgYXBpVXJsKSB7XHJcblx0XHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmNhbGxDdXN0b21FbWJlZGRpbmcoYXBpVXJsLCBxdWVyeSk7XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgZW1iZWRkaW5nIHByb3ZpZGVyOiAke3Byb3ZpZGVyfWApO1xyXG5cdFx0XHRcdH1cclxuXHJcblx0XHRcdFx0Ly8gQ2FjaGUgdGhlIHJlc3VsdFxyXG5cdFx0XHRcdHRoaXMuZW1iZWRkaW5nQ2FjaGUuc2V0KHF1ZXJ5LCB7IHZlY3RvciwgdGltZXN0YW1wOiBEYXRlLm5vdygpIH0pO1xyXG5cdFx0XHRcdHJldHVybiB2ZWN0b3I7XHJcblx0XHRcdFx0XHJcblx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XHJcblx0XHRcdFx0bGFzdEVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIENoZWNrIGlmIGl0J3MgYSA0MjkgZXJyb3JcclxuXHRcdFx0XHRjb25zdCBpc1JhdGVMaW1pdCA9IGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKCc0MjknKSB8fCBcclxuXHRcdFx0XHRcdFx0XHRcdCAgIGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdyYXRlIGxpbWl0JykgfHxcclxuXHRcdFx0XHRcdFx0XHRcdCAgIGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKCd0b28gbWFueSByZXF1ZXN0cycpO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIElmIGl0J3MgYSA0MjkgYW5kIHdlIGhhdmUgcmV0cmllcyBsZWZ0LCB3YWl0IGFuZCByZXRyeVxyXG5cdFx0XHRcdGlmIChpc1JhdGVMaW1pdCAmJiBhdHRlbXB0IDwgdGhpcy5yZXRyeUNvbmZpZy5tYXhSZXRyaWVzKSB7XHJcblx0XHRcdFx0XHRjb25zdCBkZWxheSA9IE1hdGgubWluKFxyXG5cdFx0XHRcdFx0XHR0aGlzLnJldHJ5Q29uZmlnLmJhc2VEZWxheSAqIE1hdGgucG93KHRoaXMucmV0cnlDb25maWcuYmFja29mZk11bHRpcGxpZXIsIGF0dGVtcHQpLFxyXG5cdFx0XHRcdFx0XHR0aGlzLnJldHJ5Q29uZmlnLm1heERlbGF5XHJcblx0XHRcdFx0XHQpO1xyXG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIFJhdGUgbGltaXRlZCAoNDI5KSwgcmV0cnlpbmcgaW4gJHtkZWxheX1tcyAoYXR0ZW1wdCAke2F0dGVtcHQgKyAxfS8ke3RoaXMucmV0cnlDb25maWcubWF4UmV0cmllcyArIDF9KWApO1xyXG5cdFx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIGRlbGF5KSk7XHJcblx0XHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gSWYgaXQncyBub3QgYSA0MjksIG9yIHdlJ3JlIG91dCBvZiByZXRyaWVzLCB0aHJvdyBpbW1lZGlhdGVseVxyXG5cdFx0XHRcdGlmICghaXNSYXRlTGltaXQgfHwgYXR0ZW1wdCA+PSB0aGlzLnJldHJ5Q29uZmlnLm1heFJldHJpZXMpIHtcclxuXHRcdFx0XHRcdGJyZWFrO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBBbGwgcmV0cmllcyBleGhhdXN0ZWRcclxuXHRcdGNvbnNvbGUuZXJyb3IoYFtFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlcl0gRmFpbGVkIHRvIGdldCBlbWJlZGRpbmcgYWZ0ZXIgJHt0aGlzLnJldHJ5Q29uZmlnLm1heFJldHJpZXMgKyAxfSBhdHRlbXB0czpgLCBsYXN0RXJyb3IpO1xyXG5cdFx0dGhyb3cgbGFzdEVycm9yIHx8IG5ldyBFcnJvcignRmFpbGVkIHRvIGdldCBlbWJlZGRpbmcnKTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgZ2V0RGVmYXVsdE1vZGVsKHByb3ZpZGVyPzogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRcdHN3aXRjaCAocHJvdmlkZXIpIHtcclxuXHRcdFx0Y2FzZSAnb3BlbmFpJzpcclxuXHRcdFx0XHRyZXR1cm4gJ3RleHQtZW1iZWRkaW5nLTMtc21hbGwnO1xyXG5cdFx0XHRjYXNlICdjb2hlcmUnOlxyXG5cdFx0XHRcdHJldHVybiAnZW1iZWQtZW5nbGlzaC12My4wJztcclxuXHRcdFx0Y2FzZSAnZ29vZ2xlJzpcclxuXHRcdFx0XHRyZXR1cm4gJ2dlbWluaS1lbWJlZGRpbmctMDAxJztcclxuXHRcdFx0ZGVmYXVsdDpcclxuXHRcdFx0XHRyZXR1cm4gJyc7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGNhbGxPcGVuQUlFbWJlZGRpbmcoYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xyXG5cdFx0XHR1cmw6ICdodHRwczovL2FwaS5vcGVuYWkuY29tL3YxL2VtYmVkZGluZ3MnLFxyXG5cdFx0XHRtZXRob2Q6ICdQT1NUJyxcclxuXHRcdFx0aGVhZGVyczoge1xyXG5cdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcblx0XHRcdFx0J0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7YXBpS2V5fWBcclxuXHRcdFx0fSxcclxuXHRcdFx0Ym9keTogSlNPTi5zdHJpbmdpZnkoe1xyXG5cdFx0XHRcdG1vZGVsLFxyXG5cdFx0XHRcdGlucHV0OiBxdWVyeVxyXG5cdFx0XHR9KVxyXG5cdFx0fSk7XHJcblxyXG5cdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XHJcblx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHJlc3BvbnNlLnRleHQgfHwgJyc7XHJcblx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XHJcblx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xyXG5cdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZS5oZWFkZXJzWydyZXRyeS1hZnRlciddIHx8IHJlc3BvbnNlLmhlYWRlcnNbJ1JldHJ5LUFmdGVyJ107XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBPcGVuQUkgcmF0ZSBsaW1pdCAoNDI5KS4gJHtyZXRyeUFmdGVyID8gYFJldHJ5IGFmdGVyICR7cmV0cnlBZnRlcn0gc2Vjb25kcy5gIDogJ1BsZWFzZSB3YWl0IGJlZm9yZSByZXRyeWluZy4nfWApO1xyXG5cdFx0XHR9XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihgT3BlbkFJIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcclxuXHRcdH1cclxuXHJcblx0XHRjb25zdCBkYXRhOiBFbWJlZGRpbmdBcGlSZXNwb25zZSA9IHR5cGVvZiByZXNwb25zZS5qc29uID09PSAnb2JqZWN0JyA/IHJlc3BvbnNlLmpzb24gOiBKU09OLnBhcnNlKHJlc3BvbnNlLnRleHQpO1xyXG5cdFx0aWYgKGRhdGEuZGF0YSAmJiBkYXRhLmRhdGFbMF0gJiYgZGF0YS5kYXRhWzBdLmVtYmVkZGluZykge1xyXG5cdFx0XHRyZXR1cm4gZGF0YS5kYXRhWzBdLmVtYmVkZGluZztcclxuXHRcdH1cclxuXHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBPcGVuQUkgZW1iZWRkaW5nIHJlc3BvbnNlIGZvcm1hdCcpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBjYWxsQ29oZXJlRW1iZWRkaW5nKGFwaUtleTogc3RyaW5nLCBtb2RlbDogc3RyaW5nLCBxdWVyeTogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0VXJsKHtcclxuXHRcdFx0dXJsOiAnaHR0cHM6Ly9hcGkuY29oZXJlLmFpL3YxL2VtYmVkJyxcclxuXHRcdFx0bWV0aG9kOiAnUE9TVCcsXHJcblx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHQnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxyXG5cdFx0XHRcdCdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2FwaUtleX1gXHJcblx0XHRcdH0sXHJcblx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHRtb2RlbCxcclxuXHRcdFx0XHR0ZXh0czogW3F1ZXJ5XVxyXG5cdFx0XHR9KVxyXG5cdFx0fSk7XHJcblxyXG5cdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XHJcblx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHJlc3BvbnNlLnRleHQgfHwgJyc7XHJcblx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XHJcblx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xyXG5cdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZS5oZWFkZXJzWydyZXRyeS1hZnRlciddIHx8IHJlc3BvbnNlLmhlYWRlcnNbJ1JldHJ5LUFmdGVyJ107XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBDb2hlcmUgcmF0ZSBsaW1pdCAoNDI5KS4gJHtyZXRyeUFmdGVyID8gYFJldHJ5IGFmdGVyICR7cmV0cnlBZnRlcn0gc2Vjb25kcy5gIDogJ1BsZWFzZSB3YWl0IGJlZm9yZSByZXRyeWluZy4nfWApO1xyXG5cdFx0XHR9XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ29oZXJlIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcclxuXHRcdH1cclxuXHJcblx0XHRjb25zdCBkYXRhOiBFbWJlZGRpbmdBcGlSZXNwb25zZSA9IHR5cGVvZiByZXNwb25zZS5qc29uID09PSAnb2JqZWN0JyA/IHJlc3BvbnNlLmpzb24gOiBKU09OLnBhcnNlKHJlc3BvbnNlLnRleHQpO1xyXG5cdFx0aWYgKGRhdGEuZW1iZWRkaW5ncyAmJiBkYXRhLmVtYmVkZGluZ3NbMF0pIHtcclxuXHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nc1swXTtcclxuXHRcdH1cclxuXHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBDb2hlcmUgZW1iZWRkaW5nIHJlc3BvbnNlIGZvcm1hdCcpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBjYWxsR29vZ2xlRW1iZWRkaW5nKGFwaUtleTogc3RyaW5nLCBtb2RlbDogc3RyaW5nLCBxdWVyeTogc3RyaW5nLCB1c2VCYXRjaDogYm9vbGVhbik6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGlmICh1c2VCYXRjaCkge1xyXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xyXG5cdFx0XHRcdHVybDogYGh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YS9tb2RlbHMvJHttb2RlbH06YmF0Y2hFbWJlZENvbnRlbnRzP2tleT0ke2FwaUtleX1gLFxyXG5cdFx0XHRcdG1ldGhvZDogJ1BPU1QnLFxyXG5cdFx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbidcclxuXHRcdFx0XHR9LFxyXG5cdFx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHRcdHJlcXVlc3RzOiBbe1xyXG5cdFx0XHRcdFx0XHRjb250ZW50OiB7XHJcblx0XHRcdFx0XHRcdFx0cGFydHM6IFt7IHRleHQ6IHF1ZXJ5IH1dXHJcblx0XHRcdFx0XHRcdH1cclxuXHRcdFx0XHRcdH1dXHJcblx0XHRcdFx0fSlcclxuXHRcdFx0fSk7XHJcblxyXG5cdFx0XHRpZiAocmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHtcclxuXHRcdFx0XHRjb25zdCBlcnJvclRleHQgPSByZXNwb25zZS50ZXh0IHx8ICcnO1xyXG5cdFx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XHJcblx0XHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XHJcblx0XHRcdFx0XHRjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2UuaGVhZGVyc1sncmV0cnktYWZ0ZXInXSB8fCByZXNwb25zZS5oZWFkZXJzWydSZXRyeS1BZnRlciddO1xyXG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIHJhdGUgbGltaXQgKDQyOSkuICR7cmV0cnlBZnRlciA/IGBSZXRyeSBhZnRlciAke3JldHJ5QWZ0ZXJ9IHNlY29uZHMuYCA6ICdQbGVhc2Ugd2FpdCBiZWZvcmUgcmV0cnlpbmcuJ31gKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIGJhdGNoIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0Y29uc3QgZGF0YTogeyBlbWJlZGRpbmdzPzogQXJyYXk8eyB2YWx1ZXM/OiBudW1iZXJbXSB9PiB9ID0gdHlwZW9mIHJlc3BvbnNlLmpzb24gPT09ICdvYmplY3QnID8gcmVzcG9uc2UuanNvbiA6IEpTT04ucGFyc2UocmVzcG9uc2UudGV4dCk7XHJcblx0XHRcdGlmIChkYXRhLmVtYmVkZGluZ3MgJiYgZGF0YS5lbWJlZGRpbmdzWzBdICYmIGRhdGEuZW1iZWRkaW5nc1swXS52YWx1ZXMpIHtcclxuXHRcdFx0XHRyZXR1cm4gZGF0YS5lbWJlZGRpbmdzWzBdLnZhbHVlcztcclxuXHRcdFx0fVxyXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgR29vZ2xlIEdlbWluaSBiYXRjaCBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xyXG5cdFx0XHRcdHVybDogYGh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YS9tb2RlbHMvJHttb2RlbH06ZW1iZWRDb250ZW50P2tleT0ke2FwaUtleX1gLFxyXG5cdFx0XHRcdG1ldGhvZDogJ1BPU1QnLFxyXG5cdFx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbidcclxuXHRcdFx0XHR9LFxyXG5cdFx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHRcdGNvbnRlbnQ6IHtcclxuXHRcdFx0XHRcdFx0cGFydHM6IFt7IHRleHQ6IHF1ZXJ5IH1dXHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fSlcclxuXHRcdFx0fSk7XHJcblxyXG5cdFx0XHRpZiAocmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHtcclxuXHRcdFx0XHRjb25zdCBlcnJvclRleHQgPSByZXNwb25zZS50ZXh0IHx8ICcnO1xyXG5cdFx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XHJcblx0XHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XHJcblx0XHRcdFx0XHRjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2UuaGVhZGVyc1sncmV0cnktYWZ0ZXInXSB8fCByZXNwb25zZS5oZWFkZXJzWydSZXRyeS1BZnRlciddO1xyXG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIHJhdGUgbGltaXQgKDQyOSkuICR7cmV0cnlBZnRlciA/IGBSZXRyeSBhZnRlciAke3JldHJ5QWZ0ZXJ9IHNlY29uZHMuYCA6ICdQbGVhc2Ugd2FpdCBiZWZvcmUgcmV0cnlpbmcuJ31gKTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcclxuXHRcdFx0fVxyXG5cclxuXHRcdFx0Y29uc3QgZGF0YTogeyBlbWJlZGRpbmc/OiB7IHZhbHVlcz86IG51bWJlcltdIH0gfSA9IHR5cGVvZiByZXNwb25zZS5qc29uID09PSAnb2JqZWN0JyA/IHJlc3BvbnNlLmpzb24gOiBKU09OLnBhcnNlKHJlc3BvbnNlLnRleHQpO1xyXG5cdFx0XHRpZiAoZGF0YS5lbWJlZGRpbmcgJiYgZGF0YS5lbWJlZGRpbmcudmFsdWVzKSB7XHJcblx0XHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nLnZhbHVlcztcclxuXHRcdFx0fVxyXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgR29vZ2xlIEdlbWluaSBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGNhbGxDdXN0b21FbWJlZGRpbmcoYXBpVXJsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xyXG5cdFx0XHR1cmw6IGFwaVVybCxcclxuXHRcdFx0bWV0aG9kOiAnUE9TVCcsXHJcblx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHQnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nXHJcblx0XHRcdH0sXHJcblx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHR0ZXh0OiBxdWVyeVxyXG5cdFx0XHR9KVxyXG5cdFx0fSk7XHJcblxyXG5cdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XHJcblx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHJlc3BvbnNlLnRleHQgfHwgJyc7XHJcblx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XHJcblx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xyXG5cdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZS5oZWFkZXJzWydyZXRyeS1hZnRlciddIHx8IHJlc3BvbnNlLmhlYWRlcnNbJ1JldHJ5LUFmdGVyJ107XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBDdXN0b20gZW1iZWRkaW5nIEFQSSByYXRlIGxpbWl0ICg0MjkpLiAke3JldHJ5QWZ0ZXIgPyBgUmV0cnkgYWZ0ZXIgJHtyZXRyeUFmdGVyfSBzZWNvbmRzLmAgOiAnUGxlYXNlIHdhaXQgYmVmb3JlIHJldHJ5aW5nLid9YCk7XHJcblx0XHRcdH1cclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBDdXN0b20gZW1iZWRkaW5nIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9ICR7ZXJyb3JUZXh0fWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IGRhdGEgPSB0eXBlb2YgcmVzcG9uc2UuanNvbiA9PT0gJ29iamVjdCcgPyByZXNwb25zZS5qc29uIDogSlNPTi5wYXJzZShyZXNwb25zZS50ZXh0KTtcclxuXHRcdC8vIFRyeSBjb21tb24gcmVzcG9uc2UgZm9ybWF0c1xyXG5cdFx0aWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcclxuXHRcdFx0cmV0dXJuIGRhdGE7XHJcblx0XHR9XHJcblx0XHRpZiAoZGF0YS5lbWJlZGRpbmcgJiYgQXJyYXkuaXNBcnJheShkYXRhLmVtYmVkZGluZykpIHtcclxuXHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nO1xyXG5cdFx0fVxyXG5cdFx0aWYgKGRhdGEudmVjdG9yICYmIEFycmF5LmlzQXJyYXkoZGF0YS52ZWN0b3IpKSB7XHJcblx0XHRcdHJldHVybiBkYXRhLnZlY3RvcjtcclxuXHRcdH1cclxuXHRcdGlmIChkYXRhLnZhbHVlcyAmJiBBcnJheS5pc0FycmF5KGRhdGEudmFsdWVzKSkge1xyXG5cdFx0XHRyZXR1cm4gZGF0YS52YWx1ZXM7XHJcblx0XHR9XHJcblx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY3VzdG9tIGVtYmVkZGluZyBBUEkgcmVzcG9uc2UgZm9ybWF0Jyk7XHJcblx0fVxyXG5cclxuXHRhc3luYyBzZWFyY2gocXVlcnk6IFJldHJpZXZhbFF1ZXJ5LCBvcHRzOiBSZXRyaWV2YWxPcHRpb25zKTogUHJvbWlzZTxDb250ZXh0SXRlbVtdPiB7XHJcblx0XHRpZiAoIXRoaXMuaXNFbmFibGVkKCkpIHJldHVybiBbXTtcclxuXHRcdGNvbnN0IHEgPSAocXVlcnkudGV4dCA/PyAnJykudHJpbSgpO1xyXG5cdFx0aWYgKCFxKSByZXR1cm4gW107XHJcblxyXG5cdFx0YXdhaXQgdGhpcy5lbWJlZGRpbmdzSW5kZXguZW5zdXJlTG9hZGVkKCk7XHJcblxyXG5cdFx0Ly8gR2V0IHF1ZXJ5IGVtYmVkZGluZyBmcm9tIGV4dGVybmFsIEFQSVxyXG5cdFx0bGV0IHFWZWM6IG51bWJlcltdO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0cVZlYyA9IGF3YWl0IHRoaXMuZ2V0UXVlcnlFbWJlZGRpbmcocSk7XHJcblx0XHR9IGNhdGNoIChlcnJvcikge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIEZhaWxlZCB0byBnZXQgcXVlcnkgZW1iZWRkaW5nOmAsIGVycm9yKTtcclxuXHRcdFx0Ly8gRmFsbCBiYWNrIHRvIGVtcHR5IHJlc3VsdHMgcmF0aGVyIHRoYW4gYnJlYWtpbmcgcmV0cmlldmFsXHJcblx0XHRcdHJldHVybiBbXTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBHZXQgYWxsIGNodW5rcyBmcm9tIGxvY2FsIGluZGV4ICh0aGVzZSBoYXZlIGxvY2FsIGhhc2ggdmVjdG9ycywgYnV0IHdlJ2xsIHVzZSBleHRlcm5hbCBxdWVyeSB2ZWN0b3IpXHJcblx0XHQvLyBOb3RlOiBUaGlzIGlzIGEgaHlicmlkIGFwcHJvYWNoIC0gZXh0ZXJuYWwgcXVlcnkgdmVjdG9yIHdpdGggbG9jYWwgY2h1bmsgdmVjdG9yc1xyXG5cdFx0Ly8gRm9yIHRydWUgaHlicmlkLCB3ZSdkIG5lZWQgdG8gcmUtZW1iZWQgY2h1bmtzIHdpdGggZXh0ZXJuYWwgQVBJLCBidXQgdGhhdCdzIGV4cGVuc2l2ZVxyXG5cdFx0Ly8gSW5zdGVhZCwgd2UgdXNlIHRoZSBleHRlcm5hbCBxdWVyeSB2ZWN0b3Igd2l0aCBsb2NhbCBoYXNoIHZlY3RvcnMgKGRpbWVuc2lvbiBtaXNtYXRjaCBoYW5kbGVkKVxyXG5cdFx0Y29uc3QgY2h1bmtzID0gdGhpcy5lbWJlZGRpbmdzSW5kZXguZ2V0QWxsQ2h1bmtzKCkuZmlsdGVyKChjKSA9PiB0aGlzLmlzQWxsb3dlZFBhdGgoYy5wYXRoKSk7XHJcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xyXG5cclxuXHRcdC8vIFNjb3JlIGNodW5rcyB1c2luZyBleHRlcm5hbCBxdWVyeSB2ZWN0b3IgYWdhaW5zdCBsb2NhbCBoYXNoIHZlY3RvcnNcclxuXHRcdC8vIE5vdGU6IERpbWVuc2lvbiBtaXNtYXRjaCBpcyBoYW5kbGVkIGJ5IGRvdCBwcm9kdWN0ICh1c2VzIG1pbiBsZW5ndGgpXHJcblx0XHRjb25zdCBzY29yZWQgPSBjaHVua3NcclxuXHRcdFx0Lm1hcCgoYykgPT4ge1xyXG5cdFx0XHRcdGNvbnN0IGxvY2FsVmVjID0gYy52ZWN0b3I7XHJcblx0XHRcdFx0Ly8gTm9ybWFsaXplIGJvdGggdmVjdG9ycyBmb3IgYmV0dGVyIGNvbXBhcmlzb24gYWNyb3NzIGRpZmZlcmVudCBlbWJlZGRpbmcgc3BhY2VzXHJcblx0XHRcdFx0Y29uc3QgcU5vcm0gPSBNYXRoLnNxcnQocVZlYy5yZWR1Y2UoKHN1bSwgdikgPT4gc3VtICsgdiAqIHYsIDApKSB8fCAxO1xyXG5cdFx0XHRcdGNvbnN0IGxvY2FsTm9ybSA9IE1hdGguc3FydChsb2NhbFZlYy5yZWR1Y2UoKHN1bSwgdikgPT4gc3VtICsgdiAqIHYsIDApKSB8fCAxO1xyXG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRRID0gcVZlYy5tYXAodiA9PiB2IC8gcU5vcm0pO1xyXG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRMb2NhbCA9IGxvY2FsVmVjLm1hcCh2ID0+IHYgLyBsb2NhbE5vcm0pO1xyXG5cdFx0XHRcdGNvbnN0IHNjb3JlID0gZG90KG5vcm1hbGl6ZWRRLCBub3JtYWxpemVkTG9jYWwpO1xyXG5cdFx0XHRcdHJldHVybiB7IGNodW5rOiBjLCBzY29yZSB9O1xyXG5cdFx0XHR9KVxyXG5cdFx0XHQuc29ydCgoYSwgYikgPT4gYi5zY29yZSAtIGEuc2NvcmUpXHJcblx0XHRcdC5zbGljZSgwLCBNYXRoLm1heCgxLCBNYXRoLm1pbigyMDAsIG9wdHMubGltaXQgKiA2KSkpO1xyXG5cclxuXHRcdGNvbnN0IHJlc3VsdHM6IENvbnRleHRJdGVtW10gPSBbXTtcclxuXHRcdGZvciAoY29uc3QgeyBjaHVuaywgc2NvcmUgfSBvZiBzY29yZWQpIHtcclxuXHRcdFx0cmVzdWx0cy5wdXNoKHtcclxuXHRcdFx0XHRrZXk6IGNodW5rLmtleSxcclxuXHRcdFx0XHRwYXRoOiBjaHVuay5wYXRoLFxyXG5cdFx0XHRcdHRpdGxlOiBjaHVuay5wYXRoLnNwbGl0KCcvJykucG9wKCksXHJcblx0XHRcdFx0ZXhjZXJwdDogY2h1bmsuZXhjZXJwdCxcclxuXHRcdFx0XHRzY29yZTogTWF0aC5tYXgoMCwgTWF0aC5taW4oMSwgKHNjb3JlICsgMSkgLyAyKSksXHJcblx0XHRcdFx0c291cmNlOiB0aGlzLmlkLFxyXG5cdFx0XHRcdHJlYXNvblRhZ3M6IFsnZXh0ZXJuYWwtZW1iZWRkaW5ncyddXHJcblx0XHRcdH0pO1xyXG5cdFx0fVxyXG5cclxuXHRcdHJldHVybiByZXN1bHRzLnNsaWNlKDAsIG9wdHMubGltaXQpO1xyXG5cdH1cclxufVxyXG5cclxuIl19