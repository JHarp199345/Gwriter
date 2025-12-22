import type { Vault } from 'obsidian';
import WritingDashboardPlugin from '../../main';

export interface LocalEmbeddingModel {
	readonly id: string;
	readonly dim: number;
	embed(text: string): Promise<number[]>;
}

function l2Normalize(vec: number[]): number[] {
	let sumSq = 0;
	for (const v of vec) sumSq += v * v;
	const norm = Math.sqrt(sumSq) || 1;
	return vec.map((v) => v / norm);
}

/**
 * True local embeddings using @xenova/transformers (WASM). Loaded lazily.
 * Falls back to throwing on load failure; callers should catch and use heuristic/hash.
 */
export class MiniLmLocalEmbeddingModel implements LocalEmbeddingModel {
	readonly id = 'minilm';
	readonly dim = 384;

	private readonly vault: Vault;
	private readonly plugin: WritingDashboardPlugin;
	private pipeline: null | ((text: string) => Promise<number[]>) = null;
	private loading: Promise<void> | null = null;

	constructor(vault: Vault, plugin: WritingDashboardPlugin) {
		this.vault = vault;
		this.plugin = plugin;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.pipeline) return;
		if (this.loading !== null) return this.loading;

		this.loading = (async () => {
			// Dynamic import to avoid bundling weight unless enabled.
			const transformersUnknown: unknown = await import('@xenova/transformers');
			const transformers = transformersUnknown as {
				pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
			};
			if (!transformers.pipeline) throw new Error('Transformers pipeline is unavailable');

			// Cache models inside plugin data to avoid re-downloading if possible.
			// Note: transformers uses its own caching strategy; this is a hint.
			const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;

			const pipeUnknown = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
				quantized: true,
				progress_callback: undefined,
				cache_dir: cacheDir
			});
			const pipe = pipeUnknown as (input: string, opts?: Record<string, unknown>) => Promise<unknown>;

			this.pipeline = async (text: string) => {
				const out = (await pipe(text, { pooling: 'mean', normalize: true })) as unknown;
				// transformers output can vary; handle common cases.
				if (Array.isArray(out) && Array.isArray(out[0])) {
					return l2Normalize(out[0] as number[]);
				}
				if (Array.isArray(out)) {
					return l2Normalize(out as number[]);
				}
				const maybe = out as { data?: number[] };
				if (Array.isArray(maybe?.data)) return l2Normalize(maybe.data);
				throw new Error('Unexpected embeddings output');
			};
		})().finally(() => {
			this.loading = null;
		});

		return this.loading;
	}

	async embed(text: string): Promise<number[]> {
		const t = (text || '').trim();
		if (!t) return new Array<number>(this.dim).fill(0);
		await this.ensureLoaded();
		if (!this.pipeline) throw new Error('Embeddings pipeline unavailable');
		return await this.pipeline(t);
	}
}


