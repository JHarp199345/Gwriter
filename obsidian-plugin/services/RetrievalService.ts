import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './retrieval/types';
import { fuseRrf } from './retrieval/Fusion';
import { mmrSelect } from './retrieval/Mmr';
import { CO_AUTHORING_POLICY } from './policy';
import { RAGFailureCode } from './Schemas';

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
		const timeout = CO_AUTHORING_POLICY.PERFORMANCE.MAX_TIME_PER_SMART_CALL_MS;

		// Separate lexical vs semantic
		const lexicalProviders = this.providers.filter(p => p.id === 'heuristic');
		const semanticProviders = this.providers.filter(p => p.id === 'semantic');

	const runWithTimeout = async (p: RetrievalProvider) => {
		const searchPromise = p.search(query, { limit: candidateLimit });
		let timeoutHandle: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<ContextItem[]>((_, reject) => {
			timeoutHandle = setTimeout(() => reject(new Error('FAIL_TIME_BUDGET')), timeout);
		});

		try {
			const result = await Promise.race([searchPromise, timeoutPromise]);
			clearTimeout(timeoutHandle!);
			return { providerId: p.id, items: result };
		} catch (err) {
			clearTimeout(timeoutHandle!);
			const errMessage = err instanceof Error ? err.message : String(err);
			console.warn(`[Retrieval] Provider ${p.id} failed or timed out:`, err);
			return { providerId: p.id, items: [] as ContextItem[], failureCode: errMessage === 'FAIL_TIME_BUDGET' ? 'FAIL_TIME_BUDGET' : undefined };
		}
	};

		// Run in parallel
		const [lexicalBuckets, semanticBuckets] = await Promise.all([
			Promise.all(lexicalProviders.map(runWithTimeout)),
			Promise.all(semanticProviders.map(runWithTimeout))
		]);

		// Flatten buckets
		let buckets = [...lexicalBuckets, ...semanticBuckets].filter(b => b.items.length > 0);
		
		// Lexical Fallback: If all semantic providers failed/timed out, and we have lexical results
		const semanticFailed = semanticProviders.length > 0 && semanticBuckets.every(b => b.items.length === 0 && b.failureCode === 'FAIL_TIME_BUDGET');
		if (semanticFailed && lexicalBuckets.some(b => b.items.length > 0)) {
			console.warn('[Retrieval] ⚡ Semantic providers timed out. Falling back to Lexical-only results.');
			buckets = lexicalBuckets.filter(b => b.items.length > 0);
		}

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

		// Phase 2: Intent-Driven Retrieval
		const extendedQuery = query as RetrievalQuery & { intents?: Array<{ query?: string; type?: string }> };
		const intents = extendedQuery.intents || [];
		
		// Run searches for each intent if present
		const intentBuckets = await Promise.all(intents.map(async (intent) => {
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

		// Instrumentation: candidate pool size

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

		// Instrumentation: Log failures
		if (diverse.length === 0) {
			console.warn('[Retrieval] ❌ RAG Failure: FAIL_MIN_HITS');
		} else {
			const topScore = diverse[0].relevance?.finalScore || 0;
			if (topScore < T_hard) {
				console.warn(`[Retrieval] ⚠️ RAG Warning: FAIL_CONFIDENCE (Top score ${topScore.toFixed(2)} < ${T_hard})`);
			}
		}

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


