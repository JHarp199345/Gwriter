import type { Vault } from 'obsidian';
import { TFile, Notice } from 'obsidian';
import WritingDashboardPlugin from '../../main';
import { buildIndexChunks } from './Chunking';
import { fnv1a32, sha256 } from '../ContentHash';
import { OllamaEmbeddingProvider } from './OllamaEmbeddingProvider';
import { CO_AUTHORING_POLICY } from '../policy';
import { relayEventBus } from '../EventBus';

export interface IndexedChunk {
	key: string;
	path: string;
	chunkIndex: number;
	startWord: number;
	endWord: number;
	textHash: string; // SHA-256
	vector: number[];
	excerpt: string;
}

/**
 * Stable normalization for bit-perfect hash continuity.
 */
export function normalizeChunkText(text: string): string {
	return text
		.trim()
		.replace(/\r\n/g, '\n') // Normalize newlines
		.replace(/\r/g, '\n')
		.replace(/[ \t]+/g, ' '); // Normalize spaces/tabs
}

interface PersistedIndexV1 {
	version: 1;
	dim: number;
	backend: 'ollama';
	chunking?: { headingLevel: 'h1' | 'h2' | 'h3' | 'none'; targetWords: number; overlapWords: number };
	chunks: IndexedChunk[];
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
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
	private dim: number;
	private readonly backend: 'ollama';
	private embeddingProvider: OllamaEmbeddingProvider;

	private loaded = false;
	private readonly chunksByKey = new Map<string, IndexedChunk>();
	private readonly chunkKeysByPath = new Map<string, Set<string>>();

	private readonly queue = new Set<string>();
	private workerRunning = false;
	private rebuildTimer: number | null = null;
	private persistTimer: number | null = null;
	private settingsSaveTimer: number | null = null;

	// Error tracking
	private readonly errorLog: ErrorLogEntry[] = [];
	private readonly maxStoredErrors = 100;
	
	// Circuit breaker for AI embedding failures
	private aiErrorStreak = 0;
	private readonly AI_ERROR_STREAK_THRESHOLD = 3;
	private readonly AI_PAUSE_DURATION_MS = 15000;

	// Shared Brain state
	private isReadOnly = false;
	private heartbeatTimer: number | null = null;
	private currentStorageMode: 'isolated' | 'auto' | 'manual' | null = null;
	private lockAcquiredAt: number | null = null; // Preserve for heartbeat

	constructor(vault: Vault, plugin: WritingDashboardPlugin, embeddingProvider: OllamaEmbeddingProvider) {
		this.vault = vault;
		this.plugin = plugin;
		this.backend = 'ollama';
		this.embeddingProvider = embeddingProvider;
		this.dim = 0;
	}

	/**
	 * Hot-swaps the embedding provider (e.g. when user changes models).
	 */
	updateProvider(provider: OllamaEmbeddingProvider) {
		this.embeddingProvider = provider;
	}

	async onunload() {
		this.stopHeartbeat();
		// Remove lock only if we own it (JSON format check)
		const dir = await this.resolveIndexDir();
		const lockPath = `${dir}/index.lock`;
		try {
			if (await this.vault.adapter.exists(lockPath)) {
				const raw = await this.vault.adapter.read(lockPath);
				try {
				const lock = JSON.parse(raw);
					if (lock.holder === 'writing-dashboard') {
						await this.vault.adapter.remove(lockPath);
					}
				} catch (err) {
					// JSON parse failed - do not delete (could be another plugin's lock)
					console.debug('[EmbeddingsIndex] Lock file JSON parse failed, skipping removal:', err);
				}
			}
		} catch (err) {
			console.debug('[EmbeddingsIndex] Filesystem error during lock cleanup:', err);
		}
	}

	/**
	 * Returns the canonical embedding profile (single source of truth).
	 * Used for handshake files, manifest validation, and profile matching.
	 */
	getEmbeddingProfile() {
		return {
			provider: 'ollama' as const,
			modelId: this.plugin.settings.relayEmbeddingModel,
			dimensions: this.dim || 768,
			normalize: true,
			chunkingVersion: 2,
			schemaVersion: 2
		};
	}

