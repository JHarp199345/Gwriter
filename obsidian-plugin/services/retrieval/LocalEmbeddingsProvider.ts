import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import type { EmbeddingsIndex } from './EmbeddingsIndex';

function dot(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

export class LocalEmbeddingsProvider implements RetrievalProvider {
	readonly id = 'semantic';

	private readonly index: EmbeddingsIndex;
	private readonly isEnabled: () => boolean;
	private readonly isAllowedPath: (path: string) => boolean;

	constructor(index: EmbeddingsIndex, isEnabled: () => boolean, isAllowedPath: (path: string) => boolean) {
		this.index = index;
		this.isEnabled = isEnabled;
		this.isAllowedPath = isAllowedPath;
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		if (!this.isEnabled()) return [];
		const q = (query.text ?? '').trim();
		if (!q) return [];

		await this.index.ensureLoaded();

		const qVec = this.index.buildQueryVector(q);
		const chunks = this.index.getAllChunks().filter((c) => this.isAllowedPath(c.path));
		if (chunks.length === 0) return [];

		// Score all chunks. For large vaults this is still typically fast at 256 dims.
		const scored = chunks
			.map((c) => ({ chunk: c, score: dot(qVec, c.vector) }))
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
				reasonTags: ['semantic']
			});
		}

		return results.slice(0, opts.limit);
	}
}


