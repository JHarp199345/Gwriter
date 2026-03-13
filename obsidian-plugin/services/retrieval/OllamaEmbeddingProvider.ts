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
		const modelLower = modelName.toLowerCase().trim();
		const normalize = (val: string) => (val || '').split(':')[0].toLowerCase().trim();
		
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
					const cLower = c.toLowerCase().trim();
					// Accept exact match, tagged variants (e.g., ":latest"), and normalized prefix match
					return (
						cLower === modelLower ||
						cLower === `${modelLower}:latest` ||
						cLower.startsWith(`${modelLower}:`) ||
						normalize(cLower) === modelLower
					);
				});
			});
		} catch {
			return false;
		}
	}

	async getEmbedding(text: string): Promise<number[]> {
		const { text: defanged, count: defangCount } = this.defang(text, 100);
		const sandwiched = this.sandwich(defanged);

		try {
			return await this._executeEmbed(sandwiched, {
				originalLength: text.length,
				finalLength: sandwiched.length,
				defangCount,
				hadRetry: false
			});
		} catch (err: any) {
			// If 400 error, retry with stricter defanging
			if (err?.status === 400 || String(err).includes('400')) {
				const { text: defanged2, count: defangCount2 } = this.defang(text, 60);
				const sandwiched2 = this.sandwich(defanged2);
				return await this._executeEmbed(sandwiched2, {
					originalLength: text.length,
					finalLength: sandwiched2.length,
					defangCount: defangCount2,
					hadRetry: true
				});
			}
			throw err;
		}
	}

	private defang(text: string, cap: number): { text: string; count: number } {
		let count = 0;
		const tokens = text.split(/(\s+)/);
		const processed = tokens.map(token => {
			if (token.trim().length > cap) {
				count++;
				const len = token.length;
				return token.slice(0, 30) + `…<snip:len=${len}>…` + token.slice(-30);
			}
			return token;
		});
		return { text: processed.join(''), count };
	}

	private sandwich(text: string): string {
		if (text.length <= 6000) return text;
		const start = text.slice(0, 2000);
		const end = text.slice(-2000);
		const middleStart = Math.max(0, Math.floor(text.length / 2) - 1000);
		const middle = text.slice(middleStart, middleStart + 2000);
		return `${start}\n\n[...snip...]\n\n${middle}\n\n[...snip...]\n\n${end}`;
	}

	private async _executeEmbed(text: string, meta: { originalLength: number; finalLength: number; defangCount: number; hadRetry: boolean }): Promise<number[]> {
		let res;
		try {
			res = await requestUrl({
				url: `${this.baseUrl}/api/embed`,
				method: 'POST',
				body: JSON.stringify({
					model: this.model,
					input: text
				})
			});
		} catch (err: any) {
			if (err?.status === 404) {
				// Fallback to /api/embeddings
				res = await requestUrl({
					url: `${this.baseUrl}/api/embeddings`,
					method: 'POST',
					body: JSON.stringify({
						model: this.model,
						prompt: text
					})
				});
			} else {
				throw err;
			}
		}

		console.debug(`[Ollama] Embed call: original=${meta.originalLength}, final=${meta.finalLength}, defangs=${meta.defangCount}, retry=${meta.hadRetry}, status=${res.status}`);

		if (res.status !== 200) {
			const err: any = new Error(`[Ollama] Embed failed with status ${res.status}`);
			err.status = res.status;
			throw err;
		}

		const vec = (res.json as any)?.embeddings?.[0] || (res.json as any)?.embedding;
		if (!Array.isArray(vec) || vec.length === 0) {
			throw new Error('[Ollama] Invalid embedding response');
		}
		return vec;
	}
}

