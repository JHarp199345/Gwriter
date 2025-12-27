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

	/**
	 * Check if a specific model is present in the local Ollama registry.
	 */
	async hasModel(modelName: string = this.model): Promise<boolean> {
		const normalize = (val: string) => (val || '').split(':')[0];
		try {
			const res = await requestUrl({ url: `${this.baseUrl}/api/tags`, method: 'GET' });
			if (res.status !== 200) return false;
			const tags = (res.json as any)?.models || (res.json as any)?.modelsList || (res.json as any)?.data;
			if (!Array.isArray(tags)) return false;

			return tags.some((m: any) => {
				const candidates = [
					typeof m === 'string' ? m : undefined,
					m?.name,
					m?.model
				].filter(Boolean) as string[];

				return candidates.some((c) => {
					if (!c) return false;
					// Accept exact match, tagged variants (e.g., ":latest"), and normalized prefix match
					return (
						c === modelName ||
						c === `${modelName}:latest` ||
						c.startsWith(`${modelName}:`) ||
						normalize(c) === modelName
					);
				});
			});
		} catch {
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

