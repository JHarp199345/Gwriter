import type { ContextItem } from './types';
import type { CpuRerankerModel } from './RerankerModel';
import { fnv1a32 } from '../ContentHash';

function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 0;
	return Math.max(0, Math.min(1, x));
}

function normalizeText(s: string): string {
	return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * CPU reranker using @xenova/transformers (WASM). Loaded lazily.
 * If the model fails to load/run, callers should fall back to the pre-rerank order.
 */
class TransformersCrossEncoder implements CpuRerankerModel {
	readonly id = 'cross-encoder-msmarco-minilm';

	private pipeline:
		| null
		| ((input: string | Array<{ text: string; text_pair: string }>) => Promise<unknown>) = null;
	private loading: Promise<void> | null = null;

	private async ensureLoaded(): Promise<void> {
		if (this.pipeline) return;
		if (this.loading !== null) return this.loading;

		this.loading = (async () => {
			const transformersUnknown: unknown = await import('@xenova/transformers');
			const transformers = transformersUnknown as {
				pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
			};
			if (!transformers.pipeline) throw new Error('Transformers pipeline is unavailable');

			// Cross-encoder reranker model (small-ish). Best-effort: may fail on some environments.
			const pipeUnknown = await transformers.pipeline(
				'text-classification',
				'Xenova/cross-encoder-ms-marco-MiniLM-L-6-v2',
				{ quantized: true }
			);
			const pipe = pipeUnknown as (input: unknown) => Promise<unknown>;
			this.pipeline = async (input) => await pipe(input);
		})().finally(() => {
			this.loading = null;
		});

		return this.loading;
	}

	async rerankPair(query: string, document: string): Promise<{ score: number }> {
		const q = normalizeText(query);
		const d = normalizeText(document);
		if (!q || !d) return { score: 0 };
		await this.ensureLoaded();
		if (!this.pipeline) throw new Error('Reranker pipeline unavailable');

		// Prefer pair input if supported by the pipeline implementation; fall back to concatenation.
		let out: unknown;
		try {
			out = await this.pipeline([{ text: q, text_pair: d }]);
		} catch {
			out = await this.pipeline(`${q}\n\n${d}`);
		}

		// Common output formats:
		// - [{ label: 'LABEL_1', score: 0.93 }, ...]
		// - { label, score }
		const first = Array.isArray(out) ? out[0] : out;
		const obj = first as { score?: unknown; label?: unknown };
		const score = typeof obj?.score === 'number' ? obj.score : 0;
		return { score: clamp01(score) };
	}
}

export interface CpuRerankOptions {
	limit: number; // how many items to return
	shortlist?: number; // how many to score
}

export class CpuReranker {
	private readonly model: CpuRerankerModel;
	// queryHash -> itemKey -> score
	private readonly cache = new Map<string, Map<string, number>>();

	constructor(model?: CpuRerankerModel) {
		this.model = model ?? new TransformersCrossEncoder();
	}

	private hashQuery(q: string): string {
		return fnv1a32(normalizeText(q));
	}

	warm(query: string, items: ContextItem[], opts?: { shortlist?: number }): void {
		const shortlist = Math.max(1, Math.min(120, Math.floor(opts?.shortlist ?? 40)));
		const qh = this.hashQuery(query);
		const map = this.cache.get(qh) ?? new Map<string, number>();
		this.cache.set(qh, map);

		const toScore = items.slice(0, shortlist).filter((it) => !map.has(it.key));
		if (toScore.length === 0) return;

		// Fire-and-forget warmup; never block UI.
		void (async () => {
			for (const it of toScore) {
				try {
					const doc = `${it.path}\n${it.excerpt}`;
					const res = await this.model.rerankPair(query, doc);
					map.set(it.key, res.score);
				} catch {
					// stop warming if model fails
					break;
				}
			}
		})().catch(() => {
			// ignore
		});
	}

	async rerank(query: string, items: ContextItem[], opts: CpuRerankOptions): Promise<ContextItem[]> {
		const limit = Math.max(1, Math.min(200, Math.floor(opts.limit)));
		const shortlist = Math.max(limit, Math.min(120, Math.floor(opts.shortlist ?? 60)));
		const qh = this.hashQuery(query);
		const map = this.cache.get(qh) ?? new Map<string, number>();
		this.cache.set(qh, map);

		const scored: Array<{ item: ContextItem; score: number }> = [];
		const slice = items.slice(0, shortlist);
		for (const it of slice) {
			const cached = map.get(it.key);
			if (typeof cached === 'number') {
				scored.push({ item: it, score: cached });
				continue;
			}
			const doc = `${it.path}\n${it.excerpt}`;
			const res = await this.model.rerankPair(query, doc);
			map.set(it.key, res.score);
			scored.push({ item: it, score: res.score });
		}

		// Merge rerank score into final ordering; keep original score as secondary signal.
		const out = scored
			.sort((a, b) => b.score - a.score || b.item.score - a.item.score)
			.slice(0, limit)
			.map((s) => ({
				...s.item,
				// Keep the score field as the rerank score so formatting reflects true order.
				score: s.score,
				source: 'rerank',
				reasonTags: Array.from(new Set([...(s.item.reasonTags ?? []), 'rerank']))
			}));

		return out;
	}
}


