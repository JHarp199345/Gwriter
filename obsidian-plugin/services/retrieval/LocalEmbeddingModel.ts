import type { Vault } from 'obsidian';
import WritingDashboardPlugin from '../../main';

// Helper function to safely inspect object structure without causing errors
function deepInspect(obj: any, maxDepth: number = 3, currentDepth: number = 0, visited: WeakSet<any> = new WeakSet()): any {
	if (currentDepth >= maxDepth || obj === null || obj === undefined) {
		return typeof obj;
	}
	if (typeof obj !== 'object') {
		return obj;
	}
	if (visited.has(obj)) {
		return '[Circular]';
	}
	visited.add(obj);
	
	const result: any = {};
	try {
		const keys = Object.keys(obj).slice(0, 20); // Limit keys to avoid huge output
		for (const key of keys) {
			try {
				const val = obj[key];
				if (typeof val === 'function') {
					result[key] = `[Function: ${val.name || 'anonymous'}]`;
				} else if (typeof val === 'object' && val !== null) {
					result[key] = deepInspect(val, maxDepth, currentDepth + 1, visited);
				} else {
					result[key] = val;
				}
			} catch (e) {
				result[key] = `[Error accessing: ${e}]`;
			}
		}
	} catch (e) {
		return `[Error inspecting: ${e}]`;
	}
	return result;
}

