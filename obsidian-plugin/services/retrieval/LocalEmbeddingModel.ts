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

// Capture a one-time snapshot of the transformers env / ONNX state for diagnostics
let lastEnvSnapshot: any | null = null;

function captureEnvSnapshot(mod: any, env: any, where: string): void {
	try {
		const onnx = env?.backends?.onnx;
		const backends = env?.backends;
		lastEnvSnapshot = {
			where,
			timestamp: new Date().toISOString(),
			modKeys: mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 20) : null,
			hasDefault: !!mod?.default,
			hasPipeline: typeof (mod?.pipeline || mod?.default?.pipeline) === 'function',
			envKeys: env ? Object.keys(env).slice(0, 20) : null,
			envHasBackends: !!backends,
			backendsKeys: backends ? Object.keys(backends) : null,
			onnxKeyExists: backends ? 'onnx' in backends : false,
			onnxValueExists: onnx !== undefined,
			onnxValueType: typeof onnx,
			onnxKeys: onnx ? Object.keys(onnx).slice(0, 20) : null,
			onnxHasWasm: !!onnx?.wasm,
			onnxWasmKeys: onnx?.wasm ? Object.keys(onnx.wasm).slice(0, 20) : null,
			onnxWasmPaths: onnx?.wasm?.wasmPaths ?? null,
			envHasUseWasm: typeof env?.useWasm === 'function',
		};
		console.log('[LocalEmbeddingModel] [ENV SNAPSHOT]', lastEnvSnapshot);
	} catch (e) {
		console.warn('[LocalEmbeddingModel] [ENV SNAPSHOT] Failed to capture env snapshot:', e);
	}
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
	
	// Try multiple ways to access the environment
	let env: any = null;
	let envSource = 'none';
	
	console.log(`[LocalEmbeddingModel] [STEP 3] Attempting to locate environment structure...`);
	
	// Method 1: Direct mod.env (standard structure)
	if (mod?.env) {
		console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.env`);
		env = mod.env;
		envSource = 'mod.env';
	}
	// Method 2: mod.default.env (if default export)
	else if (mod?.default?.env) {
		console.log(`[LocalEmbeddingModel] [STEP 3] ✓ Found env via mod.default.env`);
		env = mod.default.env;
		envSource = 'mod.default.env';
	}
	
	// Deep inspection of what we have
	if (env) {
		console.log(`[LocalEmbeddingModel] [STEP 3] env type: ${typeof env}`);
		console.log(`[LocalEmbeddingModel] [STEP 3] env keys (first 30):`, Object.keys(env).slice(0, 30));
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends exists:`, 'backends' in env);
		console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx exists:`, env.backends?.onnx !== undefined);
		console.log(`[LocalEmbeddingModel] [STEP 3] env.useWasm exists:`, typeof env.useWasm === 'function');
		if (env.backends) {
			console.log(`[LocalEmbeddingModel] [STEP 3] env.backends keys:`, Object.keys(env.backends));
		}
		if (env.backends?.onnx) {
			console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx type:`, typeof env.backends.onnx);
			console.log(`[LocalEmbeddingModel] [STEP 3] env.backends.onnx keys:`, Object.keys(env.backends.onnx).slice(0, 20));
		}
		// Capture env snapshot before WASM config
		if (!lastEnvSnapshot) {
			captureEnvSnapshot(mod, env, 'before-wasm-config');
		}
	} else {
		console.warn(`[LocalEmbeddingModel] [STEP 3] ✗ Could not find env structure`);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.env exists:`, mod?.env !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default exists:`, mod?.default !== undefined);
		console.warn(`[LocalEmbeddingModel] [STEP 3] mod.default.env exists:`, mod?.default?.env !== undefined);
		if (mod?.env) {
			console.log(`[LocalEmbeddingModel] [STEP 3] mod.env structure (depth 3):`, deepInspect(mod.env, 3));
		}
		if (mod?.default?.env) {
			console.log(`[LocalEmbeddingModel] [STEP 3] mod.default.env structure (depth 3):`, deepInspect(mod.default.env, 3));
		}
	}
	
	// Configure WASM paths - CRITICAL: Must be done BEFORE any ONNX backend initialization
	console.log(`[LocalEmbeddingModel] [STEP 4] Attempting to configure WASM paths...`);
	
	const wasmBasePath = './lib/';
	
	if (env) {
		// Approach 1: Try to access ONNX backend directly from the module
		// The ONNX backend is exported from transformers.js, we need to access it
		let onnxBackendEnv: any = null;
		let onnxBackendPath = 'none';
		
		// Try to find ONNX in the module exports
		if (mod?.ONNX) {
			console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX export in module`);
			const onnx = mod.ONNX;
			if (onnx?.env?.wasm) {
				onnxBackendEnv = onnx.env.wasm;
				onnxBackendPath = 'mod.ONNX.env.wasm';
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env.wasm via mod.ONNX`);
			} else if (onnx?.env) {
				onnxBackendEnv = onnx.env;
				onnxBackendPath = 'mod.ONNX.env';
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found ONNX env via mod.ONNX`);
			}
		}
		
		// Approach 2: Try via env.backends.onnx (transformers.js structure)
		if (!onnxBackendEnv && env.backends?.onnx) {
			const onnxBackend = env.backends.onnx;
			console.log(`[LocalEmbeddingModel] [STEP 4] ✓ ONNX backend found via env.backends.onnx`);
			
			if (onnxBackend.env?.wasm) {
				onnxBackendEnv = onnxBackend.env.wasm;
				onnxBackendPath = 'env.backends.onnx.env.wasm';
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.env.wasm`);
			} else if (onnxBackend.wasm) {
				onnxBackendEnv = onnxBackend.wasm;
				onnxBackendPath = 'onnxBackend.wasm';
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found WASM env at onnxBackend.wasm`);
			} else if (onnxBackend.env) {
				onnxBackendEnv = onnxBackend.env;
				onnxBackendPath = 'onnxBackend.env';
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Found env at onnxBackend.env`);
			}
		}
		
		// Set wasmPaths on the ONNX backend environment
		if (onnxBackendEnv) {
			console.log(`[LocalEmbeddingModel] [STEP 4] Configuring WASM paths at: ${onnxBackendPath}`);
			try {
				if ('wasmPaths' in onnxBackendEnv) {
					const currentPaths = onnxBackendEnv.wasmPaths;
					console.log(`[LocalEmbeddingModel] [STEP 4] Current wasmPaths: ${JSON.stringify(currentPaths)}`);
					onnxBackendEnv.wasmPaths = wasmBasePath;
					console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Updated wasmPaths to: ${wasmBasePath}`);
					console.log(`[LocalEmbeddingModel] [STEP 4] Verified wasmPaths: ${JSON.stringify(onnxBackendEnv.wasmPaths)}`);
				} else {
					Object.defineProperty(onnxBackendEnv, 'wasmPaths', {
						value: wasmBasePath,
						writable: true,
						enumerable: true,
						configurable: true
					});
					console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Created and set wasmPaths to: ${wasmBasePath}`);
				}
			} catch (pathErr) {
				console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set wasmPaths at ${onnxBackendPath}:`, pathErr);
			}
		} else {
			// ONNX backend environment not found - try fallback approaches
			console.warn(`[LocalEmbeddingModel] [STEP 4] ⚠ ONNX backend environment not found via standard paths`);
			console.warn(`[LocalEmbeddingModel] [STEP 4] Attempting fallback: setting on env.backends.onnx directly...`);
			
			// Try to create/access backends.onnx if it doesn't exist
			if (!env.backends) {
				try {
					env.backends = {};
					console.log(`[LocalEmbeddingModel] [STEP 4] Created env.backends object`);
				} catch (e) {
					console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to create env.backends:`, e);
				}
			}
			
			// Check if we can access ONNX after creating backends
			if (env.backends && !env.backends.onnx) {
				console.warn(`[LocalEmbeddingModel] [STEP 4] env.backends.onnx is still undefined - ONNX backend may not be initialized yet`);
				console.warn(`[LocalEmbeddingModel] [STEP 4] This is expected if ONNX backend initializes lazily`);
			}
			
			// Always capture snapshot for diagnostics
			captureEnvSnapshot(mod, env, 'wasm-config-attempt');
			if (lastEnvSnapshot) {
				console.log('[LocalEmbeddingModel] [ENV SNAPSHOT]', JSON.stringify(lastEnvSnapshot, null, 2));
			}
		}
		
		// Approach 3: Also try setting at top-level env (some transformers.js versions use this)
		try {
			if ('wasmPaths' in env) {
				env.wasmPaths = wasmBasePath;
				console.log(`[LocalEmbeddingModel] [STEP 4] ✓ Also set env.wasmPaths to: ${wasmBasePath}`);
			}
		} catch (envPathErr) {
			console.warn(`[LocalEmbeddingModel] [STEP 4] Failed to set top-level env.wasmPaths:`, envPathErr);
		}
	} else {
		console.warn(`[LocalEmbeddingModel] [STEP 4] ✗ Cannot configure WASM paths - env not found`);
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
					// Capture env snapshot at failure time if we don't have one
					if (!lastEnvSnapshot) {
						try {
							const modAtError = await import('../../lib/transformers.js');
							const envAtError = modAtError.env || modAtError.default?.env;
							if (envAtError) {
								captureEnvSnapshot(modAtError, envAtError, 'on-pipeline-error');
							}
						} catch {
							// ignore secondary failures
						}
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

	getEnvSnapshot(): any | null {
		return lastEnvSnapshot;
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


