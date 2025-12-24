import type { Vault } from 'obsidian';
import WritingDashboardPlugin from '../../main';

// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin: WritingDashboardPlugin): Promise<any> {
	// Import the vendored transformers library first
	const mod: any = await import('../../lib/transformers.js');
	
	// Configure WASM paths - need absolute URLs that Obsidian can serve
	if (mod.env && mod.env.backends && mod.env.backends.onnx) {
		const onnxEnv = mod.env.backends.onnx;
		if (!onnxEnv.wasm) onnxEnv.wasm = {};
		
		// Construct absolute paths to WASM files
		// Obsidian serves plugin files from the plugin directory
		// @ts-ignore - basePath exists but not in types
		const vaultBase = (plugin.app.vault.adapter as any).basePath || '';
		const pluginId = plugin.manifest.id;
		
		// WASM files that need to be accessible
		const wasmFiles = [
			'ort-wasm.wasm',
			'ort-wasm-simd.wasm',
			'ort-wasm-threaded.wasm',
			'ort-wasm-simd-threaded.wasm'
		];
		
		// Strategy: Use object mapping with paths relative to plugin root
		// The library will try to fetch these, so they need to be accessible via HTTP
		// In Obsidian, plugin files are served from .obsidian/plugins/plugin-name/
		const wasmPaths: Record<string, string> = {};
		
		// Try relative path from plugin root - Obsidian should serve files from plugin directory
		// The path should be relative to where the plugin is installed
		for (const wasmFile of wasmFiles) {
			// Use relative path - library will resolve from plugin root
			wasmPaths[wasmFile] = `./lib/${wasmFile}`;
		}
		
		// Set as object mapping (library supports this format)
		onnxEnv.wasm.wasmPaths = wasmPaths;
		
		// Enhanced logging for diagnostics
		console.log(`[LocalEmbeddingModel] === WASM PATH CONFIGURATION ===`);
		console.log(`[LocalEmbeddingModel] Vault base: ${vaultBase}`);
		console.log(`[LocalEmbeddingModel] Plugin ID: ${pluginId}`);
		console.log(`[LocalEmbeddingModel] WASM paths configured:`, wasmPaths);
		console.log(`[LocalEmbeddingModel] ONNX env structure:`, {
			hasEnv: !!mod.env,
			hasBackends: !!mod.env?.backends,
			hasOnnx: !!mod.env?.backends?.onnx,
			hasWasm: !!mod.env?.backends?.onnx?.wasm,
			wasmPathsType: typeof onnxEnv.wasm.wasmPaths,
			wasmPathsIsObject: typeof onnxEnv.wasm.wasmPaths === 'object',
			wasmPathsKeys: typeof onnxEnv.wasm.wasmPaths === 'object' ? Object.keys(onnxEnv.wasm.wasmPaths) : 'N/A'
		});
		console.log(`[LocalEmbeddingModel] === END WASM CONFIGURATION ===`);
	} else {
		console.error(`[LocalEmbeddingModel] ERROR: mod.env structure not found:`, {
			hasMod: !!mod,
			hasEnv: !!mod?.env,
			hasBackends: !!mod?.env?.backends,
			hasOnnx: !!mod?.env?.backends?.onnx,
			modKeys: mod ? Object.keys(mod) : []
		});
	}
	
	const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
	if (!pipeline || typeof pipeline !== 'function') {
		throw new Error('Pipeline not found in transformers module');
	}
	return pipeline;
}

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
interface ModelErrorLogEntry {
	timestamp: string;
	location: string;
	context: string;
	message: string;
	stack?: string;
	errorType?: string;
}

export class MiniLmLocalEmbeddingModel implements LocalEmbeddingModel {
	readonly id = 'minilm';
	readonly dim = 384;

