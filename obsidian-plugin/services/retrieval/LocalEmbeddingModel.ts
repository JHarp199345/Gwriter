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
		if (this.pipeline) {
			console.log(`[LocalEmbeddingModel] Pipeline already loaded`);
			return;
		}
		if (this.loading !== null) {
			console.log(`[LocalEmbeddingModel] Pipeline loading in progress, waiting...`);
			return this.loading;
		}

		console.log(`[LocalEmbeddingModel] Starting model load...`);
		const loadStart = Date.now();
		this.loading = (async () => {
			try {
				// Dynamic import to avoid bundling weight unless enabled.
				console.log(`[LocalEmbeddingModel] Importing @xenova/transformers...`);
				const transformersUnknown: unknown = await import('@xenova/transformers');
				const transformers = transformersUnknown as {
					pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
				};
				if (!transformers.pipeline) {
					throw new Error('Transformers pipeline is unavailable - @xenova/transformers may not be installed or compatible');
				}
				console.log(`[LocalEmbeddingModel] ✓ Transformers library loaded`);

				// Cache models inside plugin data to avoid re-downloading if possible.
				// Note: transformers uses its own caching strategy; this is a hint.
				const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
				console.log(`[LocalEmbeddingModel] Cache directory: ${cacheDir}`);
				console.log(`[LocalEmbeddingModel] Loading model: Xenova/all-MiniLM-L6-v2 (quantized)...`);

				const pipeUnknown = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
					quantized: true,
					progress_callback: undefined,
					cache_dir: cacheDir
				});
				const pipe = pipeUnknown as (input: string, opts?: Record<string, unknown>) => Promise<unknown>;
				console.log(`[LocalEmbeddingModel] ✓ Model pipeline created`);

				this.pipeline = async (text: string) => {
					try {
						const out = await pipe(text, { pooling: 'mean', normalize: true });
						// transformers output can vary; handle common cases.
						if (Array.isArray(out) && Array.isArray(out[0])) {
							return l2Normalize(out[0] as number[]);
						}
						if (Array.isArray(out)) {
							return l2Normalize(out as number[]);
						}
						const maybe = out as { data?: number[] };
						if (Array.isArray(maybe?.data)) return l2Normalize(maybe.data);
						console.error(`[LocalEmbeddingModel] Unexpected output format:`, typeof out, Array.isArray(out), out);
						throw new Error('Unexpected embeddings output');
					} catch (err) {
						console.error(`[LocalEmbeddingModel] Error during embedding generation:`, err);
						throw err;
					}
				};
				const loadDuration = Date.now() - loadStart;
				console.log(`[LocalEmbeddingModel] ✓ Model fully loaded in ${loadDuration}ms`);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorStack = err instanceof Error ? err.stack : undefined;
				console.error(`[LocalEmbeddingModel] ✗ Model loading failed:`, errorMsg);
				if (errorStack) {
					console.error(`[LocalEmbeddingModel] Stack:`, errorStack.split('\n').slice(0, 5).join('\n'));
				}
				throw err;
			}
		})().finally(() => {
			this.loading = null;
		});

		return this.loading;
	}

	async isReady(): Promise<boolean> {
		try {
			await this.ensureLoaded();
			return this.pipeline !== null;
		} catch {
			return false;
		}
	}

	async embed(text: string): Promise<number[]> {
		const t = (text || '').trim();
		if (!t) {
			console.warn(`[LocalEmbeddingModel] Empty text provided, returning zero vector`);
			return new Array<number>(this.dim).fill(0);
		}
		try {
			await this.ensureLoaded();
			if (!this.pipeline) {
				throw new Error('Embeddings pipeline unavailable after loading attempt');
			}
			const embedStart = Date.now();
			const result = await this.pipeline(t);
			const embedDuration = Date.now() - embedStart;
			console.log(`[LocalEmbeddingModel] Generated embedding in ${embedDuration}ms for text (${t.length} chars, ${t.split(/\s+/).length} words)`);
			return result;
		} catch (err) {
			console.error(`[LocalEmbeddingModel] Embedding generation failed:`, err);
			throw err;
		}
	}
}