	async resolveIndexDir(): Promise<string> {
		const mode = this.currentStorageMode || this.plugin.settings.embeddingStorageMode || 'isolated';

		if (mode === 'isolated') {
			return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
		}

		if (mode === 'manual') {
			const manualPath = this.plugin.settings.manualSharedPath;
			if (manualPath) return manualPath;
			return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
		}

		// auto mode
		const storyboardHandshakePath = `${this.vault.configDir}/embeddings/handshake/story-canvas-observer.json`;
		if (await this.vault.adapter.exists(storyboardHandshakePath)) {
			try {
				const raw = await this.vault.adapter.read(storyboardHandshakePath);
				const storyboard = JSON.parse(raw);
				if (this.profilesMatch(storyboard.embeddingProfile)) {
					return 'Embeddings/shared-index';
				} else {
					console.warn('[EmbeddingsIndex] Shared index disabled: embedding profiles do not match storyboard');
				}
			} catch (err) {
				console.error('[EmbeddingsIndex] Failed to read storyboard handshake:', err);
			}
		}

		return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
	}

	private profilesMatch(other: any): boolean {
		const mine = this.getEmbeddingProfile();
		return (
			mine.provider === other.provider &&
			mine.modelId === other.modelId &&
			mine.dimensions === other.dimensions &&
			mine.normalize === other.normalize &&
			mine.chunkingVersion === other.chunkingVersion &&
			mine.schemaVersion === other.schemaVersion
		);
	}

	async validateManifest(dir: string): Promise<boolean> {
		const manifestPath = `${dir}/index.manifest.json`;
		if (!(await this.vault.adapter.exists(manifestPath))) return true; // No manifest yet

		try {
			const raw = await this.vault.adapter.read(manifestPath);
			const manifest = JSON.parse(raw);
			return this.profilesMatch(manifest.embeddingProfile);
		} catch {
			return false;
		}
	}

	async acquireLock(dir: string): Promise<boolean> {
		const lockPath = `${dir}/index.lock`;
		const myId = 'writing-dashboard';
		const now = Date.now();

		try {
			let existingLock: { holder: string; acquiredAt: number; updatedAt: number } | null = null;

			if (await this.vault.adapter.exists(lockPath)) {
				const raw = await this.vault.adapter.read(lockPath);
				try {
					existingLock = JSON.parse(raw);
				} catch {
					// Invalid JSON (legacy string format) - treat as stale
					existingLock = null;
				}
			}

			if (existingLock) {
				const isStale = (now - existingLock.updatedAt) > 60000;
				const isSelf = existingLock.holder === myId;

				if (!isStale && !isSelf) {
					// Valid lock held by another plugin
					this.isReadOnly = true;
					return false;
				}

				if (isSelf) {
					// Refresh: preserve acquiredAt, update updatedAt
					this.lockAcquiredAt = existingLock.acquiredAt;
				} else {
					// Stale takeover: reset both timestamps
					this.lockAcquiredAt = now;
				}
			} else {
				// New lock
				this.lockAcquiredAt = now;
			}

			// Write lock JSON
			const lockData = {
				holder: myId,
				acquiredAt: this.lockAcquiredAt,
				updatedAt: now
			};
			await this.vault.adapter.write(lockPath, JSON.stringify(lockData));
			this.isReadOnly = false;
			this.startHeartbeat(lockPath);
			return true;
		} catch {
			this.isReadOnly = true;
			return false;
		}
	}

	private startHeartbeat(lockPath: string) {
		this.stopHeartbeat();
		this.heartbeatTimer = window.setInterval(async () => {
			try {
				const lockData = {
					holder: 'writing-dashboard',
					acquiredAt: this.lockAcquiredAt,
					updatedAt: Date.now()
				};
				await this.vault.adapter.write(lockPath, JSON.stringify(lockData));
			} catch {
				this.stopHeartbeat();
			}
		}, 30000);
	}

