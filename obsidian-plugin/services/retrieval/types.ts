export type RetrievalMode = 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';

export interface RetrievalQuery {
	/**
	 * Free-form text that represents the user's current need.
	 * Usually built from: selected text, director notes, scene summary, character names, etc.
	 */
	text: string;
	/**
	 * Optional hint about where the user is working.
	 */
	activeFilePath?: string;
	mode?: RetrievalMode;
	/**
	 * Optional entity hints (character/location names) used for boosting.
	 */
	hints?: {
		characters?: string[];
		locations?: string[];
	};
}

export interface RetrievalOptions {
	limit: number;
	strictMode?: boolean;
	noveltyBias?: number;
	stickyMin?: number;
	fallbackSet?: string[];
	scoringVersion?: number;
}

export interface HitRelevance {
	lexScore: number;
	embedScore: number;
	finalScore: number;
	threshold: number;
	weights: { lex: number, embed: number };
}

export interface ContextItem {
	/**
	 * Stable identity for dedupe (path + optional anchor).
	 */
	key: string;
	path: string;
	anchor?: string;
	title?: string;
	excerpt: string;
	/**
	 * Higher is better. Providers should normalize to roughly 0..1 when possible.
	 */
	score: number;
	/**
	 * Where this result came from (heuristic/embeddings/etc).
	 */
	source: string;
	/**
	 * Optional small list of tags explaining why this item ranked (useful for debugging/UI).
	 */
	reasonTags?: string[];
	/**
	 * Flag indicating the chunk is derived from stale index data.
	 */
	isStale?: boolean;
	/**
	 * Diagnostic flag showing that a stale penalty was applied to this item.
	 */
	stalePenaltyApplied?: boolean;

	// Phase 2: Versioned RAG
	relevance?: HitRelevance;
	intentType?: string;
}

export interface RetrievalProvider {
	readonly id: string;
	search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]>;
}


