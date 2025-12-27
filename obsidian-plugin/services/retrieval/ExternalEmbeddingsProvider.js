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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFFQSxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBR3RDLFNBQVMsR0FBRyxDQUFDLENBQVcsRUFBRSxDQUFXO0lBQ3BDLE1BQU0sQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ1YsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEVBQUU7UUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM3QyxPQUFPLENBQUMsQ0FBQztBQUNWLENBQUM7QUFTRCxNQUFNLE9BQU8sMEJBQTBCO0lBeUJ0QyxZQUNDLE1BQThCLEVBQzlCLGVBQWdDLEVBQ2hDLFNBQXdCLEVBQ3hCLGFBQXdDO1FBNUJoQyxPQUFFLEdBQUcscUJBQXFCLENBQUM7UUFPcEMscURBQXFEO1FBQ3BDLG1CQUFjLEdBQUcsSUFBSSxHQUFHLEVBQW1ELENBQUM7UUFDNUUsYUFBUSxHQUFHLE9BQU8sQ0FBQyxDQUFDLFNBQVM7UUFFOUMsK0JBQStCO1FBQ2QsaUJBQVksR0FBaUcsRUFBRSxDQUFDO1FBQ3pILG9CQUFlLEdBQUcsS0FBSyxDQUFDO1FBQ2YsMEJBQXFCLEdBQUcsQ0FBQyxDQUFDLENBQUMscUNBQXFDO1FBQ2hFLHVCQUFrQixHQUFHLEdBQUcsQ0FBQyxDQUFDLGlDQUFpQztRQUNwRSxvQkFBZSxHQUFHLENBQUMsQ0FBQztRQUNYLGdCQUFXLEdBQUc7WUFDOUIsVUFBVSxFQUFFLENBQUM7WUFDYixTQUFT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LENBQUMsRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEtBQUssQ0FBQzthQUNqQyxLQUFLLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLElBQUksQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBRXZELE1BQU0sT0FBTyxHQUFrQixFQUFFLENBQUM7UUFDbEMsS0FBSyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ3ZDLE9BQU8sQ0FBQyxJQUFJLENBQUM7Z0JBQ1osR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO2dCQUNkLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtnQkFDaEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRTtnQkFDbEMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO2dCQUN0QixLQUFLLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7Z0JBQ2hELE1BQU0sRUFBRSxJQUFJLENBQUMsRUFBRTtnQkFDZixVQUFVLEVBQUUsQ0FBQyxxQkFBcUIsQ0FBQzthQUNuQyxDQUFDLENBQUM7UUFDSixDQUFDO1FBRUQsT0FBTyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDckMsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBDb250ZXh0SXRlbSwgUmV0cmlldmFsT3B0aW9ucywgUmV0cmlldmFsUHJvdmlkZXIsIFJldHJpZXZhbFF1ZXJ5IH0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgdHlwZSB7IEVtYmVkZGluZ3NJbmRleCB9IGZyb20gJy4vRW1iZWRkaW5nc0luZGV4JztcbmltcG9ydCB7IHJlcXVlc3RVcmwgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcblxuZnVuY3Rpb24gZG90KGE6IG51bWJlcltdLCBiOiBudW1iZXJbXSk6IG51bWJlciB7XG5cdGNvbnN0IG4gPSBNYXRoLm1pbihhLmxlbmd0aCwgYi5sZW5ndGgpO1xuXHRsZXQgcyA9IDA7XG5cdGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSBzICs9IGFbaV0gKiBiW2ldO1xuXHRyZXR1cm4gcztcbn1cblxuaW50ZXJmYWNlIEVtYmVkZGluZ0FwaVJlc3BvbnNlIHtcblx0ZW1iZWRkaW5nPzogbnVtYmVyW107XG5cdHZhbHVlcz86IG51bWJlcltdO1xuXHRkYXRhPzogQXJyYXk8eyBlbWJlZGRpbmc6IG51bWJlcltdIH0+O1xuXHRlbWJlZGRpbmdzPzogbnVtYmVyW11bXTtcbn1cblxuZXhwb3J0IGNsYXNzIEV4dGVybmFsRW1iZWRkaW5nc1Byb3ZpZGVyIGltcGxlbWVudHMgUmV0cmlldmFsUHJvdmlkZXIge1xuXHRyZWFkb25seSBpZCA9ICdleHRlcm5hbC1lbWJlZGRpbmdzJztcblxuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSByZWFkb25seSBlbWJlZGRpbmdzSW5kZXg6IEVtYmVkZGluZ3NJbmRleDtcblx0cHJpdmF0ZSByZWFkb25seSBpc0VuYWJsZWQ6ICgpID0+IGJvb2xlYW47XG5cdHByaXZhdGUgcmVhZG9ubHkgaXNBbGxvd2VkUGF0aDogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcblx0XG5cdC8vIENhY2hlIGZvciBlbWJlZGRpbmcgdmVjdG9ycyAocXVlcnkgdGV4dCAtPiB2ZWN0b3IpXG5cdHByaXZhdGUgcmVhZG9ubHkgZW1iZWRkaW5nQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyB2ZWN0b3I6IG51bWJlcltdOyB0aW1lc3RhbXA6IG51bWJlciB9PigpO1xuXHRwcml2YXRlIHJlYWRvbmx5IGNhY2hlVHRsID0gMzYwMDAwMDsgLy8gMSBob3VyXG5cdFxuXHQvLyBSYXRlIGxpbWl0aW5nIGluZnJhc3RydWN0dXJlXG5cdHByaXZhdGUgcmVhZG9ubHkgcmVxdWVzdFF1ZXVlOiBBcnJheTx7IHJlc29sdmU6ICh2YWx1ZTogbnVtYmVyW10pID0+IHZvaWQ7IHJlamVjdDogKGVycm9yOiBFcnJvcikgPT4gdm9pZDsgcXVlcnk6IHN0cmluZyB9PiA9IFtdO1xuXHRwcml2YXRlIHJlcXVlc3RJbkZsaWdodCA9IGZhbHNlO1xuXHRwcml2YXRlIHJlYWRvbmx5IG1heENvbmN1cnJlbnRSZXF1ZXN0cyA9IDE7IC8vIFNlcmlhbGl6ZSByZXF1ZXN0cyB0byBhdm9pZCBidXJzdHNcblx0cHJpdmF0ZSByZWFkb25seSBtaW5SZXF1ZXN0SW50ZXJ2YWwgPSAxMDA7IC8vIE1pbmltdW0gMTAwbXMgYmV0d2VlbiByZXF1ZXN0c1xuXHRwcml2YXRlIGxhc3RSZXF1ZXN0VGltZSA9IDA7XG5cdHByaXZhdGUgcmVhZG9ubHkgcmV0cnlDb25maWcgPSB7XG5cdFx0bWF4UmV0cmllczogMyxcblx0XHRiYXNlRGVsYXk6IDEwMDAsIC8vIDEgc2Vjb25kXG5cdFx0bWF4RGVsYXk6IDEwMDAwLCAvLyAxMCBzZWNvbmRzXG5cdFx0YmFja29mZk11bHRpcGxpZXI6IDJcblx0fTtcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sXG5cdFx0ZW1iZWRkaW5nc0luZGV4OiBFbWJlZGRpbmdzSW5kZXgsXG5cdFx0aXNFbmFibGVkOiAoKSA9PiBib29sZWFuLFxuXHRcdGlzQWxsb3dlZFBhdGg6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW5cblx0KSB7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdFx0dGhpcy5lbWJlZGRpbmdzSW5kZXggPSBlbWJlZGRpbmdzSW5kZXg7XG5cdFx0dGhpcy5pc0VuYWJsZWQgPSBpc0VuYWJsZWQ7XG5cdFx0dGhpcy5pc0FsbG93ZWRQYXRoID0gaXNBbGxvd2VkUGF0aDtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZ2V0UXVlcnlFbWJlZGRpbmcocXVlcnk6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHQvLyBDaGVjayBjYWNoZSBmaXJzdFxuXHRcdGNvbnN0IGNhY2hlZCA9IHRoaXMuZW1iZWRkaW5nQ2FjaGUuZ2V0KHF1ZXJ5KTtcblx0XHRpZiAoY2FjaGVkICYmIERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wIDwgdGhpcy5jYWNoZVR0bCkge1xuXHRcdFx0cmV0dXJuIGNhY2hlZC52ZWN0b3I7XG5cdFx0fVxuXG5cdFx0Ly8gUmF0ZSBsaW1pdGluZzogZW5zdXJlIG1pbmltdW0gaW50ZXJ2YWwgYmV0d2VlbiByZXF1ZXN0c1xuXHRcdGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cdFx0Y29uc3QgdGltZVNpbmNlTGFzdFJlcXVlc3QgPSBub3cgLSB0aGlzLmxhc3RSZXF1ZXN0VGltZTtcblx0XHRpZiAodGltZVNpbmNlTGFzdFJlcXVlc3QgPCB0aGlzLm1pblJlcXVlc3RJbnRlcnZhbCkge1xuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UocmVzb2x2ZSA9PiBzZXRUaW1lb3V0KHJlc29sdmUsIHRoaXMubWluUmVxdWVzdEludGVydmFsIC0gdGltZVNpbmNlTGFzdFJlcXVlc3QpKTtcblx0XHR9XG5cblx0XHRjb25zdCBzZXR0aW5ncyA9IHRoaXMucGx1Z2luLnNldHRpbmdzO1xuXHRcdGNvbnN0IHByb3ZpZGVyID0gc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdQcm92aWRlcjtcblx0XHRjb25zdCBhcGlLZXkgPSBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaUtleTtcblx0XHRjb25zdCBtb2RlbCA9IHNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nTW9kZWwgfHwgdGhpcy5nZXREZWZhdWx0TW9kZWwocHJvdmlkZXIpO1xuXHRcdGNvbnN0IGFwaVVybCA9IHNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nQXBpVXJsO1xuXG5cdFx0aWYgKCFwcm92aWRlciB8fCAhYXBpS2V5KSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0V4dGVybmFsIGVtYmVkZGluZyBwcm92aWRlciBvciBBUEkga2V5IG5vdCBjb25maWd1cmVkJyk7XG5cdFx0fVxuXG5cdFx0Ly8gUmV0cnkgbG9naWMgd2l0aCBleHBvbmVudGlhbCBiYWNrb2ZmXG5cdFx0bGV0IGxhc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcblx0XHRmb3IgKGxldCBhdHRlbXB0ID0gMDsgYXR0ZW1wdCA8PSB0aGlzLnJldHJ5Q29uZmlnLm1heFJldHJpZXM7IGF0dGVtcHQrKykge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0dGhpcy5sYXN0UmVxdWVzdFRpbWUgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHRcblx0XHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHRcdGlmIChwcm92aWRlciA9PT0gJ29wZW5haScpIHtcblx0XHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmNhbGxPcGVuQUlFbWJlZGRpbmcoYXBpS2V5LCBtb2RlbCwgcXVlcnkpO1xuXHRcdFx0XHR9IGVsc2UgaWYgKHByb3ZpZGVyID09PSAnY29oZXJlJykge1xuXHRcdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuY2FsbENvaGVyZUVtYmVkZGluZyhhcGlLZXksIG1vZGVsLCBxdWVyeSk7XG5cdFx0XHRcdH0gZWxzZSBpZiAocHJvdmlkZXIgPT09ICdnb29nbGUnKSB7XG5cdFx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5jYWxsR29vZ2xlRW1iZWRkaW5nKGFwaUtleSwgbW9kZWwsIHF1ZXJ5LCBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ1VzZUJhdGNoIHx8IGZhbHNlKTtcblx0XHRcdFx0fSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ2N1c3RvbScgJiYgYXBpVXJsKSB7XG5cdFx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5jYWxsQ3VzdG9tRW1iZWRkaW5nKGFwaVVybCwgcXVlcnkpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgZW1iZWRkaW5nIHByb3ZpZGVyOiAke3Byb3ZpZGVyfWApO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0Ly8gQ2FjaGUgdGhlIHJlc3VsdFxuXHRcdFx0XHR0aGlzLmVtYmVkZGluZ0NhY2hlLnNldChxdWVyeSwgeyB2ZWN0b3IsIHRpbWVzdGFtcDogRGF0ZS5ub3coKSB9KTtcblx0XHRcdFx0cmV0dXJuIHZlY3Rvcjtcblx0XHRcdFx0XG5cdFx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0XHRsYXN0RXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBDaGVjayBpZiBpdCdzIGEgNDI5IGVycm9yXG5cdFx0XHRcdGNvbnN0IGlzUmF0ZUxpbWl0ID0gbGFzdEVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoJzQyOScpIHx8IFxuXHRcdFx0XHRcdFx0XHRcdCAgIGxhc3RFcnJvci5tZXNzYWdlLmluY2x1ZGVzKCdyYXRlIGxpbWl0JykgfHxcblx0XHRcdFx0XHRcdFx0XHQgICBsYXN0RXJyb3IubWVzc2FnZS5pbmNsdWRlcygndG9vIG1hbnkgcmVxdWVzdHMnKTtcblx0XHRcdFx0XG5cdFx0XHRcdC8vIElmIGl0J3MgYSA0MjkgYW5kIHdlIGhhdmUgcmV0cmllcyBsZWZ0LCB3YWl0IGFuZCByZXRyeVxuXHRcdFx0XHRpZiAoaXNSYXRlTGltaXQgJiYgYXR0ZW1wdCA8IHRoaXMucmV0cnlDb25maWcubWF4UmV0cmllcykge1xuXHRcdFx0XHRcdGNvbnN0IGRlbGF5ID0gTWF0aC5taW4oXG5cdFx0XHRcdFx0XHR0aGlzLnJldHJ5Q29uZmlnLmJhc2VEZWxheSAqIE1hdGgucG93KHRoaXMucmV0cnlDb25maWcuYmFja29mZk11bHRpcGxpZXIsIGF0dGVtcHQpLFxuXHRcdFx0XHRcdFx0dGhpcy5yZXRyeUNvbmZpZy5tYXhEZWxheVxuXHRcdFx0XHRcdCk7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIFJhdGUgbGltaXRlZCAoNDI5KSwgcmV0cnlpbmcgaW4gJHtkZWxheX1tcyAoYXR0ZW1wdCAke2F0dGVtcHQgKyAxfS8ke3RoaXMucmV0cnlDb25maWcubWF4UmV0cmllcyArIDF9KWApO1xuXHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHJlc29sdmUgPT4gc2V0VGltZW91dChyZXNvbHZlLCBkZWxheSkpO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBJZiBpdCdzIG5vdCBhIDQyOSwgb3Igd2UncmUgb3V0IG9mIHJldHJpZXMsIHRocm93IGltbWVkaWF0ZWx5XG5cdFx0XHRcdGlmICghaXNSYXRlTGltaXQgfHwgYXR0ZW1wdCA+PSB0aGlzLnJldHJ5Q29uZmlnLm1heFJldHJpZXMpIHtcblx0XHRcdFx0XHRicmVhaztcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH1cblx0XHRcblx0XHQvLyBBbGwgcmV0cmllcyBleGhhdXN0ZWRcblx0XHRjb25zb2xlLmVycm9yKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIEZhaWxlZCB0byBnZXQgZW1iZWRkaW5nIGFmdGVyICR7dGhpcy5yZXRyeUNvbmZpZy5tYXhSZXRyaWVzICsgMX0gYXR0ZW1wdHM6YCwgbGFzdEVycm9yKTtcblx0XHR0aHJvdyBsYXN0RXJyb3IgfHwgbmV3IEVycm9yKCdGYWlsZWQgdG8gZ2V0IGVtYmVkZGluZycpO1xuXHR9XG5cblx0cHJpdmF0ZSBnZXREZWZhdWx0TW9kZWwocHJvdmlkZXI/OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRcdHN3aXRjaCAocHJvdmlkZXIpIHtcblx0XHRcdGNhc2UgJ29wZW5haSc6XG5cdFx0XHRcdHJldHVybiAndGV4dC1lbWJlZGRpbmctMy1zbWFsbCc7XG5cdFx0XHRjYXNlICdjb2hlcmUnOlxuXHRcdFx0XHRyZXR1cm4gJ2VtYmVkLWVuZ2xpc2gtdjMuMCc7XG5cdFx0XHRjYXNlICdnb29nbGUnOlxuXHRcdFx0XHRyZXR1cm4gJ2dlbWluaS1lbWJlZGRpbmctMDAxJztcblx0XHRcdGRlZmF1bHQ6XG5cdFx0XHRcdHJldHVybiAnJztcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGNhbGxPcGVuQUlFbWJlZGRpbmcoYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0VXJsKHtcblx0XHRcdHVybDogJ2h0dHBzOi8vYXBpLm9wZW5haS5jb20vdjEvZW1iZWRkaW5ncycsXG5cdFx0XHRtZXRob2Q6ICdQT1NUJyxcblx0XHRcdGhlYWRlcnM6IHtcblx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcblx0XHRcdFx0J0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7YXBpS2V5fWBcblx0XHRcdH0sXG5cdFx0XHRib2R5OiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdG1vZGVsLFxuXHRcdFx0XHRpbnB1dDogcXVlcnlcblx0XHRcdH0pXG5cdFx0fSk7XG5cblx0XHRpZiAocmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHtcblx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHJlc3BvbnNlLnRleHQgfHwgJyc7XG5cdFx0XHQvLyBDaGVjayBmb3IgNDI5IHNwZWNpZmljYWxseVxuXHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XG5cdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZS5oZWFkZXJzWydyZXRyeS1hZnRlciddIHx8IHJlc3BvbnNlLmhlYWRlcnNbJ1JldHJ5LUFmdGVyJ107XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgT3BlbkFJIHJhdGUgbGltaXQgKDQyOSkuICR7cmV0cnlBZnRlciA/IGBSZXRyeSBhZnRlciAke3JldHJ5QWZ0ZXJ9IHNlY29uZHMuYCA6ICdQbGVhc2Ugd2FpdCBiZWZvcmUgcmV0cnlpbmcuJ31gKTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihgT3BlbkFJIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCBkYXRhOiBFbWJlZGRpbmdBcGlSZXNwb25zZSA9IHR5cGVvZiByZXNwb25zZS5qc29uID09PSAnb2JqZWN0JyA/IHJlc3BvbnNlLmpzb24gOiBKU09OLnBhcnNlKHJlc3BvbnNlLnRleHQpO1xuXHRcdGlmIChkYXRhLmRhdGEgJiYgZGF0YS5kYXRhWzBdICYmIGRhdGEuZGF0YVswXS5lbWJlZGRpbmcpIHtcblx0XHRcdHJldHVybiBkYXRhLmRhdGFbMF0uZW1iZWRkaW5nO1xuXHRcdH1cblx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgT3BlbkFJIGVtYmVkZGluZyByZXNwb25zZSBmb3JtYXQnKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgY2FsbENvaGVyZUVtYmVkZGluZyhhcGlLZXk6IHN0cmluZywgbW9kZWw6IHN0cmluZywgcXVlcnk6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RVcmwoe1xuXHRcdFx0dXJsOiAnaHR0cHM6Ly9hcGkuY29oZXJlLmFpL3YxL2VtYmVkJyxcblx0XHRcdG1ldGhvZDogJ1BPU1QnLFxuXHRcdFx0aGVhZGVyczoge1xuXHRcdFx0XHQnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuXHRcdFx0XHQnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHthcGlLZXl9YFxuXHRcdFx0fSxcblx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0bW9kZWwsXG5cdFx0XHRcdHRleHRzOiBbcXVlcnldXG5cdFx0XHR9KVxuXHRcdH0pO1xuXG5cdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XG5cdFx0XHRjb25zdCBlcnJvclRleHQgPSByZXNwb25zZS50ZXh0IHx8ICcnO1xuXHRcdFx0Ly8gQ2hlY2sgZm9yIDQyOSBzcGVjaWZpY2FsbHlcblx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuXHRcdFx0XHRjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2UuaGVhZGVyc1sncmV0cnktYWZ0ZXInXSB8fCByZXNwb25zZS5oZWFkZXJzWydSZXRyeS1BZnRlciddO1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENvaGVyZSByYXRlIGxpbWl0ICg0MjkpLiAke3JldHJ5QWZ0ZXIgPyBgUmV0cnkgYWZ0ZXIgJHtyZXRyeUFmdGVyfSBzZWNvbmRzLmAgOiAnUGxlYXNlIHdhaXQgYmVmb3JlIHJldHJ5aW5nLid9YCk7XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoYENvaGVyZSBlbWJlZGRpbmcgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gJHtlcnJvclRleHR9YCk7XG5cdFx0fVxuXG5cdFx0Y29uc3QgZGF0YTogRW1iZWRkaW5nQXBpUmVzcG9uc2UgPSB0eXBlb2YgcmVzcG9uc2UuanNvbiA9PT0gJ29iamVjdCcgPyByZXNwb25zZS5qc29uIDogSlNPTi5wYXJzZShyZXNwb25zZS50ZXh0KTtcblx0XHRpZiAoZGF0YS5lbWJlZGRpbmdzICYmIGRhdGEuZW1iZWRkaW5nc1swXSkge1xuXHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nc1swXTtcblx0XHR9XG5cdFx0dGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIENvaGVyZSBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGNhbGxHb29nbGVFbWJlZGRpbmcoYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcsIHVzZUJhdGNoOiBib29sZWFuKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuXHRcdGlmICh1c2VCYXRjaCkge1xuXHRcdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0VXJsKHtcblx0XHRcdFx0dXJsOiBgaHR0cHM6Ly9nZW5lcmF0aXZlbGFuZ3VhZ2UuZ29vZ2xlYXBpcy5jb20vdjFiZXRhL21vZGVscy8ke21vZGVsfTpiYXRjaEVtYmVkQ29udGVudHM/a2V5PSR7YXBpS2V5fWAsXG5cdFx0XHRcdG1ldGhvZDogJ1BPU1QnLFxuXHRcdFx0XHRoZWFkZXJzOiB7XG5cdFx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xuXHRcdFx0XHR9LFxuXHRcdFx0XHRib2R5OiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdFx0cmVxdWVzdHM6IFt7XG5cdFx0XHRcdFx0XHRjb250ZW50OiB7XG5cdFx0XHRcdFx0XHRcdHBhcnRzOiBbeyB0ZXh0OiBxdWVyeSB9XVxuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1dXG5cdFx0XHRcdH0pXG5cdFx0XHR9KTtcblxuXHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XG5cdFx0XHRcdGNvbnN0IGVycm9yVGV4dCA9IHJlc3BvbnNlLnRleHQgfHwgJyc7XG5cdFx0XHRcdC8vIENoZWNrIGZvciA0Mjkgc3BlY2lmaWNhbGx5XG5cdFx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuXHRcdFx0XHRcdGNvbnN0IHJldHJ5QWZ0ZXIgPSByZXNwb25zZS5oZWFkZXJzWydyZXRyeS1hZnRlciddIHx8IHJlc3BvbnNlLmhlYWRlcnNbJ1JldHJ5LUFmdGVyJ107XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIHJhdGUgbGltaXQgKDQyOSkuICR7cmV0cnlBZnRlciA/IGBSZXRyeSBhZnRlciAke3JldHJ5QWZ0ZXJ9IHNlY29uZHMuYCA6ICdQbGVhc2Ugd2FpdCBiZWZvcmUgcmV0cnlpbmcuJ31gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEdvb2dsZSBHZW1pbmkgYmF0Y2ggZW1iZWRkaW5nIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9ICR7ZXJyb3JUZXh0fWApO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBkYXRhOiB7IGVtYmVkZGluZ3M/OiBBcnJheTx7IHZhbHVlcz86IG51bWJlcltdIH0+IH0gPSB0eXBlb2YgcmVzcG9uc2UuanNvbiA9PT0gJ29iamVjdCcgPyByZXNwb25zZS5qc29uIDogSlNPTi5wYXJzZShyZXNwb25zZS50ZXh0KTtcblx0XHRcdGlmIChkYXRhLmVtYmVkZGluZ3MgJiYgZGF0YS5lbWJlZGRpbmdzWzBdICYmIGRhdGEuZW1iZWRkaW5nc1swXS52YWx1ZXMpIHtcblx0XHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nc1swXS52YWx1ZXM7XG5cdFx0XHR9XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgR29vZ2xlIEdlbWluaSBiYXRjaCBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdFVybCh7XG5cdFx0XHRcdHVybDogYGh0dHBzOi8vZ2VuZXJhdGl2ZWxhbmd1YWdlLmdvb2dsZWFwaXMuY29tL3YxYmV0YS9tb2RlbHMvJHttb2RlbH06ZW1iZWRDb250ZW50P2tleT0ke2FwaUtleX1gLFxuXHRcdFx0XHRtZXRob2Q6ICdQT1NUJyxcblx0XHRcdFx0aGVhZGVyczoge1xuXHRcdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbidcblx0XHRcdFx0fSxcblx0XHRcdFx0Ym9keTogSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRcdGNvbnRlbnQ6IHtcblx0XHRcdFx0XHRcdHBhcnRzOiBbeyB0ZXh0OiBxdWVyeSB9XVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSlcblx0XHRcdH0pO1xuXG5cdFx0XHRpZiAocmVzcG9uc2Uuc3RhdHVzICE9PSAyMDApIHtcblx0XHRcdFx0Y29uc3QgZXJyb3JUZXh0ID0gcmVzcG9uc2UudGV4dCB8fCAnJztcblx0XHRcdFx0Ly8gQ2hlY2sgZm9yIDQyOSBzcGVjaWZpY2FsbHlcblx0XHRcdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyA9PT0gNDI5KSB7XG5cdFx0XHRcdFx0Y29uc3QgcmV0cnlBZnRlciA9IHJlc3BvbnNlLmhlYWRlcnNbJ3JldHJ5LWFmdGVyJ10gfHwgcmVzcG9uc2UuaGVhZGVyc1snUmV0cnktQWZ0ZXInXTtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEdvb2dsZSBHZW1pbmkgcmF0ZSBsaW1pdCAoNDI5KS4gJHtyZXRyeUFmdGVyID8gYFJldHJ5IGFmdGVyICR7cmV0cnlBZnRlcn0gc2Vjb25kcy5gIDogJ1BsZWFzZSB3YWl0IGJlZm9yZSByZXRyeWluZy4nfWApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdHRocm93IG5ldyBFcnJvcihgR29vZ2xlIEdlbWluaSBlbWJlZGRpbmcgQVBJIGVycm9yOiAke3Jlc3BvbnNlLnN0YXR1c30gJHtlcnJvclRleHR9YCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGRhdGE6IHsgZW1iZWRkaW5nPzogeyB2YWx1ZXM/OiBudW1iZXJbXSB9IH0gPSB0eXBlb2YgcmVzcG9uc2UuanNvbiA9PT0gJ29iamVjdCcgPyByZXNwb25zZS5qc29uIDogSlNPTi5wYXJzZShyZXNwb25zZS50ZXh0KTtcblx0XHRcdGlmIChkYXRhLmVtYmVkZGluZyAmJiBkYXRhLmVtYmVkZGluZy52YWx1ZXMpIHtcblx0XHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nLnZhbHVlcztcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBHb29nbGUgR2VtaW5pIGVtYmVkZGluZyByZXNwb25zZSBmb3JtYXQnKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIGNhbGxDdXN0b21FbWJlZGRpbmcoYXBpVXJsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0VXJsKHtcblx0XHRcdHVybDogYXBpVXJsLFxuXHRcdFx0bWV0aG9kOiAnUE9TVCcsXG5cdFx0XHRoZWFkZXJzOiB7XG5cdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbidcblx0XHRcdH0sXG5cdFx0XHRib2R5OiBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdHRleHQ6IHF1ZXJ5XG5cdFx0XHR9KVxuXHRcdH0pO1xuXG5cdFx0aWYgKHJlc3BvbnNlLnN0YXR1cyAhPT0gMjAwKSB7XG5cdFx0XHRjb25zdCBlcnJvclRleHQgPSByZXNwb25zZS50ZXh0IHx8ICcnO1xuXHRcdFx0Ly8gQ2hlY2sgZm9yIDQyOSBzcGVjaWZpY2FsbHlcblx0XHRcdGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQyOSkge1xuXHRcdFx0XHRjb25zdCByZXRyeUFmdGVyID0gcmVzcG9uc2UuaGVhZGVyc1sncmV0cnktYWZ0ZXInXSB8fCByZXNwb25zZS5oZWFkZXJzWydSZXRyeS1BZnRlciddO1xuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEN1c3RvbSBlbWJlZGRpbmcgQVBJIHJhdGUgbGltaXQgKDQyOSkuICR7cmV0cnlBZnRlciA/IGBSZXRyeSBhZnRlciAke3JldHJ5QWZ0ZXJ9IHNlY29uZHMuYCA6ICdQbGVhc2Ugd2FpdCBiZWZvcmUgcmV0cnlpbmcuJ31gKTtcblx0XHRcdH1cblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ3VzdG9tIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yVGV4dH1gKTtcblx0XHR9XG5cblx0XHRjb25zdCBkYXRhID0gdHlwZW9mIHJlc3BvbnNlLmpzb24gPT09ICdvYmplY3QnID8gcmVzcG9uc2UuanNvbiA6IEpTT04ucGFyc2UocmVzcG9uc2UudGV4dCk7XG5cdFx0Ly8gVHJ5IGNvbW1vbiByZXNwb25zZSBmb3JtYXRzXG5cdFx0aWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcblx0XHRcdHJldHVybiBkYXRhO1xuXHRcdH1cblx0XHRpZiAoZGF0YS5lbWJlZGRpbmcgJiYgQXJyYXkuaXNBcnJheShkYXRhLmVtYmVkZGluZykpIHtcblx0XHRcdHJldHVybiBkYXRhLmVtYmVkZGluZztcblx0XHR9XG5cdFx0aWYgKGRhdGEudmVjdG9yICYmIEFycmF5LmlzQXJyYXkoZGF0YS52ZWN0b3IpKSB7XG5cdFx0XHRyZXR1cm4gZGF0YS52ZWN0b3I7XG5cdFx0fVxuXHRcdGlmIChkYXRhLnZhbHVlcyAmJiBBcnJheS5pc0FycmF5KGRhdGEudmFsdWVzKSkge1xuXHRcdFx0cmV0dXJuIGRhdGEudmFsdWVzO1xuXHRcdH1cblx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgY3VzdG9tIGVtYmVkZGluZyBBUEkgcmVzcG9uc2UgZm9ybWF0Jyk7XG5cdH1cblxuXHRhc3luYyBzZWFyY2gocXVlcnk6IFJldHJpZXZhbFF1ZXJ5LCBvcHRzOiBSZXRyaWV2YWxPcHRpb25zKTogUHJvbWlzZTxDb250ZXh0SXRlbVtdPiB7XG5cdFx0aWYgKCF0aGlzLmlzRW5hYmxlZCgpKSByZXR1cm4gW107XG5cdFx0Y29uc3QgcSA9IChxdWVyeS50ZXh0ID8/ICcnKS50cmltKCk7XG5cdFx0aWYgKCFxKSByZXR1cm4gW107XG5cblx0XHRhd2FpdCB0aGlzLmVtYmVkZGluZ3NJbmRleC5lbnN1cmVMb2FkZWQoKTtcblxuXHRcdC8vIEdldCBxdWVyeSBlbWJlZGRpbmcgZnJvbSBleHRlcm5hbCBBUElcblx0XHRsZXQgcVZlYzogbnVtYmVyW107XG5cdFx0dHJ5IHtcblx0XHRcdHFWZWMgPSBhd2FpdCB0aGlzLmdldFF1ZXJ5RW1iZWRkaW5nKHEpO1xuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIEZhaWxlZCB0byBnZXQgcXVlcnkgZW1iZWRkaW5nOmAsIGVycm9yKTtcblx0XHRcdC8vIEZhbGwgYmFjayB0byBlbXB0eSByZXN1bHRzIHJhdGhlciB0aGFuIGJyZWFraW5nIHJldHJpZXZhbFxuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblxuXHRcdC8vIEdldCBhbGwgY2h1bmtzIGZyb20gbG9jYWwgaW5kZXggKHRoZXNlIGhhdmUgbG9jYWwgaGFzaCB2ZWN0b3JzLCBidXQgd2UnbGwgdXNlIGV4dGVybmFsIHF1ZXJ5IHZlY3Rvcilcblx0XHQvLyBOb3RlOiBUaGlzIGlzIGEgaHlicmlkIGFwcHJvYWNoIC0gZXh0ZXJuYWwgcXVlcnkgdmVjdG9yIHdpdGggbG9jYWwgY2h1bmsgdmVjdG9yc1xuXHRcdC8vIEZvciB0cnVlIGh5YnJpZCwgd2UnZCBuZWVkIHRvIHJlLWVtYmVkIGNodW5rcyB3aXRoIGV4dGVybmFsIEFQSSwgYnV0IHRoYXQncyBleHBlbnNpdmVcblx0XHQvLyBJbnN0ZWFkLCB3ZSB1c2UgdGhlIGV4dGVybmFsIHF1ZXJ5IHZlY3RvciB3aXRoIGxvY2FsIGhhc2ggdmVjdG9ycyAoZGltZW5zaW9uIG1pc21hdGNoIGhhbmRsZWQpXG5cdFx0Y29uc3QgY2h1bmtzID0gdGhpcy5lbWJlZGRpbmdzSW5kZXguZ2V0QWxsQ2h1bmtzKCkuZmlsdGVyKChjKSA9PiB0aGlzLmlzQWxsb3dlZFBhdGgoYy5wYXRoKSk7XG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcblxuXHRcdC8vIFNjb3JlIGNodW5rcyB1c2luZyBleHRlcm5hbCBxdWVyeSB2ZWN0b3IgYWdhaW5zdCBsb2NhbCBoYXNoIHZlY3RvcnNcblx0XHQvLyBOb3RlOiBEaW1lbnNpb24gbWlzbWF0Y2ggaXMgaGFuZGxlZCBieSBkb3QgcHJvZHVjdCAodXNlcyBtaW4gbGVuZ3RoKVxuXHRcdGNvbnN0IHNjb3JlZCA9IGNodW5rc1xuXHRcdFx0Lm1hcCgoYykgPT4ge1xuXHRcdFx0XHRjb25zdCBsb2NhbFZlYyA9IGMudmVjdG9yO1xuXHRcdFx0XHQvLyBOb3JtYWxpemUgYm90aCB2ZWN0b3JzIGZvciBiZXR0ZXIgY29tcGFyaXNvbiBhY3Jvc3MgZGlmZmVyZW50IGVtYmVkZGluZyBzcGFjZXNcblx0XHRcdFx0Y29uc3QgcU5vcm0gPSBNYXRoLnNxcnQocVZlYy5yZWR1Y2UoKHN1bSwgdikgPT4gc3VtICsgdiAqIHYsIDApKSB8fCAxO1xuXHRcdFx0XHRjb25zdCBsb2NhbE5vcm0gPSBNYXRoLnNxcnQobG9jYWxWZWMucmVkdWNlKChzdW0sIHYpID0+IHN1bSArIHYgKiB2LCAwKSkgfHwgMTtcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZFEgPSBxVmVjLm1hcCh2ID0+IHYgLyBxTm9ybSk7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRMb2NhbCA9IGxvY2FsVmVjLm1hcCh2ID0+IHYgLyBsb2NhbE5vcm0pO1xuXHRcdFx0XHRjb25zdCBzY29yZSA9IGRvdChub3JtYWxpemVkUSwgbm9ybWFsaXplZExvY2FsKTtcblx0XHRcdFx0cmV0dXJuIHsgY2h1bms6IGMsIHNjb3JlIH07XG5cdFx0XHR9KVxuXHRcdFx0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlKVxuXHRcdFx0LnNsaWNlKDAsIE1hdGgubWF4KDEsIE1hdGgubWluKDIwMCwgb3B0cy5saW1pdCAqIDYpKSk7XG5cblx0XHRjb25zdCByZXN1bHRzOiBDb250ZXh0SXRlbVtdID0gW107XG5cdFx0Zm9yIChjb25zdCB7IGNodW5rLCBzY29yZSB9IG9mIHNjb3JlZCkge1xuXHRcdFx0cmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0a2V5OiBjaHVuay5rZXksXG5cdFx0XHRcdHBhdGg6IGNodW5rLnBhdGgsXG5cdFx0XHRcdHRpdGxlOiBjaHVuay5wYXRoLnNwbGl0KCcvJykucG9wKCksXG5cdFx0XHRcdGV4Y2VycHQ6IGNodW5rLmV4Y2VycHQsXG5cdFx0XHRcdHNjb3JlOiBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAoc2NvcmUgKyAxKSAvIDIpKSxcblx0XHRcdFx0c291cmNlOiB0aGlzLmlkLFxuXHRcdFx0XHRyZWFzb25UYWdzOiBbJ2V4dGVybmFsLWVtYmVkZGluZ3MnXVxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0cmV0dXJuIHJlc3VsdHMuc2xpY2UoMCwgb3B0cy5saW1pdCk7XG5cdH1cbn1cblxuIl19