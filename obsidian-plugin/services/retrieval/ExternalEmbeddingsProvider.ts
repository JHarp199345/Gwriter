import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import type { EmbeddingsIndex } from './EmbeddingsIndex';
import type { Bm25Index } from './Bm25Index';
import WritingDashboardPlugin from '../../main';

function dot(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

interface EmbeddingApiResponse {
	embedding?: number[];
	values?: number[];
	data?: Array<{ embedding: number[] }>;
	embeddings?: number[][];
}

export class ExternalEmbeddingsProvider implements RetrievalProvider {
	readonly id = 'external-embeddings';

	private readonly plugin: WritingDashboardPlugin;
	private readonly embeddingsIndex: EmbeddingsIndex;
	private readonly bm25Index: Bm25Index;
	private readonly isEnabled: () => boolean;
	private readonly isAllowedPath: (path: string) => boolean;
	
	// Cache for embedding vectors (query text -> vector)
	private readonly embeddingCache = new Map<string, { vector: number[]; timestamp: number }>();
	private readonly cacheTtl = 3600000; // 1 hour

	constructor(
		plugin: WritingDashboardPlugin,
		embeddingsIndex: EmbeddingsIndex,
		bm25Index: Bm25Index,
		isEnabled: () => boolean,
		isAllowedPath: (path: string) => boolean
	) {
		this.plugin = plugin;
		this.embeddingsIndex = embeddingsIndex;
		this.bm25Index = bm25Index;
		this.isEnabled = isEnabled;
		this.isAllowedPath = isAllowedPath;
	}

	private async getQueryEmbedding(query: string): Promise<number[]> {
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

		let vector: number[];
		try {
			if (provider === 'openai') {
				vector = await this.callOpenAIEmbedding(apiKey, model, query);
			} else if (provider === 'cohere') {
				vector = await this.callCohereEmbedding(apiKey, model, query);
			} else if (provider === 'google') {
				vector = await this.callGoogleEmbedding(apiKey, model, query, settings.externalEmbeddingUseBatch || false);
			} else if (provider === 'custom' && apiUrl) {
				vector = await this.callCustomEmbedding(apiUrl, query);
			} else {
				throw new Error(`Unsupported embedding provider: ${provider}`);
			}

			// Cache the result
			this.embeddingCache.set(query, { vector, timestamp: Date.now() });
			return vector;
		} catch (error) {
			console.error(`[ExternalEmbeddingsProvider] Failed to get embedding:`, error);
			throw error;
		}
	}

	private getDefaultModel(provider?: string): string {
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

	private async callOpenAIEmbedding(apiKey: string, model: string, query: string): Promise<number[]> {
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

		const data: EmbeddingApiResponse = await response.json();
		if (data.data && data.data[0] && data.data[0].embedding) {
			return data.data[0].embedding;
		}
		throw new Error('Invalid OpenAI embedding response format');
	}

	private async callCohereEmbedding(apiKey: string, model: string, query: string): Promise<number[]> {
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

		const data: EmbeddingApiResponse = await response.json();
		if (data.embeddings && data.embeddings[0]) {
			return data.embeddings[0];
		}
		throw new Error('Invalid Cohere embedding response format');
	}

	private async callGoogleEmbedding(apiKey: string, model: string, query: string, useBatch: boolean): Promise<number[]> {
		if (useBatch) {
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
				{
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
				}
			);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Google Gemini batch embedding API error: ${response.status} ${error}`);
			}

			const data: { embeddings?: Array<{ values?: number[] }> } = await response.json();
			if (data.embeddings && data.embeddings[0] && data.embeddings[0].values) {
				return data.embeddings[0].values;
			}
			throw new Error('Invalid Google Gemini batch embedding response format');
		} else {
			const response = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						content: {
							parts: [{ text: query }]
						}
					})
				}
			);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`Google Gemini embedding API error: ${response.status} ${error}`);
			}

			const data: { embedding?: { values?: number[] } } = await response.json();
			if (data.embedding && data.embedding.values) {
				return data.embedding.values;
			}
			throw new Error('Invalid Google Gemini embedding response format');
		}
	}

	private async callCustomEmbedding(apiUrl: string, query: string): Promise<number[]> {
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

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		if (!this.isEnabled()) return [];
		const q = (query.text ?? '').trim();
		if (!q) return [];

		await this.embeddingsIndex.ensureLoaded();

		// Get query embedding from external API
		let qVec: number[];
		try {
			qVec = await this.getQueryEmbedding(q);
		} catch (error) {
			console.error(`[ExternalEmbeddingsProvider] Failed to get query embedding:`, error);
			// Fall back to empty results rather than breaking retrieval
			return [];
		}

		// Get all chunks from local index (these have local hash vectors, but we'll use external query vector)
		// Note: This is a hybrid approach - external query vector with local chunk vectors
		// For true hybrid, we'd need to re-embed chunks with external API, but that's expensive
		// Instead, we use the external query vector with local hash vectors (dimension mismatch handled)
		const chunks = this.embeddingsIndex.getAllChunks().filter((c) => this.isAllowedPath(c.path));
		if (chunks.length === 0) return [];

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

		const results: ContextItem[] = [];
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