	private stopHeartbeat() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	async seedSharedIndex(sourceDir: string, targetDir: string): Promise<void> {
		const manifestPath = `${targetDir}/index.manifest.json`;
		const indexPath = `${targetDir}/index.json`;

		const isEmpty = !(await this.vault.adapter.exists(manifestPath)) || !(await this.vault.adapter.exists(indexPath));
		if (!isEmpty) return;

		const sourceIndex = `${sourceDir}/index.json`;
		if (await this.vault.adapter.exists(sourceIndex)) {
			try {
				if (!(await this.vault.adapter.exists(targetDir))) {
					// Recursive mkdir
					const parts = targetDir.split('/');
					let current = '';
					for (const part of parts) {
						if (!part) continue;
						current += (current ? '/' : '') + part;
						if (!(await this.vault.adapter.exists(current))) {
							await this.vault.adapter.mkdir(current);
						}
					}
				}
				const content = await this.vault.adapter.read(sourceIndex);
				await this.vault.adapter.write(indexPath, content);

				const manifest = {
					schemaVersion: 2,
					embeddingProfile: this.getEmbeddingProfile(),
					engine: 'json'
				};
				await this.vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
			} catch (err) {
				console.error('[EmbeddingsIndex] Seeding failed:', err);
			}
		}
	}

	/**
	 * Atomic migration from legacy .obsidian/embeddings/shared-index/ to overt Embeddings/shared-index/
	 * Returns true if migration succeeded or was not needed, false if failed.
	 */
	async migrateFromLegacy(): Promise<boolean> {
		const overtDir = 'Embeddings/shared-index';
		const legacyDir = `${this.vault.configDir}/embeddings/shared-index`;
		const overtIndex = `${overtDir}/index.json`;
		const legacyIndex = `${legacyDir}/index.json`;
		const migrationMarker = `${overtDir}/.migrated-from-legacy`;

		try {
			// Check if migration is needed
			const overtExists = await this.vault.adapter.exists(overtIndex);
			const legacyExists = await this.vault.adapter.exists(legacyIndex);

			// If overt already exists or legacy doesn't exist, no migration needed
			if (overtExists || !legacyExists) {
				return true;
			}

			// Check if already migrated
			if (await this.vault.adapter.exists(migrationMarker)) {
				return true;
			}

			console.debug('[EmbeddingsIndex] Starting atomic migration from legacy to overt folder...');

			// Ensure overt folder exists
			if (!(await this.vault.adapter.exists(overtDir))) {
				const parts = overtDir.split('/');
				let current = '';
				for (const part of parts) {
					if (!part) continue;
					current += (current ? '/' : '') + part;
					if (!(await this.vault.adapter.exists(current))) {
						await this.vault.adapter.mkdir(current);
					}
				}
			}

			// Acquire writer lock on overt folder
			const hasLock = await this.acquireLock(overtDir);
			if (!hasLock) {
				console.warn('[EmbeddingsIndex] Legacy migration aborted: could not acquire lock (read-only mode).');
				return false;
			}

			// Step 1: Copy legacy files to .tmp versions
			const legacyContent = await this.vault.adapter.read(legacyIndex);
			await this.vault.adapter.write(`${overtIndex}.tmp`, legacyContent);

			const legacyManifest = `${legacyDir}/index.manifest.json`;
			const overtManifest = `${overtDir}/index.manifest.json`;
			let hasManifest = false;
			if (await this.vault.adapter.exists(legacyManifest)) {
				const manifestContent = await this.vault.adapter.read(legacyManifest);
				await this.vault.adapter.write(`${overtManifest}.tmp`, manifestContent);
				hasManifest = true;
			}

			// Step 2: Rename .tmp to canonical (atomic commit)
			await this.vault.adapter.rename(`${overtIndex}.tmp`, overtIndex);
			if (hasManifest) {
				await this.vault.adapter.rename(`${overtManifest}.tmp`, overtManifest);
			}

			// Step 3: Write migration marker
			const markerContent = JSON.stringify({
				migratedAt: Date.now(),
				from: legacyDir
			}, null, 2);
			await this.vault.adapter.write(migrationMarker, markerContent);

			// Step 4: Disable legacy by renaming
			await this.vault.adapter.rename(legacyIndex, `${legacyIndex}.migrated`);
			if (await this.vault.adapter.exists(legacyManifest)) {
				await this.vault.adapter.rename(legacyManifest, `${legacyManifest}.migrated`);
			}

			console.debug('[EmbeddingsIndex] ✓ Atomic migration completed successfully.');
			return true;
		} catch (err) {
			console.warn('[EmbeddingsIndex] Legacy migration failed; falling back to isolated.', err);

			// Cleanup temp files best-effort
			try {
				if (await this.vault.adapter.exists(`${overtIndex}.tmp`)) {
					await this.vault.adapter.remove(`${overtIndex}.tmp`);
				}
				if (await this.vault.adapter.exists(`${overtDir}/index.manifest.json.tmp`)) {
					await this.vault.adapter.remove(`${overtDir}/index.manifest.json.tmp`);
				}
			} catch (err) {
				console.debug('[EmbeddingsIndex] Temp file cleanup failed (non-critical):', err);
			}

			return false;
		}
	}

