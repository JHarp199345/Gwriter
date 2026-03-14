import { TFile, Notice } from 'obsidian';
import { buildIndexChunks } from './Chunking';
import { sha256 } from '../ContentHash';
import { CO_AUTHORING_POLICY } from '../policy';
import { relayEventBus } from '../EventBus';
/**
 * Stable normalization for bit-perfect hash continuity.
 */
export function normalizeChunkText(text) {
    return text
        .trim()
        .replaceAll('\r\n', '\n') // Normalize newlines
        .replaceAll('\r', '\n')
        .replace(/[ \t]+/g, ' '); // Normalize spaces/tabs
}
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.max(min, Math.min(max, Math.floor(value)));
}
function chunkingKey(plugin) {
    return {
        headingLevel: plugin.settings.retrievalChunkHeadingLevel ?? 'h1',
        targetWords: clampInt(plugin.settings.retrievalChunkWords ?? 500, 200, 2000),
        overlapWords: clampInt(plugin.settings.retrievalChunkOverlapWords ?? 100, 0, 500)
    };
}
function excerptOf(text, maxChars) {
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= maxChars)
        return trimmed;
    return `${trimmed.slice(0, maxChars)}…`;
}
export class EmbeddingsIndex {
    constructor(vault, plugin) {
        this.loaded = false;
        this.chunksByKey = new Map();
        this.chunkKeysByPath = new Map();
        this.queue = new Set();
        this.workerRunning = false;
        this.rebuildTimer = null;
        this.persistTimer = null;
        this.settingsSaveTimer = null;
        // Error tracking
        this.errorLog = [];
        this.maxStoredErrors = 100;
        // Shared Brain state
        this.isReadOnly = false;
        this.heartbeatTimer = null;
        this.currentStorageMode = null;
        this.lockAcquiredAt = null; // Preserve for heartbeat
        this.vault = vault;
        this.plugin = plugin;
        this.dim = 0;
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
                }
                catch (err) {
                    // JSON parse failed - do not delete (could be another plugin's lock)
                    console.debug('[EmbeddingsIndex] Lock file JSON parse failed, skipping removal:', err);
                }
            }
        }
        catch (err) {
            console.debug('[EmbeddingsIndex] Filesystem error during lock cleanup:', err);
        }
    }
    /**
     * Returns the canonical embedding profile (single source of truth).
     * Used for handshake files, manifest validation, and profile matching.
     */
    getEmbeddingProfile() {
        return {
            provider: 'external',
            modelId: this.plugin.settings.externalEmbeddingModel ?? 'text-embedding-3-small',
            dimensions: this.dim || 0,
            normalize: true,
            chunkingVersion: 2,
            schemaVersion: 2
        };
    }
    async resolveIndexDir() {
        const mode = this.currentStorageMode || this.plugin.settings.embeddingStorageMode || 'isolated';
        if (mode === 'isolated') {
            return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
        }
        if (mode === 'manual') {
            const manualPath = this.plugin.settings.manualSharedPath;
            if (manualPath)
                return manualPath;
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
                }
                else {
                    console.warn('[EmbeddingsIndex] Shared index disabled: embedding profiles do not match storyboard');
                }
            }
            catch (err) {
                console.error('[EmbeddingsIndex] Failed to read storyboard handshake:', err);
            }
        }
        return `${this.vault.configDir}/plugins/${this.plugin.manifest.id}/rag-index`;
    }
    profilesMatch(other) {
        const mine = this.getEmbeddingProfile();
        return (mine.provider === other.provider &&
            mine.modelId === other.modelId &&
            mine.normalize === other.normalize &&
            mine.chunkingVersion === other.chunkingVersion &&
            mine.schemaVersion === other.schemaVersion);
    }
    async validateManifest(dir) {
        const manifestPath = `${dir}/index.manifest.json`;
        if (!(await this.vault.adapter.exists(manifestPath)))
            return true; // No manifest yet
        try {
            const raw = await this.vault.adapter.read(manifestPath);
            const manifest = JSON.parse(raw);
            return this.profilesMatch(manifest.embeddingProfile);
        }
        catch {
            return false;
        }
    }
    async acquireLock(dir) {
        const lockPath = `${dir}/index.lock`;
        const myId = 'writing-dashboard';
        const now = Date.now();
        try {
            let existingLock = null;
            if (await this.vault.adapter.exists(lockPath)) {
                const raw = await this.vault.adapter.read(lockPath);
                try {
                    existingLock = JSON.parse(raw);
                }
                catch {
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
                }
                else {
                    // Stale takeover: reset both timestamps
                    this.lockAcquiredAt = now;
                }
            }
            else {
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
        }
        catch {
            this.isReadOnly = true;
            return false;
        }
    }
    startHeartbeat(lockPath) {
        this.stopHeartbeat();
        this.heartbeatTimer = window.setInterval(async () => {
            try {
                const lockData = {
                    holder: 'writing-dashboard',
                    acquiredAt: this.lockAcquiredAt,
                    updatedAt: Date.now()
                };
                await this.vault.adapter.write(lockPath, JSON.stringify(lockData));
            }
            catch {
                this.stopHeartbeat();
            }
        }, 30000);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    async seedSharedIndex(sourceDir, targetDir) {
        const manifestPath = `${targetDir}/index.manifest.json`;
        const indexPath = `${targetDir}/index.json`;
        const isEmpty = !(await this.vault.adapter.exists(manifestPath)) || !(await this.vault.adapter.exists(indexPath));
        if (!isEmpty)
            return;
        const sourceIndex = `${sourceDir}/index.json`;
        if (await this.vault.adapter.exists(sourceIndex)) {
            try {
                if (!(await this.vault.adapter.exists(targetDir))) {
                    // Recursive mkdir
                    const parts = targetDir.split('/');
                    let current = '';
                    for (const part of parts) {
                        if (!part)
                            continue;
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
            }
            catch (err) {
                console.error('[EmbeddingsIndex] Seeding failed:', err);
            }
        }
    }
    /**
     * Atomic migration from legacy .obsidian/embeddings/shared-index/ to overt Embeddings/shared-index/
     * Returns true if migration succeeded or was not needed, false if failed.
     */
    async migrateFromLegacy() {
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
                    if (!part)
                        continue;
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
            console.debug('[EmbeddingsIndex] Atomic migration completed successfully.');
            return true;
        }
        catch (err) {
            console.warn('[EmbeddingsIndex] Legacy migration failed; falling back to isolated.', err);
            // Cleanup temp files best-effort
            try {
                if (await this.vault.adapter.exists(`${overtIndex}.tmp`)) {
                    await this.vault.adapter.remove(`${overtIndex}.tmp`);
                }
                if (await this.vault.adapter.exists(`${overtDir}/index.manifest.json.tmp`)) {
                    await this.vault.adapter.remove(`${overtDir}/index.manifest.json.tmp`);
                }
            }
            catch (err) {
                console.debug('[EmbeddingsIndex] Temp file cleanup failed (non-critical):', err);
            }
            return false;
        }
    }
    async getIndexFilePath() {
        const dir = await this.resolveIndexDir();
        return `${dir}/index.json`;
    }
    async clearIndex() {
        this.chunksByKey.clear();
        this.chunkKeysByPath.clear();
        this.plugin.settings.retrievalIndexState = {};
        await this.plugin.saveSettings();
        const path = await this.getIndexFilePath();
        if (await this.vault.adapter.exists(path)) {
            await this.vault.adapter.remove(path);
        }
    }
    async ensureLoaded() {
        if (this.loaded)
            return;
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
            if (!(await this.vault.adapter.exists(path)))
                return;
            const raw = await this.vault.adapter.read(path);
            const parsed = JSON.parse(raw);
            if (parsed?.version !== 1 || !Array.isArray(parsed.chunks))
                return;
            if (typeof parsed.dim === 'number') {
                this.dim = parsed.dim;
            }
            const expectedChunking = chunkingKey(this.plugin);
            if (parsed.chunking &&
                (parsed.chunking.headingLevel !== expectedChunking.headingLevel ||
                    parsed.chunking.targetWords !== expectedChunking.targetWords ||
                    parsed.chunking.overlapWords !== expectedChunking.overlapWords)) {
                // Chunking config changed; rebuild index.
                this.enqueueFullRescan();
                return;
            }
            for (const chunk of parsed.chunks) {
                if (!chunk?.key || !chunk?.path || !Array.isArray(chunk.vector))
                    continue;
                this._setChunk(chunk);
            }
        }
        catch (err) {
            // Corrupt index should not break the plugin. We'll rebuild lazily.
            console.warn('[EmbeddingsIndex] Corrupt index data detected, rebuilding from scratch:', err);
            this.chunksByKey.clear();
            this.chunkKeysByPath.clear();
        }
    }
    getStatus() {
        return {
            indexedFiles: this.chunkKeysByPath.size,
            indexedChunks: this.chunksByKey.size,
            paused: Boolean(this.plugin.settings.retrievalIndexPaused),
            queued: this.queue.size
        };
    }
    getRecentErrors(limit = 20) {
        return this.errorLog.slice(-limit);
    }
    getErrorSummary() {
        const byLocation = {};
        for (const err of this.errorLog) {
            byLocation[err.location] = (byLocation[err.location] || 0) + 1;
        }
        return {
            total: this.errorLog.length,
            byLocation,
            recent: this.errorLog.slice(-10)
        };
    }
    logError(location, context, error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        const errorType = error instanceof Error ? error.constructor.name : typeof error;
        const entry = {
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
    enqueueFullRescan() {
        const files = this.plugin.vaultService.getIncludedMarkdownFiles();
        for (const f of files)
            this.queue.add(f.path);
        this._kickWorker();
    }
    queueUpdateFile(path) {
        if (!path)
            return;
        this.queue.add(path);
        this._scheduleRebuild();
    }
    _scheduleRebuild() {
        const policy = CO_AUTHORING_POLICY.PERFORMANCE;
        if (this.rebuildTimer)
            window.clearTimeout(this.rebuildTimer);
        this.rebuildTimer = window.setTimeout(() => {
            this.rebuildTimer = null;
            this._kickWorker();
        }, policy.REBUILD_QUEUE_DEBOUNCE_MS);
    }
    queueRemoveFile(path) {
        if (!path)
            return;
        this._removePath(path);
        this._schedulePersist();
        this._scheduleSettingsSave();
    }
    _kickWorker() {
        if (this.workerRunning)
            return;
        this.workerRunning = true;
        // Fire and forget, but ensure errors are swallowed.
        void this._runWorker().catch(() => {
            this.workerRunning = false;
        });
    }
    async _runWorker() {
        await this.ensureLoaded();
        if (this.isReadOnly) {
            console.debug('[EmbeddingsIndex] Shared index locked; operating read-only.');
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
            new Notice(`Starting index scan (${totalFiles} files)...`);
            relayEventBus.emit('index:start', { totalFiles });
        }
        while (this.queue.size > 0 && indexedCount < policy.MAX_REBUILDS_PER_BATCH) {
            if (this.plugin.settings.retrievalIndexPaused)
                break;
            const next = this.queue.values().next().value;
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
            }
            catch (err) {
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
            new Notice(`Indexed ${indexedCount} files in ${duration.toFixed(1)}s (${this.chunksByKey.size} chunks total)`);
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
    async _reindexFile(path, content) {
        this._removePath(path);
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
        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            const normalizedText = normalizeChunkText(ch.text);
            const textHash = await sha256(normalizedText);
            const key = `chunk:${path}:${i}`;
            // Store chunks with an empty vector; external embeddings are resolved at query time
            // by ExternalEmbeddingsProvider, not pre-computed here.
            const excerpt = excerptOf(ch.text, 2500);
            this._setChunk({
                key,
                path,
                chunkIndex: i,
                startWord: ch.startWord,
                endWord: ch.endWord,
                textHash,
                vector: [],
                excerpt
            });
        }
        console.debug(`[EmbeddingsIndex] Indexed ${path}: ${chunks.length} chunks`);
    }
    _setChunk(chunk) {
        this.chunksByKey.set(chunk.key, chunk);
        const set = this.chunkKeysByPath.get(chunk.path) ?? new Set();
        set.add(chunk.key);
        this.chunkKeysByPath.set(chunk.path, set);
    }
    _removePath(path) {
        const keys = this.chunkKeysByPath.get(path);
        if (keys) {
            for (const k of keys)
                this.chunksByKey.delete(k);
        }
        this.chunkKeysByPath.delete(path);
        if (this.plugin.settings.retrievalIndexState?.[path]) {
            const next = { ...(this.plugin.settings.retrievalIndexState || {}) };
            delete next[path];
            this.plugin.settings.retrievalIndexState = next;
        }
    }
    getAllChunks() {
        return Array.from(this.chunksByKey.values());
    }
    /**
     * Computes a bit-perfect corpus hash for strict replay.
     * sha256(join(sort(chunk_id + ":" + content_hash), "\n"))
     */
    async getCorpusHash() {
        const chunks = this.getAllChunks();
        const lines = chunks.map(c => `${c.key}:${c.textHash}`);
        lines.sort();
        const joined = lines.join('\n');
        return await sha256(joined);
    }
    getIndexedPaths() {
        return Array.from(this.chunkKeysByPath.keys());
    }
    /**
     * Checks if a path is currently marked as stale in the index state.
     */
    isStale(path) {
        const state = this.plugin.settings.retrievalIndexState?.[path];
        if (!state)
            return false;
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile))
            return true; // Missing file is effectively stale
        // If updatedAt is not set, we can't be sure, assume not stale for now
        if (!state.updatedAt)
            return false;
        const fileMtime = file.stat.mtime;
        const indexTime = new Date(state.updatedAt).getTime();
        return fileMtime > indexTime;
    }
    /**
     * Queue all currently indexed paths for re-checking. This is useful when exclusions/profiles change.
     */
    queueRecheckAllIndexed() {
        for (const p of this.getIndexedPaths())
            this.queue.add(p);
        this._kickWorker();
    }
    getVectorForKey(key) {
        const ch = this.chunksByKey.get(key);
        return ch?.vector ?? null;
    }
    buildQueryVector(queryText) {
        console.warn('[EmbeddingsIndex] buildQueryVector called; returning empty vector. Use ExternalEmbeddingsProvider for query embedding.');
        return [];
    }
    _schedulePersist() {
        if (this.persistTimer)
            window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout(() => {
            this.persistTimer = null;
            void this._persistNow().catch(() => {
                // ignore
            });
        }, 1000);
    }
    async _persistNow() {
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
                    if (!part)
                        continue;
                    current += (current ? '/' : '') + part;
                    if (!(await this.vault.adapter.exists(current))) {
                        await this.vault.adapter.mkdir(current);
                    }
                }
            }
        }
        catch (err) {
            console.warn('[EmbeddingsIndex] Failed to create index directory:', err);
        }
        const payload = {
            version: 1,
            dim: this.dim,
            backend: 'external',
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
    _scheduleSettingsSave() {
        if (this.settingsSaveTimer)
            window.clearTimeout(this.settingsSaveTimer);
        this.settingsSaveTimer = window.setTimeout(() => {
            this.settingsSaveTimer = null;
            void this.plugin.saveSettings().catch(() => {
                // ignore
            });
        }, 1000);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBRXpDLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUM5QyxPQUFPLEVBQUUsTUFBTSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDeEMsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2hELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFhNUM7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixVQUFVLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM5QyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksQ0FBQztTQUN0QixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFB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QUMsTUFBTSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7UUFFdkYsZ0RBQWdEO1FBQ2hELE1BQU0sWUFBWSxHQUFHLEdBQUcsR0FBRyxzQkFBc0IsQ0FBQztRQUNsRCxJQUFJLENBQUMsQ0FBQyxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDdEQsTUFBTSxRQUFRLEdBQUc7Z0JBQ2hCLGFBQWEsRUFBRSxDQUFDO2dCQUNoQixnQkFBZ0IsRUFBRSxJQUFJLENBQUMsbUJBQW1CLEVBQUU7Z0JBQzVDLE1BQU0sRUFBRSxNQUFNO2FBQ2QsQ0FBQztZQUNGLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNqRixDQUFDO0lBQ0YsQ0FBQztJQUVPLHFCQUFxQjtRQUM1QixJQUFJLElBQUksQ0FBQyxpQkFBaUI7WUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3hFLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMvQyxJQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1lBQzlCLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUMxQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgVEZpbGUsIE5vdGljZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xuaW1wb3J0IHsgc2hhMjU2IH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuaW1wb3J0IHsgQ09fQVVUSE9SSU5HX1BPTElDWSB9IGZyb20gJy4uL3BvbGljeSc7XG5pbXBvcnQgeyByZWxheUV2ZW50QnVzIH0gZnJvbSAnLi4vRXZlbnRCdXMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XG5cdGtleTogc3RyaW5nO1xuXHRwYXRoOiBzdHJpbmc7XG5cdGNodW5rSW5kZXg6IG51bWJlcjtcblx0c3RhcnRXb3JkOiBudW1iZXI7XG5cdGVuZFdvcmQ6IG51bWJlcjtcblx0dGV4dEhhc2g6IHN0cmluZzsgLy8gU0hBLTI1NlxuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RhYmxlIG5vcm1hbGl6YXRpb24gZm9yIGJpdC1wZXJmZWN0IGhhc2ggY29udGludWl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNodW5rVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC50cmltKClcblx0XHQucmVwbGFjZUFsbCgnXFxyXFxuJywgJ1xcbicpIC8vIE5vcm1hbGl6ZSBuZXdsaW5lc1xuXHRcdC5yZXBsYWNlQWxsKCdcXHInLCAnXFxuJylcblx0XHQucmVwbGFjZSgvWyBcXHRdKy9nLCAnICcpOyAvLyBOb3JtYWxpemUgc3BhY2VzL3RhYnNcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZEluZGV4VjEge1xuXHR2ZXJzaW9uOiAxO1xuXHRkaW06IG51bWJlcjtcblx0YmFja2VuZDogJ2V4dGVybmFsJyB8ICdoYXNoJztcblx0Y2h1bmtpbmc/OiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9O1xuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xufVxuXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XG5cdHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgTWF0aC5mbG9vcih2YWx1ZSkpKTtcbn1cblxuZnVuY3Rpb24gY2h1bmtpbmdLZXkocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfSB7XG5cdHJldHVybiB7XG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcblx0XHR0YXJnZXRXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rV29yZHMgPz8gNTAwLCAyMDAsIDIwMDApLFxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxuXHR9O1xufVxuXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XG59XG5cbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgZGltOiBudW1iZXI7XG5cblx0cHJpdmF0ZSBsb2FkZWQgPSBmYWxzZTtcblx0cHJpdmF0ZSBjaHVua3NCeUtleSA9IG5ldyBNYXA8c3RyaW5nLCBJbmRleGVkQ2h1bms+KCk7XG5cdHByaXZhdGUgY2h1bmtLZXlzQnlQYXRoID0gbmV3IE1hcDxzdHJpbmcsIFNldDxzdHJpbmc+PigpO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgcXVldWUgPSBuZXcgU2V0PHN0cmluZz4oKTtcblx0cHJpdmF0ZSB3b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdHByaXZhdGUgcmVidWlsZFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBwZXJzaXN0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHNldHRpbmdzU2F2ZVRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuXHQvLyBFcnJvciB0cmFja2luZ1xuXHRwcml2YXRlIHJlYWRvbmx5IGVycm9yTG9nOiBFcnJvckxvZ0VudHJ5W10gPSBbXTtcblx0cHJpdmF0ZSByZWFkb25seSBtYXhTdG9yZWRFcnJvcnMgPSAxMDA7XG5cblx0Ly8gU2hhcmVkIEJyYWluIHN0YXRlXG5cdHByaXZhdGUgaXNSZWFkT25seSA9IGZhbHNlO1xuXHRwcml2YXRlIGhlYXJ0YmVhdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBjdXJyZW50U3RvcmFnZU1vZGU6ICdpc29sYXRlZCcgfCAnYXV0bycgfCAnbWFudWFsJyB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGxvY2tBY3F1aXJlZEF0OiBudW1iZXIgfCBudWxsID0gbnVsbDsgLy8gUHJlc2VydmUgZm9yIGhlYXJ0YmVhdFxuXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCwgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHRcdHRoaXMuZGltID0gMDtcblx0fVxuXG5cdGFzeW5jIG9udW5sb2FkKCkge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdC8vIFJlbW92ZSBsb2NrIG9ubHkgaWYgd2Ugb3duIGl0IChKU09OIGZvcm1hdCBjaGVjaylcblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdGNvbnN0IGxvY2tQYXRoID0gYCR7ZGlyfS9pbmRleC5sb2NrYDtcblx0XHR0cnkge1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobG9ja1BhdGgpKSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxvY2tQYXRoKTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgbG9jayA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdFx0XHRpZiAobG9jay5ob2xkZXIgPT09ICd3cml0aW5nLWRhc2hib2FyZCcpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUobG9ja1BhdGgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdFx0Ly8gSlNPTiBwYXJzZSBmYWlsZWQgLSBkbyBub3QgZGVsZXRlIChjb3VsZCBiZSBhbm90aGVyIHBsdWdpbidzIGxvY2spXG5cdFx0XHRcdFx0Y29uc29sZS5kZWJ1ZygnW0VtYmVkZGluZ3NJbmRleF0gTG9jayBmaWxlIEpTT04gcGFyc2UgZmFpbGVkLCBza2lwcGluZyByZW1vdmFsOicsIGVycik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnNvbGUuZGVidWcoJ1tFbWJlZGRpbmdzSW5kZXhdIEZpbGVzeXN0ZW0gZXJyb3IgZHVyaW5nIGxvY2sgY2xlYW51cDonLCBlcnIpO1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSZXR1cm5zIHRoZSBjYW5vbmljYWwgZW1iZWRkaW5nIHByb2ZpbGUgKHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGgpLlxuXHQgKiBVc2VkIGZvciBoYW5kc2hha2UgZmlsZXMsIG1hbmlmZXN0IHZhbGlkYXRpb24sIGFuZCBwcm9maWxlIG1hdGNoaW5nLlxuXHQgKi9cblx0Z2V0RW1iZWRkaW5nUHJvZmlsZSgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0cHJvdmlkZXI6ICdleHRlcm5hbCcgYXMgY29uc3QsXG5cdFx0XHRtb2RlbElkOiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ01vZGVsID8/ICd0ZXh0LWVtYmVkZGluZy0zLXNtYWxsJyxcblx0XHRcdGRpbWVuc2lvbnM6IHRoaXMuZGltIHx8IDAsXG5cdFx0XHRub3JtYWxpemU6IHRydWUsXG5cdFx0XHRjaHVua2luZ1ZlcnNpb246IDIsXG5cdFx0XHRzY2hlbWFWZXJzaW9uOiAyXG5cdFx0fTtcblx0fVxuXG5cdGFzeW5jIHJlc29sdmVJbmRleERpcigpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IG1vZGUgPSB0aGlzLmN1cnJlbnRTdG9yYWdlTW9kZSB8fCB0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbWJlZGRpbmdTdG9yYWdlTW9kZSB8fCAnaXNvbGF0ZWQnO1xuXG5cdFx0aWYgKG1vZGUgPT09ICdpc29sYXRlZCcpIHtcblx0XHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHRcdH1cblxuXHRcdGlmIChtb2RlID09PSAnbWFudWFsJykge1xuXHRcdFx0Y29uc3QgbWFudWFsUGF0aCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLm1hbnVhbFNoYXJlZFBhdGg7XG5cdFx0XHRpZiAobWFudWFsUGF0aCkgcmV0dXJuIG1hbnVhbFBhdGg7XG5cdFx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR9XG5cblx0XHQvLyBhdXRvIG1vZGVcblx0XHRjb25zdCBzdG9yeWJvYXJkSGFuZHNoYWtlUGF0aCA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9lbWJlZGRpbmdzL2hhbmRzaGFrZS9zdG9yeS1jYW52YXMtb2JzZXJ2ZXIuanNvbmA7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChzdG9yeWJvYXJkSGFuZHNoYWtlUGF0aCk7XG5cdFx0XHRcdGNvbnN0IHN0b3J5Ym9hcmQgPSBKU09OLnBhcnNlKHJhdyk7XG5cdFx0XHRcdGlmICh0aGlzLnByb2ZpbGVzTWF0Y2goc3Rvcnlib2FyZC5lbWJlZGRpbmdQcm9maWxlKSkge1xuXHRcdFx0XHRcdHJldHVybiAnRW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgnO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gU2hhcmVkIGluZGV4IGRpc2FibGVkOiBlbWJlZGRpbmcgcHJvZmlsZXMgZG8gbm90IG1hdGNoIHN0b3J5Ym9hcmQnKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoJ1tFbWJlZGRpbmdzSW5kZXhdIEZhaWxlZCB0byByZWFkIHN0b3J5Ym9hcmQgaGFuZHNoYWtlOicsIGVycik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdH1cblxuXHRwcml2YXRlIHByb2ZpbGVzTWF0Y2gob3RoZXI6IGFueSk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IG1pbmUgPSB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKTtcblx0XHRyZXR1cm4gKFxuXHRcdFx0bWluZS5wcm92aWRlciA9PT0gb3RoZXIucHJvdmlkZXIgJiZcblx0XHRcdG1pbmUubW9kZWxJZCA9PT0gb3RoZXIubW9kZWxJZCAmJlxuXHRcdFx0bWluZS5ub3JtYWxpemUgPT09IG90aGVyLm5vcm1hbGl6ZSAmJlxuXHRcdFx0bWluZS5jaHVua2luZ1ZlcnNpb24gPT09IG90aGVyLmNodW5raW5nVmVyc2lvbiAmJlxuXHRcdFx0bWluZS5zY2hlbWFWZXJzaW9uID09PSBvdGhlci5zY2hlbWFWZXJzaW9uXG5cdFx0KTtcblx0fVxuXG5cdGFzeW5jIHZhbGlkYXRlTWFuaWZlc3QoZGlyOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBtYW5pZmVzdFBhdGggPSBgJHtkaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkpIHJldHVybiB0cnVlOyAvLyBObyBtYW5pZmVzdCB5ZXRcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChtYW5pZmVzdFBhdGgpO1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKHJhdyk7XG5cdFx0XHRyZXR1cm4gdGhpcy5wcm9maWxlc01hdGNoKG1hbmlmZXN0LmVtYmVkZGluZ1Byb2ZpbGUpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGFjcXVpcmVMb2NrKGRpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3QgbG9ja1BhdGggPSBgJHtkaXJ9L2luZGV4LmxvY2tgO1xuXHRcdGNvbnN0IG15SWQgPSAnd3JpdGluZy1kYXNoYm9hcmQnO1xuXHRcdGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cblx0XHR0cnkge1xuXHRcdFx0bGV0IGV4aXN0aW5nTG9jazogeyBob2xkZXI6IHN0cmluZzsgYWNxdWlyZWRBdDogbnVtYmVyOyB1cGRhdGVkQXQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG5cblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxvY2tQYXRoKSkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsb2NrUGF0aCk7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0ZXhpc3RpbmdMb2NrID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBJbnZhbGlkIEpTT04gKGxlZ2FjeSBzdHJpbmcgZm9ybWF0KSAtIHRyZWF0IGFzIHN0YWxlXG5cdFx0XHRcdFx0ZXhpc3RpbmdMb2NrID0gbnVsbDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoZXhpc3RpbmdMb2NrKSB7XG5cdFx0XHRcdGNvbnN0IGlzU3RhbGUgPSAobm93IC0gZXhpc3RpbmdMb2NrLnVwZGF0ZWRBdCkgPiA2MDAwMDtcblx0XHRcdFx0Y29uc3QgaXNTZWxmID0gZXhpc3RpbmdMb2NrLmhvbGRlciA9PT0gbXlJZDtcblxuXHRcdFx0XHRpZiAoIWlzU3RhbGUgJiYgIWlzU2VsZikge1xuXHRcdFx0XHRcdC8vIFZhbGlkIGxvY2sgaGVsZCBieSBhbm90aGVyIHBsdWdpblxuXHRcdFx0XHRcdHRoaXMuaXNSZWFkT25seSA9IHRydWU7XG5cdFx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGlzU2VsZikge1xuXHRcdFx0XHRcdC8vIFJlZnJlc2g6IHByZXNlcnZlIGFjcXVpcmVkQXQsIHVwZGF0ZSB1cGRhdGVkQXRcblx0XHRcdFx0XHR0aGlzLmxvY2tBY3F1aXJlZEF0ID0gZXhpc3RpbmdMb2NrLmFjcXVpcmVkQXQ7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gU3RhbGUgdGFrZW92ZXI6IHJlc2V0IGJvdGggdGltZXN0YW1wc1xuXHRcdFx0XHRcdHRoaXMubG9ja0FjcXVpcmVkQXQgPSBub3c7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIE5ldyBsb2NrXG5cdFx0XHRcdHRoaXMubG9ja0FjcXVpcmVkQXQgPSBub3c7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFdyaXRlIGxvY2sgSlNPTlxuXHRcdFx0Y29uc3QgbG9ja0RhdGEgPSB7XG5cdFx0XHRcdGhvbGRlcjogbXlJZCxcblx0XHRcdFx0YWNxdWlyZWRBdDogdGhpcy5sb2NrQWNxdWlyZWRBdCxcblx0XHRcdFx0dXBkYXRlZEF0OiBub3dcblx0XHRcdH07XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobG9ja1BhdGgsIEpTT04uc3RyaW5naWZ5KGxvY2tEYXRhKSk7XG5cdFx0XHR0aGlzLmlzUmVhZE9ubHkgPSBmYWxzZTtcblx0XHRcdHRoaXMuc3RhcnRIZWFydGJlYXQobG9ja1BhdGgpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHR0aGlzLmlzUmVhZE9ubHkgPSB0cnVlO1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgc3RhcnRIZWFydGJlYXQobG9ja1BhdGg6IHN0cmluZykge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdHRoaXMuaGVhcnRiZWF0VGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoYXN5bmMgKCkgPT4ge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgbG9ja0RhdGEgPSB7XG5cdFx0XHRcdFx0aG9sZGVyOiAnd3JpdGluZy1kYXNoYm9hcmQnLFxuXHRcdFx0XHRcdGFjcXVpcmVkQXQ6IHRoaXMubG9ja0FjcXVpcmVkQXQsXG5cdFx0XHRcdFx0dXBkYXRlZEF0OiBEYXRlLm5vdygpXG5cdFx0XHRcdH07XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShsb2NrUGF0aCwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEpKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHRcdH1cblx0XHR9LCAzMDAwMCk7XG5cdH1cblxuXHRwcml2YXRlIHN0b3BIZWFydGJlYXQoKSB7XG5cdFx0aWYgKHRoaXMuaGVhcnRiZWF0VGltZXIpIHtcblx0XHRcdGNsZWFySW50ZXJ2YWwodGhpcy5oZWFydGJlYXRUaW1lcik7XG5cdFx0XHR0aGlzLmhlYXJ0YmVhdFRpbWVyID0gbnVsbDtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBzZWVkU2hhcmVkSW5kZXgoc291cmNlRGlyOiBzdHJpbmcsIHRhcmdldERpcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgbWFuaWZlc3RQYXRoID0gYCR7dGFyZ2V0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRjb25zdCBpbmRleFBhdGggPSBgJHt0YXJnZXREaXJ9L2luZGV4Lmpzb25gO1xuXG5cdFx0Y29uc3QgaXNFbXB0eSA9ICEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtYW5pZmVzdFBhdGgpKSB8fCAhKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoaW5kZXhQYXRoKSk7XG5cdFx0aWYgKCFpc0VtcHR5KSByZXR1cm47XG5cblx0XHRjb25zdCBzb3VyY2VJbmRleCA9IGAke3NvdXJjZURpcn0vaW5kZXguanNvbmA7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoc291cmNlSW5kZXgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHRhcmdldERpcikpKSB7XG5cdFx0XHRcdFx0Ly8gUmVjdXJzaXZlIG1rZGlyXG5cdFx0XHRcdFx0Y29uc3QgcGFydHMgPSB0YXJnZXREaXIuc3BsaXQoJy8nKTtcblx0XHRcdFx0XHRsZXQgY3VycmVudCA9ICcnO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdFx0aWYgKCFwYXJ0KSBjb250aW51ZTtcblx0XHRcdFx0XHRcdGN1cnJlbnQgKz0gKGN1cnJlbnQgPyAnLycgOiAnJykgKyBwYXJ0O1xuXHRcdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQoc291cmNlSW5kZXgpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoaW5kZXhQYXRoLCBjb250ZW50KTtcblxuXHRcdFx0XHRjb25zdCBtYW5pZmVzdCA9IHtcblx0XHRcdFx0XHRzY2hlbWFWZXJzaW9uOiAyLFxuXHRcdFx0XHRcdGVtYmVkZGluZ1Byb2ZpbGU6IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpLFxuXHRcdFx0XHRcdGVuZ2luZTogJ2pzb24nXG5cdFx0XHRcdH07XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtYW5pZmVzdFBhdGgsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcignW0VtYmVkZGluZ3NJbmRleF0gU2VlZGluZyBmYWlsZWQ6JywgZXJyKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogQXRvbWljIG1pZ3JhdGlvbiBmcm9tIGxlZ2FjeSAub2JzaWRpYW4vZW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgvIHRvIG92ZXJ0IEVtYmVkZGluZ3Mvc2hhcmVkLWluZGV4L1xuXHQgKiBSZXR1cm5zIHRydWUgaWYgbWlncmF0aW9uIHN1Y2NlZWRlZCBvciB3YXMgbm90IG5lZWRlZCwgZmFsc2UgaWYgZmFpbGVkLlxuXHQgKi9cblx0YXN5bmMgbWlncmF0ZUZyb21MZWdhY3koKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3Qgb3ZlcnREaXIgPSAnRW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgnO1xuXHRcdGNvbnN0IGxlZ2FjeURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9lbWJlZGRpbmdzL3NoYXJlZC1pbmRleGA7XG5cdFx0Y29uc3Qgb3ZlcnRJbmRleCA9IGAke292ZXJ0RGlyfS9pbmRleC5qc29uYDtcblx0XHRjb25zdCBsZWdhY3lJbmRleCA9IGAke2xlZ2FjeURpcn0vaW5kZXguanNvbmA7XG5cdFx0Y29uc3QgbWlncmF0aW9uTWFya2VyID0gYCR7b3ZlcnREaXJ9Ly5taWdyYXRlZC1mcm9tLWxlZ2FjeWA7XG5cblx0XHR0cnkge1xuXHRcdFx0Ly8gQ2hlY2sgaWYgbWlncmF0aW9uIGlzIG5lZWRlZFxuXHRcdFx0Y29uc3Qgb3ZlcnRFeGlzdHMgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG92ZXJ0SW5kZXgpO1xuXHRcdFx0Y29uc3QgbGVnYWN5RXhpc3RzID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsZWdhY3lJbmRleCk7XG5cblx0XHRcdC8vIElmIG92ZXJ0IGFscmVhZHkgZXhpc3RzIG9yIGxlZ2FjeSBkb2Vzbid0IGV4aXN0LCBubyBtaWdyYXRpb24gbmVlZGVkXG5cdFx0XHRpZiAob3ZlcnRFeGlzdHMgfHwgIWxlZ2FjeUV4aXN0cykge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQ2hlY2sgaWYgYWxyZWFkeSBtaWdyYXRlZFxuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWlncmF0aW9uTWFya2VyKSkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc29sZS5kZWJ1ZygnW0VtYmVkZGluZ3NJbmRleF0gU3RhcnRpbmcgYXRvbWljIG1pZ3JhdGlvbiBmcm9tIGxlZ2FjeSB0byBvdmVydCBmb2xkZXIuLi4nKTtcblxuXHRcdFx0Ly8gRW5zdXJlIG92ZXJ0IGZvbGRlciBleGlzdHNcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMob3ZlcnREaXIpKSkge1xuXHRcdFx0XHRjb25zdCBwYXJ0cyA9IG92ZXJ0RGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0Y3VycmVudCArPSAoY3VycmVudCA/ICcvJyA6ICcnKSArIHBhcnQ7XG5cdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gQWNxdWlyZSB3cml0ZXIgbG9jayBvbiBvdmVydCBmb2xkZXJcblx0XHRcdGNvbnN0IGhhc0xvY2sgPSBhd2FpdCB0aGlzLmFjcXVpcmVMb2NrKG92ZXJ0RGlyKTtcblx0XHRcdGlmICghaGFzTG9jaykge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIExlZ2FjeSBtaWdyYXRpb24gYWJvcnRlZDogY291bGQgbm90IGFjcXVpcmUgbG9jayAocmVhZC1vbmx5IG1vZGUpLicpO1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMTogQ29weSBsZWdhY3kgZmlsZXMgdG8gLnRtcCB2ZXJzaW9uc1xuXHRcdFx0Y29uc3QgbGVnYWN5Q29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxlZ2FjeUluZGV4KTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShgJHtvdmVydEluZGV4fS50bXBgLCBsZWdhY3lDb250ZW50KTtcblxuXHRcdFx0Y29uc3QgbGVnYWN5TWFuaWZlc3QgPSBgJHtsZWdhY3lEaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdFx0Y29uc3Qgb3ZlcnRNYW5pZmVzdCA9IGAke292ZXJ0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRcdGxldCBoYXNNYW5pZmVzdCA9IGZhbHNlO1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobGVnYWN5TWFuaWZlc3QpKSB7XG5cdFx0XHRcdGNvbnN0IG1hbmlmZXN0Q29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxlZ2FjeU1hbmlmZXN0KTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGAke292ZXJ0TWFuaWZlc3R9LnRtcGAsIG1hbmlmZXN0Q29udGVudCk7XG5cdFx0XHRcdGhhc01hbmlmZXN0ID0gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCAyOiBSZW5hbWUgLnRtcCB0byBjYW5vbmljYWwgKGF0b21pYyBjb21taXQpXG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGAke292ZXJ0SW5kZXh9LnRtcGAsIG92ZXJ0SW5kZXgpO1xuXHRcdFx0aWYgKGhhc01hbmlmZXN0KSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW5hbWUoYCR7b3ZlcnRNYW5pZmVzdH0udG1wYCwgb3ZlcnRNYW5pZmVzdCk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMzogV3JpdGUgbWlncmF0aW9uIG1hcmtlclxuXHRcdFx0Y29uc3QgbWFya2VyQ29udGVudCA9IEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0bWlncmF0ZWRBdDogRGF0ZS5ub3coKSxcblx0XHRcdFx0ZnJvbTogbGVnYWN5RGlyXG5cdFx0XHR9LCBudWxsLCAyKTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtaWdyYXRpb25NYXJrZXIsIG1hcmtlckNvbnRlbnQpO1xuXG5cdFx0XHQvLyBTdGVwIDQ6IERpc2FibGUgbGVnYWN5IGJ5IHJlbmFtaW5nXG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGxlZ2FjeUluZGV4LCBgJHtsZWdhY3lJbmRleH0ubWlncmF0ZWRgKTtcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxlZ2FjeU1hbmlmZXN0KSkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGxlZ2FjeU1hbmlmZXN0LCBgJHtsZWdhY3lNYW5pZmVzdH0ubWlncmF0ZWRgKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc29sZS5kZWJ1ZygnW0VtYmVkZGluZ3NJbmRleF0gQXRvbWljIG1pZ3JhdGlvbiBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LicpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIExlZ2FjeSBtaWdyYXRpb24gZmFpbGVkOyBmYWxsaW5nIGJhY2sgdG8gaXNvbGF0ZWQuJywgZXJyKTtcblxuXHRcdFx0Ly8gQ2xlYW51cCB0ZW1wIGZpbGVzIGJlc3QtZWZmb3J0XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhgJHtvdmVydEluZGV4fS50bXBgKSkge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUoYCR7b3ZlcnRJbmRleH0udG1wYCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoYCR7b3ZlcnREaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb24udG1wYCkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVtb3ZlKGAke292ZXJ0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uLnRtcGApO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc29sZS5kZWJ1ZygnW0VtYmVkZGluZ3NJbmRleF0gVGVtcCBmaWxlIGNsZWFudXAgZmFpbGVkIChub24tY3JpdGljYWwpOicsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBnZXRJbmRleEZpbGVQYXRoKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRyZXR1cm4gYCR7ZGlyfS9pbmRleC5qc29uYDtcblx0fVxuXG5cdGFzeW5jIGNsZWFySW5kZXgoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IHt9O1xuXHRcdGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuXHRcdGNvbnN0IHBhdGggPSBhd2FpdCB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkge1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShwYXRoKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMubG9hZGVkKSByZXR1cm47XG5cdFx0dGhpcy5sb2FkZWQgPSB0cnVlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdC8vIFN0ZXAgMTogRGV0ZXJtaW5lIG1vZGUgYW5kIGF0dGVtcHQgbWlncmF0aW9uIGluIGF1dG8gbW9kZVxuXHRcdFx0Y29uc3QgbW9kZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLmVtYmVkZGluZ1N0b3JhZ2VNb2RlIHx8ICdpc29sYXRlZCc7XG5cdFx0XHRpZiAobW9kZSA9PT0gJ2F1dG8nKSB7XG5cdFx0XHRcdC8vIEF0dGVtcHQgbGVnYWN5IG1pZ3JhdGlvbiBCRUZPUkUgcmVzb2x2aW5nIGZpbmFsIGRpclxuXHRcdFx0XHRjb25zdCBtaWdyYXRpb25TdWNjZXNzID0gYXdhaXQgdGhpcy5taWdyYXRlRnJvbUxlZ2FjeSgpO1xuXHRcdFx0XHRpZiAoIW1pZ3JhdGlvblN1Y2Nlc3MpIHtcblx0XHRcdFx0XHQvLyBNaWdyYXRpb24gZmFpbGVkIChsb2NrZWQgYnkgb3RoZXIgcGx1Z2luIG9yIGVycm9yKSAtIGZhbGwgYmFjayB0byBpc29sYXRlZFxuXHRcdFx0XHRcdHRoaXMuY3VycmVudFN0b3JhZ2VNb2RlID0gJ2lzb2xhdGVkJztcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIEF1dG8gbW9kZTogbWlncmF0aW9uIGZhaWxlZCwgdXNpbmcgaXNvbGF0ZWQgbW9kZS4nKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDI6IFJlc29sdmUgaW5kZXggZGlyZWN0b3J5XG5cdFx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXG5cdFx0XHQvLyBTdGVwIDM6IFZhbGlkYXRlIG1hbmlmZXN0XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhbGlkYXRlTWFuaWZlc3QoZGlyKSkpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBNYW5pZmVzdCBtaXNtYXRjaDsgZmFsbGluZyBiYWNrIHRvIGlzb2xhdGVkIG1vZGUnKTtcblx0XHRcdFx0dGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgPSAnaXNvbGF0ZWQnOyAvLyBJbnRlcm5hbCBvdmVycmlkZSBmb3IgdGhpcyBzZXNzaW9uXG5cdFx0XHRcdC8vIFJlLXJlc29sdmUgcGF0aCBhZnRlciBmYWxsYmFja1xuXHRcdFx0XHRjb25zdCBuZXdEaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG5ld0RpcikpKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKG5ld0Rpcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCA0OiBJbiBhdXRvL21hbnVhbCwgYWNxdWlyZSBsb2NrIGFuZCBzZWVkIGlmIG5lZWRlZFxuXHRcdFx0Y29uc3QgcmVzb2x2ZWRNb2RlID0gdGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgfHwgbW9kZTtcblx0XHRcdGlmIChyZXNvbHZlZE1vZGUgIT09ICdpc29sYXRlZCcpIHtcblx0XHRcdFx0Y29uc3Qgc291cmNlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHRcdFx0YXdhaXQgdGhpcy5zZWVkU2hhcmVkSW5kZXgoc291cmNlRGlyLCBkaXIpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLmFjcXVpcmVMb2NrKGRpcik7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChwYXRoKTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRJbmRleFYxO1xuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJykge1xuXHRcdFx0XHR0aGlzLmRpbSA9IHBhcnNlZC5kaW07XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHBlY3RlZENodW5raW5nID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcblx0XHRcdFx0KHBhcnNlZC5jaHVua2luZy5oZWFkaW5nTGV2ZWwgIT09IGV4cGVjdGVkQ2h1bmtpbmcuaGVhZGluZ0xldmVsIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXG5cdFx0XHQpIHtcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XG5cdFx0XHRcdGlmICghY2h1bms/LmtleSB8fCAhY2h1bms/LnBhdGggfHwgIUFycmF5LmlzQXJyYXkoY2h1bmsudmVjdG9yKSkgY29udGludWU7XG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcblx0XHRcdH1cblx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0Ly8gQ29ycnVwdCBpbmRleCBzaG91bGQgbm90IGJyZWFrIHRoZSBwbHVnaW4uIFdlJ2xsIHJlYnVpbGQgbGF6aWx5LlxuXHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gQ29ycnVwdCBpbmRleCBkYXRhIGRldGVjdGVkLCByZWJ1aWxkaW5nIGZyb20gc2NyYXRjaDonLCBlcnIpO1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHR9XG5cdH1cblxuXHRnZXRTdGF0dXMoKTogeyBpbmRleGVkRmlsZXM6IG51bWJlcjsgaW5kZXhlZENodW5rczogbnVtYmVyOyBwYXVzZWQ6IGJvb2xlYW47IHF1ZXVlZDogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXG5cdFx0XHRpbmRleGVkQ2h1bmtzOiB0aGlzLmNodW5rc0J5S2V5LnNpemUsXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcblx0XHR9O1xuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IEVycm9yTG9nRW50cnlbXSB7XG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcblx0fVxuXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xuXHRcdGNvbnN0IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcblx0XHRmb3IgKGNvbnN0IGVyciBvZiB0aGlzLmVycm9yTG9nKSB7XG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcblx0XHRcdGJ5TG9jYXRpb24sXG5cdFx0XHRyZWNlbnQ6IHRoaXMuZXJyb3JMb2cuc2xpY2UoLTEwKVxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXG5cdFx0Y29uc3QgZW50cnk6IEVycm9yTG9nRW50cnkgPSB7XG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGxvY2F0aW9uLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXG5cdFx0XHRlcnJvclR5cGVcblx0XHR9O1xuXG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblxuXHRcdC8vIEFsc28gbG9nIHRvIGNvbnNvbGUgZm9yIGRlYnVnZ2luZ1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcblx0XHR9XG5cdH1cblxuXHRlbnF1ZXVlRnVsbFJlc2NhbigpOiB2b2lkIHtcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0cXVldWVVcGRhdGVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUmVidWlsZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVSZWJ1aWxkKCk6IHZvaWQge1xuXHRcdGNvbnN0IHBvbGljeSA9IENPX0FVVEhPUklOR19QT0xJQ1kuUEVSRk9STUFOQ0U7XG5cdFx0aWYgKHRoaXMucmVidWlsZFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucmVidWlsZFRpbWVyKTtcblx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucmVidWlsZFRpbWVyID0gbnVsbDtcblx0XHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0XHR9LCBwb2xpY3kuUkVCVUlMRF9RVUVVRV9ERUJPVU5DRV9NUyk7XG5cdH1cblxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy53b3JrZXJSdW5uaW5nKSByZXR1cm47XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXG5cdFx0dm9pZCB0aGlzLl9ydW5Xb3JrZXIoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXG5cdFx0aWYgKHRoaXMuaXNSZWFkT25seSkge1xuXHRcdFx0Y29uc29sZS5kZWJ1ZygnW0VtYmVkZGluZ3NJbmRleF0gU2hhcmVkIGluZGV4IGxvY2tlZDsgb3BlcmF0aW5nIHJlYWQtb25seS4nKTtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHBvbGljeSA9IENPX0FVVEhPUklOR19QT0xJQ1kuUEVSRk9STUFOQ0U7XG5cdFx0Y29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblx0XHRjb25zdCB0b3RhbEZpbGVzID0gdGhpcy5xdWV1ZS5zaXplO1xuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xuXG5cdFx0Ly8gRW1pdCBzdGFydCBldmVudCBhbmQgbm90aWZpY2F0aW9uXG5cdFx0aWYgKHRvdGFsRmlsZXMgPiAwKSB7XG5cdFx0XHRuZXcgTm90aWNlKGBTdGFydGluZyBpbmRleCBzY2FuICgke3RvdGFsRmlsZXN9IGZpbGVzKS4uLmApO1xuXHRcdFx0cmVsYXlFdmVudEJ1cy5lbWl0KCdpbmRleDpzdGFydCcsIHsgdG90YWxGaWxlcyB9KTtcblx0XHR9XG5cblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCAmJiBpbmRleGVkQ291bnQgPCBwb2xpY3kuTUFYX1JFQlVJTERTX1BFUl9CQVRDSCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEVtaXQgcHJvZ3Jlc3MgZXZlcnkgMTAgZmlsZXNcblx0XHRcdGlmIChwcm9jZXNzZWRDb3VudCAlIDEwID09PSAwKSB7XG5cdFx0XHRcdG5ldyBOb3RpY2UoYEluZGV4aW5nLi4uICR7cHJvY2Vzc2VkQ291bnR9LyR7dG90YWxGaWxlc30gZmlsZXNgKTtcblx0XHRcdFx0cmVsYXlFdmVudEJ1cy5lbWl0KCdpbmRleDpwcm9ncmVzcycsIHsgcHJvY2Vzc2VkOiBwcm9jZXNzZWRDb3VudCwgdG90YWw6IHRvdGFsRmlsZXMsIGN1cnJlbnRGaWxlOiBuZXh0IH0pO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKG5leHQpKSB7XG5cdFx0XHRcdHNraXBwZWRFeGNsdWRlZCsrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcblx0XHRcdC8vIE9ubHkgaW5kZXggbWFya2Rvd24gZmlsZXMuXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSB7XG5cdFx0XHRcdHNraXBwZWROb3RNYXJrZG93bisrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gbm9ybWFsaXplQ2h1bmtUZXh0KGNvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBmaWxlSGFzaCA9IGF3YWl0IHNoYTI1Nihub3JtYWxpemVkQ29udGVudCk7XG5cdFx0XHRcdGNvbnN0IHByZXYgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bbmV4dF07XG5cdFx0XHRcdGNvbnN0IGlzQ3VycmVudGx5SW5kZXhlZCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmhhcyhuZXh0KTtcblxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gQ2FsY3VsYXRlIGR1cmF0aW9uIGFuZCBlbWl0IGNvbXBsZXRpb25cblx0XHRjb25zdCBkdXJhdGlvbiA9IChEYXRlLm5vdygpIC0gc3RhcnRUaW1lKSAvIDEwMDA7XG5cdFx0Y29uc3QgdG90YWxTa2lwcGVkID0gc2tpcHBlZEV4Y2x1ZGVkICsgc2tpcHBlZE5vdE1hcmtkb3duICsgc2tpcHBlZEhhc2hNYXRjaDtcblxuXHRcdC8vIExvZyBpbmRleGluZyBzdGF0cyBmb3IgZGVidWdnaW5nXG5cdFx0aWYgKHByb2Nlc3NlZENvdW50ID4gMCkge1xuXHRcdFx0Y29uc29sZS5kZWJ1ZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHRcdG5ldyBOb3RpY2UoYEluZGV4ZWQgJHtpbmRleGVkQ291bnR9IGZpbGVzIGluICR7ZHVyYXRpb24udG9GaXhlZCgxKX1zICgke3RoaXMuY2h1bmtzQnlLZXkuc2l6ZX0gY2h1bmtzIHRvdGFsKWApO1xuXHRcdFx0cmVsYXlFdmVudEJ1cy5lbWl0KCdpbmRleDpjb21wbGV0ZScsIHtcblx0XHRcdFx0aW5kZXhlZDogaW5kZXhlZENvdW50LFxuXHRcdFx0XHRjaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSxcblx0XHRcdFx0ZHVyYXRpb24sXG5cdFx0XHRcdHNraXBwZWQ6IHRvdGFsU2tpcHBlZFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdGNvbnN0IGNodW5rcyA9IGJ1aWxkSW5kZXhDaHVua3Moe1xuXHRcdFx0dGV4dDogY29udGVudCxcblx0XHRcdGhlYWRpbmdMZXZlbDogY2ZnLmhlYWRpbmdMZXZlbCxcblx0XHRcdHRhcmdldFdvcmRzOiBjZmcudGFyZ2V0V29yZHMsXG5cdFx0XHRvdmVybGFwV29yZHM6IGNmZy5vdmVybGFwV29yZHNcblx0XHR9KTtcblxuXHRcdC8vIElmIG5vIGNodW5rcyBjcmVhdGVkLCBza2lwIHRoaXMgZmlsZSAobWlnaHQgYmUgdG9vIHNob3J0IG9yIGhhdmUgbm8gaGVhZGluZ3MpXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gTm8gY2h1bmtzIGNyZWF0ZWQgZm9yICR7cGF0aH0gLSBmaWxlIHRvbyBzaG9ydCBvciBubyBoZWFkaW5ncyBtYXRjaCBjaHVua2luZyBjb25maWdgKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgY2ggPSBjaHVua3NbaV07XG5cdFx0XHRjb25zdCBub3JtYWxpemVkVGV4dCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjaC50ZXh0KTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRUZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXG5cdFx0XHQvLyBTdG9yZSBjaHVua3Mgd2l0aCBhbiBlbXB0eSB2ZWN0b3I7IGV4dGVybmFsIGVtYmVkZGluZ3MgYXJlIHJlc29sdmVkIGF0IHF1ZXJ5IHRpbWVcblx0XHRcdC8vIGJ5IEV4dGVybmFsRW1iZWRkaW5nc1Byb3ZpZGVyLCBub3QgcHJlLWNvbXB1dGVkIGhlcmUuXG5cdFx0XHRjb25zdCBleGNlcnB0ID0gZXhjZXJwdE9mKGNoLnRleHQsIDI1MDApO1xuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xuXHRcdFx0XHRrZXksXG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXG5cdFx0XHRcdHN0YXJ0V29yZDogY2guc3RhcnRXb3JkLFxuXHRcdFx0XHRlbmRXb3JkOiBjaC5lbmRXb3JkLFxuXHRcdFx0XHR0ZXh0SGFzaCxcblx0XHRcdFx0dmVjdG9yOiBbXSxcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0Y29uc29sZS5kZWJ1ZyhgW0VtYmVkZGluZ3NJbmRleF0gSW5kZXhlZCAke3BhdGh9OiAke2NodW5rcy5sZW5ndGh9IGNodW5rc2ApO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ29tcHV0ZXMgYSBiaXQtcGVyZmVjdCBjb3JwdXMgaGFzaCBmb3Igc3RyaWN0IHJlcGxheS5cblx0ICogc2hhMjU2KGpvaW4oc29ydChjaHVua19pZCArIFwiOlwiICsgY29udGVudF9oYXNoKSwgXCJcXG5cIikpXG5cdCAqL1xuXHRhc3luYyBnZXRDb3JwdXNIYXNoKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgY2h1bmtzID0gdGhpcy5nZXRBbGxDaHVua3MoKTtcblx0XHRjb25zdCBsaW5lcyA9IGNodW5rcy5tYXAoYyA9PiBgJHtjLmtleX06JHtjLnRleHRIYXNofWApO1xuXHRcdGxpbmVzLnNvcnQoKTtcblx0XHRjb25zdCBqb2luZWQgPSBsaW5lcy5qb2luKCdcXG4nKTtcblx0XHRyZXR1cm4gYXdhaXQgc2hhMjU2KGpvaW5lZCk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2tzIGlmIGEgcGF0aCBpcyBjdXJyZW50bHkgbWFya2VkIGFzIHN0YWxlIGluIHRoZSBpbmRleCBzdGF0ZS5cblx0ICovXG5cdGlzU3RhbGUocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0Y29uc3Qgc3RhdGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF07XG5cdFx0aWYgKCFzdGF0ZSkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuXHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybiB0cnVlOyAvLyBNaXNzaW5nIGZpbGUgaXMgZWZmZWN0aXZlbHkgc3RhbGVcblxuXHRcdC8vIElmIHVwZGF0ZWRBdCBpcyBub3Qgc2V0LCB3ZSBjYW4ndCBiZSBzdXJlLCBhc3N1bWUgbm90IHN0YWxlIGZvciBub3dcblx0XHRpZiAoIXN0YXRlLnVwZGF0ZWRBdCkgcmV0dXJuIGZhbHNlO1xuXG5cdFx0Y29uc3QgZmlsZU10aW1lID0gZmlsZS5zdGF0Lm10aW1lO1xuXHRcdGNvbnN0IGluZGV4VGltZSA9IG5ldyBEYXRlKHN0YXRlLnVwZGF0ZWRBdCkuZ2V0VGltZSgpO1xuXG5cdFx0cmV0dXJuIGZpbGVNdGltZSA+IGluZGV4VGltZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxuXHQgKi9cblx0cXVldWVSZWNoZWNrQWxsSW5kZXhlZCgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0Z2V0VmVjdG9yRm9yS2V5KGtleTogc3RyaW5nKTogbnVtYmVyW10gfCBudWxsIHtcblx0XHRjb25zdCBjaCA9IHRoaXMuY2h1bmtzQnlLZXkuZ2V0KGtleSk7XG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcblx0fVxuXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XG5cdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBidWlsZFF1ZXJ5VmVjdG9yIGNhbGxlZDsgcmV0dXJuaW5nIGVtcHR5IHZlY3Rvci4gVXNlIEV4dGVybmFsRW1iZWRkaW5nc1Byb3ZpZGVyIGZvciBxdWVyeSBlbWJlZGRpbmcuJyk7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmlzUmVhZE9ubHkpIHtcblx0XHRcdGNvbnNvbGUuZGVidWcoJ1tFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIHBlcnNpc3RlbmNlOiBSZWFkLU9ubHkgbW9kZScpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0Ly8gUmVjdXJzaXZlIG1rZGlyXG5cdFx0XHRcdGNvbnN0IHBhcnRzID0gZGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0Y3VycmVudCArPSAoY3VycmVudCA/ICcvJyA6ICcnKSArIHBhcnQ7XG5cdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gRmFpbGVkIHRvIGNyZWF0ZSBpbmRleCBkaXJlY3Rvcnk6JywgZXJyKTtcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiAnZXh0ZXJuYWwnLFxuXHRcdFx0Y2h1bmtpbmc6IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKSxcblx0XHRcdGNodW5rczogdGhpcy5nZXRBbGxDaHVua3MoKVxuXHRcdH07XG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpLCBKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG5cblx0XHQvLyBFbnN1cmUgbWFuaWZlc3QgZXhpc3RzIGluIHRoZSBpbmRleCBkaXJlY3Rvcnlcblx0XHRjb25zdCBtYW5pZmVzdFBhdGggPSBgJHtkaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkpIHtcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0ge1xuXHRcdFx0XHRzY2hlbWFWZXJzaW9uOiAyLFxuXHRcdFx0XHRlbWJlZGRpbmdQcm9maWxlOiB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKSxcblx0XHRcdFx0ZW5naW5lOiAnanNvbidcblx0XHRcdH07XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobWFuaWZlc3RQYXRoLCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG59XG4iXX0=