import type { ContextItem } from './types';

export interface ProviderBatch {
	providerId: string;
	items: ContextItem[];
}

function mergeReasonTags(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (!a?.length && !b?.length) return undefined;
	const set = new Set<string>();
	a?.forEach((t) => set.add(t));
	b?.forEach((t) => set.add(t));
	return Array.from(set);
}

/**
 * Reciprocal Rank Fusion (RRF) across provider-ranked lists.
 * Produces a stable ranking even when providers disagree on score scales.
 */
export function fuseRrf(batches: ProviderBatch[], opts?: { k?: number; limit?: number }): ContextItem[] {
	const k = opts?.k ?? 60;
	const limit = opts?.limit ?? 200;

	const acc = new Map<string, { item: ContextItem; score: number }>();

	for (const batch of batches) {
		const sorted = (batch.items || []).slice().sort((a, b) => b.score - a.score);
		for (let i = 0; i < sorted.length; i++) {
			const it = sorted[i];
			const key = it.key || `${it.path}${it.anchor ? `#${it.anchor}` : ''}`;
			const add = 1 / (k + (i + 1));
			const existing = acc.get(key);
			if (!existing) {
				acc.set(key, { item: { ...it, key }, score: add });
			} else {
				acc.set(key, {
					item: {
						...existing.item,
						// keep highest base score among providers but include tags from both
						score: Math.max(existing.item.score, it.score),
						reasonTags: mergeReasonTags(existing.item.reasonTags, it.reasonTags)
					},
					score: existing.score + add
				});
			}
		}
	}

	const fused = Array.from(acc.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, Math.min(1000, limit)));

	// Normalize fused scores to 0..1 for downstream consumers.
	let max = 0;
	for (const f of fused) if (f.score > max) max = f.score;
	const denom = max || 1;

	return fused.map((f) => ({
		...f.item,
		score: Math.max(0, Math.min(1, f.score / denom)),
		source: 'fused',
		reasonTags: mergeReasonTags(f.item.reasonTags, ['fused'])
	}));
}


