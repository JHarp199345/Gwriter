import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';
import WritingDashboardPlugin from '../../main';
import { fnv1a32 } from '../ContentHash';
import { buildIndexChunks } from './Chunking';

export interface IndexedChunk {
	key: string;
	path: string;
	chunkIndex: number;
	startWord: number;
	endWord: number;
	textHash: string;
	vector: number[];
	excerpt: string;
}

interface PersistedIndexV1 {
	version: 1;
	dim: number;
	backend: 'hash';
	chunking?: { headingLevel: 'h1' | 'h2' | 'h3' | 'none'; targetWords: number; overlapWords: number };
	chunks: IndexedChunk[];
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2);
}

function buildVector(text: string, dim: number): number[] {
	const vec = new Array<number>(dim).fill(0);
	const tokens = tokenize(text);
	for (const tok of tokens) {
		const h = parseInt(fnv1a32(tok), 16);
		const idx = h % dim;
		// Signed hashing helps reduce collisions bias
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[idx] += sign;
	}
	// L2 normalize
	let sumSq = 0;
	for (let i = 0; i < dim; i++) sumSq += vec[i] * vec[i];
	const norm = Math.sqrt(sumSq) || 1;
	for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
	return vec;
}

function chunkingKey(plugin: WritingDashboardPlugin): { headingLevel: 'h1' | 'h2' | 'h3' | 'none'; targetWords: number; overlapWords: number } {
	return {
		headingLevel: plugin.settings.retrievalChunkHeadingLevel ?? 'h1',
		targetWords: clampInt(plugin.settings.retrievalChunkWords ?? 500, 200, 2000),
		overlapWords: clampInt(plugin.settings.retrievalChunkOverlapWords ?? 100, 0, 500)
	};
}