// Helper to get pipeline function with proper error handling
// Uses vendored transformers.js to avoid bundling issues
async function getPipeline(plugin: WritingDashboardPlugin): Promise<any> {
	console.log(`[LocalEmbeddingModel] === STARTING PIPELINE LOAD ===`);
	console.log(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
	
	// Import the vendored transformers library first
	console.log(`[LocalEmbeddingModel] [STEP 1] Importing transformers.js module...`);
	let mod: any;
	try {
		mod = await import('../../lib/transformers.js');
		console.log(`[LocalEmbeddingModel] [STEP 1] ✓ Module imported successfully`);
		console.log(`[LocalEmbeddingModel] [STEP 1] Module type: ${typeof mod}`);
		console.log(`[LocalEmbeddingModel] [STEP 1] Module is null: ${mod === null}`);
		console.log(`[LocalEmbeddingModel] [STEP 1] Module is undefined: ${mod === undefined}`);
	} catch (importErr) {
		console.error(`[LocalEmbeddingModel] [STEP 1] ✗ Module import failed:`, importErr);
		throw new Error(`Failed to import transformers.js: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
	}
	
	// Deep inspection of module structure
	console.log(`[LocalEmbeddingModel] [STEP 2] Inspecting module structure...`);
	console.log(`[LocalEmbeddingModel] [STEP 2] Module keys (first 30):`, mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 30) : 'N/A');
	console.log(`[LocalEmbeddingModel] [STEP 2] Has 'env' property:`, 'env' in (mod || {}));
	console.log(`[LocalEmbeddingModel] [STEP 2] Has 'default' property:`, 'default' in (mod || {}));
	console.log(`[LocalEmbeddingModel] [STEP 2] Has 'pipeline' property:`, 'pipeline' in (mod || {}));
	console.log(`[LocalEmbeddingModel] [STEP 2] mod.env type:`, typeof mod?.env);
	console.log(`[LocalEmbeddingModel] [STEP 2] mod.default type:`, typeof mod?.default);
	console.log(`[LocalEmbeddingModel] [STEP 2] mod.pipeline type:`, typeof mod?.pipeline);
	
	// Try multiple ways to access the environment - DON'T CREATE FAKE ONES
	let env: any = null;
	let envSource = 'none';
	
	console.log(`[LocalEmbeddingModel] [STEP 3] Attempting to locate ONNX environment structure...`);
	
	// Method 1: Direct mod.env.backends.onnx (standard structure)
	if (mod?.env?.backends?.onnx) {
		console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.env.backends.onnx`);
		env = mod.env;
		envSource = 'mod.env';
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, typeof env.backends.onnx === 'object' && env.backends.onnx ? Object.keys(env.backends.onnx).slice(0, 20) : 'N/A');
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env exists:`, 'env' in (env.backends.onnx || {}));
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env.wasm exists:`, env.backends.onnx?.env?.wasm !== undefined);
	}
	// Method 2: mod.default.env.backends.onnx (if default export)
	else if (mod?.default?.env?.backends?.onnx) {
		console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.default.env.backends.onnx`);
		env = mod.default.env;
		envSource = 'mod.default.env';
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, typeof env.backends.onnx === 'object' && env.backends.onnx ? Object.keys(env.backends.onnx).slice(0, 20) : 'N/A');
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env exists:`, 'env' in (env.backends.onnx || {}));
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx.env.wasm exists:`, env.backends.onnx?.env?.wasm !== undefined);
	}
	else {
		console.warn(`[LocalEmbeddingModel] [STEP 3] ✗ Could not find ONNX environment structure`);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env exists:`, mod?.env !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env.backends exists:`, mod?.env?.backends !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env.backends.onnx exists:`, mod?.env?.backends?.onnx !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default exists:`, mod?.default !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env exists:`, mod?.default?.env !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env.backends exists:`, mod?.default?.env?.backends !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env.backends.onnx exists:`, mod?.default?.env?.backends?.onnx !== undefined);
		
		// Deep inspection of what we DO have
		if (mod?.env) {
			console.log(`[LocalEmbeddingModel] [STEP 3] mod.env structure (depth 3):`, deepInspect(mod.env, 3));
		}
		if (mod?.default?.env) {
			console.log(`[LocalEmbeddingModel] [STEP 3] mod.default.env structure (depth 3):`, deepInspect(mod.default.env, 3));
		}
	}
	
	// Configure WASM paths ONLY if the real ONNX environment exists
	// The structure should be: env.backends.onnx.env.wasm (note the nested .env)
	console.log(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
	
	if (env && env.backends && env.backends.onnx) {
		const onnxBackend = env.backends.onnx;
		console.log(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via ${envSource}`);
		
		// Try to find the actual ONNX Runtime environment
		// It might be at: onnxBackend.env.wasm OR onnxBackend.wasm
		let wasmEnv: any = null;
		let wasmEnvPath = 'none';
		
		if (onnxBackend.env?.wasm) {
			console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.env.wasm`);
			wasmEnv = onnxBackend.env.wasm;
			wasmEnvPath = 'onnxBackend.env.wasm';
		} else if (onnxBackend.wasm) {
			console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.wasm`);
			wasmEnv = onnxBackend.wasm;
			wasmEnvPath = 'onnxBackend.wasm';
		} else {
			console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ WASM environment not found at expected paths`);
			console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env exists:`, onnxBackend.env !== undefined);
			console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env.wasm exists:`, onnxBackend.env?.wasm !== undefined);
			console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend.wasm exists:`, onnxBackend.wasm !== undefined);
			console.warn(`[LocalEmbeddingModel] [STEP 4] onnxBackend keys:`, Object.keys(onnxBackend).slice(0, 30));
			if (onnxBackend.env) {
				console.log(`[LocalEmbeddingModel] [STEP 4] onnxBackend.env structure:`, deepInspect(onnxBackend.env, 2));
			}
		}
		
		if (wasmEnv) {
			const vaultBase = (plugin.app.vault.adapter as any).basePath || '';
			const pluginId = plugin.manifest.id;
			
			console.log(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${wasmEnvPath}`);
			console.log(`[LocalEmbeddingModel] [STEP 4] Vault base: ${vaultBase}`);
			console.log(`[LocalEmbeddingModel] [STEP 4] Plugin ID: ${pluginId}`);
			
			// Use string-based path (base directory) like transformers.js does internally
			const wasmBasePath = './lib/';
			
			// Check current wasmPaths value
			const currentPaths = wasmEnv.wasmPaths;
			console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths value:`, currentPaths);
			console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths type:`, typeof currentPaths);
			
			// Set the base path (transformers.js uses string, not object mapping)
			wasmEnv.wasmPaths = wasmBasePath;
			console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Set wasmPaths to: ${wasmBasePath}`);
			console.log(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths after setting:`, wasmEnv.wasmPaths);
			console.log(`[LocalEmbeddingModel] [STEP 4] wasmEnv structure after config:`, deepInspect(wasmEnv, 2));
		} else {
			console.error(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - WASM environment not found`);
		}
	} else {
		console.error(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - ONNX backend not found`);
	}
	
	// Get pipeline function
	console.log(`[LocalEmbeddingModel] [STEP 5] Locating pipeline function...`);
	const pipeline = mod.pipeline || mod.default?.pipeline;
	console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline found:`, pipeline !== undefined && pipeline !== null);
	console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline type:`, typeof pipeline);
	console.log(`[LocalEmbeddingModel] [STEP 5] Pipeline is function:`, typeof pipeline === 'function');
	
	if (!pipeline || typeof pipeline !== 'function') {
		console.error(`[LocalEmbeddingModel] [STEP 5] ✗ Pipeline not found or not a function`);
		console.error(`[LocalEmbeddingModel] [STEP 5] mod.pipeline:`, mod?.pipeline);
		console.error(`[LocalEmbeddingModel] [STEP 5] mod.default.pipeline:`, mod?.default?.pipeline);
		throw new Error('Pipeline not found in transformers module');
	}
	
	console.log(`[LocalEmbeddingModel] [STEP 5] ✓ Pipeline function found`);
	console.log(`[LocalEmbeddingModel] === PIPELINE LOAD COMPLETE ===`);
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
			console.log(`[LocalEmbeddingModel] Pipeline already loaded (attempt #${this.loadAttempts})`);
			return;
		}
		if (this.loading !== null) {
			console.log(`[LocalEmbeddingModel] Pipeline loading in progress (attempt #${this.loadAttempts}), waiting...`);
			return this.loading;
		}

		console.log(`[LocalEmbeddingModel] === STARTING MODEL LOAD ===`);
		console.log(`[LocalEmbeddingModel] Load attempt #${this.loadAttempts + 1}`);
		console.log(`[LocalEmbeddingModel] Timestamp: ${new Date().toISOString()}`);
		this.loadAttempts++;
		const loadStart = Date.now();
		this.loading = (async () => {
			try {
				// Get pipeline function - using helper to ensure proper initialization
				console.log(`[LocalEmbeddingModel] [LOAD] Step 1: Getting pipeline function...`);
				let pipeline: any;
				try {
					pipeline = await getPipeline(this.plugin);
					if (!pipeline) {
						throw new Error('Pipeline is null or undefined');
					}
					if (typeof pipeline !== 'function') {
						throw new Error(`Pipeline is not a function, got: ${typeof pipeline}`);
					}
					console.log(`[LocalEmbeddingModel] [LOAD] Step 1: ✓ Pipeline function loaded (type: ${typeof pipeline}, name: ${pipeline.name || 'anonymous'})`);
				} catch (importErr) {
					console.error(`[LocalEmbeddingModel] [LOAD] Step 1: ✗ Failed to get pipeline function`);
					this.logError('ensureLoaded.import', 'Loading vendored transformers pipeline', importErr);
					throw new Error(`Failed to load transformers pipeline: ${importErr instanceof Error ? importErr.message : String(importErr)}`);
				}

				// Cache models inside plugin data to avoid re-downloading if possible.
				// Note: transformers uses its own caching strategy; this is a hint.
				const cacheDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/models`;
				console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Preparing model cache...`);
				console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Cache directory: ${cacheDir}`);
				console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Model: Xenova/all-MiniLM-L6-v2`);
				console.log(`[LocalEmbeddingModel] [LOAD] Step 2: Quantized: true`);
				console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Creating model pipeline (this may take time)...`);

				let pipeUnknown: unknown;
				try {
					const pipelineStartTime = Date.now();
					// Call pipeline directly as a function
					pipeUnknown = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
						quantized: true,
						progress_callback: undefined,
						cache_dir: cacheDir
					});
					const pipelineDuration = Date.now() - pipelineStartTime;
					console.log(`[LocalEmbeddingModel] [LOAD] Step 3: ✓ Pipeline created in ${pipelineDuration}ms`);
					console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output type: ${typeof pipeUnknown}`);
					console.log(`[LocalEmbeddingModel] [LOAD] Step 3: Pipeline output is array: ${Array.isArray(pipeUnknown)}`);
				} catch (pipelineErr) {
					console.error(`[LocalEmbeddingModel] [LOAD] Step 3: ✗ Pipeline creation failed`);
					console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error type: ${pipelineErr instanceof Error ? pipelineErr.constructor.name : typeof pipelineErr}`);
					console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error message: ${pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)}`);
					if (pipelineErr instanceof Error && pipelineErr.stack) {
						console.error(`[LocalEmbeddingModel] [LOAD] Step 3: Error stack (first 10 lines):`);
						console.error(pipelineErr.stack.split('\n').slice(0, 10).join('\n'));
					}
					this.logError('ensureLoaded.createPipeline', `Creating pipeline with model Xenova/all-MiniLM-L6-v2, cache: ${cacheDir}`, pipelineErr);
					throw pipelineErr;
				}
				
				const pipe = pipeUnknown as (input: string, opts?: Record<string, unknown>) => Promise<unknown>;
				console.log(`[LocalEmbeddingModel] [LOAD] Step 4: Wrapping pipeline function...`);

				this.pipeline = async (text: string) => {
					const embedStartTime = Date.now();
					try {
						console.log(`[LocalEmbeddingModel] [EMBED] Starting embedding generation for text (${text.length} chars, ${text.split(/\s+/).length} words)...`);
						const out = await pipe(text, { pooling: 'mean', normalize: true });
						const embedDuration = Date.now() - embedStartTime;
						console.log(`[LocalEmbeddingModel] [EMBED] Raw output received in ${embedDuration}ms`);
						console.log(`[LocalEmbeddingModel] [EMBED] Output type: ${typeof out}`);
						console.log(`[LocalEmbeddingModel] [EMBED] Output is array: ${Array.isArray(out)}`);
						
						// transformers output can vary; handle common cases.
						let result: number[];
						if (Array.isArray(out) && Array.isArray(out[0])) {
							console.log(`[LocalEmbeddingModel] [EMBED] Format: Array<Array<number>>, using out[0]`);
							result = l2Normalize(out[0] as number[]);
						} else if (Array.isArray(out)) {
							console.log(`[LocalEmbeddingModel] [EMBED] Format: Array<number>, using directly`);
							result = l2Normalize(out as number[]);
						} else {
							const maybe = out as { data?: number[] };
							if (Array.isArray(maybe?.data)) {
								console.log(`[LocalEmbeddingModel] [EMBED] Format: Object with data array, using data`);
								result = l2Normalize(maybe.data);
							} else {
								const err = new Error(`Unexpected embeddings output format: ${typeof out}, isArray: ${Array.isArray(out)}`);
								this.logError('pipeline.embed', `Processing text (${text.length} chars)`, err);
								console.error(`[LocalEmbeddingModel] [EMBED] ✗ Unexpected output format`);
								console.error(`[LocalEmbeddingModel] [EMBED] Output:`, out);
								throw err;
							}
						}
						console.log(`[LocalEmbeddingModel] [EMBED] ✓ Embedding generated successfully (${result.length} dimensions)`);
						return result;
					} catch (err) {
						const embedDuration = Date.now() - embedStartTime;
						console.error(`[LocalEmbeddingModel] [EMBED] ✗ Embedding generation failed after ${embedDuration}ms`);
						this.logError('pipeline.embed', `Generating embedding for text (${text.length} chars, ${text.split(/\s+/).length} words)`, err);
						console.error(`[LocalEmbeddingModel] [EMBED] Error:`, err);
						throw err;
					}
				};
				const loadDuration = Date.now() - loadStart;
				console.log(`[LocalEmbeddingModel] [LOAD] Step 4: ✓ Pipeline wrapper created`);
				console.log(`[LocalEmbeddingModel] === MODEL FULLY LOADED ===`);
				console.log(`[LocalEmbeddingModel] Total load time: ${loadDuration}ms`);
				console.log(`[LocalEmbeddingModel] Load attempts: ${this.loadAttempts}`);
			} catch (err) {
				const loadDuration = Date.now() - loadStart;
				console.error(`[LocalEmbeddingModel] === MODEL LOAD FAILED ===`);
				console.error(`[LocalEmbeddingModel] Total load time: ${loadDuration}ms`);
				console.error(`[LocalEmbeddingModel] Load attempt: #${this.loadAttempts}`);
				this.logError('ensureLoaded', `Model loading attempt #${this.loadAttempts}`, err);
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorStack = err instanceof Error ? err.stack : undefined;
				const errorType = err instanceof Error ? err.constructor.name : typeof err;
				console.error(`[LocalEmbeddingModel] Error type: ${errorType}`);
				console.error(`[LocalEmbeddingModel] Error message: ${errorMsg}`);
				if (errorStack) {
					console.error(`[LocalEmbeddingModel] Error stack (first 15 lines):`);
					console.error(errorStack.split('\n').slice(0, 15).join('\n'));
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


