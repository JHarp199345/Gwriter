import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';
import WritingDashboardPlugin from '../../main';
import { fnv1a32 } from '../ContentHash';
import { MiniLmLocalEmbeddingModel } from './LocalEmbeddingModel';
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
	backend: 'hash' | 'minilm';
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

export class EmbeddingsIndex {
	private readonly vault: Vault;
	private readonly plugin: WritingDashboardPlugin;
	private readonly dim: number;
	private readonly backend: 'hash' | 'minilm';
	private readonly model: MiniLmLocalEmbeddingModel;

	private loaded = false;
	private chunksByKey = new Map<string, IndexedChunk>();
	private chunkKeysByPath = new Map<string, Set<string>>();

	private readonly queue = new Set<string>();
	private workerRunning = false;
	private persistTimer: number | null = null;
	private settingsSaveTimer: number | null = null;

	constructor(vault: Vault, plugin: WritingDashboardPlugin, dim: number = 256) {
		this.vault = vault;
		this.plugin = plugin;
		const backend = plugin.settings.retrievalEmbeddingBackend;
		this.backend = backend === 'hash' ? 'hash' : 'minilm';
		this.dim = this.backend === 'minilm' ? 384 : dim;
		this.model = new MiniLmLocalEmbeddingModel(vault, plugin);
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
				console.warn(`Failed to index file ${next}:`, err);
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
			return;
		}

		const cfg = chunkingKey(this.plugin);
		const chunks = buildIndexChunks({
			text: content,
			headingLevel: cfg.headingLevel,
			targetWords: cfg.targetWords,
			overlapWords: cfg.overlapWords
		});
		
		// If no chunks created, skip this file (might be too short or have no headings)
		if (chunks.length === 0) {
			return;
		}
		
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			const textHash = fnv1a32(ch.text);
			const key = `chunk:${path}:${i}`;
			let vector: number[];
			try {
				vector =
					this.backend === 'minilm'
						? await this.model.embed(ch.text)
						: buildVector(ch.text, this.dim);
			} catch (err) {
				console.error(`Failed to generate embedding for chunk ${i} of ${path}:`, err);
				// Skip this chunk if embedding fails, but continue with others
				continue;
			}
			const excerpt = excerptOf(ch.text, 500);
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
		if (this.backend !== 'minilm') return buildVector(queryText, this.dim);
		// Note: query embedding is async; providers should call embedQueryVector instead.
		return buildVector(queryText, this.dim);
	}

	async embedQueryVector(queryText: string): Promise<number[]> {
		if (this.backend !== 'minilm') return buildVector(queryText, this.dim);
		return await this.model.embed(queryText);
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


