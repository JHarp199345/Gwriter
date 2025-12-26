import { App, requestUrl } from 'obsidian';

export class OllamaEmbeddingProvider {
	private readonly app: App;
	private readonly baseUrl: string;
	private readonly model: string;

	constructor(app: App, baseUrl = 'http://127.0.0.1:11434', model = 'nomic-embed-text') {
		this.app = app;
		this.baseUrl = baseUrl;
		this.model = model;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const res = await requestUrl({ url: `${this.baseUrl}/api/tags`, method: 'GET' });
			return res.status === 200;
		} catch (e) {
			console.warn("[Ollama] Not detected. Ensure 'ollama serve' is running.");
			return false;
		}
	}

	async getEmbedding(text: string): Promise<number[]> {
		const res = await requestUrl({
			url: `${this.baseUrl}/api/embed`,
			method: 'POST',
			body: JSON.stringify({
				model: this.model,
				input: text
			})
		});
		const vec = (res.json as any)?.embeddings?.[0];
		if (!Array.isArray(vec) || vec.length === 0) {
			throw new Error('[Ollama] Invalid embedding response');
		}
		return vec;
	}
}