function excerptOf(text: string, maxChars: number): string {
	const trimmed = text.trim().replace(/\s+/g, ' ');
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}…`;
}

interface ErrorLogEntry {
	timestamp: string;
	location: string; // Where the error occurred (method/function name)
	context: string; // What was happening (file path, chunk index, etc.)
	message: string;
	stack?: string;
	errorType?: string;
}

export class EmbeddingsIndex {
	private readonly vault: Vault;
	private readonly plugin: WritingDashboardPlugin;
	private readonly dim: number;
	private readonly backend: 'hash';

	private loaded = false;
	private chunksByKey = new Map<string, IndexedChunk>();
	private chunkKeysByPath = new Map<string, Set<string>>();

	private readonly queue = new Set<string>();
	private workerRunning = false;
	private persistTimer: number | null = null;
	private settingsSaveTimer: number | null = null;

	// Error tracking
	private readonly errorLog: ErrorLogEntry[] = [];
	private readonly maxStoredErrors = 100;

	constructor(vault: Vault, plugin: WritingDashboardPlugin, dim: number = 256) {
		this.vault = vault;
		this.plugin = plugin;
		this.backend = 'hash';
		this.dim = dim;
	}

	getIndexFilePath(): string {
		return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/index.json`;
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		try {
			const path = this.getIndexFilePath();
			if (!(await this.vault.adapter.exists(path))) return;
			const raw = await this.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as PersistedIndexV1;
			if (parsed?.version !== 1 || !Array.isArray(parsed.chunks)) return;
			if (parsed.backend && parsed.backend !== this.backend) {
				// Backend mismatch: ignore persisted index and rebuild.
				this.enqueueFullRescan();
				return;
			}
			if (typeof parsed.dim === 'number' && parsed.dim !== this.dim) {
				// Dimension mismatch: ignore persisted index and rebuild.
				this.enqueueFullRescan();
				return;
			}
			const expectedChunking = chunkingKey(this.plugin);
			if (
				parsed.chunking &&
				(parsed.chunking.headingLevel !== expectedChunking.headingLevel ||
					parsed.chunking.targetWords !== expectedChunking.targetWords ||
					parsed.chunking.overlapWords !== expectedChunking.overlapWords)
			) {
				// Chunking config changed; rebuild index.
				this.enqueueFullRescan();
				return;
			}
			for (const chunk of parsed.chunks) {
				if (!chunk?.key || !chunk?.path || !Array.isArray(chunk.vector)) continue;
				this._setChunk(chunk);
			}
		} catch {
			// Corrupt index should not break the plugin. We'll rebuild lazily.
			this.chunksByKey.clear();
			this.chunkKeysByPath.clear();
		}
	}

	getStatus(): { indexedFiles: number; indexedChunks: number; paused: boolean; queued: number } {
		return {
			indexedFiles: this.chunkKeysByPath.size,
			indexedChunks: this.chunksByKey.size,
			paused: Boolean(this.plugin.settings.retrievalIndexPaused),
			queued: this.queue.size
		};
	}

	getRecentErrors(limit: number = 20): ErrorLogEntry[] {
		return this.errorLog.slice(-limit);
	}

	getErrorSummary(): { total: number; byLocation: Record<string, number>; recent: ErrorLogEntry[] } {
		const byLocation: Record<string, number> = {};
		for (const err of this.errorLog) {
			byLocation[err.location] = (byLocation[err.location] || 0) + 1;
		}
		return {
			total: this.errorLog.length,
			byLocation,
			recent: this.errorLog.slice(-10)
		};
	}

	private logError(location: string, context: string, error: unknown): void {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const errorStack = error instanceof Error ? error.stack : undefined;
		const errorType = error instanceof Error ? error.constructor.name : typeof error;
		
		const entry: ErrorLogEntry = {
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
		
		// Also log to console for debugging
		console.error(`[EmbeddingsIndex] ERROR [${location}] ${context}:`, errorMsg);
		if (errorStack) {
			console.error(`[EmbeddingsIndex] Stack:`, errorStack.split('\n').slice(0, 3).join('\n'));
		}
	}

	enqueueFullRescan(): void {
		const files = this.plugin.vaultService.getIncludedMarkdownFiles();
		for (const f of files) this.queue.add(f.path);
		this._kickWorker();
	}

	queueUpdateFile(path: string): void {
		if (!path) return;
		this.queue.add(path);
		this._kickWorker();
	}

	queueRemoveFile(path: string): void {
		if (!path) return;
		this._removePath(path);
		this._schedulePersist();
		this._scheduleSettingsSave();
	}

	private _kickWorker(): void {
		if (this.workerRunning) return;
		this.workerRunning = true;
		// Fire and forget, but ensure errors are swallowed.
		void this._runWorker().catch(() => {
			this.workerRunning = false;
		});
	}

	private async _runWorker(): Promise<void> {
		await this.ensureLoaded();

		let processedCount = 0;
		let skippedExcluded = 0;
		let skippedNotMarkdown = 0;
		let skippedHashMatch = 0;
		let indexedCount = 0;
		
		while (this.queue.size > 0) {
			if (this.plugin.settings.retrievalIndexPaused) break;
			const next = this.queue.values().next().value as string;
			this.queue.delete(next);
			processedCount++;

			// Exclusions can change at any time; honor them during processing.
			if (this.plugin.vaultService.isExcludedPath(next)) {
				skippedExcluded++;
				this._removePath(next);
				this._schedulePersist();
				this._scheduleSettingsSave();
				continue;
			}

			const file = this.vault.getAbstractFileByPath(next);
			// Only index markdown files.
			if (!(file instanceof TFile) || file.extension !== 'md') {
				skippedNotMarkdown++;
				this._removePath(next);
				this._schedulePersist();
				this._scheduleSettingsSave();
				continue;
			}

			try {
				const content = await this.vault.read(file);
				const fileHash = fnv1a32(content);
				const prev = this.plugin.settings.retrievalIndexState?.[next];
				const isCurrentlyIndexed = this.chunkKeysByPath.has(next);
				
				// Skip only if: hash matches AND file is already indexed
				// If hash matches but file is NOT indexed, re-index it (might have been removed)
				if (prev?.hash === fileHash && isCurrentlyIndexed) {
					skippedHashMatch++;
					continue;
				}

				await this._reindexFile(next, content);
				indexedCount++;
				this.plugin.settings.retrievalIndexState = {
					...(this.plugin.settings.retrievalIndexState || {}),
					[next]: {
						hash: fileHash,
						chunkCount: this.chunkKeysByPath.get(next)?.size ?? 0,
						updatedAt: new Date().toISOString()
					}
				};
				this._schedulePersist();
				this._scheduleSettingsSave();
			} catch (err) {
				// Skip unreadable files, but log for debugging
				this.logError('_runWorker', `Processing file: ${next}`, err);
			}

			// Yield to keep UI responsive.
			await new Promise((r) => setTimeout(r, 10));
		}

		// Log indexing stats for debugging
		if (processedCount > 0) {
			console.log(`[EmbeddingsIndex] Processed ${processedCount} files: ${indexedCount} indexed, ${skippedExcluded} excluded, ${skippedNotMarkdown} not markdown, ${skippedHashMatch} hash match (already indexed)`);
		}

		this.workerRunning = false;
	}

	private async _reindexFile(path: string, content: string): Promise<void> {
		this._removePath(path);

		// Skip empty files
		if (!content || content.trim().length === 0) {
			console.warn(`[EmbeddingsIndex] Skipping empty file: ${path}`);
			return;
		}

		const cfg = chunkingKey(this.plugin);
		console.log(`[EmbeddingsIndex] Processing file: ${path}`);
		console.log(`  - Backend: ${this.backend}`);
		console.log(`  - Content length: ${content.length} chars, ${content.split(/\s+/).length} words`);
		console.log(`  - Chunking config: headingLevel=${cfg.headingLevel}, targetWords=${cfg.targetWords}, overlapWords=${cfg.overlapWords}`);
		
		const chunks = buildIndexChunks({
			text: content,
			headingLevel: cfg.headingLevel,
			targetWords: cfg.targetWords,
			overlapWords: cfg.overlapWords
		});
		
		console.log(`  - Chunks created: ${chunks.length}`);
		if (chunks.length > 0) {
			console.log(`  - First chunk preview: ${chunks[0].text.substring(0, 100)}...`);
		}
		
		// If no chunks created, skip this file (might be too short or have no headings)
		if (chunks.length === 0) {
			console.warn(`[EmbeddingsIndex] No chunks created for ${path} - file too short or no headings match chunking config`);
			return;
		}

		let successfulChunks = 0;
		let firstError: Error | null = null;
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			const textHash = fnv1a32(ch.text);
			const key = `chunk:${path}:${i}`;
			let vector: number[];
			try {
				console.log(`  - Generating embedding for chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words)...`);
				const embedStart = Date.now();
				vector = buildVector(ch.text, this.dim);
				const embedDuration = Date.now() - embedStart;
				console.log(`  - ✓ Hash-based vector generated in ${embedDuration}ms: ${vector.length} dimensions`);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorStack = err instanceof Error ? err.stack : undefined;
				const context = `File: ${path}, Chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words, ${ch.text.length} chars)`;
				this.logError('_reindexFile.embedChunk', context, err);
				
				console.error(`  - ✗ Embedding generation failed for chunk ${i + 1}/${chunks.length}:`, errorMsg);
				if (errorStack) {
					console.error(`    Stack: ${errorStack.split('\n').slice(0, 3).join('\n    ')}`);
				}
				if (err instanceof Error) {
					console.error(`    Error type: ${err.constructor.name}`);
					if ('cause' in err) {
						console.error(`    Cause: ${err.cause}`);
					}
				}
				// If ALL chunks fail for a file, the file won't be indexed
				// This is a critical failure that should be logged
				if (i === 0) {
					console.error(`  - CRITICAL: First chunk failed for ${path} - file will not be indexed`);
					firstError = err instanceof Error ? err : new Error(String(err));
				}
				// Skip this chunk if embedding fails, but continue with others
				continue;
			}
			const excerpt = excerptOf(ch.text, 2500);
			this._setChunk({
				key,
				path,
				chunkIndex: i,
				startWord: ch.startWord,
				endWord: ch.endWord,
				textHash,
				vector,
				excerpt
			});
			successfulChunks++;
		}
		
		if (successfulChunks === 0 && chunks.length > 0) {
			const criticalContext = `File: ${path}, All ${chunks.length} chunks failed`;
			if (firstError) {
				this.logError('_reindexFile.allChunksFailed', criticalContext, firstError);
				console.error(`[EmbeddingsIndex] CRITICAL: All ${chunks.length} chunks failed for ${path} - file not indexed`);
				console.error(`  Root cause: ${firstError.message}`);
			} else {
				this.logError('_reindexFile.allChunksFailed', criticalContext, new Error('All chunks failed but no first error captured'));
			}
		} else if (successfulChunks < chunks.length) {
			console.warn(`[EmbeddingsIndex] Partial success for ${path}: ${successfulChunks}/${chunks.length} chunks indexed`);
		} else {
			console.log(`[EmbeddingsIndex] ✓ Successfully indexed ${path}: ${successfulChunks} chunks`);
		}
	}

	private _setChunk(chunk: IndexedChunk): void {
		this.chunksByKey.set(chunk.key, chunk);
		const set = this.chunkKeysByPath.get(chunk.path) ?? new Set<string>();
		set.add(chunk.key);
		this.chunkKeysByPath.set(chunk.path, set);
	}

	private _removePath(path: string): void {
		const keys = this.chunkKeysByPath.get(path);
		if (keys) {
			for (const k of keys) this.chunksByKey.delete(k);
		}
		this.chunkKeysByPath.delete(path);

		if (this.plugin.settings.retrievalIndexState?.[path]) {
			const next = { ...(this.plugin.settings.retrievalIndexState || {}) };
			delete next[path];
			this.plugin.settings.retrievalIndexState = next;
		}
	}

	getAllChunks(): IndexedChunk[] {
		return Array.from(this.chunksByKey.values());
	}

	getIndexedPaths(): string[] {
		return Array.from(this.chunkKeysByPath.keys());
	}

	/**
	 * Queue all currently indexed paths for re-checking. This is useful when exclusions/profiles change.
	 */
	queueRecheckAllIndexed(): void {
		for (const p of this.getIndexedPaths()) this.queue.add(p);
		this._kickWorker();
	}

	getVectorForKey(key: string): number[] | null {
		const ch = this.chunksByKey.get(key);
		return ch?.vector ?? null;
	}

	buildQueryVector(queryText: string): number[] {
		return buildVector(queryText, this.dim);
	}

	async embedQueryVector(queryText: string): Promise<number[]> {
		return buildVector(queryText, this.dim);
	}

	private _schedulePersist(): void {
		if (this.persistTimer) window.clearTimeout(this.persistTimer);
		this.persistTimer = window.setTimeout(() => {
			this.persistTimer = null;
			void this._persistNow().catch(() => {
				// ignore
			});
		}, 1000);
	}

	private async _persistNow(): Promise<void> {
		const dir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
		try {
			if (!(await this.vault.adapter.exists(dir))) {
				await this.vault.adapter.mkdir(dir);
			}
		} catch {
			// ignore mkdir failures
		}

		const payload: PersistedIndexV1 = {
			version: 1,
			dim: this.dim,
			backend: this.backend,
			chunking: chunkingKey(this.plugin),
			chunks: this.getAllChunks()
		};
		await this.vault.adapter.write(this.getIndexFilePath(), JSON.stringify(payload));
	}

	private _scheduleSettingsSave(): void {
		if (this.settingsSaveTimer) window.clearTimeout(this.settingsSaveTimer);
		this.settingsSaveTimer = window.setTimeout(() => {
			this.settingsSaveTimer = null;
			void this.plugin.saveSettings().catch(() => {
				// ignore
			});
		}, 1000);
	}
	
}


