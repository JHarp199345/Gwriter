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
        .replace(/\r\n/g, '\n') // Normalize newlines
        .replace(/\r/g, '\n')
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
    constructor(vault, plugin, embeddingProvider) {
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
        // Circuit breaker for AI embedding failures
        this.aiErrorStreak = 0;
        this.AI_ERROR_STREAK_THRESHOLD = 3;
        this.AI_PAUSE_DURATION_MS = 15000;
        // Shared Brain state
        this.isReadOnly = false;
        this.heartbeatTimer = null;
        this.currentStorageMode = null;
        this.lockAcquiredAt = null; // Preserve for heartbeat
        this.vault = vault;
        this.plugin = plugin;
        this.backend = 'ollama';
        this.embeddingProvider = embeddingProvider;
        this.dim = 0;
    }
    /**
     * Hot-swaps the embedding provider (e.g. when user changes models).
     */
    updateProvider(provider) {
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
                }
                catch {
                    // JSON parse failed - do not delete (could be another plugin's lock)
                }
            }
        }
        catch {
            // ignore filesystem errors
        }
    }
    /**
     * Returns the canonical embedding profile (single source of truth).
     * Used for handshake files, manifest validation, and profile matching.
     */
    getEmbeddingProfile() {
        return {
            provider: 'ollama',
            modelId: this.plugin.settings.relayEmbeddingModel,
            dimensions: this.dim || 768,
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
            mine.dimensions === other.dimensions &&
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
            console.log('[EmbeddingsIndex] Starting atomic migration from legacy to overt folder...');
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
            console.log('[EmbeddingsIndex] ✓ Atomic migration completed successfully.');
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
            catch {
                // ignore cleanup errors
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
            if (parsed.backend && parsed.backend !== this.backend) {
                // Backend mismatch: ignore persisted index and rebuild.
                this.enqueueFullRescan();
                return;
            }
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
        catch {
            // Corrupt index should not break the plugin. We'll rebuild lazily.
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
            console.log('[EmbeddingsIndex] Shared index locked; operating read-only.');
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
            console.log(`[EmbeddingsIndex] Processed ${processedCount} files: ${indexedCount} indexed, ${skippedExcluded} excluded, ${skippedNotMarkdown} not markdown, ${skippedHashMatch} hash match (already indexed)`);
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
    async _reindexFile(path, content) {
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
        let firstError = null;
        for (let i = 0; i < chunks.length; i++) {
            const ch = chunks[i];
            const normalizedText = normalizeChunkText(ch.text);
            const textHash = await sha256(normalizedText);
            const key = `chunk:${path}:${i}`;
            let vector;
            try {
                console.log(`  - Generating embedding for chunk ${i + 1}/${chunks.length} (${ch.text.split(/\s+/).length} words)...`);
                const embedStart = Date.now();
                vector = await this.embeddingProvider.getEmbedding(normalizedText);
                this.aiErrorStreak = 0; // Success: reset streak
                if (!Array.isArray(vector) || vector.length === 0) {
                    throw new Error('Empty embedding returned from Ollama');
                }
                if (this.dim === 0) {
                    this.dim = vector.length;
                }
                const embedDuration = Date.now() - embedStart;
                console.log(`  - ✓ Ollama embedding generated in ${embedDuration}ms: ${vector.length} dimensions`);
            }
            catch (err) {
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
            }
            else {
                this.logError('_reindexFile.allChunksFailed', criticalContext, new Error('All chunks failed but no first error captured'));
            }
        }
        else if (successfulChunks < chunks.length) {
            console.warn(`[EmbeddingsIndex] Partial success for ${path}: ${successfulChunks}/${chunks.length} chunks indexed`);
        }
        else {
            console.log(`[EmbeddingsIndex] ✓ Successfully indexed ${path}: ${successfulChunks} chunks`);
        }
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
        console.warn('[EmbeddingsIndex] buildQueryVector called; returning empty vector. Use embedQueryVector instead.');
        return [];
    }
    async embedQueryVector(queryText) {
        const vec = await this.embeddingProvider.getEmbedding(queryText);
        if (!Array.isArray(vec) || vec.length === 0) {
            throw new Error('Empty embedding returned from Ollama');
        }
        return vec;
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
            console.log('[EmbeddingsIndex] Skipping persistence: Read-Only mode');
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
        catch {
            // ignore mkdir failures
        }
        const payload = {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBRXpDLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUM5QyxPQUFPLEVBQVcsTUFBTSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFakQsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2hELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFhNUM7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFB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UUFDaEQsTUFBTSxZQUFZLEdBQUcsR0FBRyxHQUFHLHNCQUFzQixDQUFDO1FBQ2xELElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN0RCxNQUFNLFFBQVEsR0FBRztnQkFDaEIsYUFBYSxFQUFFLENBQUM7Z0JBQ2hCLGdCQUFnQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsRUFBRTtnQkFDNUMsTUFBTSxFQUFFLE1BQU07YUFDZCxDQUFDO1lBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pGLENBQUM7SUFDRixDQUFDO0lBRU8scUJBQXFCO1FBQzVCLElBQUksSUFBSSxDQUFDLGlCQUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBURmlsZSwgTm90aWNlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5pbXBvcnQgeyBmbnYxYTMyLCBzaGEyNTYgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XG5pbXBvcnQgeyBPbGxhbWFFbWJlZGRpbmdQcm92aWRlciB9IGZyb20gJy4vT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXInO1xuaW1wb3J0IHsgQ09fQVVUSE9SSU5HX1BPTElDWSB9IGZyb20gJy4uL3BvbGljeSc7XG5pbXBvcnQgeyByZWxheUV2ZW50QnVzIH0gZnJvbSAnLi4vRXZlbnRCdXMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XG5cdGtleTogc3RyaW5nO1xuXHRwYXRoOiBzdHJpbmc7XG5cdGNodW5rSW5kZXg6IG51bWJlcjtcblx0c3RhcnRXb3JkOiBudW1iZXI7XG5cdGVuZFdvcmQ6IG51bWJlcjtcblx0dGV4dEhhc2g6IHN0cmluZzsgLy8gU0hBLTI1NlxuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RhYmxlIG5vcm1hbGl6YXRpb24gZm9yIGJpdC1wZXJmZWN0IGhhc2ggY29udGludWl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNodW5rVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC50cmltKClcblx0XHQucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKSAvLyBOb3JtYWxpemUgbmV3bGluZXNcblx0XHQucmVwbGFjZSgvXFxyL2csICdcXG4nKVxuXHRcdC5yZXBsYWNlKC9bIFxcdF0rL2csICcgJyk7IC8vIE5vcm1hbGl6ZSBzcGFjZXMvdGFic1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkSW5kZXhWMSB7XG5cdHZlcnNpb246IDE7XG5cdGRpbTogbnVtYmVyO1xuXHRiYWNrZW5kOiAnb2xsYW1hJztcblx0Y2h1bmtpbmc/OiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9O1xuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xufVxuXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XG5cdHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgTWF0aC5mbG9vcih2YWx1ZSkpKTtcbn1cblxuZnVuY3Rpb24gY2h1bmtpbmdLZXkocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfSB7XG5cdHJldHVybiB7XG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcblx0XHR0YXJnZXRXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rV29yZHMgPz8gNTAwLCAyMDAsIDIwMDApLFxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxuXHR9O1xufVxuXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XG59XG5cbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgZGltOiBudW1iZXI7XG5cdHByaXZhdGUgcmVhZG9ubHkgYmFja2VuZDogJ29sbGFtYSc7XG5cdHByaXZhdGUgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyO1xuXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xuXHRwcml2YXRlIGNodW5rS2V5c0J5UGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdHByaXZhdGUgd29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHJlYnVpbGRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcGVyc2lzdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gRXJyb3IgdHJhY2tpbmdcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xuXHRcblx0Ly8gQ2lyY3VpdCBicmVha2VyIGZvciBBSSBlbWJlZGRpbmcgZmFpbHVyZXNcblx0cHJpdmF0ZSBhaUVycm9yU3RyZWFrID0gMDtcblx0cHJpdmF0ZSByZWFkb25seSBBSV9FUlJPUl9TVFJFQUtfVEhSRVNIT0xEID0gMztcblx0cHJpdmF0ZSByZWFkb25seSBBSV9QQVVTRV9EVVJBVElPTl9NUyA9IDE1MDAwO1xuXG5cdC8vIFNoYXJlZCBCcmFpbiBzdGF0ZVxuXHRwcml2YXRlIGlzUmVhZE9ubHkgPSBmYWxzZTtcblx0cHJpdmF0ZSBoZWFydGJlYXRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgY3VycmVudFN0b3JhZ2VNb2RlOiAnaXNvbGF0ZWQnIHwgJ2F1dG8nIHwgJ21hbnVhbCcgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBsb2NrQWNxdWlyZWRBdDogbnVtYmVyIHwgbnVsbCA9IG51bGw7IC8vIFByZXNlcnZlIGZvciBoZWFydGJlYXRcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyKSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHRcdHRoaXMuYmFja2VuZCA9ICdvbGxhbWEnO1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBlbWJlZGRpbmdQcm92aWRlcjtcblx0XHR0aGlzLmRpbSA9IDA7XG5cdH1cblxuXHQvKipcblx0ICogSG90LXN3YXBzIHRoZSBlbWJlZGRpbmcgcHJvdmlkZXIgKGUuZy4gd2hlbiB1c2VyIGNoYW5nZXMgbW9kZWxzKS5cblx0ICovXG5cdHVwZGF0ZVByb3ZpZGVyKHByb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBwcm92aWRlcjtcblx0fVxuXG5cdGFzeW5jIG9udW5sb2FkKCkge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdC8vIFJlbW92ZSBsb2NrIG9ubHkgaWYgd2Ugb3duIGl0IChKU09OIGZvcm1hdCBjaGVjaylcblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdGNvbnN0IGxvY2tQYXRoID0gYCR7ZGlyfS9pbmRleC5sb2NrYDtcblx0XHR0cnkge1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobG9ja1BhdGgpKSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxvY2tQYXRoKTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCBsb2NrID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHRcdGlmIChsb2NrLmhvbGRlciA9PT0gJ3dyaXRpbmctZGFzaGJvYXJkJykge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShsb2NrUGF0aCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBKU09OIHBhcnNlIGZhaWxlZCAtIGRvIG5vdCBkZWxldGUgKGNvdWxkIGJlIGFub3RoZXIgcGx1Z2luJ3MgbG9jaylcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlIGZpbGVzeXN0ZW0gZXJyb3JzXG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFJldHVybnMgdGhlIGNhbm9uaWNhbCBlbWJlZGRpbmcgcHJvZmlsZSAoc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCkuXG5cdCAqIFVzZWQgZm9yIGhhbmRzaGFrZSBmaWxlcywgbWFuaWZlc3QgdmFsaWRhdGlvbiwgYW5kIHByb2ZpbGUgbWF0Y2hpbmcuXG5cdCAqL1xuXHRnZXRFbWJlZGRpbmdQcm9maWxlKCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRwcm92aWRlcjogJ29sbGFtYScgYXMgY29uc3QsXG5cdFx0XHRtb2RlbElkOiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZWxheUVtYmVkZGluZ01vZGVsLFxuXHRcdFx0ZGltZW5zaW9uczogdGhpcy5kaW0gfHwgNzY4LFxuXHRcdFx0bm9ybWFsaXplOiB0cnVlLFxuXHRcdFx0Y2h1bmtpbmdWZXJzaW9uOiAyLFxuXHRcdFx0c2NoZW1hVmVyc2lvbjogMlxuXHRcdH07XG5cdH1cblxuXHRhc3luYyByZXNvbHZlSW5kZXhEaXIoKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBtb2RlID0gdGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgfHwgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZW1iZWRkaW5nU3RvcmFnZU1vZGUgfHwgJ2lzb2xhdGVkJztcblxuXHRcdGlmIChtb2RlID09PSAnaXNvbGF0ZWQnKSB7XG5cdFx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR9XG5cblx0XHRpZiAobW9kZSA9PT0gJ21hbnVhbCcpIHtcblx0XHRcdGNvbnN0IG1hbnVhbFBhdGggPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tYW51YWxTaGFyZWRQYXRoO1xuXHRcdFx0aWYgKG1hbnVhbFBhdGgpIHJldHVybiBtYW51YWxQYXRoO1xuXHRcdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0fVxuXG5cdFx0Ly8gYXV0byBtb2RlXG5cdFx0Y29uc3Qgc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGggPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vZW1iZWRkaW5ncy9oYW5kc2hha2Uvc3RvcnktY2FudmFzLW9ic2VydmVyLmpzb25gO1xuXHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHN0b3J5Ym9hcmRIYW5kc2hha2VQYXRoKSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQoc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGgpO1xuXHRcdFx0XHRjb25zdCBzdG9yeWJvYXJkID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHRpZiAodGhpcy5wcm9maWxlc01hdGNoKHN0b3J5Ym9hcmQuZW1iZWRkaW5nUHJvZmlsZSkpIHtcblx0XHRcdFx0XHRyZXR1cm4gJ0VtYmVkZGluZ3Mvc2hhcmVkLWluZGV4Jztcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIFNoYXJlZCBpbmRleCBkaXNhYmxlZDogZW1iZWRkaW5nIHByb2ZpbGVzIGRvIG5vdCBtYXRjaCBzdG9yeWJvYXJkJyk7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKCdbRW1iZWRkaW5nc0luZGV4XSBGYWlsZWQgdG8gcmVhZCBzdG9yeWJvYXJkIGhhbmRzaGFrZTonLCBlcnIpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHR9XG5cblx0cHJpdmF0ZSBwcm9maWxlc01hdGNoKG90aGVyOiBhbnkpOiBib29sZWFuIHtcblx0XHRjb25zdCBtaW5lID0gdGhpcy5nZXRFbWJlZGRpbmdQcm9maWxlKCk7XG5cdFx0cmV0dXJuIChcblx0XHRcdG1pbmUucHJvdmlkZXIgPT09IG90aGVyLnByb3ZpZGVyICYmXG5cdFx0XHRtaW5lLm1vZGVsSWQgPT09IG90aGVyLm1vZGVsSWQgJiZcblx0XHRcdG1pbmUuZGltZW5zaW9ucyA9PT0gb3RoZXIuZGltZW5zaW9ucyAmJlxuXHRcdFx0bWluZS5ub3JtYWxpemUgPT09IG90aGVyLm5vcm1hbGl6ZSAmJlxuXHRcdFx0bWluZS5jaHVua2luZ1ZlcnNpb24gPT09IG90aGVyLmNodW5raW5nVmVyc2lvbiAmJlxuXHRcdFx0bWluZS5zY2hlbWFWZXJzaW9uID09PSBvdGhlci5zY2hlbWFWZXJzaW9uXG5cdFx0KTtcblx0fVxuXG5cdGFzeW5jIHZhbGlkYXRlTWFuaWZlc3QoZGlyOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBtYW5pZmVzdFBhdGggPSBgJHtkaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkpIHJldHVybiB0cnVlOyAvLyBObyBtYW5pZmVzdCB5ZXRcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChtYW5pZmVzdFBhdGgpO1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKHJhdyk7XG5cdFx0XHRyZXR1cm4gdGhpcy5wcm9maWxlc01hdGNoKG1hbmlmZXN0LmVtYmVkZGluZ1Byb2ZpbGUpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGFjcXVpcmVMb2NrKGRpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3QgbG9ja1BhdGggPSBgJHtkaXJ9L2luZGV4LmxvY2tgO1xuXHRcdGNvbnN0IG15SWQgPSAnd3JpdGluZy1kYXNoYm9hcmQnO1xuXHRcdGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG5cblx0XHR0cnkge1xuXHRcdFx0bGV0IGV4aXN0aW5nTG9jazogeyBob2xkZXI6IHN0cmluZzsgYWNxdWlyZWRBdDogbnVtYmVyOyB1cGRhdGVkQXQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG5cblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxvY2tQYXRoKSkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsb2NrUGF0aCk7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0ZXhpc3RpbmdMb2NrID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBJbnZhbGlkIEpTT04gKGxlZ2FjeSBzdHJpbmcgZm9ybWF0KSAtIHRyZWF0IGFzIHN0YWxlXG5cdFx0XHRcdFx0ZXhpc3RpbmdMb2NrID0gbnVsbDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHRpZiAoZXhpc3RpbmdMb2NrKSB7XG5cdFx0XHRcdGNvbnN0IGlzU3RhbGUgPSAobm93IC0gZXhpc3RpbmdMb2NrLnVwZGF0ZWRBdCkgPiA2MDAwMDtcblx0XHRcdFx0Y29uc3QgaXNTZWxmID0gZXhpc3RpbmdMb2NrLmhvbGRlciA9PT0gbXlJZDtcblxuXHRcdFx0XHRpZiAoIWlzU3RhbGUgJiYgIWlzU2VsZikge1xuXHRcdFx0XHRcdC8vIFZhbGlkIGxvY2sgaGVsZCBieSBhbm90aGVyIHBsdWdpblxuXHRcdFx0XHRcdHRoaXMuaXNSZWFkT25seSA9IHRydWU7XG5cdFx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGlzU2VsZikge1xuXHRcdFx0XHRcdC8vIFJlZnJlc2g6IHByZXNlcnZlIGFjcXVpcmVkQXQsIHVwZGF0ZSB1cGRhdGVkQXRcblx0XHRcdFx0XHR0aGlzLmxvY2tBY3F1aXJlZEF0ID0gZXhpc3RpbmdMb2NrLmFjcXVpcmVkQXQ7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Ly8gU3RhbGUgdGFrZW92ZXI6IHJlc2V0IGJvdGggdGltZXN0YW1wc1xuXHRcdFx0XHRcdHRoaXMubG9ja0FjcXVpcmVkQXQgPSBub3c7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdC8vIE5ldyBsb2NrXG5cdFx0XHRcdHRoaXMubG9ja0FjcXVpcmVkQXQgPSBub3c7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFdyaXRlIGxvY2sgSlNPTlxuXHRcdFx0Y29uc3QgbG9ja0RhdGEgPSB7XG5cdFx0XHRcdGhvbGRlcjogbXlJZCxcblx0XHRcdFx0YWNxdWlyZWRBdDogdGhpcy5sb2NrQWNxdWlyZWRBdCxcblx0XHRcdFx0dXBkYXRlZEF0OiBub3dcblx0XHRcdH07XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobG9ja1BhdGgsIEpTT04uc3RyaW5naWZ5KGxvY2tEYXRhKSk7XG5cdFx0XHR0aGlzLmlzUmVhZE9ubHkgPSBmYWxzZTtcblx0XHRcdHRoaXMuc3RhcnRIZWFydGJlYXQobG9ja1BhdGgpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHR0aGlzLmlzUmVhZE9ubHkgPSB0cnVlO1xuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgc3RhcnRIZWFydGJlYXQobG9ja1BhdGg6IHN0cmluZykge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdHRoaXMuaGVhcnRiZWF0VGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoYXN5bmMgKCkgPT4ge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgbG9ja0RhdGEgPSB7XG5cdFx0XHRcdFx0aG9sZGVyOiAnd3JpdGluZy1kYXNoYm9hcmQnLFxuXHRcdFx0XHRcdGFjcXVpcmVkQXQ6IHRoaXMubG9ja0FjcXVpcmVkQXQsXG5cdFx0XHRcdFx0dXBkYXRlZEF0OiBEYXRlLm5vdygpXG5cdFx0XHRcdH07XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShsb2NrUGF0aCwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEpKTtcblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHRcdH1cblx0XHR9LCAzMDAwMCk7XG5cdH1cblxuXHRwcml2YXRlIHN0b3BIZWFydGJlYXQoKSB7XG5cdFx0aWYgKHRoaXMuaGVhcnRiZWF0VGltZXIpIHtcblx0XHRcdGNsZWFySW50ZXJ2YWwodGhpcy5oZWFydGJlYXRUaW1lcik7XG5cdFx0XHR0aGlzLmhlYXJ0YmVhdFRpbWVyID0gbnVsbDtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBzZWVkU2hhcmVkSW5kZXgoc291cmNlRGlyOiBzdHJpbmcsIHRhcmdldERpcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgbWFuaWZlc3RQYXRoID0gYCR7dGFyZ2V0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRjb25zdCBpbmRleFBhdGggPSBgJHt0YXJnZXREaXJ9L2luZGV4Lmpzb25gO1xuXG5cdFx0Y29uc3QgaXNFbXB0eSA9ICEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtYW5pZmVzdFBhdGgpKSB8fCAhKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoaW5kZXhQYXRoKSk7XG5cdFx0aWYgKCFpc0VtcHR5KSByZXR1cm47XG5cblx0XHRjb25zdCBzb3VyY2VJbmRleCA9IGAke3NvdXJjZURpcn0vaW5kZXguanNvbmA7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoc291cmNlSW5kZXgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHRhcmdldERpcikpKSB7XG5cdFx0XHRcdFx0Ly8gUmVjdXJzaXZlIG1rZGlyXG5cdFx0XHRcdFx0Y29uc3QgcGFydHMgPSB0YXJnZXREaXIuc3BsaXQoJy8nKTtcblx0XHRcdFx0XHRsZXQgY3VycmVudCA9ICcnO1xuXHRcdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdFx0aWYgKCFwYXJ0KSBjb250aW51ZTtcblx0XHRcdFx0XHRcdGN1cnJlbnQgKz0gKGN1cnJlbnQgPyAnLycgOiAnJykgKyBwYXJ0O1xuXHRcdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xuXHRcdFx0XHRcdFx0fVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQoc291cmNlSW5kZXgpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoaW5kZXhQYXRoLCBjb250ZW50KTtcblxuXHRcdFx0XHRjb25zdCBtYW5pZmVzdCA9IHtcblx0XHRcdFx0XHRzY2hlbWFWZXJzaW9uOiAyLFxuXHRcdFx0XHRcdGVtYmVkZGluZ1Byb2ZpbGU6IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpLFxuXHRcdFx0XHRcdGVuZ2luZTogJ2pzb24nXG5cdFx0XHRcdH07XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtYW5pZmVzdFBhdGgsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcignW0VtYmVkZGluZ3NJbmRleF0gU2VlZGluZyBmYWlsZWQ6JywgZXJyKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogQXRvbWljIG1pZ3JhdGlvbiBmcm9tIGxlZ2FjeSAub2JzaWRpYW4vZW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgvIHRvIG92ZXJ0IEVtYmVkZGluZ3Mvc2hhcmVkLWluZGV4L1xuXHQgKiBSZXR1cm5zIHRydWUgaWYgbWlncmF0aW9uIHN1Y2NlZWRlZCBvciB3YXMgbm90IG5lZWRlZCwgZmFsc2UgaWYgZmFpbGVkLlxuXHQgKi9cblx0YXN5bmMgbWlncmF0ZUZyb21MZWdhY3koKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3Qgb3ZlcnREaXIgPSAnRW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgnO1xuXHRcdGNvbnN0IGxlZ2FjeURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9lbWJlZGRpbmdzL3NoYXJlZC1pbmRleGA7XG5cdFx0Y29uc3Qgb3ZlcnRJbmRleCA9IGAke292ZXJ0RGlyfS9pbmRleC5qc29uYDtcblx0XHRjb25zdCBsZWdhY3lJbmRleCA9IGAke2xlZ2FjeURpcn0vaW5kZXguanNvbmA7XG5cdFx0Y29uc3QgbWlncmF0aW9uTWFya2VyID0gYCR7b3ZlcnREaXJ9Ly5taWdyYXRlZC1mcm9tLWxlZ2FjeWA7XG5cblx0XHR0cnkge1xuXHRcdFx0Ly8gQ2hlY2sgaWYgbWlncmF0aW9uIGlzIG5lZWRlZFxuXHRcdFx0Y29uc3Qgb3ZlcnRFeGlzdHMgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG92ZXJ0SW5kZXgpO1xuXHRcdFx0Y29uc3QgbGVnYWN5RXhpc3RzID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsZWdhY3lJbmRleCk7XG5cblx0XHRcdC8vIElmIG92ZXJ0IGFscmVhZHkgZXhpc3RzIG9yIGxlZ2FjeSBkb2Vzbid0IGV4aXN0LCBubyBtaWdyYXRpb24gbmVlZGVkXG5cdFx0XHRpZiAob3ZlcnRFeGlzdHMgfHwgIWxlZ2FjeUV4aXN0cykge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gQ2hlY2sgaWYgYWxyZWFkeSBtaWdyYXRlZFxuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWlncmF0aW9uTWFya2VyKSkge1xuXHRcdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc29sZS5sb2coJ1tFbWJlZGRpbmdzSW5kZXhdIFN0YXJ0aW5nIGF0b21pYyBtaWdyYXRpb24gZnJvbSBsZWdhY3kgdG8gb3ZlcnQgZm9sZGVyLi4uJyk7XG5cblx0XHRcdC8vIEVuc3VyZSBvdmVydCBmb2xkZXIgZXhpc3RzXG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG92ZXJ0RGlyKSkpIHtcblx0XHRcdFx0Y29uc3QgcGFydHMgPSBvdmVydERpci5zcGxpdCgnLycpO1xuXHRcdFx0XHRsZXQgY3VycmVudCA9ICcnO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcblx0XHRcdFx0XHRpZiAoIXBhcnQpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdGN1cnJlbnQgKz0gKGN1cnJlbnQgPyAnLycgOiAnJykgKyBwYXJ0O1xuXHRcdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCkpKSB7XG5cdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoY3VycmVudCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIEFjcXVpcmUgd3JpdGVyIGxvY2sgb24gb3ZlcnQgZm9sZGVyXG5cdFx0XHRjb25zdCBoYXNMb2NrID0gYXdhaXQgdGhpcy5hY3F1aXJlTG9jayhvdmVydERpcik7XG5cdFx0XHRpZiAoIWhhc0xvY2spIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBMZWdhY3kgbWlncmF0aW9uIGFib3J0ZWQ6IGNvdWxkIG5vdCBhY3F1aXJlIGxvY2sgKHJlYWQtb25seSBtb2RlKS4nKTtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDE6IENvcHkgbGVnYWN5IGZpbGVzIHRvIC50bXAgdmVyc2lvbnNcblx0XHRcdGNvbnN0IGxlZ2FjeUNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsZWdhY3lJbmRleCk7XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoYCR7b3ZlcnRJbmRleH0udG1wYCwgbGVnYWN5Q29udGVudCk7XG5cblx0XHRcdGNvbnN0IGxlZ2FjeU1hbmlmZXN0ID0gYCR7bGVnYWN5RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRcdGNvbnN0IG92ZXJ0TWFuaWZlc3QgPSBgJHtvdmVydERpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0XHRsZXQgaGFzTWFuaWZlc3QgPSBmYWxzZTtcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxlZ2FjeU1hbmlmZXN0KSkge1xuXHRcdFx0XHRjb25zdCBtYW5pZmVzdENvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsZWdhY3lNYW5pZmVzdCk7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShgJHtvdmVydE1hbmlmZXN0fS50bXBgLCBtYW5pZmVzdENvbnRlbnQpO1xuXHRcdFx0XHRoYXNNYW5pZmVzdCA9IHRydWU7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMjogUmVuYW1lIC50bXAgdG8gY2Fub25pY2FsIChhdG9taWMgY29tbWl0KVxuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbmFtZShgJHtvdmVydEluZGV4fS50bXBgLCBvdmVydEluZGV4KTtcblx0XHRcdGlmIChoYXNNYW5pZmVzdCkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGAke292ZXJ0TWFuaWZlc3R9LnRtcGAsIG92ZXJ0TWFuaWZlc3QpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDM6IFdyaXRlIG1pZ3JhdGlvbiBtYXJrZXJcblx0XHRcdGNvbnN0IG1hcmtlckNvbnRlbnQgPSBKU09OLnN0cmluZ2lmeSh7XG5cdFx0XHRcdG1pZ3JhdGVkQXQ6IERhdGUubm93KCksXG5cdFx0XHRcdGZyb206IGxlZ2FjeURpclxuXHRcdFx0fSwgbnVsbCwgMik7XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobWlncmF0aW9uTWFya2VyLCBtYXJrZXJDb250ZW50KTtcblxuXHRcdFx0Ly8gU3RlcCA0OiBEaXNhYmxlIGxlZ2FjeSBieSByZW5hbWluZ1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbmFtZShsZWdhY3lJbmRleCwgYCR7bGVnYWN5SW5kZXh9Lm1pZ3JhdGVkYCk7XG5cdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsZWdhY3lNYW5pZmVzdCkpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbmFtZShsZWdhY3lNYW5pZmVzdCwgYCR7bGVnYWN5TWFuaWZlc3R9Lm1pZ3JhdGVkYCk7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnNvbGUubG9nKCdbRW1iZWRkaW5nc0luZGV4XSDinJMgQXRvbWljIG1pZ3JhdGlvbiBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LicpO1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIExlZ2FjeSBtaWdyYXRpb24gZmFpbGVkOyBmYWxsaW5nIGJhY2sgdG8gaXNvbGF0ZWQuJywgZXJyKTtcblxuXHRcdFx0Ly8gQ2xlYW51cCB0ZW1wIGZpbGVzIGJlc3QtZWZmb3J0XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhgJHtvdmVydEluZGV4fS50bXBgKSkge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUoYCR7b3ZlcnRJbmRleH0udG1wYCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoYCR7b3ZlcnREaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb24udG1wYCkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVtb3ZlKGAke292ZXJ0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uLnRtcGApO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0Ly8gaWdub3JlIGNsZWFudXAgZXJyb3JzXG5cdFx0XHR9XG5cblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBnZXRJbmRleEZpbGVQYXRoKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRyZXR1cm4gYCR7ZGlyfS9pbmRleC5qc29uYDtcblx0fVxuXG5cdGFzeW5jIGNsZWFySW5kZXgoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IHt9O1xuXHRcdGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuXHRcdGNvbnN0IHBhdGggPSBhd2FpdCB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkge1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShwYXRoKTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBlbnN1cmVMb2FkZWQoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMubG9hZGVkKSByZXR1cm47XG5cdFx0dGhpcy5sb2FkZWQgPSB0cnVlO1xuXG5cdFx0dHJ5IHtcblx0XHRcdC8vIFN0ZXAgMTogRGV0ZXJtaW5lIG1vZGUgYW5kIGF0dGVtcHQgbWlncmF0aW9uIGluIGF1dG8gbW9kZVxuXHRcdFx0Y29uc3QgbW9kZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLmVtYmVkZGluZ1N0b3JhZ2VNb2RlIHx8ICdpc29sYXRlZCc7XG5cdFx0XHRpZiAobW9kZSA9PT0gJ2F1dG8nKSB7XG5cdFx0XHRcdC8vIEF0dGVtcHQgbGVnYWN5IG1pZ3JhdGlvbiBCRUZPUkUgcmVzb2x2aW5nIGZpbmFsIGRpclxuXHRcdFx0XHRjb25zdCBtaWdyYXRpb25TdWNjZXNzID0gYXdhaXQgdGhpcy5taWdyYXRlRnJvbUxlZ2FjeSgpO1xuXHRcdFx0XHRpZiAoIW1pZ3JhdGlvblN1Y2Nlc3MpIHtcblx0XHRcdFx0XHQvLyBNaWdyYXRpb24gZmFpbGVkIChsb2NrZWQgYnkgb3RoZXIgcGx1Z2luIG9yIGVycm9yKSAtIGZhbGwgYmFjayB0byBpc29sYXRlZFxuXHRcdFx0XHRcdHRoaXMuY3VycmVudFN0b3JhZ2VNb2RlID0gJ2lzb2xhdGVkJztcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIEF1dG8gbW9kZTogbWlncmF0aW9uIGZhaWxlZCwgdXNpbmcgaXNvbGF0ZWQgbW9kZS4nKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDI6IFJlc29sdmUgaW5kZXggZGlyZWN0b3J5XG5cdFx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXG5cdFx0XHQvLyBTdGVwIDM6IFZhbGlkYXRlIG1hbmlmZXN0XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhbGlkYXRlTWFuaWZlc3QoZGlyKSkpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBNYW5pZmVzdCBtaXNtYXRjaDsgZmFsbGluZyBiYWNrIHRvIGlzb2xhdGVkIG1vZGUnKTtcblx0XHRcdFx0dGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgPSAnaXNvbGF0ZWQnOyAvLyBJbnRlcm5hbCBvdmVycmlkZSBmb3IgdGhpcyBzZXNzaW9uXG5cdFx0XHRcdC8vIFJlLXJlc29sdmUgcGF0aCBhZnRlciBmYWxsYmFja1xuXHRcdFx0XHRjb25zdCBuZXdEaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG5ld0RpcikpKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKG5ld0Rpcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCA0OiBJbiBhdXRvL21hbnVhbCwgYWNxdWlyZSBsb2NrIGFuZCBzZWVkIGlmIG5lZWRlZFxuXHRcdFx0Y29uc3QgcmVzb2x2ZWRNb2RlID0gdGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgfHwgbW9kZTtcblx0XHRcdGlmIChyZXNvbHZlZE1vZGUgIT09ICdpc29sYXRlZCcpIHtcblx0XHRcdFx0Y29uc3Qgc291cmNlRGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHRcdFx0YXdhaXQgdGhpcy5zZWVkU2hhcmVkSW5kZXgoc291cmNlRGlyLCBkaXIpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLmFjcXVpcmVMb2NrKGRpcik7XG5cdFx0XHR9XG5cblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpKSByZXR1cm47XG5cdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChwYXRoKTtcblx0XHRcdGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyBQZXJzaXN0ZWRJbmRleFYxO1xuXHRcdFx0aWYgKHBhcnNlZD8udmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShwYXJzZWQuY2h1bmtzKSkgcmV0dXJuO1xuXHRcdFx0aWYgKHBhcnNlZC5iYWNrZW5kICYmIHBhcnNlZC5iYWNrZW5kICE9PSB0aGlzLmJhY2tlbmQpIHtcblx0XHRcdFx0Ly8gQmFja2VuZCBtaXNtYXRjaDogaWdub3JlIHBlcnNpc3RlZCBpbmRleCBhbmQgcmVidWlsZC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRpZiAodHlwZW9mIHBhcnNlZC5kaW0gPT09ICdudW1iZXInKSB7XG5cdFx0XHRcdHRoaXMuZGltID0gcGFyc2VkLmRpbTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4cGVjdGVkQ2h1bmtpbmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0XHRpZiAoXG5cdFx0XHRcdHBhcnNlZC5jaHVua2luZyAmJlxuXHRcdFx0XHQocGFyc2VkLmNodW5raW5nLmhlYWRpbmdMZXZlbCAhPT0gZXhwZWN0ZWRDaHVua2luZy5oZWFkaW5nTGV2ZWwgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcudGFyZ2V0V29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcudGFyZ2V0V29yZHMgfHxcblx0XHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcub3ZlcmxhcFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLm92ZXJsYXBXb3Jkcylcblx0XHRcdCkge1xuXHRcdFx0XHQvLyBDaHVua2luZyBjb25maWcgY2hhbmdlZDsgcmVidWlsZCBpbmRleC5cblx0XHRcdFx0dGhpcy5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdFx0XHRyZXR1cm47XG5cdFx0XHR9XG5cdFx0XHRmb3IgKGNvbnN0IGNodW5rIG9mIHBhcnNlZC5jaHVua3MpIHtcblx0XHRcdFx0aWYgKCFjaHVuaz8ua2V5IHx8ICFjaHVuaz8ucGF0aCB8fCAhQXJyYXkuaXNBcnJheShjaHVuay52ZWN0b3IpKSBjb250aW51ZTtcblx0XHRcdFx0dGhpcy5fc2V0Q2h1bmsoY2h1bmspO1xuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gQ29ycnVwdCBpbmRleCBzaG91bGQgbm90IGJyZWFrIHRoZSBwbHVnaW4uIFdlJ2xsIHJlYnVpbGQgbGF6aWx5LlxuXHRcdFx0dGhpcy5jaHVua3NCeUtleS5jbGVhcigpO1xuXHRcdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcblx0XHR9XG5cdH1cblxuXHRnZXRTdGF0dXMoKTogeyBpbmRleGVkRmlsZXM6IG51bWJlcjsgaW5kZXhlZENodW5rczogbnVtYmVyOyBwYXVzZWQ6IGJvb2xlYW47IHF1ZXVlZDogbnVtYmVyIH0ge1xuXHRcdHJldHVybiB7XG5cdFx0XHRpbmRleGVkRmlsZXM6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNpemUsXG5cdFx0XHRpbmRleGVkQ2h1bmtzOiB0aGlzLmNodW5rc0J5S2V5LnNpemUsXG5cdFx0XHRwYXVzZWQ6IEJvb2xlYW4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpLFxuXHRcdFx0cXVldWVkOiB0aGlzLnF1ZXVlLnNpemVcblx0XHR9O1xuXHR9XG5cblx0Z2V0UmVjZW50RXJyb3JzKGxpbWl0OiBudW1iZXIgPSAyMCk6IEVycm9yTG9nRW50cnlbXSB7XG5cdFx0cmV0dXJuIHRoaXMuZXJyb3JMb2cuc2xpY2UoLWxpbWl0KTtcblx0fVxuXG5cdGdldEVycm9yU3VtbWFyeSgpOiB7IHRvdGFsOiBudW1iZXI7IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj47IHJlY2VudDogRXJyb3JMb2dFbnRyeVtdIH0ge1xuXHRcdGNvbnN0IGJ5TG9jYXRpb246IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcblx0XHRmb3IgKGNvbnN0IGVyciBvZiB0aGlzLmVycm9yTG9nKSB7XG5cdFx0XHRieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gPSAoYnlMb2NhdGlvbltlcnIubG9jYXRpb25dIHx8IDApICsgMTtcblx0XHR9XG5cdFx0cmV0dXJuIHtcblx0XHRcdHRvdGFsOiB0aGlzLmVycm9yTG9nLmxlbmd0aCxcblx0XHRcdGJ5TG9jYXRpb24sXG5cdFx0XHRyZWNlbnQ6IHRoaXMuZXJyb3JMb2cuc2xpY2UoLTEwKVxuXHRcdH07XG5cdH1cblxuXHRwcml2YXRlIGxvZ0Vycm9yKGxvY2F0aW9uOiBzdHJpbmcsIGNvbnRleHQ6IHN0cmluZywgZXJyb3I6IHVua25vd24pOiB2b2lkIHtcblx0XHRjb25zdCBlcnJvck1zZyA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcblx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdGNvbnN0IGVycm9yVHlwZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5jb25zdHJ1Y3Rvci5uYW1lIDogdHlwZW9mIGVycm9yO1xuXHRcdFxuXHRcdGNvbnN0IGVudHJ5OiBFcnJvckxvZ0VudHJ5ID0ge1xuXHRcdFx0dGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG5cdFx0XHRsb2NhdGlvbixcblx0XHRcdGNvbnRleHQsXG5cdFx0XHRtZXNzYWdlOiBlcnJvck1zZyxcblx0XHRcdHN0YWNrOiBlcnJvclN0YWNrLFxuXHRcdFx0ZXJyb3JUeXBlXG5cdFx0fTtcblx0XHRcblx0XHR0aGlzLmVycm9yTG9nLnB1c2goZW50cnkpO1xuXHRcdGlmICh0aGlzLmVycm9yTG9nLmxlbmd0aCA+IHRoaXMubWF4U3RvcmVkRXJyb3JzKSB7XG5cdFx0XHR0aGlzLmVycm9yTG9nLnNoaWZ0KCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIEFsc28gbG9nIHRvIGNvbnNvbGUgZm9yIGRlYnVnZ2luZ1xuXHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIEVSUk9SIFske2xvY2F0aW9ufV0gJHtjb250ZXh0fTpgLCBlcnJvck1zZyk7XG5cdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIFN0YWNrOmAsIGVycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbicpKTtcblx0XHR9XG5cdH1cblxuXHRlbnF1ZXVlRnVsbFJlc2NhbigpOiB2b2lkIHtcblx0XHRjb25zdCBmaWxlcyA9IHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5nZXRJbmNsdWRlZE1hcmtkb3duRmlsZXMoKTtcblx0XHRmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHRoaXMucXVldWUuYWRkKGYucGF0aCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0cXVldWVVcGRhdGVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMucXVldWUuYWRkKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUmVidWlsZCgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVSZWJ1aWxkKCk6IHZvaWQge1xuXHRcdGNvbnN0IHBvbGljeSA9IENPX0FVVEhPUklOR19QT0xJQ1kuUEVSRk9STUFOQ0U7XG5cdFx0aWYgKHRoaXMucmVidWlsZFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucmVidWlsZFRpbWVyKTtcblx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucmVidWlsZFRpbWVyID0gbnVsbDtcblx0XHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0XHR9LCBwb2xpY3kuUkVCVUlMRF9RVUVVRV9ERUJPVU5DRV9NUyk7XG5cdH1cblxuXHRxdWV1ZVJlbW92ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHR9XG5cblx0cHJpdmF0ZSBfa2lja1dvcmtlcigpOiB2b2lkIHtcblx0XHRpZiAodGhpcy53b3JrZXJSdW5uaW5nKSByZXR1cm47XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gdHJ1ZTtcblx0XHQvLyBGaXJlIGFuZCBmb3JnZXQsIGJ1dCBlbnN1cmUgZXJyb3JzIGFyZSBzd2FsbG93ZWQuXG5cdFx0dm9pZCB0aGlzLl9ydW5Xb3JrZXIoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHR9KTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3J1bldvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUxvYWRlZCgpO1xuXG5cdFx0aWYgKHRoaXMuaXNSZWFkT25seSkge1xuXHRcdFx0Y29uc29sZS5sb2coJ1tFbWJlZGRpbmdzSW5kZXhdIFNoYXJlZCBpbmRleCBsb2NrZWQ7IG9wZXJhdGluZyByZWFkLW9ubHkuJyk7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyB0byBhdm9pZCBmYWlsdXJlcy5cblx0XHRpZiAoIShhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmlzQXZhaWxhYmxlKCkpKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBzZW1hbnRpYyBpbmRleGluZycpO1xuXHRcdFx0bmV3IE5vdGljZSgn4pqg77iPIE9sbGFtYSBub3QgYXZhaWxhYmxlIC0gaW5kZXhpbmcgc2tpcHBlZCcpO1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgcG9saWN5ID0gQ09fQVVUSE9SSU5HX1BPTElDWS5QRVJGT1JNQU5DRTtcblx0XHRjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXHRcdGNvbnN0IHRvdGFsRmlsZXMgPSB0aGlzLnF1ZXVlLnNpemU7XG5cdFx0bGV0IHByb2Nlc3NlZENvdW50ID0gMDtcblx0XHRsZXQgc2tpcHBlZEV4Y2x1ZGVkID0gMDtcblx0XHRsZXQgc2tpcHBlZE5vdE1hcmtkb3duID0gMDtcblx0XHRsZXQgc2tpcHBlZEhhc2hNYXRjaCA9IDA7XG5cdFx0bGV0IGluZGV4ZWRDb3VudCA9IDA7XG5cblx0XHQvLyBFbWl0IHN0YXJ0IGV2ZW50IGFuZCBub3RpZmljYXRpb25cblx0XHRpZiAodG90YWxGaWxlcyA+IDApIHtcblx0XHRcdG5ldyBOb3RpY2UoYPCflI0gU3RhcnRpbmcgaW5kZXggc2NhbiAoJHt0b3RhbEZpbGVzfSBmaWxlcykuLi5gKTtcblx0XHRcdHJlbGF5RXZlbnRCdXMuZW1pdCgnaW5kZXg6c3RhcnQnLCB7IHRvdGFsRmlsZXMgfSk7XG5cdFx0fVxuXHRcdFxuXHRcdHdoaWxlICh0aGlzLnF1ZXVlLnNpemUgPiAwICYmIGluZGV4ZWRDb3VudCA8IHBvbGljeS5NQVhfUkVCVUlMRFNfUEVSX0JBVENIKSB7XG5cdFx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpIGJyZWFrO1xuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcblx0XHRcdHRoaXMucXVldWUuZGVsZXRlKG5leHQpO1xuXHRcdFx0cHJvY2Vzc2VkQ291bnQrKztcblxuXHRcdFx0Ly8gRW1pdCBwcm9ncmVzcyBldmVyeSAxMCBmaWxlc1xuXHRcdFx0aWYgKHByb2Nlc3NlZENvdW50ICUgMTAgPT09IDApIHtcblx0XHRcdFx0bmV3IE5vdGljZShgSW5kZXhpbmcuLi4gJHtwcm9jZXNzZWRDb3VudH0vJHt0b3RhbEZpbGVzfSBmaWxlc2ApO1xuXHRcdFx0XHRyZWxheUV2ZW50QnVzLmVtaXQoJ2luZGV4OnByb2dyZXNzJywgeyBwcm9jZXNzZWQ6IHByb2Nlc3NlZENvdW50LCB0b3RhbDogdG90YWxGaWxlcywgY3VycmVudEZpbGU6IG5leHQgfSk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIEV4Y2x1c2lvbnMgY2FuIGNoYW5nZSBhdCBhbnkgdGltZTsgaG9ub3IgdGhlbSBkdXJpbmcgcHJvY2Vzc2luZy5cblx0XHRcdGlmICh0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgobmV4dCkpIHtcblx0XHRcdFx0c2tpcHBlZEV4Y2x1ZGVkKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKG5leHQpO1xuXHRcdFx0Ly8gT25seSBpbmRleCBtYXJrZG93biBmaWxlcy5cblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0c2tpcHBlZE5vdE1hcmtkb3duKys7XG5cdFx0XHRcdHRoaXMuX3JlbW92ZVBhdGgobmV4dCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZENvbnRlbnQgPSBub3JtYWxpemVDaHVua1RleHQoY29udGVudCk7XG5cdFx0XHRcdGNvbnN0IGZpbGVIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRDb250ZW50KTtcblx0XHRcdFx0Y29uc3QgcHJldiA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltuZXh0XTtcblx0XHRcdFx0Y29uc3QgaXNDdXJyZW50bHlJbmRleGVkID0gdGhpcy5jaHVua0tleXNCeVBhdGguaGFzKG5leHQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2tpcCBvbmx5IGlmOiBoYXNoIG1hdGNoZXMgQU5EIGZpbGUgaXMgYWxyZWFkeSBpbmRleGVkXG5cdFx0XHRcdC8vIElmIGhhc2ggbWF0Y2hlcyBidXQgZmlsZSBpcyBOT1QgaW5kZXhlZCwgcmUtaW5kZXggaXQgKG1pZ2h0IGhhdmUgYmVlbiByZW1vdmVkKVxuXHRcdFx0XHRpZiAocHJldj8uaGFzaCA9PT0gZmlsZUhhc2ggJiYgaXNDdXJyZW50bHlJbmRleGVkKSB7XG5cdFx0XHRcdFx0c2tpcHBlZEhhc2hNYXRjaCsrO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0YXdhaXQgdGhpcy5fcmVpbmRleEZpbGUobmV4dCwgY29udGVudCk7XG5cdFx0XHRcdGluZGV4ZWRDb3VudCsrO1xuXHRcdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge1xuXHRcdFx0XHRcdC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSxcblx0XHRcdFx0XHRbbmV4dF06IHtcblx0XHRcdFx0XHRcdGhhc2g6IGZpbGVIYXNoLFxuXHRcdFx0XHRcdFx0Y2h1bmtDb3VudDogdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KG5leHQpPy5zaXplID8/IDAsXG5cdFx0XHRcdFx0XHR1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuXHRcdFx0XHRcdH1cblx0XHRcdFx0fTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Ly8gU2tpcCB1bnJlYWRhYmxlIGZpbGVzLCBidXQgbG9nIGZvciBkZWJ1Z2dpbmdcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3J1bldvcmtlcicsIGBQcm9jZXNzaW5nIGZpbGU6ICR7bmV4dH1gLCBlcnIpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBZaWVsZCB0byBrZWVwIFVJIHJlc3BvbnNpdmUuXG5cdFx0XHRhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCAxMCkpO1xuXHRcdH1cblxuXHRcdC8vIENhbGN1bGF0ZSBkdXJhdGlvbiBhbmQgZW1pdCBjb21wbGV0aW9uXG5cdFx0Y29uc3QgZHVyYXRpb24gPSAoRGF0ZS5ub3coKSAtIHN0YXJ0VGltZSkgLyAxMDAwO1xuXHRcdGNvbnN0IHRvdGFsU2tpcHBlZCA9IHNraXBwZWRFeGNsdWRlZCArIHNraXBwZWROb3RNYXJrZG93biArIHNraXBwZWRIYXNoTWF0Y2g7XG5cblx0XHQvLyBMb2cgaW5kZXhpbmcgc3RhdHMgZm9yIGRlYnVnZ2luZ1xuXHRcdGlmIChwcm9jZXNzZWRDb3VudCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzZWQgJHtwcm9jZXNzZWRDb3VudH0gZmlsZXM6ICR7aW5kZXhlZENvdW50fSBpbmRleGVkLCAke3NraXBwZWRFeGNsdWRlZH0gZXhjbHVkZWQsICR7c2tpcHBlZE5vdE1hcmtkb3dufSBub3QgbWFya2Rvd24sICR7c2tpcHBlZEhhc2hNYXRjaH0gaGFzaCBtYXRjaCAoYWxyZWFkeSBpbmRleGVkKWApO1xuXHRcdFx0bmV3IE5vdGljZShg4pyFIEluZGV4ZWQgJHtpbmRleGVkQ291bnR9IGZpbGVzIGluICR7ZHVyYXRpb24udG9GaXhlZCgxKX1zICgke3RoaXMuY2h1bmtzQnlLZXkuc2l6ZX0gY2h1bmtzIHRvdGFsKWApO1xuXHRcdFx0cmVsYXlFdmVudEJ1cy5lbWl0KCdpbmRleDpjb21wbGV0ZScsIHsgXG5cdFx0XHRcdGluZGV4ZWQ6IGluZGV4ZWRDb3VudCwgXG5cdFx0XHRcdGNodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLCBcblx0XHRcdFx0ZHVyYXRpb24sXG5cdFx0XHRcdHNraXBwZWQ6IHRvdGFsU2tpcHBlZFxuXHRcdFx0fSk7XG5cdFx0fVxuXG5cdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9yZWluZGV4RmlsZShwYXRoOiBzdHJpbmcsIGNvbnRlbnQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cblx0XHQvLyBJZiBPbGxhbWEgaXMgbm90IGF2YWlsYWJsZSwgc2tpcCBzZW1hbnRpYyBpbmRleGluZyBmb3IgdGhpcyBmaWxlLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHQvLyBTa2lwIGVtcHR5IGZpbGVzXG5cdFx0aWYgKCFjb250ZW50IHx8IGNvbnRlbnQudHJpbSgpLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBlbXB0eSBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgY2ZnID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSBQcm9jZXNzaW5nIGZpbGU6ICR7cGF0aH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIEJhY2tlbmQ6ICR7dGhpcy5iYWNrZW5kfWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ29udGVudCBsZW5ndGg6ICR7Y29udGVudC5sZW5ndGh9IGNoYXJzLCAke2NvbnRlbnQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzYCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua2luZyBjb25maWc6IGhlYWRpbmdMZXZlbD0ke2NmZy5oZWFkaW5nTGV2ZWx9LCB0YXJnZXRXb3Jkcz0ke2NmZy50YXJnZXRXb3Jkc30sIG92ZXJsYXBXb3Jkcz0ke2NmZy5vdmVybGFwV29yZHN9YCk7XG5cdFx0XG5cdFx0Y29uc3QgY2h1bmtzID0gYnVpbGRJbmRleENodW5rcyh7XG5cdFx0XHR0ZXh0OiBjb250ZW50LFxuXHRcdFx0aGVhZGluZ0xldmVsOiBjZmcuaGVhZGluZ0xldmVsLFxuXHRcdFx0dGFyZ2V0V29yZHM6IGNmZy50YXJnZXRXb3Jkcyxcblx0XHRcdG92ZXJsYXBXb3JkczogY2ZnLm92ZXJsYXBXb3Jkc1xuXHRcdH0pO1xuXHRcdFxuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtzIGNyZWF0ZWQ6ICR7Y2h1bmtzLmxlbmd0aH1gKTtcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnNvbGUubG9nKGAgIC0gRmlyc3QgY2h1bmsgcHJldmlldzogJHtjaHVua3NbMF0udGV4dC5zdWJzdHJpbmcoMCwgMTAwKX0uLi5gKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gSWYgbm8gY2h1bmtzIGNyZWF0ZWQsIHNraXAgdGhpcyBmaWxlIChtaWdodCBiZSB0b28gc2hvcnQgb3IgaGF2ZSBubyBoZWFkaW5ncylcblx0XHRpZiAoY2h1bmtzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBObyBjaHVua3MgY3JlYXRlZCBmb3IgJHtwYXRofSAtIGZpbGUgdG9vIHNob3J0IG9yIG5vIGhlYWRpbmdzIG1hdGNoIGNodW5raW5nIGNvbmZpZ2ApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGxldCBzdWNjZXNzZnVsQ2h1bmtzID0gMDtcblx0XHRsZXQgZmlyc3RFcnJvcjogRXJyb3IgfCBudWxsID0gbnVsbDtcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGNodW5rcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgY2ggPSBjaHVua3NbaV07XG5cdFx0XHRjb25zdCBub3JtYWxpemVkVGV4dCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjaC50ZXh0KTtcblx0XHRcdGNvbnN0IHRleHRIYXNoID0gYXdhaXQgc2hhMjU2KG5vcm1hbGl6ZWRUZXh0KTtcblx0XHRcdGNvbnN0IGtleSA9IGBjaHVuazoke3BhdGh9OiR7aX1gO1xuXHRcdFx0bGV0IHZlY3RvcjogbnVtYmVyW107XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIEdlbmVyYXRpbmcgZW1iZWRkaW5nIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzKS4uLmApO1xuXHRcdFx0XHRjb25zdCBlbWJlZFN0YXJ0ID0gRGF0ZS5ub3coKTtcblx0XHRcdFx0dmVjdG9yID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0XHR0aGlzLmFpRXJyb3JTdHJlYWsgPSAwOyAvLyBTdWNjZXNzOiByZXNldCBzdHJlYWtcblx0XHRcdFx0aWYgKCFBcnJheS5pc0FycmF5KHZlY3RvcikgfHwgdmVjdG9yLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1wdHkgZW1iZWRkaW5nIHJldHVybmVkIGZyb20gT2xsYW1hJyk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKHRoaXMuZGltID09PSAwKSB7XG5cdFx0XHRcdFx0dGhpcy5kaW0gPSB2ZWN0b3IubGVuZ3RoO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGVtYmVkRHVyYXRpb24gPSBEYXRlLm5vdygpIC0gZW1iZWRTdGFydDtcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSDinJMgT2xsYW1hIGVtYmVkZGluZyBnZW5lcmF0ZWQgaW4gJHtlbWJlZER1cmF0aW9ufW1zOiAke3ZlY3Rvci5sZW5ndGh9IGRpbWVuc2lvbnNgKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHR0aGlzLmFpRXJyb3JTdHJlYWsrKztcblx0XHRcdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG5cdFx0XHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRcdFx0Y29uc3QgY29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBDaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9ICgke2NoLnRleHQuc3BsaXQoL1xccysvKS5sZW5ndGh9IHdvcmRzLCAke2NoLnRleHQubGVuZ3RofSBjaGFycylgO1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuZW1iZWRDaHVuaycsIGNvbnRleHQsIGVycik7XG5cdFx0XHRcdFxuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIC0g4pyXIEVtYmVkZGluZyBnZW5lcmF0aW9uIGZhaWxlZCBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofTpgLCBlcnJvck1zZyk7XG5cdFx0XHRcdFxuXHRcdFx0XHRpZiAodGhpcy5haUVycm9yU3RyZWFrID49IDMpIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIEVtYmVkZGluZyBicmVha2VyIHRyaWdnZXJlZDogcGF1c2VkIDE1cyBhbmQgY2xlYXJlZCBxdWV1ZSBhZnRlciAzIGNvbnNlY3V0aXZlIGZhaWx1cmVzLicpO1xuXHRcdFx0XHRcdHRoaXMucXVldWUuY2xlYXIoKTtcblx0XHRcdFx0XHR0aGlzLmFpRXJyb3JTdHJlYWsgPSAwO1xuXHRcdFx0XHRcdC8vIFlpZWxkIGFuZCB3YWl0IDE1c1xuXHRcdFx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAxNTAwMCkpO1xuXHRcdFx0XHRcdHRocm93IG5ldyBFcnJvcignRW1iZWRkaW5nIGJyZWFrZXIgdHJpZ2dlcmVkOyBiYXRjaCBhYm9ydGVkLicpO1xuXHRcdFx0XHR9XG5cblx0XHRcdFx0aWYgKGVycm9yU3RhY2spIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgU3RhY2s6ICR7ZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuICAgICcpfWApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChlcnIgaW5zdGFuY2VvZiBFcnJvcikge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBFcnJvciB0eXBlOiAke2Vyci5jb25zdHJ1Y3Rvci5uYW1lfWApO1xuXHRcdFx0XHRcdGlmICgnY2F1c2UnIGluIGVycikge1xuXHRcdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIENhdXNlOiAke2Vyci5jYXVzZX1gKTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gSWYgQUxMIGNodW5rcyBmYWlsIGZvciBhIGZpbGUsIHRoZSBmaWxlIHdvbid0IGJlIGluZGV4ZWRcblx0XHRcdFx0Ly8gVGhpcyBpcyBhIGNyaXRpY2FsIGZhaWx1cmUgdGhhdCBzaG91bGQgYmUgbG9nZ2VkXG5cdFx0XHRcdGlmIChpID09PSAwKSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKGAgIC0gV2FybmluZzogRmlyc3QgY2h1bmsgZmFpbGVkIGZvciAke3BhdGh9LiBBdHRlbXB0aW5nIHN1YnNlcXVlbnQgY2h1bmtzLmApO1xuXHRcdFx0XHRcdGZpcnN0RXJyb3IgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyKSk7XG5cdFx0XHRcdH1cblx0XHRcdFx0Ly8gU2tpcCB0aGlzIGNodW5rIGlmIGVtYmVkZGluZyBmYWlscywgYnV0IGNvbnRpbnVlIHdpdGggb3RoZXJzXG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGV4Y2VycHRPZihjaC50ZXh0LCAyNTAwKTtcblx0XHRcdHRoaXMuX3NldENodW5rKHtcblx0XHRcdFx0a2V5LFxuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRjaHVua0luZGV4OiBpLFxuXHRcdFx0XHRzdGFydFdvcmQ6IGNoLnN0YXJ0V29yZCxcblx0XHRcdFx0ZW5kV29yZDogY2guZW5kV29yZCxcblx0XHRcdFx0dGV4dEhhc2gsXG5cdFx0XHRcdHZlY3Rvcixcblx0XHRcdFx0ZXhjZXJwdFxuXHRcdFx0fSk7XG5cdFx0XHRzdWNjZXNzZnVsQ2h1bmtzKys7XG5cdFx0fVxuXHRcdFxuXHRcdGlmIChzdWNjZXNzZnVsQ2h1bmtzID09PSAwICYmIGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBjcml0aWNhbENvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZGA7XG5cdFx0XHRpZiAoZmlyc3RFcnJvcikge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBmaXJzdEVycm9yKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gQ1JJVElDQUw6IEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWQgZm9yICR7cGF0aH0gLSBmaWxlIG5vdCBpbmRleGVkYCk7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgUm9vdCBjYXVzZTogJHtmaXJzdEVycm9yLm1lc3NhZ2V9YCk7XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcmVpbmRleEZpbGUuYWxsQ2h1bmtzRmFpbGVkJywgY3JpdGljYWxDb250ZXh0LCBuZXcgRXJyb3IoJ0FsbCBjaHVua3MgZmFpbGVkIGJ1dCBubyBmaXJzdCBlcnJvciBjYXB0dXJlZCcpKTtcblx0XHRcdH1cblx0XHR9IGVsc2UgaWYgKHN1Y2Nlc3NmdWxDaHVua3MgPCBjaHVua3MubGVuZ3RoKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFBhcnRpYWwgc3VjY2VzcyBmb3IgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfS8ke2NodW5rcy5sZW5ndGh9IGNodW5rcyBpbmRleGVkYCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnNvbGUubG9nKGBbRW1iZWRkaW5nc0luZGV4XSDinJMgU3VjY2Vzc2Z1bGx5IGluZGV4ZWQgJHtwYXRofTogJHtzdWNjZXNzZnVsQ2h1bmtzfSBjaHVua3NgKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9zZXRDaHVuayhjaHVuazogSW5kZXhlZENodW5rKTogdm9pZCB7XG5cdFx0dGhpcy5jaHVua3NCeUtleS5zZXQoY2h1bmsua2V5LCBjaHVuayk7XG5cdFx0Y29uc3Qgc2V0ID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KGNodW5rLnBhdGgpID8/IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdHNldC5hZGQoY2h1bmsua2V5KTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5zZXQoY2h1bmsucGF0aCwgc2V0KTtcblx0fVxuXG5cdHByaXZhdGUgX3JlbW92ZVBhdGgocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0Y29uc3Qga2V5cyA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChwYXRoKTtcblx0XHRpZiAoa2V5cykge1xuXHRcdFx0Zm9yIChjb25zdCBrIG9mIGtleXMpIHRoaXMuY2h1bmtzQnlLZXkuZGVsZXRlKGspO1xuXHRcdH1cblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5kZWxldGUocGF0aCk7XG5cblx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdKSB7XG5cdFx0XHRjb25zdCBuZXh0ID0geyAuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSkgfTtcblx0XHRcdGRlbGV0ZSBuZXh0W3BhdGhdO1xuXHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IG5leHQ7XG5cdFx0fVxuXHR9XG5cblx0Z2V0QWxsQ2h1bmtzKCk6IEluZGV4ZWRDaHVua1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rc0J5S2V5LnZhbHVlcygpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDb21wdXRlcyBhIGJpdC1wZXJmZWN0IGNvcnB1cyBoYXNoIGZvciBzdHJpY3QgcmVwbGF5LlxuXHQgKiBzaGEyNTYoam9pbihzb3J0KGNodW5rX2lkICsgXCI6XCIgKyBjb250ZW50X2hhc2gpLCBcIlxcblwiKSlcblx0ICovXG5cdGFzeW5jIGdldENvcnB1c0hhc2goKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBjaHVua3MgPSB0aGlzLmdldEFsbENodW5rcygpO1xuXHRcdGNvbnN0IGxpbmVzID0gY2h1bmtzLm1hcChjID0+IGAke2Mua2V5fToke2MudGV4dEhhc2h9YCk7XG5cdFx0bGluZXMuc29ydCgpO1xuXHRcdGNvbnN0IGpvaW5lZCA9IGxpbmVzLmpvaW4oJ1xcbicpO1xuXHRcdHJldHVybiBhd2FpdCBzaGEyNTYoam9pbmVkKTtcblx0fVxuXG5cdGdldEluZGV4ZWRQYXRocygpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua0tleXNCeVBhdGgua2V5cygpKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVja3MgaWYgYSBwYXRoIGlzIGN1cnJlbnRseSBtYXJrZWQgYXMgc3RhbGUgaW4gdGhlIGluZGV4IHN0YXRlLlxuXHQgKi9cblx0aXNTdGFsZShwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcblx0XHRjb25zdCBzdGF0ZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXTtcblx0XHRpZiAoIXN0YXRlKSByZXR1cm4gZmFsc2U7XG5cdFx0XG5cdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xuXHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHJldHVybiB0cnVlOyAvLyBNaXNzaW5nIGZpbGUgaXMgZWZmZWN0aXZlbHkgc3RhbGVcblx0XHRcblx0XHQvLyBJZiB1cGRhdGVkQXQgaXMgbm90IHNldCwgd2UgY2FuJ3QgYmUgc3VyZSwgYXNzdW1lIG5vdCBzdGFsZSBmb3Igbm93XG5cdFx0aWYgKCFzdGF0ZS51cGRhdGVkQXQpIHJldHVybiBmYWxzZTtcblx0XHRcblx0XHRjb25zdCBmaWxlTXRpbWUgPSBmaWxlLnN0YXQubXRpbWU7XG5cdFx0Y29uc3QgaW5kZXhUaW1lID0gbmV3IERhdGUoc3RhdGUudXBkYXRlZEF0KS5nZXRUaW1lKCk7XG5cdFx0XG5cdFx0cmV0dXJuIGZpbGVNdGltZSA+IGluZGV4VGltZTtcblx0fVxuXG5cdC8qKlxuXHQgKiBRdWV1ZSBhbGwgY3VycmVudGx5IGluZGV4ZWQgcGF0aHMgZm9yIHJlLWNoZWNraW5nLiBUaGlzIGlzIHVzZWZ1bCB3aGVuIGV4Y2x1c2lvbnMvcHJvZmlsZXMgY2hhbmdlLlxuXHQgKi9cblx0cXVldWVSZWNoZWNrQWxsSW5kZXhlZCgpOiB2b2lkIHtcblx0XHRmb3IgKGNvbnN0IHAgb2YgdGhpcy5nZXRJbmRleGVkUGF0aHMoKSkgdGhpcy5xdWV1ZS5hZGQocCk7XG5cdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHR9XG5cblx0Z2V0VmVjdG9yRm9yS2V5KGtleTogc3RyaW5nKTogbnVtYmVyW10gfCBudWxsIHtcblx0XHRjb25zdCBjaCA9IHRoaXMuY2h1bmtzQnlLZXkuZ2V0KGtleSk7XG5cdFx0cmV0dXJuIGNoPy52ZWN0b3IgPz8gbnVsbDtcblx0fVxuXG5cdGJ1aWxkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XG5cdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBidWlsZFF1ZXJ5VmVjdG9yIGNhbGxlZDsgcmV0dXJuaW5nIGVtcHR5IHZlY3Rvci4gVXNlIGVtYmVkUXVlcnlWZWN0b3IgaW5zdGVhZC4nKTtcblx0XHRyZXR1cm4gW107XG5cdH1cblxuXHRhc3luYyBlbWJlZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuXHRcdGNvbnN0IHZlYyA9IGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuZ2V0RW1iZWRkaW5nKHF1ZXJ5VGV4dCk7XG5cdFx0aWYgKCFBcnJheS5pc0FycmF5KHZlYykgfHwgdmVjLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHR9XG5cdFx0cmV0dXJuIHZlYztcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlUGVyc2lzdCgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5wZXJzaXN0VGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5wZXJzaXN0VGltZXIpO1xuXHRcdHRoaXMucGVyc2lzdFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5wZXJzaXN0VGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLl9wZXJzaXN0Tm93KCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcGVyc2lzdE5vdygpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5pc1JlYWRPbmx5KSB7XG5cdFx0XHRjb25zb2xlLmxvZygnW0VtYmVkZGluZ3NJbmRleF0gU2tpcHBpbmcgcGVyc2lzdGVuY2U6IFJlYWQtT25seSBtb2RlJyk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHR0cnkge1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhkaXIpKSkge1xuXHRcdFx0XHQvLyBSZWN1cnNpdmUgbWtkaXJcblx0XHRcdFx0Y29uc3QgcGFydHMgPSBkaXIuc3BsaXQoJy8nKTtcblx0XHRcdFx0bGV0IGN1cnJlbnQgPSAnJztcblx0XHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG5cdFx0XHRcdFx0aWYgKCFwYXJ0KSBjb250aW51ZTtcblx0XHRcdFx0XHRjdXJyZW50ICs9IChjdXJyZW50ID8gJy8nIDogJycpICsgcGFydDtcblx0XHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGN1cnJlbnQpKSkge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlIG1rZGlyIGZhaWx1cmVzXG5cdFx0fVxuXG5cdFx0Y29uc3QgcGF5bG9hZDogUGVyc2lzdGVkSW5kZXhWMSA9IHtcblx0XHRcdHZlcnNpb246IDEsXG5cdFx0XHRkaW06IHRoaXMuZGltLFxuXHRcdFx0YmFja2VuZDogdGhpcy5iYWNrZW5kLFxuXHRcdFx0Y2h1bmtpbmc6IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKSxcblx0XHRcdGNodW5rczogdGhpcy5nZXRBbGxDaHVua3MoKVxuXHRcdH07XG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpLCBKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG5cblx0XHQvLyBFbnN1cmUgbWFuaWZlc3QgZXhpc3RzIGluIHRoZSBpbmRleCBkaXJlY3Rvcnlcblx0XHRjb25zdCBtYW5pZmVzdFBhdGggPSBgJHtkaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkpIHtcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0ge1xuXHRcdFx0XHRzY2hlbWFWZXJzaW9uOiAyLFxuXHRcdFx0XHRlbWJlZGRpbmdQcm9maWxlOiB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKSxcblx0XHRcdFx0ZW5naW5lOiAnanNvbidcblx0XHRcdH07XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobWFuaWZlc3RQYXRoLCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpO1xuXHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0XHQvLyBpZ25vcmVcblx0XHRcdH0pO1xuXHRcdH0sIDEwMDApO1xuXHR9XG5cdFxufVxuXG5cbiJdfQ==