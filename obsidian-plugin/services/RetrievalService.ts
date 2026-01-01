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

	async _searchRaw(
		query: RetrievalQuery, 
		opts: RetrievalOptions
	): Promise<ContextItem[]> {
		const candidateLimit = opts.limit;

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
		
		// RRF fusion over lexical + semantic
		return fuseRrf(buckets, { limit: candidateLimit, k: 60 });
	}

	async search(
		query: RetrievalQuery, 
		opts: RetrievalOptions
	): Promise<ContextItem[]> {
		const limit = normalizeLimit(opts.limit);
		const candidateLimit = Math.max(limit, Math.min(500, limit * 8)); // Wider net

		// Scoring Weights (Version 1)
		const weights = { lex: 0.4, embed: 0.6 };
		const scoringVersion = opts.scoringVersion || 1;

		// Phase 2: Intent-Driven Retrieval
		const intents = (query as any).intents || [];
		
		// Run searches for each intent if present
		const intentBuckets = await Promise.all(intents.map(async (intent: any) => {
			const intentQuery = { ...query, text: intent.query || query.text };
			const items = await this._searchRaw(intentQuery, { limit: candidateLimit });
			return items.map(it => ({ ...it, intentType: intent.type }));
		}));

		// Run default search as well
		const defaultItems = await this._searchRaw(query, { limit: candidateLimit });
		
		const allItems = [...defaultItems, ...intentBuckets.flat()];

		// Deduplicate and Fuse
		const acc = new Map<string, ContextItem>();
		allItems.forEach(it => {
			const existing = acc.get(it.key);
			if (!existing || it.score > existing.score) {
				acc.set(it.key, it);
			}
		});

		let fused = Array.from(acc.values());

		// Instrumentation: Log candidate pools
		console.log(`[Retrieval] Gathered ${fused.length} unique candidates.`);

		// Phase 2: Versioned RAG Scoring
		const T_hard = 0.7;
		const E_hard = 0.6;
		const L_hard = 0.6;

		fused = fused.map(item => {
			// In a real implementation, we would recalculate lex/embed per provider
			// For now, we use the combined score as a base
			const lexScore = item.source === 'heuristic' ? item.score : 0;
			const embedScore = item.source === 'semantic' ? item.score : 0;
			const finalScore = (lexScore * weights.lex) + (embedScore * weights.embed);

			return {
				...item,
				score: finalScore,
				relevance: {
					lexScore,
					embedScore,
					finalScore,
					threshold: T_hard,
					weights
				}
			};
		});

		// Sort by new finalScore
		fused.sort((a, b) => b.score - a.score);

		// Post-fusion stale handling
		if (opts.strictMode) {
			// Exclude stale chunks in strict mode
			fused = fused.filter(it => !it.isStale);
		} else {
			// Apply 0.5x stale penalty in best-effort mode
			fused = fused.map(it => {
				if (it.isStale) {
					return {
						...it,
						score: it.score * 0.5,
						stalePenaltyApplied: true,
						reasonTags: [...(it.reasonTags || []), 'stale-penalty']
					};
				}
				return it;
			}).sort((a, b) => b.score - a.score);
		}

		// MMR for diversity
		const lambda = opts.noveltyBias !== undefined 
			? Math.max(0.4, 0.72 - opts.noveltyBias) 
			: 0.72;

		let diverse = mmrSelect(fused, { limit, lambda, getVector: this.getVector });

		// Post-MMR: Ensure stickyMin is satisfied from fallbackSet
		if (opts.fallbackSet && opts.stickyMin !== undefined && opts.fallbackSet.length > 0) {
			const stickyTarget = Math.ceil(limit * opts.stickyMin);
			const currentSticky = diverse.filter(it => opts.fallbackSet?.includes(it.key)).length;
			
			if (currentSticky < stickyTarget) {
				const missing = stickyTarget - currentSticky;
				const availableSticky = fused
					.filter(it => opts.fallbackSet?.includes(it.key) && !diverse.some(d => d.key === it.key))
					.sort((a, b) => b.score - a.score);
				
				const toAdd = availableSticky.slice(0, missing);
				diverse = [...diverse.slice(0, limit - toAdd.length), ...toAdd];
			}
		}

		return diverse.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}


