import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './retrieval/types';
import { fuseRrf } from './retrieval/Fusion';
import { mmrSelect } from './retrieval/Mmr';

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 20;
	return Math.max(1, Math.min(200, Math.floor(limit)));
}

export class RetrievalService {
	private readonly providers: RetrievalProvider[];
	private readonly getVector?: (key: string) => number[] | null;

	constructor(providers: RetrievalProvider[], opts?: { getVector?: (key: string) => number[] | null }) {
		this.providers = providers;
		this.getVector = opts?.getVector;
	}

	async search(
		query: RetrievalQuery, 
		opts: RetrievalOptions
	): Promise<ContextItem[]> {
		const limit = normalizeLimit(opts.limit);
		const candidateLimit = Math.max(limit, Math.min(500, limit * 8)); // Wider net

		// Separate lexical vs semantic
		const lexicalProviders = this.providers.filter(p => p.id === 'heuristic');
		const semanticProviders = this.providers.filter(p => p.id === 'semantic');

		// Run in parallel
		const [lexicalBuckets, semanticBuckets] = await Promise.all([
			Promise.all(lexicalProviders.map(async (p) => {
				try {
					return { providerId: p.id, items: await p.search(query, { limit: candidateLimit }) };
				} catch {
					return { providerId: p.id, items: [] as ContextItem[] };
				}
			})),
			Promise.all(semanticProviders.map(async (p) => {
				try {
					return { providerId: p.id, items: await p.search(query, { limit: candidateLimit }) };
				} catch {
					return { providerId: p.id, items: [] as ContextItem[] };
				}
			}))
		]);

		// Flatten buckets
		const buckets = [...lexicalBuckets, ...semanticBuckets].filter(b => b.items.length > 0);
		if (buckets.length === 0) return [];
		if (buckets.length === 1) {
			return buckets[0].items
				.slice()
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
		}

		// RRF fusion over lexical + semantic
		const fused = fuseRrf(buckets, { limit: candidateLimit, k: 60 });

		// MMR for diversity
		const diverse = mmrSelect(fused, { limit, getVector: this.getVector });

		return diverse.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}