	async getIndexFilePath(): Promise<string> {
		const dir = await this.resolveIndexDir();
		return `${dir}/index.json`;
	}

	async clearIndex(): Promise<void> {
		this.chunksByKey.clear();
		this.chunkKeysByPath.clear();
		this.plugin.settings.retrievalIndexState = {};
		await this.plugin.saveSettings();
		const path = await this.getIndexFilePath();
		if (await this.vault.adapter.exists(path)) {
			await this.vault.adapter.remove(path);
		}
	}

	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;

		try {
			// Step 1: Determine mode and attempt migration in auto mode
			const mode = this.plugin.settings.embeddingStorageMode || 'isolated';
			if (mode === 'auto') {
				// Attempt legacy migration BEFORE resolving final dir
				const migrationSuccess = await this.migrateFromLegacy();
				if (!migrationSuccess) {
					// Migration failed (locked by other plugin or error) - fall back to isolated
					this.currentStorageMode = 'isolated';
					console.warn('[EmbeddingsIndex] Auto mode: migration failed, using isolated mode.');
				}
			}

			// Step 2: Resolve index directory
			const dir = await this.resolveIndexDir();
			const path = await this.getIndexFilePath();

			// Step 3: Validate manifest
			if (!(await this.validateManifest(dir))) {
				console.warn('[EmbeddingsIndex] Manifest mismatch; falling back to isolated mode');
				this.currentStorageMode = 'isolated'; // Internal override for this session
				// Re-resolve path after fallback
				const newDir = await this.resolveIndexDir();
				if (!(await this.vault.adapter.exists(newDir))) {
					await this.vault.adapter.mkdir(newDir);
				}
			}

			// Step 4: In auto/manual, acquire lock and seed if needed
			const resolvedMode = this.currentStorageMode || mode;
			if (resolvedMode !== 'isolated') {
				const sourceDir = `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
				await this.seedSharedIndex(sourceDir, dir);
				await this.acquireLock(dir);
			}

			if (!(await this.vault.adapter.exists(path))) return;
			const raw = await this.vault.adapter.read(path);
			const parsed = JSON.parse(raw) as PersistedIndexV1;
			if (parsed?.version !== 1 || !Array.isArray(parsed.chunks)) return;
			if (parsed.backend && parsed.backend !== this.backend) {
				// Backend mismatch: ignore persisted index and rebuild.
				this.enqueueFullRescan();
				return;
			}
			if (typeof parsed.dim === 'number') {
				this.dim = parsed.dim;
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
	} catch (err) {
		// Corrupt index should not break the plugin. We'll rebuild lazily.
		console.warn('[EmbeddingsIndex] Corrupt index data detected, rebuilding from scratch:', err);
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
		this._scheduleRebuild();
	}

	private _scheduleRebuild(): void {
		const policy = CO_AUTHORING_POLICY.PERFORMANCE;
		if (this.rebuildTimer) window.clearTimeout(this.rebuildTimer);
		this.rebuildTimer = window.setTimeout(() => {
			this.rebuildTimer = null;
			this._kickWorker();
		}, policy.REBUILD_QUEUE_DEBOUNCE_MS);
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

		if (this.isReadOnly) {
			console.debug('[EmbeddingsIndex] Shared index locked; operating read-only.');
			this.workerRunning = false;
			return;
		}

		// If Ollama is not available, skip semantic indexing to avoid failures.
		if (!(await this.embeddingProvider.isAvailable())) {
			console.warn('[EmbeddingsIndex] Ollama not available; skipping semantic indexing');
			new Notice('⚠️ Ollama not available - indexing skipped');
			this.workerRunning = false;
			return;
		}

		const policy = CO_AUTHORING_POLICY.PERFORMANCE;
		const startTime = Date.now();
		const totalFiles = this.queue.size;
		let processedCount = 0;
		let skippedExcluded = 0;
		let skippedNotMarkdown = 0;
		let skippedHashMatch = 0;
		let indexedCount = 0;

		// Emit start event and notification
		if (totalFiles > 0) {
			new Notice(`🔍 Starting index scan (${totalFiles} files)...`);
			relayEventBus.emit('index:start', { totalFiles });
		}
		
		while (this.queue.size > 0 && indexedCount < policy.MAX_REBUILDS_PER_BATCH) {
			if (this.plugin.settings.retrievalIndexPaused) break;
			const next = this.queue.values().next().value as string;
			this.queue.delete(next);
			processedCount++;

			// Emit progress every 10 files
			if (processedCount % 10 === 0) {
				new Notice(`Indexing... ${processedCount}/${totalFiles} files`);
				relayEventBus.emit('index:progress', { processed: processedCount, total: totalFiles, currentFile: next });
			}

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
				const normalizedContent = normalizeChunkText(content);
				const fileHash = await sha256(normalizedContent);
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

		// Calculate duration and emit completion
		const duration = (Date.now() - startTime) / 1000;
		const totalSkipped = skippedExcluded + skippedNotMarkdown + skippedHashMatch;

		// Log indexing stats for debugging
	if (processedCount > 0) {
		console.debug(`[EmbeddingsIndex] Processed ${processedCount} files: ${indexedCount} indexed, ${skippedExcluded} excluded, ${skippedNotMarkdown} not markdown, ${skippedHashMatch} hash match (already indexed)`);
			new Notice(`✅ Indexed ${indexedCount} files in ${duration.toFixed(1)}s (${this.chunksByKey.size} chunks total)`);
			relayEventBus.emit('index:complete', { 
				indexed: indexedCount, 
				chunks: this.chunksByKey.size, 
				duration,
				skipped: totalSkipped
			});
		}

		this.stopHeartbeat();
		this.workerRunning = false;
	}

	private async _reindexFile(path: string, content: string): Promise<void> {
		this._removePath(path);

		// If Ollama is not available, skip semantic indexing for this file.
		if (!(await this.embeddingProvider.isAvailable())) {
			console.warn(`[EmbeddingsIndex] Ollama not available; skipping file: ${path}`);
			return;
		}

		// Skip empty files
		if (!content || content.trim().length === 0) {
			console.warn(`[EmbeddingsIndex] Skipping empty file: ${path}`);
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
			console.warn(`[EmbeddingsIndex] No chunks created for ${path} - file too short or no headings match chunking config`);
			return;
		}

		let successfulChunks = 0;
		let firstError: Error | null = null;
		for (let i = 0; i < chunks.length; i++) {
			const ch = chunks[i];
			const normalizedText = normalizeChunkText(ch.text);
			const textHash = await sha256(normalizedText);
			const key = `chunk:${path}:${i}`;
			let vector: number[];
		try {
			vector = await this.embeddingProvider.getEmbedding(normalizedText);
			this.aiErrorStreak = 0; // Success: reset streak
			if (!Array.isArray(vector) || vector.length === 0) {
				throw new Error('Empty embedding returned from Ollama');
			}
			if (this.dim === 0) {
				this.dim = vector.length;
			}
		} catch (err) {
				this.aiErrorStreak++;
				const errorMsg = err instanceof Error ? err.message : String(err);
				const errorStack = err instanceof Error ? err.stack : undefined;
				const context = `File: ${path}, Chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words, ${ch.text.length} chars)`;
				this.logError('_reindexFile.embedChunk', context, err);
				
				console.error(`  - ✗ Embedding generation failed for chunk ${i + 1}/${chunks.length}:`, errorMsg);
				
				if (this.aiErrorStreak >= 3) {
					console.warn('[EmbeddingsIndex] Embedding breaker triggered: paused 15s and cleared queue after 3 consecutive failures.');
					this.queue.clear();
					this.aiErrorStreak = 0;
					// Yield and wait 15s
					await new Promise(r => setTimeout(r, 15000));
					throw new Error('Embedding breaker triggered; batch aborted.');
				}

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
					console.warn(`  - Warning: First chunk failed for ${path}. Attempting subsequent chunks.`);
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

	/**
	 * Computes a bit-perfect corpus hash for strict replay.
	 * sha256(join(sort(chunk_id + ":" + content_hash), "\n"))
	 */
	async getCorpusHash(): Promise<string> {
		const chunks = this.getAllChunks();
		const lines = chunks.map(c => `${c.key}:${c.textHash}`);
		lines.sort((a, b) => a.localeCompare(b));
		const joined = lines.join('\n');
		return await sha256(joined);
	}

	getIndexedPaths(): string[] {
		return Array.from(this.chunkKeysByPath.keys());
	}

	/**
	 * Checks if a path is currently marked as stale in the index state.
	 */
	isStale(path: string): boolean {
		const state = this.plugin.settings.retrievalIndexState?.[path];
		if (!state) return false;
		
		const file = this.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return true; // Missing file is effectively stale
		
		// If updatedAt is not set, we can't be sure, assume not stale for now
		if (!state.updatedAt) return false;
		
		const fileMtime = file.stat.mtime;
		const indexTime = new Date(state.updatedAt).getTime();
		
		return fileMtime > indexTime;
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
		console.warn('[EmbeddingsIndex] buildQueryVector called; returning empty vector. Use embedQueryVector instead.');
		return [];
	}

	async embedQueryVector(queryText: string): Promise<number[]> {
		const vec = await this.embeddingProvider.getEmbedding(queryText);
		if (!Array.isArray(vec) || vec.length === 0) {
			throw new Error('Empty embedding returned from Ollama');
		}
		return vec;
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
		if (this.isReadOnly) {
			console.debug('[EmbeddingsIndex] Skipping persistence: Read-Only mode');
			return;
		}

		const dir = await this.resolveIndexDir();
		try {
			if (!(await this.vault.adapter.exists(dir))) {
				// Recursive mkdir
				const parts = dir.split('/');
				let current = '';
				for (const part of parts) {
					if (!part) continue;
					current += (current ? '/' : '') + part;
					if (!(await this.vault.adapter.exists(current))) {
						await this.vault.adapter.mkdir(current);
					}
				}
			}
		} catch (err) {
			console.warn('[EmbeddingsIndex] Failed to create index directory:', err);
		}

		const payload: PersistedIndexV1 = {
			version: 1,
			dim: this.dim,
			backend: this.backend,
			chunking: chunkingKey(this.plugin),
			chunks: this.getAllChunks()
		};
		await this.vault.adapter.write(await this.getIndexFilePath(), JSON.stringify(payload));

		// Ensure manifest exists in the index directory
		const manifestPath = `${dir}/index.manifest.json`;
		if (!(await this.vault.adapter.exists(manifestPath))) {
			const manifest = {
				schemaVersion: 2,
				embeddingProfile: this.getEmbeddingProfile(),
				engine: 'json'
			};
			await this.vault.adapter.write(manifestPath, JSON.stringify(manifest, null, 2));
		}
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


