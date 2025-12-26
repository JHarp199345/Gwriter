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
		opts: RetrievalOptions,
		scTemplatePaths?: string[] // Optional: paths from SC template
	): Promise<ContextItem[]> {
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
		
		// Step 1: Get Smart Connections paths from template OR cache
		const scPaths = new Set<string>();
		
		// Priority: Use template paths if provided (template-based approach)
		if (scTemplatePaths && scTemplatePaths.length > 0) {
			scTemplatePaths.forEach(path => scPaths.add(path));
			console.debug(`[RetrievalService] Using ${scTemplatePaths.length} paths from SC template`);
		} else {
			// Fallback: Use cache paths (legacy capture-and-cache approach)
			if (scProvider && 'getCachePaths' in scProvider) {
				try {
					const paths = await (scProvider as any).getCachePaths();
					paths.forEach((path: string) => scPaths.add(path));
				} catch {
					// Cache not available or not enabled - that's fine
				}
			}
		}
		
		// Step 2: Get wide net from LOCAL providers (Hash, BM25, Heuristic) - top 500
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
		
		// Step 3: If SC template paths provided, find intersection (items in both lists)
		// This is the "voting system" - if both hash AND SC template agree, it's high confidence
		let finalResults = localResults;
		if (scPaths.size > 0) {
			// Find intersection: items that appear in both SC template AND hash results
			finalResults = localResults.map(({ providerId, items }) => ({
				providerId,
				items: items
					.filter(item => scPaths.has(item.path)) // Only keep items in SC template
					.map(item => ({ ...item, score: item.score * 2.0 })) // Boost intersection items
			}));
			
			const intersectionCount = finalResults.reduce((sum, r) => sum + r.items.length, 0);
			console.debug(`[RetrievalService] SC template intersection: ${scPaths.size} SC paths, ${intersectionCount} matches with hash results`);
		} else {
			// No SC paths: use hash results as-is (no intersection filtering)
			finalResults = localResults;
		}
		
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
		const allResults = [...finalResults, ...externalResults];
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


