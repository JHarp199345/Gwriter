import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import type { Bm25Index } from './Bm25Index';

export class Bm25Provider implements RetrievalProvider {
	readonly id = 'bm25';

	private readonly index: Bm25Index;
	private readonly isEnabled: () => boolean;
	private readonly isAllowedPath: (path: string) => boolean;

	constructor(index: Bm25Index, isEnabled: () => boolean, isAllowedPath: (path: string) => boolean) {
		this.index = index;
		this.isEnabled = isEnabled;
		this.isAllowedPath = isAllowedPath;
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		if (!this.isEnabled()) return [];
		const q = (query.text ?? '').trim();
		if (!q) return [];

		await this.index.ensureLoaded();
		const ranked = this.index.search(q, Math.max(1, Math.min(400, opts.limit * 8)));
		if (ranked.length === 0) return [];

		let max = 0;
		for (const r of ranked) if (r.rawScore > max) max = r.rawScore;
		const denom = max || 1;

		const results: ContextItem[] = [];
		for (const r of ranked) {
			if (!this.isAllowedPath(r.chunk.path)) continue;
			results.push({
				key: r.chunk.key,
				path: r.chunk.path,
				title: r.chunk.path.split('/').pop(),
				excerpt: r.chunk.excerpt,
				score: Math.max(0, Math.min(1, r.rawScore / denom)),
				source: this.id,
				reasonTags: ['bm25']
			});
			if (results.length >= opts.limit) break;
		}

		return results;
	}
}


