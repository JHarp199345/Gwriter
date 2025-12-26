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
		const candidateLimit = Math.max(limit, Math.min(500, limit * 8)); // Wider net for hybrid
		
		// Separate providers by type
		const localProviders = this.providers.filter(p => 
			p.id === 'local-embeddings' || 
			p.id === 'hash' || 
			p.id === 'bm25' || 
			p.id === 'heuristic'
		);
		
		const externalProviders = this.providers.filter(p => 
			p.id === 'external-embeddings'
		);
		
		const scProvider = this.providers.find(p => p.id === 'smart-connections');
		
		// Step 1: Get Smart Connections cache paths directly (NO API CALL)
		const scCachePaths = new Set<string>();
		if (scProvider && 'getCachePaths' in scProvider) {
			try {
				const paths = await (scProvider as any).getCachePaths();
				paths.forEach((path: string) => scCachePaths.add(path));
			} catch {
				// Cache not available or not enabled - that's fine
			}
		}
		
		// Step 2: Get wide net from LOCAL providers (Hash, BM25, Heuristic)
		// These are all fast, local, zero-cost operations
		const localResults = await Promise.all(
			localProviders.map(async (p) => {
				try {
					return { providerId: p.id, items: await p.search(query, { limit: candidateLimit }) };
				} catch {
					return { providerId: p.id, items: [] as ContextItem[] };
				}
			})
		);
		
		// Step 3: Boost items that appear in Smart Connections cache
		// This is the "voting system" - if both local search AND SC agree, boost it
		const boostedResults = localResults.map(({ providerId, items }) => ({
			providerId,
			items: items.map(item => {
				if (scCachePaths.has(item.path)) {
					// Both local search AND Smart Connections found this - high confidence
					// Boost score based on how many SC cache items exist (more = stronger signal)
					const boostFactor = scCachePaths.size > 50 ? 2.5 : 2.0;
					return { ...item, score: item.score * boostFactor };
				}
				return item;
			})
		}));
		
		// Step 4: If external embeddings are enabled, get their results
		// (This might make API calls, but it's optional and user-controlled)
		const externalResults = await Promise.all(
			externalProviders.map(async (p) => {
				try {
					return { providerId: p.id, items: await p.search(query, { limit: candidateLimit }) };
				} catch {
					return { providerId: p.id, items: [] as ContextItem[] };
				}
			})
		);
		
		// Step 5: Combine all results for RRF fusion
		const allResults = [...boostedResults, ...externalResults];
		const nonEmpty = allResults.filter((b) => b.items.length > 0);
		
		if (nonEmpty.length === 0) return [];
		if (nonEmpty.length === 1) {
			return nonEmpty[0].items
				.slice()
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
		}
		
		// Step 6: RRF fusion (combines scores from multiple providers)
		const fused = fuseRrf(nonEmpty, { limit: candidateLimit });
		
		// Step 7: MMR for diversity (ensures we don't get 10 results from same file)
		const diverse = mmrSelect(fused, { limit, getVector: this.getVector });
		
		// Step 8: Final sort and limit
		return diverse.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}


