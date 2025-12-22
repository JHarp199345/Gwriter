import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';
import type WritingDashboardPlugin from '../../main';
import { fnv1a32 } from '../ContentHash';

export interface Bm25Chunk {
	key: string;
	path: string;
	chunkIndex: number;
	startWord: number;
	endWord: number;
	excerpt: string;
	len: number;
}

interface PersistedBm25V1 {
	version: 1;
	avgdl: number;
	totalChunks: number;
	fileState: Record<string, { hash: string; chunkCount: number; updatedAt: string }>;
	// Chunk metadata by key
	chunks: Record<string, Bm25Chunk>;
	// term -> list of [chunkKey, tf]
	postings: Record<string, Array<[string, number]>>;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function excerptOf(text: string, maxChars: number): string {
	const trimmed = text.trim().replace(/\s+/g, ' ');
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}…`;
}

function chunkWords(
	text: string,
	chunkWordsCount: number,
	overlapWordsCount: number
): Array<{ start: number; end: number; text: string }> {
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
	return (value || '')
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/gu)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function tfMap(tokens: string[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
	return m;
}

export class Bm25Index {
	private readonly vault: Vault;
	private readonly plugin: WritingDashboardPlugin;

	private loaded = false;
	private chunksByKey = new Map<string, Bm25Chunk>();
	private chunkKeysByPath = new Map<string, Set<string>>();
	private postings = new Map<string, Array<[string, number]>>();
	private fileState: Record<string, { hash: string; chunkCount: number; updatedAt: string }> = {};
	private sumLen = 0;

	private readonly queue = new Set<string>();
	private workerRunning = false;
	private persistTimer: number | null = null;

	constructor(vault: Vault, plugin: WritingDashboardPlugin) {
		this.vault = vault;
		this.plugin = plugin;
	}

	getIndexFilePath(): string {
		return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index/bm25.json`;
	}

	getStatus(): { indexedFiles: number; indexedChunks: number; queued: number } {
		return {
			indexedFiles: this.chunkKeysByPath.size,
			indexedChunks: this.chunksByKey.size,
			queued: this.queue.size
		};
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		try {
			const path = this.getIndexFilePath();
			if (!(await this.vault.adapter.exists(path))) return;
			const raw = await this.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as PersistedBm25V1;
			if (parsed?.version !== 1) return;

			this.fileState = parsed.fileState || {};
			this.sumLen = 0;
			this.chunksByKey.clear();
			this.chunkKeysByPath.clear();
			this.postings.clear();

			const chunks = parsed.chunks || {};
			for (const [key, ch] of Object.entries(chunks)) {
				if (!ch?.key || !ch?.path) continue;
				this.chunksByKey.set(key, ch);
				this.sumLen += ch.len || 0;
				const set = this.chunkKeysByPath.get(ch.path) ?? new Set<string>();
				set.add(key);
				this.chunkKeysByPath.set(ch.path, set);
			}

			const postings = parsed.postings || {};
			for (const [term, list] of Object.entries(postings)) {
				if (!Array.isArray(list)) continue;
				this.postings.set(term, list.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') as Array<[string, number]>);
			}
		} catch {
			// Corrupt index should not break the plugin; we rebuild lazily.
			this.chunksByKey.clear();
			this.chunkKeysByPath.clear();
			this.postings.clear();
			this.fileState = {};
			this.sumLen = 0;
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
	}

	private _kickWorker(): void {
		if (this.workerRunning) return;
		this.workerRunning = true;
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

			if (this.plugin.vaultService.isExcludedPath(next)) {
				this._removePath(next);
				this._schedulePersist();
				continue;
			}

			const file = this.vault.getAbstractFileByPath(next);
			if (!(file instanceof TFile) || file.extension !== 'md') {
				this._removePath(next);
				this._schedulePersist();
				continue;
			}

			try {
				const content = await this.vault.read(file);
				const fileHash = fnv1a32(content);
				const prev = this.fileState[next];
				if (prev?.hash === fileHash) continue;

				this._reindexFile(next, content);
				this.fileState[next] = {
					hash: fileHash,
					chunkCount: this.chunkKeysByPath.get(next)?.size ?? 0,
					updatedAt: new Date().toISOString()
				};
				this._schedulePersist();
			} catch {
				// ignore unreadable files
			}

			// Yield to keep UI responsive.
			await new Promise((r) => setTimeout(r, 10));
		}

		this.workerRunning = false;
	}

	private _removePath(path: string): void {
		const keys = this.chunkKeysByPath.get(path);
		if (keys) {
			for (const k of keys) {
				const ch = this.chunksByKey.get(k);
				if (ch) this.sumLen -= ch.len || 0;
				this.chunksByKey.delete(k);
			}
		}
		this.chunkKeysByPath.delete(path);
		delete this.fileState[path];
		// Note: postings are not compacted immediately; stale entries are ignored at query time.
	}

	private _reindexFile(path: string, content: string): void {
		this._removePath(path);

		const chunkWordsCount = this.plugin.settings.retrievalChunkWords ?? 500;
		const overlap = this.plugin.settings.retrievalChunkOverlapWords ?? 100;
		const chunks = chunkWords(content, chunkWordsCount, overlap);

		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			const toks = tokenize(ch.text);
			if (toks.length === 0) continue;

			const key = `chunk:${path}:${i}`;
			const tf = tfMap(toks);
			this.sumLen += toks.length;

			const meta: Bm25Chunk = {
				key,
				path,
				chunkIndex: i,
				startWord: ch.start,
				endWord: ch.end,
				excerpt: excerptOf(ch.text, 500),
				len: toks.length
			};
			this.chunksByKey.set(key, meta);
			const set = this.chunkKeysByPath.get(path) ?? new Set<string>();
			set.add(key);
			this.chunkKeysByPath.set(path, set);

			for (const [term, count] of tf.entries()) {
				const list = this.postings.get(term) ?? [];
				list.push([key, count]);
				this.postings.set(term, list);
			}
		}
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

		const postingsObj: PersistedBm25V1['postings'] = {};
		for (const [term, list] of this.postings.entries()) postingsObj[term] = list;

		const chunksObj: PersistedBm25V1['chunks'] = {};
		for (const [key, ch] of this.chunksByKey.entries()) chunksObj[key] = ch;

		const avgdl = this.chunksByKey.size ? this.sumLen / this.chunksByKey.size : 0;
		const payload: PersistedBm25V1 = {
			version: 1,
			avgdl,
			totalChunks: this.chunksByKey.size,
			fileState: this.fileState,
			chunks: chunksObj,
			postings: postingsObj
		};
		await this.vault.adapter.write(this.getIndexFilePath(), JSON.stringify(payload));
	}

	search(queryText: string, limit: number): Array<{ chunk: Bm25Chunk; rawScore: number; terms: string[] }> {
		const qTokens = tokenize(queryText).slice(0, 24);
		const terms = Array.from(new Set(qTokens));
		if (terms.length === 0) return [];

		const N = this.chunksByKey.size;
		if (N === 0) return [];

		const avgdl = N ? this.sumLen / N : 0;
		const k1 = 1.2;
		const b = 0.75;

		const scores = new Map<string, number>();

		for (const term of terms) {
			const posting = this.postings.get(term);
			if (!posting || posting.length === 0) continue;

			let df = 0;
			for (const [key] of posting) {
				if (this.chunksByKey.has(key)) df++;
			}
			if (df === 0) continue;

			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

			for (const [key, tf] of posting) {
				const ch = this.chunksByKey.get(key);
				if (!ch) continue;
				const dl = ch.len || 0;
				const denom = tf + k1 * (1 - b + (b * dl) / (avgdl || 1));
				const s = (idf * (tf * (k1 + 1))) / (denom || 1);
				scores.set(key, (scores.get(key) ?? 0) + s);
			}
		}

		const ranked = Array.from(scores.entries())
			.map(([key, rawScore]) => {
				const ch = this.chunksByKey.get(key);
				if (!ch) return null;
				return { chunk: ch, rawScore, terms };
			})
			.filter((x): x is { chunk: Bm25Chunk; rawScore: number; terms: string[] } => Boolean(x))
			.sort((a, b) => b.rawScore - a.rawScore)
			.slice(0, Math.max(1, Math.min(400, limit)));

		return ranked;
	}
}


