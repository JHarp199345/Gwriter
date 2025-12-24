import type { Vault } from 'obsidian';
import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import type { VaultService } from '../VaultService';
import { fnv1a32 } from '../ContentHash';

const STOPWORDS = new Set<string>([
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'to',
	'of',
	'in',
	'on',
	'for',
	'with',
	'at',
	'from',
	'by',
	'as',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'it',
	'that',
	'this',
	'these',
	'those'
]);

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function findSnippet(content: string, term: string, maxLen: number): string {
	const lower = content.toLowerCase();
	const idx = lower.indexOf(term.toLowerCase());
	if (idx < 0) return content.slice(0, maxLen);
	const start = Math.max(0, idx - Math.floor(maxLen / 3));
	const end = Math.min(content.length, start + maxLen);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';
	return `${prefix}${content.slice(start, end)}${suffix}`.trim();
}

export class HeuristicProvider implements RetrievalProvider {
	readonly id = 'heuristic';

	private readonly vault: Vault;
	private readonly vaultService: VaultService;
	private readonly cache = new Map<string, { at: number; results: ContextItem[] }>();
	private readonly cacheTtlMs = 30_000;

	constructor(vault: Vault, vaultService: VaultService) {
		this.vault = vault;
		this.vaultService = vaultService;
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		const q = (query.text ?? '').trim();
		if (!q) return [];

		const cacheKey = fnv1a32(
			[
				'q:' + q,
				'active:' + (query.activeFilePath ?? ''),
				'mode:' + (query.mode ?? ''),
				'k:' + String(opts.limit)
			].join('\n')
		);
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.at <= this.cacheTtlMs) {
			return cached.results.slice(0, opts.limit);
		}

		const terms = tokenize(q).slice(0, 24);
		if (terms.length === 0) return [];

		const files = this.vaultService.getIncludedMarkdownFiles();
		if (files.length === 0) return [];

		// Fast candidate scoring without reading file content.
		const now = Date.now();
		const scored = files
			.map((f) => {
				const base = `${f.basename} ${f.path}`.toLowerCase();
				let score = 0;
				let titleHits = 0;
				for (const t of terms) {
					if (base.includes(t)) {
						score += 1.0;
						titleHits++;
					}
				}
				// Recency boost (soft): newer files float up for relevance.
				const ageMs = Math.max(0, now - (f.stat?.mtime ?? now));
				const recency = 1 / (1 + ageMs / (1000 * 60 * 60 * 24 * 30)); // ~30 day scale
				score += recency * 0.5;

				// Working-file proximity boost
				if (query.activeFilePath && f.path === query.activeFilePath) score += 0.75;
				if (query.activeFilePath && f.path.startsWith(query.activeFilePath.split('/').slice(0, -1).join('/'))) score += 0.15;

				return { file: f, score, titleHits };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, 200);

		const results: ContextItem[] = [];
		const maxRead = Math.min(scored.length, 120);

		for (let i = 0; i < maxRead; i++) {
			const { file, score: baseScore, titleHits } = scored[i];
			let content = '';
			try {
				content = await this.vault.read(file);
			} catch {
				continue;
			}

			const lower = content.toLowerCase();
			let tf = 0;
			let firstTerm: string | null = null;
			for (const t of terms) {
				const hits = lower.split(t).length - 1;
				if (hits > 0 && !firstTerm) firstTerm = t;
				tf += hits;
			}
			if (tf === 0 && titleHits === 0) continue;

			const normalizedTf = Math.min(1, tf / 24);
			const score = Math.min(1, baseScore / 6 + normalizedTf * 0.7);

			const reasonTags: string[] = [];
			if (titleHits > 0) reasonTags.push('titleMatch');
			if (tf > 0) reasonTags.push('textMatch');

			const excerpt = firstTerm ? findSnippet(content, firstTerm, 2500) : content.slice(0, 2500);

			results.push({
				key: `file:${file.path}`,
				path: file.path,
				title: file.basename,
				excerpt,
				score,
				source: this.id,
				reasonTags
			});
		}

		const finalResults = results.sort((a, b) => b.score - a.score).slice(0, opts.limit);
		this.cache.set(cacheKey, { at: Date.now(), results: finalResults });
		return finalResults;
	}
}


