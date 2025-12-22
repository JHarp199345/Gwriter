import type { ContextItem } from './types';

function dot(a: number[], b: number[]): number {
	const n = Math.min(a.length, b.length);
	let s = 0;
	for (let i = 0; i < n; i++) s += a[i] * b[i];
	return s;
}

function tokenizeLoose(value: string): Set<string> {
	const toks = (value || '')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/gu)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3);
	return new Set(toks);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const t of a) if (b.has(t)) inter++;
	const union = a.size + b.size - inter;
	return union ? inter / union : 0;
}

export interface MmrOptions {
	limit: number;
	lambda?: number; // relevance weight
	getVector?: (key: string) => number[] | null;
}

/**
 * Maximal Marginal Relevance selection to reduce near-duplicates while keeping relevance.
 */
export function mmrSelect(items: ContextItem[], opts: MmrOptions): ContextItem[] {
	const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
	const lambda = Math.max(0, Math.min(1, opts.lambda ?? 0.72));

	const candidates = (items || []).slice(0, 400);
	if (candidates.length <= limit) return candidates.slice(0, limit);

	const selected: ContextItem[] = [];
	const selectedKeys = new Set<string>();

	// Precompute lexical sets for fallback similarity.
	const lex = new Map<string, Set<string>>();
	for (const it of candidates) {
		lex.set(it.key, tokenizeLoose(`${it.path} ${it.title ?? ''} ${it.excerpt}`));
	}

	const sim = (a: ContextItem, b: ContextItem): number => {
		const va = opts.getVector?.(a.key) ?? null;
		const vb = opts.getVector?.(b.key) ?? null;
		if (va && vb) {
			// vectors are expected to be L2-normalized
			return Math.max(0, Math.min(1, (dot(va, vb) + 1) / 2));
		}
		return jaccard(lex.get(a.key) ?? new Set(), lex.get(b.key) ?? new Set());
	};

	while (selected.length < limit) {
		let best: ContextItem | null = null;
		let bestScore = -Infinity;

		for (const cand of candidates) {
			if (selectedKeys.has(cand.key)) continue;

			const relevance = cand.score;
			let redundancy = 0;
			for (const s of selected) {
				redundancy = Math.max(redundancy, sim(cand, s));
				if (redundancy >= 0.95) break;
			}

			const score = lambda * relevance - (1 - lambda) * redundancy;
			if (score > bestScore) {
				bestScore = score;
				best = cand;
			}
		}

		if (!best) break;
		selected.push(best);
		selectedKeys.add(best.key);
	}

	return selected;
}


