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

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		const limit = normalizeLimit(opts.limit);
		const candidateLimit = Math.max(limit, Math.min(200, limit * 6));

		const providerResults = await Promise.all(
			this.providers.map(async (p) => {
				try {
					return { providerId: p.id, items: await p.search(query, { limit: candidateLimit }) };
				} catch {
					// Provider failure must not break generation. Treat as empty.
					return { providerId: p.id, items: [] as ContextItem[] };
				}
			})
		);

		const nonEmpty = providerResults.filter((b) => b.items.length > 0);
		if (nonEmpty.length === 0) return [];
		if (nonEmpty.length === 1) {
			return nonEmpty[0].items
				.slice()
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
		}

		const fused = fuseRrf(nonEmpty, { limit: candidateLimit });
		const diverse = mmrSelect(fused, { limit, getVector: this.getVector });
		// Keep final stable ordering by score (MMR selects the set; ordering still matters).
		return diverse.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}