	private readonly vault: Vault;
	private readonly plugin: WritingDashboardPlugin;
	private pipeline: null | ((text: string) => Promise<number[]>) = null;
	private loading: Promise<void> | null = null;
	private loadAttempts = 0;
	private lastLoadError: ModelErrorLogEntry | null = null;
	private readonly errorLog: ModelErrorLogEntry[] = [];
	private readonly maxStoredErrors = 50;

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
		this.loadAttempts++;
		const loadStart = Date.now();
		this.loading = (async () => {
			try {
				// Get pipeline function - using helper to ensure proper initialization
				console.log(`[LocalEmbeddingModel] Loading vendored transformers pipeline...`);
				let pipeline: any;
				try {
					pipeline = await getPipeline(this.plugin);
					if (!pipeline || typeof pipeline !== 'function') {
						throw new Error('Pipeline is not a function');
					}
					console.log(`[LocalEmbeddingModel] ✓ Pipeline function loaded`);
				} catch (importErr) {
					this.logError('ensureLoaded.import', 'Loading vendored transformers pipeline', importErr);
					throw new Error(`Failed to load transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
				}

				// Cache models inside plugin data to avoid re-downloading if possible.
				// Note: transformers uses its own caching strategy; this is a hint.
				const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
				console.log(`[LocalEmbeddingModel] Cache directory: ${cacheDir}`);
				console.log(`[LocalEmbeddingModel] Loading model: Xenova/all-MiniLM-L6-v2 (quantized)...`);

				let pipeUnknown: unknown;
				try {
					// Call pipeline directly as a function
					pipeUnknown = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
						quantized: true,
						progress_callback: undefined,
						cache_dir: cacheDir
					});
				} catch (pipelineErr) {
					this.logError('ensureLoaded.createPipeline', `Creating pipeline with model Xenova/all-MiniLM-L6-v2, cache: ${cacheDir}`, pipelineErr);
					throw pipelineErr;
				}
				
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
						const err = new Error(`Unexpected embeddings output format: ${typeof out}, isArray: ${Array.isArray(out)}`);
						this.logError('pipeline.embed', `Processing text (${text.length} chars)`, err);
						console.error(`[LocalEmbeddingModel] Unexpected output format:`, typeof out, Array.isArray(out), out);
						throw err;
					} catch (err) {
						this.logError('pipeline.embed', `Generating embedding for text (${text.length} chars, ${text.split(/\s+/).length} words)`, err);
						console.error(`[LocalEmbeddingModel] Error during embedding generation:`, err);
						throw err;
					}
				};
				const loadDuration = Date.now() - loadStart;
				console.log(`[LocalEmbeddingModel] ✓ Model fully loaded in ${loadDuration}ms`);
			} catch (err) {
				this.logError('ensureLoaded', `Model loading attempt #${this.loadAttempts}`, err);
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
		} catch (err) {
			this.logError('isReady', 'Checking model readiness', err);
			return false;
		}
	}

	getRecentErrors(limit: number = 20): ModelErrorLogEntry[] {
		return this.errorLog.slice(-limit);
	}

	getLastLoadError(): ModelErrorLogEntry | null {
		return this.lastLoadError;
	}

	getLoadAttempts(): number {
		return this.loadAttempts;
	}

	private logError(location: string, context: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		const errorType = error instanceof Error ? error.constructor.name : typeof error;
		
		const entry: ModelErrorLogEntry = {
			timestamp: new Date().toISOString(),
			location,
			context,
			message: errorMsg,
			stack: errorStack,
			errorType
		};
		
		this.errorLog.push(entry);
		if (this.errorLog.length > this.maxStoredErrors) {
			this.errorLog.shift();
		}
		
		// Store as last load error if it's a loading error
		if (location === 'ensureLoaded' || location === 'isReady') {
			this.lastLoadError = entry;
		}
		
		console.error(`[LocalEmbeddingModel] ERROR [${location}] ${context}:`, errorMsg);
		if (errorStack) {
			console.error(`[LocalEmbeddingModel] Stack:`, errorStack.split('\n').slice(0, 3).join('\n'));
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
			this.logError('embed', `Embedding text (${t.length} chars, ${t.split(/\s+/).length} words)`, err);
			console.error(`[LocalEmbeddingModel] Embedding generation failed:`, err);
			throw err;
		}
	}
}


