function dot(a, b) {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++)
        s += a[i] * b[i];
    return s;
}
export class ExternalEmbeddingsProvider {
    constructor(plugin, embeddingsIndex, bm25Index, isEnabled, isAllowedPath) {
        this.id = 'external-embeddings';
        // Cache for embedding vectors (query text -> vector)
        this.embeddingCache = new Map();
        this.cacheTtl = 3600000; // 1 hour
        this.plugin = plugin;
        this.embeddingsIndex = embeddingsIndex;
        this.bm25Index = bm25Index;
        this.isEnabled = isEnabled;
        this.isAllowedPath = isAllowedPath;
    }
    async getQueryEmbedding(query) {
        // Check cache first
        const cached = this.embeddingCache.get(query);
        if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
            return cached.vector;
        }
        const settings = this.plugin.settings;
        const provider = settings.externalEmbeddingProvider;
        const apiKey = settings.externalEmbeddingApiKey;
        const model = settings.externalEmbeddingModel || this.getDefaultModel(provider);
        const apiUrl = settings.externalEmbeddingApiUrl;
        if (!provider || !apiKey) {
            throw new Error('External embedding provider or API key not configured');
        }
        let vector;
        try {
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
            console.error(`[ExternalEmbeddingsProvider] Failed to get embedding:`, error);
            throw error;
        }
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
        const response = await fetch('https://api.openai.com/v1/embeddings', {
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
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI embedding API error: ${response.status} ${error}`);
        }
        const data = await response.json();
        if (data.data && data.data[0] && data.data[0].embedding) {
            return data.data[0].embedding;
        }
        throw new Error('Invalid OpenAI embedding response format');
    }
    async callCohereEmbedding(apiKey, model, query) {
        const response = await fetch('https://api.cohere.ai/v1/embed', {
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
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Cohere embedding API error: ${response.status} ${error}`);
        }
        const data = await response.json();
        if (data.embeddings && data.embeddings[0]) {
            return data.embeddings[0];
        }
        throw new Error('Invalid Cohere embedding response format');
    }
    async callGoogleEmbedding(apiKey, model, query, useBatch) {
        if (useBatch) {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`, {
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
            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Google Gemini batch embedding API error: ${response.status} ${error}`);
            }
            const data = await response.json();
            if (data.embeddings && data.embeddings[0] && data.embeddings[0].values) {
                return data.embeddings[0].values;
            }
            throw new Error('Invalid Google Gemini batch embedding response format');
        }
        else {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`, {
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
            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Google Gemini embedding API error: ${response.status} ${error}`);
            }
            const data = await response.json();
            if (data.embedding && data.embedding.values) {
                return data.embedding.values;
            }
            throw new Error('Invalid Google Gemini embedding response format');
        }
    }
    async callCustomEmbedding(apiUrl, query) {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: query
            })
        });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Custom embedding API error: ${response.status} ${error}`);
        }
        const data = await response.json();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFLQSxTQUFTLEdBQUcsQ0FBQyxDQUFXLEVBQUUsQ0FBVztJQUNwQyxNQUFNLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxNQUFNLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUNWLEtBQUssSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxFQUFFO1FBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDN0MsT0FBTyxDQUFDLENBQUM7QUFDVixDQUFDO0FBU0QsTUFBTSxPQUFPLDBCQUEwQjtJQWF0QyxZQUNDLE1BQThCLEVBQzlCLGVBQWdDLEVBQ2hDLFNBQW9CLEVBQ3BCLFNBQXdCLEVBQ3hCLGFBQXdDO1FBakJoQyxPQUFFLEdBQUcscUJBQXFCLENBQUM7UUFRcEMscURBQXFEO1FBQ3BDLG1CQUFjLEdBQUcsSUFBSSxHQUFHLEVBQW1ELENBQUM7UUFDNUUsYUFBUSxHQUFHLE9BQU8sQ0FBQyxDQUFDLFNBQVM7UUFTN0MsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFDckIsSUFBSSxDQUFDLGVBQWUsR0FBRyxlQUFlLENBQUM7UUFDdkMsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUM7UUFDM0IsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUM7UUFDM0IsSUFBSSxDQUFDLGFBQWEsR0FBRyxhQUFhLENBQUM7SUFDcEMsQ0FBQztJQUVPLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxLQUFhO1FBQzVDLG9CQUFvQjtRQUNwQixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUM5QyxJQUFJLE1BQU0sSUFBSSxJQUFJLENBQUMsR0FBRyxFQUFFLEdBQUcsTUFBTSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDN0QsT0FBTyxNQUFNLENBQUMsTUFBTSxDQUFDO1FBQ3RCLENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQztRQUN0QyxNQUFNLFFBQVEsR0FBRyxRQUFRLENBQUMseUJBQXlCLENBQUM7UUFDcEQsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLHVCQUF1QixDQUFDO1FBQ2hELE1BQU0sS0FBSyxHQUFHLFFBQVEsQ0FBQyxzQkFBc0IsSUFBSSxJQUFJLENBQUMsZUFBZSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQ2hGLE1BQU0sTUFBTSxHQUFHLFFBQVEsQ0FBQyx1QkFBdUIsQ0FBQztRQUVoRCxJQUFJLENBQUMsUUFBUSxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDMUIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1REFBdUQsQ0FBQyxDQUFDO1FBQzFFLENBQUM7UUFFRCxJQUFJLE1BQWdCLENBQUM7UUFDckIsSUFBSSxDQUFDO1lBQ0osSUFBSSxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQzNCLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQy9ELENBQUM7aUJBQU0sSUFBSSxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ2xDLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQy9ELENBQUM7aUJBQU0sSUFBSSxRQUFRLEtBQUssUUFBUSxFQUFFLENBQUM7Z0JBQ2xDLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxFQUFFLEtBQUssRUFBRSxRQUFRLENBQUMseUJBQXlCLElBQUksS0FBSyxDQUFDLENBQUM7WUFDNUcsQ0FBQztpQkFBTSxJQUFJLFFBQVEsS0FBSyxRQUFRLElBQUksTUFBTSxFQUFFLENBQUM7Z0JBQzVDLE1BQU0sR0FBRyxNQUFNLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDeEQsQ0FBQztpQkFBTSxDQUFDO2dCQUNQLE1BQU0sSUFBSSxLQUFLLENBQUMsbUNBQW1DLFFBQVEsRUFBRSxDQUFDLENBQUM7WUFDaEUsQ0FBQztZQUVELG1CQUFtQjtZQUNuQixJQUFJLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsRUFBRSxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUM7WUFDbEUsT0FBTyxNQUFNLENBQUM7UUFDZixDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNoQixPQUFPLENBQUMsS0FBSyxDQUFDLHVEQUF1RCxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQzlFLE1BQU0sS0FBSyxDQUFDO1FBQ2IsQ0FBQztJQUNGLENBQUM7SUFFTyxlQUFlLENBQUMsUUFBaUI7UUFDeEMsUUFBUSxRQUFRLEVBQUUsQ0FBQztZQUNsQixLQUFLLFFBQVE7Z0JBQ1osT0FBTyx3QkFBd0IsQ0FBQztZQUNqQyxLQUFLLFFBQVE7Z0JBQ1osT0FBTyxvQkFBb0IsQ0FBQztZQUM3QixLQUFLLFFBQVE7Z0JBQ1osT0FBTyxzQkFBc0IsQ0FBQztZQUMvQjtnQkFDQyxPQUFPLEVBQUUsQ0FBQztRQUNaLENBQUM7SUFDRixDQUFDO0lBRU8sS0FBSyxDQUFDLG1CQUFtQixDQUFDLE1BQWMsRUFBRSxLQUFhLEVBQUUsS0FBYTtRQUM3RSxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FBQyxzQ0FBc0MsRUFBRTtZQUNwRSxNQUFNLEVBQUUsTUFBTTtZQUNkLE9BQU8sRUFBRTtnQkFDUixjQUFjLEVBQUUsa0JBQWtCO2dCQUNsQyxlQUFlLEVBQUUsVUFBVSxNQUFNLEVBQUU7YUFDbkM7WUFDRCxJQUFJLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEIsS0FBSztnQkFDTCxLQUFLLEVBQUUsS0FBSzthQUNaLENBQUM7U0FDRixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sS0FBSyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQUMsK0JBQStCLFFBQVEsQ0FBQyxNQUFNLElBQUksS0FBSyxFQUFFLENBQUMsQ0FBQztRQUM1RSxDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQXlCLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3pELElBQUksSUFBSSxDQUFDLElBQUksSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDekQsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUMvQixDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQywwQ0FBMEMsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFTyxLQUFLLENBQUMsbUJBQW1CLENBQUMsTUFBYyxFQUFFLEtBQWEsRUFBRSxLQUFhO1FBQzdFLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLGdDQUFnQyxFQUFFO1lBQzlELE1BQU0sRUFBRSxNQUFNO1lBQ2QsT0FBTyxFQUFFO2dCQUNSLGNBQWMsRUFBRSxrQkFBa0I7Z0JBQ2xDLGVBQWUsRUFBRSxVQUFVLE1BQU0sRUFBRTthQUNuQztZQUNELElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO2dCQUNwQixLQUFLO2dCQUNMLEtBQUssRUFBRSxDQUFDLEtBQUssQ0FBQzthQUNkLENBQUM7U0FDRixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2xCLE1BQU0sS0FBSyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQUMsK0JBQStCLFFBQVEsQ0FBQyxNQUFNLElBQUksS0FBSyxFQUFFLENBQUMsQ0FBQztRQUM1RSxDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQXlCLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3pELElBQUksSUFBSSxDQUFDLFVBQVUsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDM0MsT0FBTyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzNCLENBQUM7UUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLDBDQUEwQyxDQUFDLENBQUM7SUFDN0QsQ0FBQztJQUVPLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxNQUFjLEVBQUUsS0FBYSxFQUFFLEtBQWEsRUFBRSxRQUFpQjtRQUNoRyxJQUFJLFFBQVEsRUFBRSxDQUFDO1lBQ2QsTUFBTSxRQUFRLEdBQUcsTUFBTSxLQUFLLENBQzNCLDJEQUEyRCxLQUFLLDJCQUEyQixNQUFNLEVBQUUsRUFDbkc7Z0JBQ0MsTUFBTSxFQUFFLE1BQU07Z0JBQ2QsT0FBTyxFQUFFO29CQUNSLGNBQWMsRUFBRSxrQkFBa0I7aUJBQ2xDO2dCQUNELElBQUksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDO29CQUNwQixRQUFRLEVBQUUsQ0FBQzs0QkFDVixPQUFPLEVBQUU7Z0NBQ1IsS0FBSyxFQUFFLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUM7NkJBQ3hCO3lCQUNELENBQUM7aUJBQ0YsQ0FBQzthQUNGLENBQ0QsQ0FBQztZQUVGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7Z0JBQ2xCLE1BQU0sS0FBSyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNwQyxNQUFNLElBQUksS0FBSyxDQUFDLDRDQUE0QyxRQUFRLENBQUMsTUFBTSxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDekYsQ0FBQztZQUVELE1BQU0sSUFBSSxHQUFrRCxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNsRixJQUFJLElBQUksQ0FBQyxVQUFVLElBQUksSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sRUFBRSxDQUFDO2dCQUN4RSxPQUFPLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO1lBQ2xDLENBQUM7WUFDRCxNQUFNLElBQUksS0FBSyxDQUFDLHVEQUF1RCxDQUFDLENBQUM7UUFDMUUsQ0FBQzthQUFNLENBQUM7WUFDUCxNQUFNLFFBQVEsR0FBRyxNQUFNLEtBQUssQ0FDM0IsMkRBQTJELEtBQUsscUJBQXFCLE1BQU0sRUFBRSxFQUM3RjtnQkFDQyxNQUFNLEVBQUUsTUFBTTtnQkFDZCxPQUFPLEVBQUU7b0JBQ1IsY0FBYyxFQUFFLGtCQUFrQjtpQkFDbEM7Z0JBQ0QsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7b0JBQ3BCLE9BQU8sRUFBRTt3QkFDUixLQUFLLEVBQUUsQ0FBQyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsQ0FBQztxQkFDeEI7aUJBQ0QsQ0FBQzthQUNGLENBQ0QsQ0FBQztZQUVGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7Z0JBQ2xCLE1BQU0sS0FBSyxHQUFHLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNwQyxNQUFNLElBQUksS0FBSyxDQUFDLHNDQUFzQyxRQUFRLENBQUMsTUFBTSxJQUFJLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDbkYsQ0FBQztZQUVELE1BQU0sSUFBSSxHQUEwQyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUMxRSxJQUFJLElBQUksQ0FBQyxTQUFTLElBQUksSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDN0MsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQztZQUM5QixDQUFDO1lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQyxpREFBaUQsQ0FBQyxDQUFDO1FBQ3BFLENBQUM7SUFDRixDQUFDO0lBRU8sS0FBSyxDQUFDLG1CQUFtQixDQUFDLE1BQWMsRUFBRSxLQUFhO1FBQzlELE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLE1BQU0sRUFBRTtZQUNwQyxNQUFNLEVBQUUsTUFBTTtZQUNkLE9BQU8sRUFBRTtnQkFDUixjQUFjLEVBQUUsa0JBQWtCO2FBQ2xDO1lBQ0QsSUFBSSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7Z0JBQ3BCLElBQUksRUFBRSxLQUFLO2FBQ1gsQ0FBQztTQUNGLENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7WUFDbEIsTUFBTSxLQUFLLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDcEMsTUFBTSxJQUFJLEtBQUssQ0FBQywrQkFBK0IsUUFBUSxDQUFDLE1BQU0sSUFBSSxLQUFLLEVBQUUsQ0FBQyxDQUFDO1FBQzVFLENBQUM7UUFFRCxNQUFNLElBQUksR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNuQyw4QkFBOEI7UUFDOUIsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDekIsT0FBTyxJQUFJLENBQUM7UUFDYixDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsU0FBUyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDckQsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ3ZCLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUMvQyxPQUFPLElBQUksQ0FBQyxNQUFNLENBQUM7UUFDcEIsQ0FBQztRQUNELElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1lBQy9DLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQztRQUNwQixDQUFDO1FBQ0QsTUFBTSxJQUFJLEtBQUssQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO0lBQ2pFLENBQUM7SUFFRCxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQXFCLEVBQUUsSUFBc0I7UUFDekQsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUU7WUFBRSxPQUFPLEVBQUUsQ0FBQztRQUNqQyxNQUFNLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDcEMsSUFBSSxDQUFDLENBQUM7WUFBRSxPQUFPLEVBQUUsQ0FBQztRQUVsQixNQUFNLElBQUksQ0FBQyxlQUFlLENBQUMsWUFBWSxFQUFFLENBQUM7UUFFMUMsd0NBQXdDO1FBQ3hDLElBQUksSUFBYyxDQUFDO1FBQ25CLElBQUksQ0FBQztZQUNKLElBQUksR0FBRyxNQUFNLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUN4QyxDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNoQixPQUFPLENBQUMsS0FBSyxDQUFDLDZEQUE2RCxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ3BGLDREQUE0RDtZQUM1RCxPQUFPLEVBQUUsQ0FBQztRQUNYLENBQUM7UUFFRCx1R0FBdUc7UUFDdkcsbUZBQW1GO1FBQ25GLHdGQUF3RjtRQUN4RixpR0FBaUc7UUFDakcsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLGVBQWUsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDN0YsSUFBSSxNQUFNLENBQUMsTUFBTSxLQUFLLENBQUM7WUFBRSxPQUFPLEVBQUUsQ0FBQztRQUVuQyxzRUFBc0U7UUFDdEUsdUVBQXVFO1FBQ3ZFLE1BQU0sTUFBTSxHQUFHLE1BQU07YUFDbkIsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUU7WUFDVixNQUFNLFFBQVEsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDO1lBQzFCLGlGQUFpRjtZQUNqRixNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN0RSxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUM5RSxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLEtBQUssQ0FBQyxDQUFDO1lBQzdDLE1BQU0sZUFBZSxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsU0FBUyxDQUFDLENBQUM7WUFDekQsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLFdBQVcsRUFBRSxlQUFlLENBQUMsQ0FBQztZQUNoRCxPQUFPLEVBQUUsS0FBSyxFQUFFLENBQUMsRUFBRSxLQUFLLEVBQUUsQ0FBQztRQUM1QixDQUFDLENBQUM7YUFDRCxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUM7YUFDakMsS0FBSyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUV2RCxNQUFNLE9BQU8sR0FBa0IsRUFBRSxDQUFDO1FBQ2xDLEtBQUssTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLEVBQUUsSUFBSSxNQUFNLEVBQUUsQ0FBQztZQUN2QyxPQUFPLENBQUMsSUFBSSxDQUFDO2dCQUNaLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRztnQkFDZCxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7Z0JBQ2hCLEtBQUssRUFBRSxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUU7Z0JBQ2xDLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTztnQkFDdEIsS0FBSyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO2dCQUNoRCxNQUFNLEVBQUUsSUFBSSxDQUFDLEVBQUU7Z0JBQ2YsVUFBVSxFQUFFLENBQUMscUJBQXFCLENBQUM7YUFDbkMsQ0FBQyxDQUFDO1FBQ0osQ0FBQztRQUVELE9BQU8sT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3JDLENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQ29udGV4dEl0ZW0sIFJldHJpZXZhbE9wdGlvbnMsIFJldHJpZXZhbFByb3ZpZGVyLCBSZXRyaWV2YWxRdWVyeSB9IGZyb20gJy4vdHlwZXMnO1xyXG5pbXBvcnQgdHlwZSB7IEVtYmVkZGluZ3NJbmRleCB9IGZyb20gJy4vRW1iZWRkaW5nc0luZGV4JztcclxuaW1wb3J0IHR5cGUgeyBCbTI1SW5kZXggfSBmcm9tICcuL0JtMjVJbmRleCc7XHJcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xyXG5cclxuZnVuY3Rpb24gZG90KGE6IG51bWJlcltdLCBiOiBudW1iZXJbXSk6IG51bWJlciB7XHJcblx0Y29uc3QgbiA9IE1hdGgubWluKGEubGVuZ3RoLCBiLmxlbmd0aCk7XHJcblx0bGV0IHMgPSAwO1xyXG5cdGZvciAobGV0IGkgPSAwOyBpIDwgbjsgaSsrKSBzICs9IGFbaV0gKiBiW2ldO1xyXG5cdHJldHVybiBzO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgRW1iZWRkaW5nQXBpUmVzcG9uc2Uge1xyXG5cdGVtYmVkZGluZz86IG51bWJlcltdO1xyXG5cdHZhbHVlcz86IG51bWJlcltdO1xyXG5cdGRhdGE/OiBBcnJheTx7IGVtYmVkZGluZzogbnVtYmVyW10gfT47XHJcblx0ZW1iZWRkaW5ncz86IG51bWJlcltdW107XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlciBpbXBsZW1lbnRzIFJldHJpZXZhbFByb3ZpZGVyIHtcclxuXHRyZWFkb25seSBpZCA9ICdleHRlcm5hbC1lbWJlZGRpbmdzJztcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XHJcblx0cHJpdmF0ZSByZWFkb25seSBlbWJlZGRpbmdzSW5kZXg6IEVtYmVkZGluZ3NJbmRleDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGJtMjVJbmRleDogQm0yNUluZGV4O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgaXNFbmFibGVkOiAoKSA9PiBib29sZWFuO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgaXNBbGxvd2VkUGF0aDogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcclxuXHRcclxuXHQvLyBDYWNoZSBmb3IgZW1iZWRkaW5nIHZlY3RvcnMgKHF1ZXJ5IHRleHQgLT4gdmVjdG9yKVxyXG5cdHByaXZhdGUgcmVhZG9ubHkgZW1iZWRkaW5nQ2FjaGUgPSBuZXcgTWFwPHN0cmluZywgeyB2ZWN0b3I6IG51bWJlcltdOyB0aW1lc3RhbXA6IG51bWJlciB9PigpO1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgY2FjaGVUdGwgPSAzNjAwMDAwOyAvLyAxIGhvdXJcclxuXHJcblx0Y29uc3RydWN0b3IoXHJcblx0XHRwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sXHJcblx0XHRlbWJlZGRpbmdzSW5kZXg6IEVtYmVkZGluZ3NJbmRleCxcclxuXHRcdGJtMjVJbmRleDogQm0yNUluZGV4LFxyXG5cdFx0aXNFbmFibGVkOiAoKSA9PiBib29sZWFuLFxyXG5cdFx0aXNBbGxvd2VkUGF0aDogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhblxyXG5cdCkge1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0XHR0aGlzLmVtYmVkZGluZ3NJbmRleCA9IGVtYmVkZGluZ3NJbmRleDtcclxuXHRcdHRoaXMuYm0yNUluZGV4ID0gYm0yNUluZGV4O1xyXG5cdFx0dGhpcy5pc0VuYWJsZWQgPSBpc0VuYWJsZWQ7XHJcblx0XHR0aGlzLmlzQWxsb3dlZFBhdGggPSBpc0FsbG93ZWRQYXRoO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBnZXRRdWVyeUVtYmVkZGluZyhxdWVyeTogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Ly8gQ2hlY2sgY2FjaGUgZmlyc3RcclxuXHRcdGNvbnN0IGNhY2hlZCA9IHRoaXMuZW1iZWRkaW5nQ2FjaGUuZ2V0KHF1ZXJ5KTtcclxuXHRcdGlmIChjYWNoZWQgJiYgRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXAgPCB0aGlzLmNhY2hlVHRsKSB7XHJcblx0XHRcdHJldHVybiBjYWNoZWQudmVjdG9yO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IHNldHRpbmdzID0gdGhpcy5wbHVnaW4uc2V0dGluZ3M7XHJcblx0XHRjb25zdCBwcm92aWRlciA9IHNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nUHJvdmlkZXI7XHJcblx0XHRjb25zdCBhcGlLZXkgPSBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaUtleTtcclxuXHRcdGNvbnN0IG1vZGVsID0gc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdNb2RlbCB8fCB0aGlzLmdldERlZmF1bHRNb2RlbChwcm92aWRlcik7XHJcblx0XHRjb25zdCBhcGlVcmwgPSBzZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaVVybDtcclxuXHJcblx0XHRpZiAoIXByb3ZpZGVyIHx8ICFhcGlLZXkpIHtcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFeHRlcm5hbCBlbWJlZGRpbmcgcHJvdmlkZXIgb3IgQVBJIGtleSBub3QgY29uZmlndXJlZCcpO1xyXG5cdFx0fVxyXG5cclxuXHRcdGxldCB2ZWN0b3I6IG51bWJlcltdO1xyXG5cdFx0dHJ5IHtcclxuXHRcdFx0aWYgKHByb3ZpZGVyID09PSAnb3BlbmFpJykge1xyXG5cdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuY2FsbE9wZW5BSUVtYmVkZGluZyhhcGlLZXksIG1vZGVsLCBxdWVyeSk7XHJcblx0XHRcdH0gZWxzZSBpZiAocHJvdmlkZXIgPT09ICdjb2hlcmUnKSB7XHJcblx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5jYWxsQ29oZXJlRW1iZWRkaW5nKGFwaUtleSwgbW9kZWwsIHF1ZXJ5KTtcclxuXHRcdFx0fSBlbHNlIGlmIChwcm92aWRlciA9PT0gJ2dvb2dsZScpIHtcclxuXHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmNhbGxHb29nbGVFbWJlZGRpbmcoYXBpS2V5LCBtb2RlbCwgcXVlcnksIHNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nVXNlQmF0Y2ggfHwgZmFsc2UpO1xyXG5cdFx0XHR9IGVsc2UgaWYgKHByb3ZpZGVyID09PSAnY3VzdG9tJyAmJiBhcGlVcmwpIHtcclxuXHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmNhbGxDdXN0b21FbWJlZGRpbmcoYXBpVXJsLCBxdWVyeSk7XHJcblx0XHRcdH0gZWxzZSB7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBlbWJlZGRpbmcgcHJvdmlkZXI6ICR7cHJvdmlkZXJ9YCk7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdC8vIENhY2hlIHRoZSByZXN1bHRcclxuXHRcdFx0dGhpcy5lbWJlZGRpbmdDYWNoZS5zZXQocXVlcnksIHsgdmVjdG9yLCB0aW1lc3RhbXA6IERhdGUubm93KCkgfSk7XHJcblx0XHRcdHJldHVybiB2ZWN0b3I7XHJcblx0XHR9IGNhdGNoIChlcnJvcikge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRXh0ZXJuYWxFbWJlZGRpbmdzUHJvdmlkZXJdIEZhaWxlZCB0byBnZXQgZW1iZWRkaW5nOmAsIGVycm9yKTtcclxuXHRcdFx0dGhyb3cgZXJyb3I7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGdldERlZmF1bHRNb2RlbChwcm92aWRlcj86IHN0cmluZyk6IHN0cmluZyB7XHJcblx0XHRzd2l0Y2ggKHByb3ZpZGVyKSB7XHJcblx0XHRcdGNhc2UgJ29wZW5haSc6XHJcblx0XHRcdFx0cmV0dXJuICd0ZXh0LWVtYmVkZGluZy0zLXNtYWxsJztcclxuXHRcdFx0Y2FzZSAnY29oZXJlJzpcclxuXHRcdFx0XHRyZXR1cm4gJ2VtYmVkLWVuZ2xpc2gtdjMuMCc7XHJcblx0XHRcdGNhc2UgJ2dvb2dsZSc6XHJcblx0XHRcdFx0cmV0dXJuICdnZW1pbmktZW1iZWRkaW5nLTAwMSc7XHJcblx0XHRcdGRlZmF1bHQ6XHJcblx0XHRcdFx0cmV0dXJuICcnO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBjYWxsT3BlbkFJRW1iZWRkaW5nKGFwaUtleTogc3RyaW5nLCBtb2RlbDogc3RyaW5nLCBxdWVyeTogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xyXG5cdFx0Y29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCgnaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MS9lbWJlZGRpbmdzJywge1xyXG5cdFx0XHRtZXRob2Q6ICdQT1NUJyxcclxuXHRcdFx0aGVhZGVyczoge1xyXG5cdFx0XHRcdCdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXHJcblx0XHRcdFx0J0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7YXBpS2V5fWBcclxuXHRcdFx0fSxcclxuXHRcdFx0Ym9keTogSlNPTi5zdHJpbmdpZnkoe1xyXG5cdFx0XHRcdG1vZGVsLFxyXG5cdFx0XHRcdGlucHV0OiBxdWVyeVxyXG5cdFx0XHR9KVxyXG5cdFx0fSk7XHJcblxyXG5cdFx0aWYgKCFyZXNwb25zZS5vaykge1xyXG5cdFx0XHRjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuXHRcdFx0dGhyb3cgbmV3IEVycm9yKGBPcGVuQUkgZW1iZWRkaW5nIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9ICR7ZXJyb3J9YCk7XHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc3QgZGF0YTogRW1iZWRkaW5nQXBpUmVzcG9uc2UgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XHJcblx0XHRpZiAoZGF0YS5kYXRhICYmIGRhdGEuZGF0YVswXSAmJiBkYXRhLmRhdGFbMF0uZW1iZWRkaW5nKSB7XHJcblx0XHRcdHJldHVybiBkYXRhLmRhdGFbMF0uZW1iZWRkaW5nO1xyXG5cdFx0fVxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIE9wZW5BSSBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGNhbGxDb2hlcmVFbWJlZGRpbmcoYXBpS2V5OiBzdHJpbmcsIG1vZGVsOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XHJcblx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKCdodHRwczovL2FwaS5jb2hlcmUuYWkvdjEvZW1iZWQnLCB7XHJcblx0XHRcdG1ldGhvZDogJ1BPU1QnLFxyXG5cdFx0XHRoZWFkZXJzOiB7XHJcblx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcclxuXHRcdFx0XHQnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHthcGlLZXl9YFxyXG5cdFx0XHR9LFxyXG5cdFx0XHRib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcblx0XHRcdFx0bW9kZWwsXHJcblx0XHRcdFx0dGV4dHM6IFtxdWVyeV1cclxuXHRcdFx0fSlcclxuXHRcdH0pO1xyXG5cclxuXHRcdGlmICghcmVzcG9uc2Uub2spIHtcclxuXHRcdFx0Y29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ29oZXJlIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yfWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IGRhdGE6IEVtYmVkZGluZ0FwaVJlc3BvbnNlID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xyXG5cdFx0aWYgKGRhdGEuZW1iZWRkaW5ncyAmJiBkYXRhLmVtYmVkZGluZ3NbMF0pIHtcclxuXHRcdFx0cmV0dXJuIGRhdGEuZW1iZWRkaW5nc1swXTtcclxuXHRcdH1cclxuXHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBDb2hlcmUgZW1iZWRkaW5nIHJlc3BvbnNlIGZvcm1hdCcpO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBjYWxsR29vZ2xlRW1iZWRkaW5nKGFwaUtleTogc3RyaW5nLCBtb2RlbDogc3RyaW5nLCBxdWVyeTogc3RyaW5nLCB1c2VCYXRjaDogYm9vbGVhbik6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGlmICh1c2VCYXRjaCkge1xyXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxyXG5cdFx0XHRcdGBodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGEvbW9kZWxzLyR7bW9kZWx9OmJhdGNoRW1iZWRDb250ZW50cz9rZXk9JHthcGlLZXl9YCxcclxuXHRcdFx0XHR7XHJcblx0XHRcdFx0XHRtZXRob2Q6ICdQT1NUJyxcclxuXHRcdFx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xyXG5cdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHRcdFx0cmVxdWVzdHM6IFt7XHJcblx0XHRcdFx0XHRcdFx0Y29udGVudDoge1xyXG5cdFx0XHRcdFx0XHRcdFx0cGFydHM6IFt7IHRleHQ6IHF1ZXJ5IH1dXHJcblx0XHRcdFx0XHRcdFx0fVxyXG5cdFx0XHRcdFx0XHR9XVxyXG5cdFx0XHRcdFx0fSlcclxuXHRcdFx0XHR9XHJcblx0XHRcdCk7XHJcblxyXG5cdFx0XHRpZiAoIXJlc3BvbnNlLm9rKSB7XHJcblx0XHRcdFx0Y29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcblx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKGBHb29nbGUgR2VtaW5pIGJhdGNoIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yfWApO1xyXG5cdFx0XHR9XHJcblxyXG5cdFx0XHRjb25zdCBkYXRhOiB7IGVtYmVkZGluZ3M/OiBBcnJheTx7IHZhbHVlcz86IG51bWJlcltdIH0+IH0gPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XHJcblx0XHRcdGlmIChkYXRhLmVtYmVkZGluZ3MgJiYgZGF0YS5lbWJlZGRpbmdzWzBdICYmIGRhdGEuZW1iZWRkaW5nc1swXS52YWx1ZXMpIHtcclxuXHRcdFx0XHRyZXR1cm4gZGF0YS5lbWJlZGRpbmdzWzBdLnZhbHVlcztcclxuXHRcdFx0fVxyXG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0ludmFsaWQgR29vZ2xlIEdlbWluaSBiYXRjaCBlbWJlZGRpbmcgcmVzcG9uc2UgZm9ybWF0Jyk7XHJcblx0XHR9IGVsc2Uge1xyXG5cdFx0XHRjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxyXG5cdFx0XHRcdGBodHRwczovL2dlbmVyYXRpdmVsYW5ndWFnZS5nb29nbGVhcGlzLmNvbS92MWJldGEvbW9kZWxzLyR7bW9kZWx9OmVtYmVkQ29udGVudD9rZXk9JHthcGlLZXl9YCxcclxuXHRcdFx0XHR7XHJcblx0XHRcdFx0XHRtZXRob2Q6ICdQT1NUJyxcclxuXHRcdFx0XHRcdGhlYWRlcnM6IHtcclxuXHRcdFx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xyXG5cdFx0XHRcdFx0fSxcclxuXHRcdFx0XHRcdGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcclxuXHRcdFx0XHRcdFx0Y29udGVudDoge1xyXG5cdFx0XHRcdFx0XHRcdHBhcnRzOiBbeyB0ZXh0OiBxdWVyeSB9XVxyXG5cdFx0XHRcdFx0XHR9XHJcblx0XHRcdFx0XHR9KVxyXG5cdFx0XHRcdH1cclxuXHRcdFx0KTtcclxuXHJcblx0XHRcdGlmICghcmVzcG9uc2Uub2spIHtcclxuXHRcdFx0XHRjb25zdCBlcnJvciA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKTtcclxuXHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoYEdvb2dsZSBHZW1pbmkgZW1iZWRkaW5nIEFQSSBlcnJvcjogJHtyZXNwb25zZS5zdGF0dXN9ICR7ZXJyb3J9YCk7XHJcblx0XHRcdH1cclxuXHJcblx0XHRcdGNvbnN0IGRhdGE6IHsgZW1iZWRkaW5nPzogeyB2YWx1ZXM/OiBudW1iZXJbXSB9IH0gPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XHJcblx0XHRcdGlmIChkYXRhLmVtYmVkZGluZyAmJiBkYXRhLmVtYmVkZGluZy52YWx1ZXMpIHtcclxuXHRcdFx0XHRyZXR1cm4gZGF0YS5lbWJlZGRpbmcudmFsdWVzO1xyXG5cdFx0XHR9XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcignSW52YWxpZCBHb29nbGUgR2VtaW5pIGVtYmVkZGluZyByZXNwb25zZSBmb3JtYXQnKTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgY2FsbEN1c3RvbUVtYmVkZGluZyhhcGlVcmw6IHN0cmluZywgcXVlcnk6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcclxuXHRcdGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYXBpVXJsLCB7XHJcblx0XHRcdG1ldGhvZDogJ1BPU1QnLFxyXG5cdFx0XHRoZWFkZXJzOiB7XHJcblx0XHRcdFx0J0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJ1xyXG5cdFx0XHR9LFxyXG5cdFx0XHRib2R5OiBKU09OLnN0cmluZ2lmeSh7XHJcblx0XHRcdFx0dGV4dDogcXVlcnlcclxuXHRcdFx0fSlcclxuXHRcdH0pO1xyXG5cclxuXHRcdGlmICghcmVzcG9uc2Uub2spIHtcclxuXHRcdFx0Y29uc3QgZXJyb3IgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XHJcblx0XHRcdHRocm93IG5ldyBFcnJvcihgQ3VzdG9tIGVtYmVkZGluZyBBUEkgZXJyb3I6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke2Vycm9yfWApO1xyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IGRhdGEgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XHJcblx0XHQvLyBUcnkgY29tbW9uIHJlc3BvbnNlIGZvcm1hdHNcclxuXHRcdGlmIChBcnJheS5pc0FycmF5KGRhdGEpKSB7XHJcblx0XHRcdHJldHVybiBkYXRhO1xyXG5cdFx0fVxyXG5cdFx0aWYgKGRhdGEuZW1iZWRkaW5nICYmIEFycmF5LmlzQXJyYXkoZGF0YS5lbWJlZGRpbmcpKSB7XHJcblx0XHRcdHJldHVybiBkYXRhLmVtYmVkZGluZztcclxuXHRcdH1cclxuXHRcdGlmIChkYXRhLnZlY3RvciAmJiBBcnJheS5pc0FycmF5KGRhdGEudmVjdG9yKSkge1xyXG5cdFx0XHRyZXR1cm4gZGF0YS52ZWN0b3I7XHJcblx0XHR9XHJcblx0XHRpZiAoZGF0YS52YWx1ZXMgJiYgQXJyYXkuaXNBcnJheShkYXRhLnZhbHVlcykpIHtcclxuXHRcdFx0cmV0dXJuIGRhdGEudmFsdWVzO1xyXG5cdFx0fVxyXG5cdFx0dGhyb3cgbmV3IEVycm9yKCdJbnZhbGlkIGN1c3RvbSBlbWJlZGRpbmcgQVBJIHJlc3BvbnNlIGZvcm1hdCcpO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgc2VhcmNoKHF1ZXJ5OiBSZXRyaWV2YWxRdWVyeSwgb3B0czogUmV0cmlldmFsT3B0aW9ucyk6IFByb21pc2U8Q29udGV4dEl0ZW1bXT4ge1xyXG5cdFx0aWYgKCF0aGlzLmlzRW5hYmxlZCgpKSByZXR1cm4gW107XHJcblx0XHRjb25zdCBxID0gKHF1ZXJ5LnRleHQgPz8gJycpLnRyaW0oKTtcclxuXHRcdGlmICghcSkgcmV0dXJuIFtdO1xyXG5cclxuXHRcdGF3YWl0IHRoaXMuZW1iZWRkaW5nc0luZGV4LmVuc3VyZUxvYWRlZCgpO1xyXG5cclxuXHRcdC8vIEdldCBxdWVyeSBlbWJlZGRpbmcgZnJvbSBleHRlcm5hbCBBUElcclxuXHRcdGxldCBxVmVjOiBudW1iZXJbXTtcclxuXHRcdHRyeSB7XHJcblx0XHRcdHFWZWMgPSBhd2FpdCB0aGlzLmdldFF1ZXJ5RW1iZWRkaW5nKHEpO1xyXG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcclxuXHRcdFx0Y29uc29sZS5lcnJvcihgW0V4dGVybmFsRW1iZWRkaW5nc1Byb3ZpZGVyXSBGYWlsZWQgdG8gZ2V0IHF1ZXJ5IGVtYmVkZGluZzpgLCBlcnJvcik7XHJcblx0XHRcdC8vIEZhbGwgYmFjayB0byBlbXB0eSByZXN1bHRzIHJhdGhlciB0aGFuIGJyZWFraW5nIHJldHJpZXZhbFxyXG5cdFx0XHRyZXR1cm4gW107XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gR2V0IGFsbCBjaHVua3MgZnJvbSBsb2NhbCBpbmRleCAodGhlc2UgaGF2ZSBsb2NhbCBoYXNoIHZlY3RvcnMsIGJ1dCB3ZSdsbCB1c2UgZXh0ZXJuYWwgcXVlcnkgdmVjdG9yKVxyXG5cdFx0Ly8gTm90ZTogVGhpcyBpcyBhIGh5YnJpZCBhcHByb2FjaCAtIGV4dGVybmFsIHF1ZXJ5IHZlY3RvciB3aXRoIGxvY2FsIGNodW5rIHZlY3RvcnNcclxuXHRcdC8vIEZvciB0cnVlIGh5YnJpZCwgd2UnZCBuZWVkIHRvIHJlLWVtYmVkIGNodW5rcyB3aXRoIGV4dGVybmFsIEFQSSwgYnV0IHRoYXQncyBleHBlbnNpdmVcclxuXHRcdC8vIEluc3RlYWQsIHdlIHVzZSB0aGUgZXh0ZXJuYWwgcXVlcnkgdmVjdG9yIHdpdGggbG9jYWwgaGFzaCB2ZWN0b3JzIChkaW1lbnNpb24gbWlzbWF0Y2ggaGFuZGxlZClcclxuXHRcdGNvbnN0IGNodW5rcyA9IHRoaXMuZW1iZWRkaW5nc0luZGV4LmdldEFsbENodW5rcygpLmZpbHRlcigoYykgPT4gdGhpcy5pc0FsbG93ZWRQYXRoKGMucGF0aCkpO1xyXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHJldHVybiBbXTtcclxuXHJcblx0XHQvLyBTY29yZSBjaHVua3MgdXNpbmcgZXh0ZXJuYWwgcXVlcnkgdmVjdG9yIGFnYWluc3QgbG9jYWwgaGFzaCB2ZWN0b3JzXHJcblx0XHQvLyBOb3RlOiBEaW1lbnNpb24gbWlzbWF0Y2ggaXMgaGFuZGxlZCBieSBkb3QgcHJvZHVjdCAodXNlcyBtaW4gbGVuZ3RoKVxyXG5cdFx0Y29uc3Qgc2NvcmVkID0gY2h1bmtzXHJcblx0XHRcdC5tYXAoKGMpID0+IHtcclxuXHRcdFx0XHRjb25zdCBsb2NhbFZlYyA9IGMudmVjdG9yO1xyXG5cdFx0XHRcdC8vIE5vcm1hbGl6ZSBib3RoIHZlY3RvcnMgZm9yIGJldHRlciBjb21wYXJpc29uIGFjcm9zcyBkaWZmZXJlbnQgZW1iZWRkaW5nIHNwYWNlc1xyXG5cdFx0XHRcdGNvbnN0IHFOb3JtID0gTWF0aC5zcXJ0KHFWZWMucmVkdWNlKChzdW0sIHYpID0+IHN1bSArIHYgKiB2LCAwKSkgfHwgMTtcclxuXHRcdFx0XHRjb25zdCBsb2NhbE5vcm0gPSBNYXRoLnNxcnQobG9jYWxWZWMucmVkdWNlKChzdW0sIHYpID0+IHN1bSArIHYgKiB2LCAwKSkgfHwgMTtcclxuXHRcdFx0XHRjb25zdCBub3JtYWxpemVkUSA9IHFWZWMubWFwKHYgPT4gdiAvIHFOb3JtKTtcclxuXHRcdFx0XHRjb25zdCBub3JtYWxpemVkTG9jYWwgPSBsb2NhbFZlYy5tYXAodiA9PiB2IC8gbG9jYWxOb3JtKTtcclxuXHRcdFx0XHRjb25zdCBzY29yZSA9IGRvdChub3JtYWxpemVkUSwgbm9ybWFsaXplZExvY2FsKTtcclxuXHRcdFx0XHRyZXR1cm4geyBjaHVuazogYywgc2NvcmUgfTtcclxuXHRcdFx0fSlcclxuXHRcdFx0LnNvcnQoKGEsIGIpID0+IGIuc2NvcmUgLSBhLnNjb3JlKVxyXG5cdFx0XHQuc2xpY2UoMCwgTWF0aC5tYXgoMSwgTWF0aC5taW4oMjAwLCBvcHRzLmxpbWl0ICogNikpKTtcclxuXHJcblx0XHRjb25zdCByZXN1bHRzOiBDb250ZXh0SXRlbVtdID0gW107XHJcblx0XHRmb3IgKGNvbnN0IHsgY2h1bmssIHNjb3JlIH0gb2Ygc2NvcmVkKSB7XHJcblx0XHRcdHJlc3VsdHMucHVzaCh7XHJcblx0XHRcdFx0a2V5OiBjaHVuay5rZXksXHJcblx0XHRcdFx0cGF0aDogY2h1bmsucGF0aCxcclxuXHRcdFx0XHR0aXRsZTogY2h1bmsucGF0aC5zcGxpdCgnLycpLnBvcCgpLFxyXG5cdFx0XHRcdGV4Y2VycHQ6IGNodW5rLmV4Y2VycHQsXHJcblx0XHRcdFx0c2NvcmU6IE1hdGgubWF4KDAsIE1hdGgubWluKDEsIChzY29yZSArIDEpIC8gMikpLFxyXG5cdFx0XHRcdHNvdXJjZTogdGhpcy5pZCxcclxuXHRcdFx0XHRyZWFzb25UYWdzOiBbJ2V4dGVybmFsLWVtYmVkZGluZ3MnXVxyXG5cdFx0XHR9KTtcclxuXHRcdH1cclxuXHJcblx0XHRyZXR1cm4gcmVzdWx0cy5zbGljZSgwLCBvcHRzLmxpbWl0KTtcclxuXHR9XHJcbn1cclxuXHJcbiJdfQ==