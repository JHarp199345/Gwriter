import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';
import WritingDashboardPlugin from '../../main';
import { fnv1a32 } from '../ContentHash';

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

function chunkWords(text: string, chunkWordsCount: number, overlapWordsCount: number): Array<{ start: number; end: number; text: string }> {
	const words = text.split(/\s+/g).filter(Boolean);
	const chunks: Array<{ start: number; end: number; text: string }> = [];
	const size = clampInt(chunkWordsCount, 200, 2000);
	const overlap = clampInt(overlapWordsCount, 0, Math.max(0, size - 1));
	const step = Math.max(1, size - overlap);

	for (let start = 0; start < words.length; start += step) {
		const end = Math.min(words.length, start + size);
		const slice = words.slice(start, end).join(' ');
		chunks.push({ start, end, text: slice });
		if (end >= words.length) break;
	}
	return chunks;
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
			if (typeof parsed.dim === 'number' && parsed.dim !== this.dim) {
				// Dimension mismatch: ignore persisted index and rebuild.
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

		while (this.queue.size > 0) {
			if (this.plugin.settings.retrievalIndexPaused) break;
			const next = this.queue.values().next().value as string;
			this.queue.delete(next);

			// Exclusions can change at any time; honor them during processing.
			if (this.plugin.vaultService.isExcludedPath(next)) {
				this._removePath(next);
				this._schedulePersist();
				this._scheduleSettingsSave();
				continue;
			}

			const file = this.vault.getAbstractFileByPath(next);
			// Only index markdown files.
			if (!(file instanceof TFile) || file.extension !== 'md') {
				this._removePath(next);
				this._schedulePersist();
				this._scheduleSettingsSave();
				continue;
			}

			try {
				const content = await this.vault.read(file);
				const fileHash = fnv1a32(content);
				const prev = this.plugin.settings.retrievalIndexState?.[next];
				if (prev?.hash === fileHash) {
					continue;
				}

				this._reindexFile(next, content);
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
			} catch {
				// Skip unreadable files.
			}

			// Yield to keep UI responsive.
			await new Promise((r) => setTimeout(r, 10));
		}

		this.workerRunning = false;
	}

	private _reindexFile(path: string, content: string): void {
		this._removePath(path);

		const chunkWordsCount = this.plugin.settings.retrievalChunkWords ?? 500;
		const overlap = this.plugin.settings.retrievalChunkOverlapWords ?? 100;

		const chunks = chunkWords(content, chunkWordsCount, overlap);
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			const textHash = fnv1a32(ch.text);
			const key = `chunk:${path}:${i}`;
			const vector = buildVector(ch.text, this.dim);
			const excerpt = excerptOf(ch.text, 500);
			this._setChunk({
				key,
				path,
				chunkIndex: i,
				startWord: ch.start,
				endWord: ch.end,
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

	buildQueryVector(queryText: string): number[] {
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


