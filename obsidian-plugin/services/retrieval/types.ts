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
}

export interface RetrievalOptions {
	limit: number;
}

export interface RetrievalProvider {
	readonly id: string;
	search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]>;
}


