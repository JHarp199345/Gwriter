import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './retrieval/types';

function mergeReasonTags(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
	if (!a?.length && !b?.length) return undefined;
	const set = new Set<string>();
	a?.forEach((t) => set.add(t));
	b?.forEach((t) => set.add(t));
	return Array.from(set);
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 20;
	return Math.max(1, Math.min(200, Math.floor(limit)));
}

export class RetrievalService {
	private readonly providers: RetrievalProvider[];

	constructor(providers: RetrievalProvider[]) {
		this.providers = providers;
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		const limit = normalizeLimit(opts.limit);
		const resultsByKey = new Map<string, ContextItem>();

		const providerResults = await Promise.all(
			this.providers.map(async (p) => {
				try {
					return await p.search(query, { limit });
				} catch {
					// Provider failure must not break generation. Treat as empty.
					return [];
				}
			})
		);

		for (const batch of providerResults) {
			for (const item of batch) {
				const key = item.key || `${item.path}${item.anchor ? `#${item.anchor}` : ''}`;
				const existing = resultsByKey.get(key);
				if (!existing) {
					resultsByKey.set(key, { ...item, key });
					continue;
				}
				// Keep best score; merge reason tags.
				if (item.score > existing.score) {
					resultsByKey.set(key, {
						...item,
						key,
						reasonTags: mergeReasonTags(existing.reasonTags, item.reasonTags)
					});
				} else {
					resultsByKey.set(key, {
						...existing,
						reasonTags: mergeReasonTags(existing.reasonTags, item.reasonTags)
					});
				}
			}
		}

		return Array.from(resultsByKey.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}


