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
        const storyboardHandshakePath = `${this.vault.configDir}/embeddings/handshake/storyboard.json`;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBRXpDLE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLFlBQVksQ0FBQztBQUM5QyxPQUFPLEVBQVcsTUFBTSxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFakQsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sV0FBVyxDQUFDO0FBQ2hELE9BQU8sRUFBRSxhQUFhLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFhNUM7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFB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UUFDaEQsTUFBTSxZQUFZLEdBQUcsR0FBRyxHQUFHLHNCQUFzQixDQUFDO1FBQ2xELElBQUksQ0FBQyxDQUFDLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFlBQVksQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN0RCxNQUFNLFFBQVEsR0FBRztnQkFDaEIsYUFBYSxFQUFFLENBQUM7Z0JBQ2hCLGdCQUFnQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsRUFBRTtnQkFDNUMsTUFBTSxFQUFFLE1BQU07YUFDZCxDQUFDO1lBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pGLENBQUM7SUFDRixDQUFDO0lBRU8scUJBQXFCO1FBQzVCLElBQUksSUFBSSxDQUFDLGlCQUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBURmlsZSwgTm90aWNlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5pbXBvcnQgeyBidWlsZEluZGV4Q2h1bmtzIH0gZnJvbSAnLi9DaHVua2luZyc7XG5pbXBvcnQgeyBmbnYxYTMyLCBzaGEyNTYgfSBmcm9tICcuLi9Db250ZW50SGFzaCc7XG5pbXBvcnQgeyBPbGxhbWFFbWJlZGRpbmdQcm92aWRlciB9IGZyb20gJy4vT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXInO1xuaW1wb3J0IHsgQ09fQVVUSE9SSU5HX1BPTElDWSB9IGZyb20gJy4uL3BvbGljeSc7XG5pbXBvcnQgeyByZWxheUV2ZW50QnVzIH0gZnJvbSAnLi4vRXZlbnRCdXMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XG5cdGtleTogc3RyaW5nO1xuXHRwYXRoOiBzdHJpbmc7XG5cdGNodW5rSW5kZXg6IG51bWJlcjtcblx0c3RhcnRXb3JkOiBudW1iZXI7XG5cdGVuZFdvcmQ6IG51bWJlcjtcblx0dGV4dEhhc2g6IHN0cmluZzsgLy8gU0hBLTI1NlxuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RhYmxlIG5vcm1hbGl6YXRpb24gZm9yIGJpdC1wZXJmZWN0IGhhc2ggY29udGludWl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNodW5rVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC50cmltKClcblx0XHQucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKSAvLyBOb3JtYWxpemUgbmV3bGluZXNcblx0XHQucmVwbGFjZSgvXFxyL2csICdcXG4nKVxuXHRcdC5yZXBsYWNlKC9bIFxcdF0rL2csICcgJyk7IC8vIE5vcm1hbGl6ZSBzcGFjZXMvdGFic1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkSW5kZXhWMSB7XG5cdHZlcnNpb246IDE7XG5cdGRpbTogbnVtYmVyO1xuXHRiYWNrZW5kOiAnb2xsYW1hJztcblx0Y2h1bmtpbmc/OiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9O1xuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xufVxuXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XG5cdHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgTWF0aC5mbG9vcih2YWx1ZSkpKTtcbn1cblxuZnVuY3Rpb24gY2h1bmtpbmdLZXkocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfSB7XG5cdHJldHVybiB7XG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcblx0XHR0YXJnZXRXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rV29yZHMgPz8gNTAwLCAyMDAsIDIwMDApLFxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxuXHR9O1xufVxuXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XG59XG5cbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgZGltOiBudW1iZXI7XG5cdHByaXZhdGUgcmVhZG9ubHkgYmFja2VuZDogJ29sbGFtYSc7XG5cdHByaXZhdGUgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyO1xuXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xuXHRwcml2YXRlIGNodW5rS2V5c0J5UGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdHByaXZhdGUgd29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHJlYnVpbGRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcGVyc2lzdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gRXJyb3IgdHJhY2tpbmdcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xuXHRcblx0Ly8gQ2lyY3VpdCBicmVha2VyIGZvciBBSSBlbWJlZGRpbmcgZmFpbHVyZXNcblx0cHJpdmF0ZSBhaUVycm9yU3RyZWFrID0gMDtcblx0cHJpdmF0ZSByZWFkb25seSBBSV9FUlJPUl9TVFJFQUtfVEhSRVNIT0xEID0gMztcblx0cHJpdmF0ZSByZWFkb25seSBBSV9QQVVTRV9EVVJBVElPTl9NUyA9IDE1MDAwO1xuXG5cdC8vIFNoYXJlZCBCcmFpbiBzdGF0ZVxuXHRwcml2YXRlIGlzUmVhZE9ubHkgPSBmYWxzZTtcblx0cHJpdmF0ZSBoZWFydGJlYXRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgY3VycmVudFN0b3JhZ2VNb2RlOiAnaXNvbGF0ZWQnIHwgJ2F1dG8nIHwgJ21hbnVhbCcgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBsb2NrQWNxdWlyZWRBdDogbnVtYmVyIHwgbnVsbCA9IG51bGw7IC8vIFByZXNlcnZlIGZvciBoZWFydGJlYXRcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyKSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHRcdHRoaXMuYmFja2VuZCA9ICdvbGxhbWEnO1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBlbWJlZGRpbmdQcm92aWRlcjtcblx0XHR0aGlzLmRpbSA9IDA7XG5cdH1cblxuXHQvKipcblx0ICogSG90LXN3YXBzIHRoZSBlbWJlZGRpbmcgcHJvdmlkZXIgKGUuZy4gd2hlbiB1c2VyIGNoYW5nZXMgbW9kZWxzKS5cblx0ICovXG5cdHVwZGF0ZVByb3ZpZGVyKHByb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBwcm92aWRlcjtcblx0fVxuXG5cdGFzeW5jIG9udW5sb2FkKCkge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdC8vIFJlbW92ZSBsb2NrIG9ubHkgaWYgd2Ugb3duIGl0IChKU09OIGZvcm1hdCBjaGVjaylcblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdGNvbnN0IGxvY2tQYXRoID0gYCR7ZGlyfS9pbmRleC5sb2NrYDtcblx0XHR0cnkge1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobG9ja1BhdGgpKSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxvY2tQYXRoKTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRjb25zdCBsb2NrID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0XHRcdGlmIChsb2NrLmhvbGRlciA9PT0gJ3dyaXRpbmctZGFzaGJvYXJkJykge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShsb2NrUGF0aCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0XHQvLyBKU09OIHBhcnNlIGZhaWxlZCAtIGRvIG5vdCBkZWxldGUgKGNvdWxkIGJlIGFub3RoZXIgcGx1Z2luJ3MgbG9jaylcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlIGZpbGVzeXN0ZW0gZXJyb3JzXG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFJldHVybnMgdGhlIGNhbm9uaWNhbCBlbWJlZGRpbmcgcHJvZmlsZSAoc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCkuXG5cdCAqIFVzZWQgZm9yIGhhbmRzaGFrZSBmaWxlcywgbWFuaWZlc3QgdmFsaWRhdGlvbiwgYW5kIHByb2ZpbGUgbWF0Y2hpbmcuXG5cdCAqL1xuXHRnZXRFbWJlZGRpbmdQcm9maWxlKCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRwcm92aWRlcjogJ29sbGFtYScgYXMgY29uc3QsXG5cdFx0XHRtb2RlbElkOiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZWxheUVtYmVkZGluZ01vZGVsLFxuXHRcdFx0ZGltZW5zaW9uczogdGhpcy5kaW0gfHwgNzY4LFxuXHRcdFx0bm9ybWFsaXplOiB0cnVlLFxuXHRcdFx0Y2h1bmtpbmdWZXJzaW9uOiAyLFxuXHRcdFx0c2NoZW1hVmVyc2lvbjogMlxuXHRcdH07XG5cdH1cblxuXHRhc3luYyByZXNvbHZlSW5kZXhEaXIoKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBtb2RlID0gdGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgfHwgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZW1iZWRkaW5nU3RvcmFnZU1vZGUgfHwgJ2lzb2xhdGVkJztcblxuXHRcdGlmIChtb2RlID09PSAnaXNvbGF0ZWQnKSB7XG5cdFx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR9XG5cblx0XHRpZiAobW9kZSA9PT0gJ21hbnVhbCcpIHtcblx0XHRcdGNvbnN0IG1hbnVhbFBhdGggPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tYW51YWxTaGFyZWRQYXRoO1xuXHRcdFx0aWYgKG1hbnVhbFBhdGgpIHJldHVybiBtYW51YWxQYXRoO1xuXHRcdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0fVxuXG5cdFx0Ly8gYXV0byBtb2RlXG5cdFx0Y29uc3Qgc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGggPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vZW1iZWRkaW5ncy9oYW5kc2hha2Uvc3Rvcnlib2FyZC5qc29uYDtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhzdG9yeWJvYXJkSGFuZHNoYWtlUGF0aCkpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHN0b3J5Ym9hcmRIYW5kc2hha2VQYXRoKTtcblx0XHRcdFx0Y29uc3Qgc3Rvcnlib2FyZCA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdFx0aWYgKHRoaXMucHJvZmlsZXNNYXRjaChzdG9yeWJvYXJkLmVtYmVkZGluZ1Byb2ZpbGUpKSB7XG5cdFx0XHRcdFx0cmV0dXJuICdFbWJlZGRpbmdzL3NoYXJlZC1pbmRleCc7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBTaGFyZWQgaW5kZXggZGlzYWJsZWQ6IGVtYmVkZGluZyBwcm9maWxlcyBkbyBub3QgbWF0Y2ggc3Rvcnlib2FyZCcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcignW0VtYmVkZGluZ3NJbmRleF0gRmFpbGVkIHRvIHJlYWQgc3Rvcnlib2FyZCBoYW5kc2hha2U6JywgZXJyKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0fVxuXG5cdHByaXZhdGUgcHJvZmlsZXNNYXRjaChvdGhlcjogYW55KTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgbWluZSA9IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpO1xuXHRcdHJldHVybiAoXG5cdFx0XHRtaW5lLnByb3ZpZGVyID09PSBvdGhlci5wcm92aWRlciAmJlxuXHRcdFx0bWluZS5tb2RlbElkID09PSBvdGhlci5tb2RlbElkICYmXG5cdFx0XHRtaW5lLmRpbWVuc2lvbnMgPT09IG90aGVyLmRpbWVuc2lvbnMgJiZcblx0XHRcdG1pbmUubm9ybWFsaXplID09PSBvdGhlci5ub3JtYWxpemUgJiZcblx0XHRcdG1pbmUuY2h1bmtpbmdWZXJzaW9uID09PSBvdGhlci5jaHVua2luZ1ZlcnNpb24gJiZcblx0XHRcdG1pbmUuc2NoZW1hVmVyc2lvbiA9PT0gb3RoZXIuc2NoZW1hVmVyc2lvblxuXHRcdCk7XG5cdH1cblxuXHRhc3luYyB2YWxpZGF0ZU1hbmlmZXN0KGRpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3QgbWFuaWZlc3RQYXRoID0gYCR7ZGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG1hbmlmZXN0UGF0aCkpKSByZXR1cm4gdHJ1ZTsgLy8gTm8gbWFuaWZlc3QgeWV0XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobWFuaWZlc3RQYXRoKTtcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0cmV0dXJuIHRoaXMucHJvZmlsZXNNYXRjaChtYW5pZmVzdC5lbWJlZGRpbmdQcm9maWxlKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBhY3F1aXJlTG9jayhkaXI6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGNvbnN0IGxvY2tQYXRoID0gYCR7ZGlyfS9pbmRleC5sb2NrYDtcblx0XHRjb25zdCBteUlkID0gJ3dyaXRpbmctZGFzaGJvYXJkJztcblx0XHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG5cdFx0dHJ5IHtcblx0XHRcdGxldCBleGlzdGluZ0xvY2s6IHsgaG9sZGVyOiBzdHJpbmc7IGFjcXVpcmVkQXQ6IG51bWJlcjsgdXBkYXRlZEF0OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuXG5cdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsb2NrUGF0aCkpIHtcblx0XHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobG9ja1BhdGgpO1xuXHRcdFx0XHR0cnkge1xuXHRcdFx0XHRcdGV4aXN0aW5nTG9jayA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gSW52YWxpZCBKU09OIChsZWdhY3kgc3RyaW5nIGZvcm1hdCkgLSB0cmVhdCBhcyBzdGFsZVxuXHRcdFx0XHRcdGV4aXN0aW5nTG9jayA9IG51bGw7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0aWYgKGV4aXN0aW5nTG9jaykge1xuXHRcdFx0XHRjb25zdCBpc1N0YWxlID0gKG5vdyAtIGV4aXN0aW5nTG9jay51cGRhdGVkQXQpID4gNjAwMDA7XG5cdFx0XHRcdGNvbnN0IGlzU2VsZiA9IGV4aXN0aW5nTG9jay5ob2xkZXIgPT09IG15SWQ7XG5cblx0XHRcdFx0aWYgKCFpc1N0YWxlICYmICFpc1NlbGYpIHtcblx0XHRcdFx0XHQvLyBWYWxpZCBsb2NrIGhlbGQgYnkgYW5vdGhlciBwbHVnaW5cblx0XHRcdFx0XHR0aGlzLmlzUmVhZE9ubHkgPSB0cnVlO1xuXHRcdFx0XHRcdHJldHVybiBmYWxzZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChpc1NlbGYpIHtcblx0XHRcdFx0XHQvLyBSZWZyZXNoOiBwcmVzZXJ2ZSBhY3F1aXJlZEF0LCB1cGRhdGUgdXBkYXRlZEF0XG5cdFx0XHRcdFx0dGhpcy5sb2NrQWNxdWlyZWRBdCA9IGV4aXN0aW5nTG9jay5hY3F1aXJlZEF0O1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdC8vIFN0YWxlIHRha2VvdmVyOiByZXNldCBib3RoIHRpbWVzdGFtcHNcblx0XHRcdFx0XHR0aGlzLmxvY2tBY3F1aXJlZEF0ID0gbm93O1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBOZXcgbG9ja1xuXHRcdFx0XHR0aGlzLmxvY2tBY3F1aXJlZEF0ID0gbm93O1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBXcml0ZSBsb2NrIEpTT05cblx0XHRcdGNvbnN0IGxvY2tEYXRhID0ge1xuXHRcdFx0XHRob2xkZXI6IG15SWQsXG5cdFx0XHRcdGFjcXVpcmVkQXQ6IHRoaXMubG9ja0FjcXVpcmVkQXQsXG5cdFx0XHRcdHVwZGF0ZWRBdDogbm93XG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGxvY2tQYXRoLCBKU09OLnN0cmluZ2lmeShsb2NrRGF0YSkpO1xuXHRcdFx0dGhpcy5pc1JlYWRPbmx5ID0gZmFsc2U7XG5cdFx0XHR0aGlzLnN0YXJ0SGVhcnRiZWF0KGxvY2tQYXRoKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0dGhpcy5pc1JlYWRPbmx5ID0gdHJ1ZTtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIHN0YXJ0SGVhcnRiZWF0KGxvY2tQYXRoOiBzdHJpbmcpIHtcblx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHR0aGlzLmhlYXJ0YmVhdFRpbWVyID0gd2luZG93LnNldEludGVydmFsKGFzeW5jICgpID0+IHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGxvY2tEYXRhID0ge1xuXHRcdFx0XHRcdGhvbGRlcjogJ3dyaXRpbmctZGFzaGJvYXJkJyxcblx0XHRcdFx0XHRhY3F1aXJlZEF0OiB0aGlzLmxvY2tBY3F1aXJlZEF0LFxuXHRcdFx0XHRcdHVwZGF0ZWRBdDogRGF0ZS5ub3coKVxuXHRcdFx0XHR9O1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobG9ja1BhdGgsIEpTT04uc3RyaW5naWZ5KGxvY2tEYXRhKSk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0XHR9XG5cdFx0fSwgMzAwMDApO1xuXHR9XG5cblx0cHJpdmF0ZSBzdG9wSGVhcnRiZWF0KCkge1xuXHRcdGlmICh0aGlzLmhlYXJ0YmVhdFRpbWVyKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuaGVhcnRiZWF0VGltZXIpO1xuXHRcdFx0dGhpcy5oZWFydGJlYXRUaW1lciA9IG51bGw7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgc2VlZFNoYXJlZEluZGV4KHNvdXJjZURpcjogc3RyaW5nLCB0YXJnZXREaXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGAke3RhcmdldERpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0Y29uc3QgaW5kZXhQYXRoID0gYCR7dGFyZ2V0RGlyfS9pbmRleC5qc29uYDtcblxuXHRcdGNvbnN0IGlzRW1wdHkgPSAhKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkgfHwgIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGluZGV4UGF0aCkpO1xuXHRcdGlmICghaXNFbXB0eSkgcmV0dXJuO1xuXG5cdFx0Y29uc3Qgc291cmNlSW5kZXggPSBgJHtzb3VyY2VEaXJ9L2luZGV4Lmpzb25gO1xuXHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHNvdXJjZUluZGV4KSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyh0YXJnZXREaXIpKSkge1xuXHRcdFx0XHRcdC8vIFJlY3Vyc2l2ZSBta2RpclxuXHRcdFx0XHRcdGNvbnN0IHBhcnRzID0gdGFyZ2V0RGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdFx0bGV0IGN1cnJlbnQgPSAnJztcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcblx0XHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0XHRjdXJyZW50ICs9IChjdXJyZW50ID8gJy8nIDogJycpICsgcGFydDtcblx0XHRcdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCkpKSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHNvdXJjZUluZGV4KTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGluZGV4UGF0aCwgY29udGVudCk7XG5cblx0XHRcdFx0Y29uc3QgbWFuaWZlc3QgPSB7XG5cdFx0XHRcdFx0c2NoZW1hVmVyc2lvbjogMixcblx0XHRcdFx0XHRlbWJlZGRpbmdQcm9maWxlOiB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKSxcblx0XHRcdFx0XHRlbmdpbmU6ICdqc29uJ1xuXHRcdFx0XHR9O1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobWFuaWZlc3RQYXRoLCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoJ1tFbWJlZGRpbmdzSW5kZXhdIFNlZWRpbmcgZmFpbGVkOicsIGVycik7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEF0b21pYyBtaWdyYXRpb24gZnJvbSBsZWdhY3kgLm9ic2lkaWFuL2VtYmVkZGluZ3Mvc2hhcmVkLWluZGV4LyB0byBvdmVydCBFbWJlZGRpbmdzL3NoYXJlZC1pbmRleC9cblx0ICogUmV0dXJucyB0cnVlIGlmIG1pZ3JhdGlvbiBzdWNjZWVkZWQgb3Igd2FzIG5vdCBuZWVkZWQsIGZhbHNlIGlmIGZhaWxlZC5cblx0ICovXG5cdGFzeW5jIG1pZ3JhdGVGcm9tTGVnYWN5KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGNvbnN0IG92ZXJ0RGlyID0gJ0VtYmVkZGluZ3Mvc2hhcmVkLWluZGV4Jztcblx0XHRjb25zdCBsZWdhY3lEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vZW1iZWRkaW5ncy9zaGFyZWQtaW5kZXhgO1xuXHRcdGNvbnN0IG92ZXJ0SW5kZXggPSBgJHtvdmVydERpcn0vaW5kZXguanNvbmA7XG5cdFx0Y29uc3QgbGVnYWN5SW5kZXggPSBgJHtsZWdhY3lEaXJ9L2luZGV4Lmpzb25gO1xuXHRcdGNvbnN0IG1pZ3JhdGlvbk1hcmtlciA9IGAke292ZXJ0RGlyfS8ubWlncmF0ZWQtZnJvbS1sZWdhY3lgO1xuXG5cdFx0dHJ5IHtcblx0XHRcdC8vIENoZWNrIGlmIG1pZ3JhdGlvbiBpcyBuZWVkZWRcblx0XHRcdGNvbnN0IG92ZXJ0RXhpc3RzID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhvdmVydEluZGV4KTtcblx0XHRcdGNvbnN0IGxlZ2FjeUV4aXN0cyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobGVnYWN5SW5kZXgpO1xuXG5cdFx0XHQvLyBJZiBvdmVydCBhbHJlYWR5IGV4aXN0cyBvciBsZWdhY3kgZG9lc24ndCBleGlzdCwgbm8gbWlncmF0aW9uIG5lZWRlZFxuXHRcdFx0aWYgKG92ZXJ0RXhpc3RzIHx8ICFsZWdhY3lFeGlzdHMpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cblx0XHRcdC8vIENoZWNrIGlmIGFscmVhZHkgbWlncmF0ZWRcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG1pZ3JhdGlvbk1hcmtlcikpIHtcblx0XHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnNvbGUubG9nKCdbRW1iZWRkaW5nc0luZGV4XSBTdGFydGluZyBhdG9taWMgbWlncmF0aW9uIGZyb20gbGVnYWN5IHRvIG92ZXJ0IGZvbGRlci4uLicpO1xuXG5cdFx0XHQvLyBFbnN1cmUgb3ZlcnQgZm9sZGVyIGV4aXN0c1xuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhvdmVydERpcikpKSB7XG5cdFx0XHRcdGNvbnN0IHBhcnRzID0gb3ZlcnREaXIuc3BsaXQoJy8nKTtcblx0XHRcdFx0bGV0IGN1cnJlbnQgPSAnJztcblx0XHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG5cdFx0XHRcdFx0aWYgKCFwYXJ0KSBjb250aW51ZTtcblx0XHRcdFx0XHRjdXJyZW50ICs9IChjdXJyZW50ID8gJy8nIDogJycpICsgcGFydDtcblx0XHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGN1cnJlbnQpKSkge1xuXHRcdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBBY3F1aXJlIHdyaXRlciBsb2NrIG9uIG92ZXJ0IGZvbGRlclxuXHRcdFx0Y29uc3QgaGFzTG9jayA9IGF3YWl0IHRoaXMuYWNxdWlyZUxvY2sob3ZlcnREaXIpO1xuXHRcdFx0aWYgKCFoYXNMb2NrKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gTGVnYWN5IG1pZ3JhdGlvbiBhYm9ydGVkOiBjb3VsZCBub3QgYWNxdWlyZSBsb2NrIChyZWFkLW9ubHkgbW9kZSkuJyk7XG5cdFx0XHRcdHJldHVybiBmYWxzZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCAxOiBDb3B5IGxlZ2FjeSBmaWxlcyB0byAudG1wIHZlcnNpb25zXG5cdFx0XHRjb25zdCBsZWdhY3lDb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobGVnYWN5SW5kZXgpO1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGAke292ZXJ0SW5kZXh9LnRtcGAsIGxlZ2FjeUNvbnRlbnQpO1xuXG5cdFx0XHRjb25zdCBsZWdhY3lNYW5pZmVzdCA9IGAke2xlZ2FjeURpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0XHRjb25zdCBvdmVydE1hbmlmZXN0ID0gYCR7b3ZlcnREaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdFx0bGV0IGhhc01hbmlmZXN0ID0gZmFsc2U7XG5cdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsZWdhY3lNYW5pZmVzdCkpIHtcblx0XHRcdFx0Y29uc3QgbWFuaWZlc3RDb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobGVnYWN5TWFuaWZlc3QpO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoYCR7b3ZlcnRNYW5pZmVzdH0udG1wYCwgbWFuaWZlc3RDb250ZW50KTtcblx0XHRcdFx0aGFzTWFuaWZlc3QgPSB0cnVlO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDI6IFJlbmFtZSAudG1wIHRvIGNhbm9uaWNhbCAoYXRvbWljIGNvbW1pdClcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW5hbWUoYCR7b3ZlcnRJbmRleH0udG1wYCwgb3ZlcnRJbmRleCk7XG5cdFx0XHRpZiAoaGFzTWFuaWZlc3QpIHtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbmFtZShgJHtvdmVydE1hbmlmZXN0fS50bXBgLCBvdmVydE1hbmlmZXN0KTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCAzOiBXcml0ZSBtaWdyYXRpb24gbWFya2VyXG5cdFx0XHRjb25zdCBtYXJrZXJDb250ZW50ID0gSlNPTi5zdHJpbmdpZnkoe1xuXHRcdFx0XHRtaWdyYXRlZEF0OiBEYXRlLm5vdygpLFxuXHRcdFx0XHRmcm9tOiBsZWdhY3lEaXJcblx0XHRcdH0sIG51bGwsIDIpO1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKG1pZ3JhdGlvbk1hcmtlciwgbWFya2VyQ29udGVudCk7XG5cblx0XHRcdC8vIFN0ZXAgNDogRGlzYWJsZSBsZWdhY3kgYnkgcmVuYW1pbmdcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW5hbWUobGVnYWN5SW5kZXgsIGAke2xlZ2FjeUluZGV4fS5taWdyYXRlZGApO1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobGVnYWN5TWFuaWZlc3QpKSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW5hbWUobGVnYWN5TWFuaWZlc3QsIGAke2xlZ2FjeU1hbmlmZXN0fS5taWdyYXRlZGApO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zb2xlLmxvZygnW0VtYmVkZGluZ3NJbmRleF0g4pyTIEF0b21pYyBtaWdyYXRpb24gY29tcGxldGVkIHN1Y2Nlc3NmdWxseS4nKTtcblx0XHRcdHJldHVybiB0cnVlO1xuXHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBMZWdhY3kgbWlncmF0aW9uIGZhaWxlZDsgZmFsbGluZyBiYWNrIHRvIGlzb2xhdGVkLicsIGVycik7XG5cblx0XHRcdC8vIENsZWFudXAgdGVtcCBmaWxlcyBiZXN0LWVmZm9ydFxuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoYCR7b3ZlcnRJbmRleH0udG1wYCkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVtb3ZlKGAke292ZXJ0SW5kZXh9LnRtcGApO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGAke292ZXJ0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uLnRtcGApKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShgJHtvdmVydERpcn0vaW5kZXgubWFuaWZlc3QuanNvbi50bXBgKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdC8vIGlnbm9yZSBjbGVhbnVwIGVycm9yc1xuXHRcdFx0fVxuXG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZ2V0SW5kZXhGaWxlUGF0aCgpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGRpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0cmV0dXJuIGAke2Rpcn0vaW5kZXguanNvbmA7XG5cdH1cblxuXHRhc3luYyBjbGVhckluZGV4KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7fTtcblx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcblx0XHRjb25zdCBwYXRoID0gYXdhaXQgdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpIHtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUocGF0aCk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcblxuXHRcdHRyeSB7XG5cdFx0XHQvLyBTdGVwIDE6IERldGVybWluZSBtb2RlIGFuZCBhdHRlbXB0IG1pZ3JhdGlvbiBpbiBhdXRvIG1vZGVcblx0XHRcdGNvbnN0IG1vZGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5lbWJlZGRpbmdTdG9yYWdlTW9kZSB8fCAnaXNvbGF0ZWQnO1xuXHRcdFx0aWYgKG1vZGUgPT09ICdhdXRvJykge1xuXHRcdFx0XHQvLyBBdHRlbXB0IGxlZ2FjeSBtaWdyYXRpb24gQkVGT1JFIHJlc29sdmluZyBmaW5hbCBkaXJcblx0XHRcdFx0Y29uc3QgbWlncmF0aW9uU3VjY2VzcyA9IGF3YWl0IHRoaXMubWlncmF0ZUZyb21MZWdhY3koKTtcblx0XHRcdFx0aWYgKCFtaWdyYXRpb25TdWNjZXNzKSB7XG5cdFx0XHRcdFx0Ly8gTWlncmF0aW9uIGZhaWxlZCAobG9ja2VkIGJ5IG90aGVyIHBsdWdpbiBvciBlcnJvcikgLSBmYWxsIGJhY2sgdG8gaXNvbGF0ZWRcblx0XHRcdFx0XHR0aGlzLmN1cnJlbnRTdG9yYWdlTW9kZSA9ICdpc29sYXRlZCc7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBBdXRvIG1vZGU6IG1pZ3JhdGlvbiBmYWlsZWQsIHVzaW5nIGlzb2xhdGVkIG1vZGUuJyk7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCAyOiBSZXNvbHZlIGluZGV4IGRpcmVjdG9yeVxuXHRcdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRcdGNvbnN0IHBhdGggPSBhd2FpdCB0aGlzLmdldEluZGV4RmlsZVBhdGgoKTtcblxuXHRcdFx0Ly8gU3RlcCAzOiBWYWxpZGF0ZSBtYW5pZmVzdFxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YWxpZGF0ZU1hbmlmZXN0KGRpcikpKSB7XG5cdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gTWFuaWZlc3QgbWlzbWF0Y2g7IGZhbGxpbmcgYmFjayB0byBpc29sYXRlZCBtb2RlJyk7XG5cdFx0XHRcdHRoaXMuY3VycmVudFN0b3JhZ2VNb2RlID0gJ2lzb2xhdGVkJzsgLy8gSW50ZXJuYWwgb3ZlcnJpZGUgZm9yIHRoaXMgc2Vzc2lvblxuXHRcdFx0XHQvLyBSZS1yZXNvbHZlIHBhdGggYWZ0ZXIgZmFsbGJhY2tcblx0XHRcdFx0Y29uc3QgbmV3RGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhuZXdEaXIpKSkge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihuZXdEaXIpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgNDogSW4gYXV0by9tYW51YWwsIGFjcXVpcmUgbG9jayBhbmQgc2VlZCBpZiBuZWVkZWRcblx0XHRcdGNvbnN0IHJlc29sdmVkTW9kZSA9IHRoaXMuY3VycmVudFN0b3JhZ2VNb2RlIHx8IG1vZGU7XG5cdFx0XHRpZiAocmVzb2x2ZWRNb2RlICE9PSAnaXNvbGF0ZWQnKSB7XG5cdFx0XHRcdGNvbnN0IHNvdXJjZURpciA9IGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0XHRcdGF3YWl0IHRoaXMuc2VlZFNoYXJlZEluZGV4KHNvdXJjZURpciwgZGlyKTtcblx0XHRcdFx0YXdhaXQgdGhpcy5hY3F1aXJlTG9jayhkaXIpO1xuXHRcdFx0fVxuXG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSkgcmV0dXJuO1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQocGF0aCk7XG5cdFx0XHRjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgUGVyc2lzdGVkSW5kZXhWMTtcblx0XHRcdGlmIChwYXJzZWQ/LnZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocGFyc2VkLmNodW5rcykpIHJldHVybjtcblx0XHRcdGlmIChwYXJzZWQuYmFja2VuZCAmJiBwYXJzZWQuYmFja2VuZCAhPT0gdGhpcy5iYWNrZW5kKSB7XG5cdFx0XHRcdC8vIEJhY2tlbmQgbWlzbWF0Y2g6IGlnbm9yZSBwZXJzaXN0ZWQgaW5kZXggYW5kIHJlYnVpbGQuXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0aWYgKHR5cGVvZiBwYXJzZWQuZGltID09PSAnbnVtYmVyJykge1xuXHRcdFx0XHR0aGlzLmRpbSA9IHBhcnNlZC5kaW07XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleHBlY3RlZENodW5raW5nID0gY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pO1xuXHRcdFx0aWYgKFxuXHRcdFx0XHRwYXJzZWQuY2h1bmtpbmcgJiZcblx0XHRcdFx0KHBhcnNlZC5jaHVua2luZy5oZWFkaW5nTGV2ZWwgIT09IGV4cGVjdGVkQ2h1bmtpbmcuaGVhZGluZ0xldmVsIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLnRhcmdldFdvcmRzICE9PSBleHBlY3RlZENodW5raW5nLnRhcmdldFdvcmRzIHx8XG5cdFx0XHRcdFx0cGFyc2VkLmNodW5raW5nLm92ZXJsYXBXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy5vdmVybGFwV29yZHMpXG5cdFx0XHQpIHtcblx0XHRcdFx0Ly8gQ2h1bmtpbmcgY29uZmlnIGNoYW5nZWQ7IHJlYnVpbGQgaW5kZXguXG5cdFx0XHRcdHRoaXMuZW5xdWV1ZUZ1bGxSZXNjYW4oKTtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXHRcdFx0Zm9yIChjb25zdCBjaHVuayBvZiBwYXJzZWQuY2h1bmtzKSB7XG5cdFx0XHRcdGlmICghY2h1bms/LmtleSB8fCAhY2h1bms/LnBhdGggfHwgIUFycmF5LmlzQXJyYXkoY2h1bmsudmVjdG9yKSkgY29udGludWU7XG5cdFx0XHRcdHRoaXMuX3NldENodW5rKGNodW5rKTtcblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIENvcnJ1cHQgaW5kZXggc2hvdWxkIG5vdCBicmVhayB0aGUgcGx1Z2luLiBXZSdsbCByZWJ1aWxkIGxhemlseS5cblx0XHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmNsZWFyKCk7XG5cdFx0fVxuXHR9XG5cblx0Z2V0U3RhdHVzKCk6IHsgaW5kZXhlZEZpbGVzOiBudW1iZXI7IGluZGV4ZWRDaHVua3M6IG51bWJlcjsgcGF1c2VkOiBib29sZWFuOyBxdWV1ZWQ6IG51bWJlciB9IHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0aW5kZXhlZEZpbGVzOiB0aGlzLmNodW5rS2V5c0J5UGF0aC5zaXplLFxuXHRcdFx0aW5kZXhlZENodW5rczogdGhpcy5jaHVua3NCeUtleS5zaXplLFxuXHRcdFx0cGF1c2VkOiBCb29sZWFuKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSxcblx0XHRcdHF1ZXVlZDogdGhpcy5xdWV1ZS5zaXplXG5cdFx0fTtcblx0fVxuXG5cdGdldFJlY2VudEVycm9ycyhsaW1pdDogbnVtYmVyID0gMjApOiBFcnJvckxvZ0VudHJ5W10ge1xuXHRcdHJldHVybiB0aGlzLmVycm9yTG9nLnNsaWNlKC1saW1pdCk7XG5cdH1cblxuXHRnZXRFcnJvclN1bW1hcnkoKTogeyB0b3RhbDogbnVtYmVyOyBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+OyByZWNlbnQ6IEVycm9yTG9nRW50cnlbXSB9IHtcblx0XHRjb25zdCBieUxvY2F0aW9uOiBSZWNvcmQ8c3RyaW5nLCBudW1iZXI+ID0ge307XG5cdFx0Zm9yIChjb25zdCBlcnIgb2YgdGhpcy5lcnJvckxvZykge1xuXHRcdFx0YnlMb2NhdGlvbltlcnIubG9jYXRpb25dID0gKGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSB8fCAwKSArIDE7XG5cdFx0fVxuXHRcdHJldHVybiB7XG5cdFx0XHR0b3RhbDogdGhpcy5lcnJvckxvZy5sZW5ndGgsXG5cdFx0XHRieUxvY2F0aW9uLFxuXHRcdFx0cmVjZW50OiB0aGlzLmVycm9yTG9nLnNsaWNlKC0xMClcblx0XHR9O1xuXHR9XG5cblx0cHJpdmF0ZSBsb2dFcnJvcihsb2NhdGlvbjogc3RyaW5nLCBjb250ZXh0OiBzdHJpbmcsIGVycm9yOiB1bmtub3duKTogdm9pZCB7XG5cdFx0Y29uc3QgZXJyb3JNc2cgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG5cdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZDtcblx0XHRjb25zdCBlcnJvclR5cGUgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IuY29uc3RydWN0b3IubmFtZSA6IHR5cGVvZiBlcnJvcjtcblx0XHRcblx0XHRjb25zdCBlbnRyeTogRXJyb3JMb2dFbnRyeSA9IHtcblx0XHRcdHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuXHRcdFx0bG9jYXRpb24sXG5cdFx0XHRjb250ZXh0LFxuXHRcdFx0bWVzc2FnZTogZXJyb3JNc2csXG5cdFx0XHRzdGFjazogZXJyb3JTdGFjayxcblx0XHRcdGVycm9yVHlwZVxuXHRcdH07XG5cdFx0XG5cdFx0dGhpcy5lcnJvckxvZy5wdXNoKGVudHJ5KTtcblx0XHRpZiAodGhpcy5lcnJvckxvZy5sZW5ndGggPiB0aGlzLm1heFN0b3JlZEVycm9ycykge1xuXHRcdFx0dGhpcy5lcnJvckxvZy5zaGlmdCgpO1xuXHRcdH1cblx0XHRcblx0XHQvLyBBbHNvIGxvZyB0byBjb25zb2xlIGZvciBkZWJ1Z2dpbmdcblx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBFUlJPUiBbJHtsb2NhdGlvbn1dICR7Y29udGV4dH06YCwgZXJyb3JNc2cpO1xuXHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBTdGFjazpgLCBlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4nKSk7XG5cdFx0fVxuXHR9XG5cblx0ZW5xdWV1ZUZ1bGxSZXNjYW4oKTogdm9pZCB7XG5cdFx0Y29uc3QgZmlsZXMgPSB0aGlzLnBsdWdpbi52YXVsdFNlcnZpY2UuZ2V0SW5jbHVkZWRNYXJrZG93bkZpbGVzKCk7XG5cdFx0Zm9yIChjb25zdCBmIG9mIGZpbGVzKSB0aGlzLnF1ZXVlLmFkZChmLnBhdGgpO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdHF1ZXVlVXBkYXRlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLnF1ZXVlLmFkZChwYXRoKTtcblx0XHR0aGlzLl9zY2hlZHVsZVJlYnVpbGQoKTtcblx0fVxuXG5cdHByaXZhdGUgX3NjaGVkdWxlUmVidWlsZCgpOiB2b2lkIHtcblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGlmICh0aGlzLnJlYnVpbGRUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnJlYnVpbGRUaW1lcik7XG5cdFx0dGhpcy5yZWJ1aWxkVGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnJlYnVpbGRUaW1lciA9IG51bGw7XG5cdFx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdFx0fSwgcG9saWN5LlJFQlVJTERfUVVFVUVfREVCT1VOQ0VfTVMpO1xuXHR9XG5cblx0cXVldWVSZW1vdmVGaWxlKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGlmICghcGF0aCkgcmV0dXJuO1xuXHRcdHRoaXMuX3JlbW92ZVBhdGgocGF0aCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0fVxuXG5cdHByaXZhdGUgX2tpY2tXb3JrZXIoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMud29ya2VyUnVubmluZykgcmV0dXJuO1xuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IHRydWU7XG5cdFx0Ly8gRmlyZSBhbmQgZm9yZ2V0LCBidXQgZW5zdXJlIGVycm9ycyBhcmUgc3dhbGxvd2VkLlxuXHRcdHZvaWQgdGhpcy5fcnVuV29ya2VyKCkuY2F0Y2goKCkgPT4ge1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0fSk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9ydW5Xb3JrZXIoKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVMb2FkZWQoKTtcblxuXHRcdGlmICh0aGlzLmlzUmVhZE9ubHkpIHtcblx0XHRcdGNvbnNvbGUubG9nKCdbRW1iZWRkaW5nc0luZGV4XSBTaGFyZWQgaW5kZXggbG9ja2VkOyBvcGVyYXRpbmcgcmVhZC1vbmx5LicpO1xuXHRcdFx0dGhpcy53b3JrZXJSdW5uaW5nID0gZmFsc2U7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gSWYgT2xsYW1hIGlzIG5vdCBhdmFpbGFibGUsIHNraXAgc2VtYW50aWMgaW5kZXhpbmcgdG8gYXZvaWQgZmFpbHVyZXMuXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xuXHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBPbGxhbWEgbm90IGF2YWlsYWJsZTsgc2tpcHBpbmcgc2VtYW50aWMgaW5kZXhpbmcnKTtcblx0XHRcdG5ldyBOb3RpY2UoJ+KaoO+4jyBPbGxhbWEgbm90IGF2YWlsYWJsZSAtIGluZGV4aW5nIHNraXBwZWQnKTtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IHBvbGljeSA9IENPX0FVVEhPUklOR19QT0xJQ1kuUEVSRk9STUFOQ0U7XG5cdFx0Y29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblx0XHRjb25zdCB0b3RhbEZpbGVzID0gdGhpcy5xdWV1ZS5zaXplO1xuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xuXG5cdFx0Ly8gRW1pdCBzdGFydCBldmVudCBhbmQgbm90aWZpY2F0aW9uXG5cdFx0aWYgKHRvdGFsRmlsZXMgPiAwKSB7XG5cdFx0XHRuZXcgTm90aWNlKGDwn5SNIFN0YXJ0aW5nIGluZGV4IHNjYW4gKCR7dG90YWxGaWxlc30gZmlsZXMpLi4uYCk7XG5cdFx0XHRyZWxheUV2ZW50QnVzLmVtaXQoJ2luZGV4OnN0YXJ0JywgeyB0b3RhbEZpbGVzIH0pO1xuXHRcdH1cblx0XHRcblx0XHR3aGlsZSAodGhpcy5xdWV1ZS5zaXplID4gMCAmJiBpbmRleGVkQ291bnQgPCBwb2xpY3kuTUFYX1JFQlVJTERTX1BFUl9CQVRDSCkge1xuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSBicmVhaztcblx0XHRcdGNvbnN0IG5leHQgPSB0aGlzLnF1ZXVlLnZhbHVlcygpLm5leHQoKS52YWx1ZSBhcyBzdHJpbmc7XG5cdFx0XHR0aGlzLnF1ZXVlLmRlbGV0ZShuZXh0KTtcblx0XHRcdHByb2Nlc3NlZENvdW50Kys7XG5cblx0XHRcdC8vIEVtaXQgcHJvZ3Jlc3MgZXZlcnkgMTAgZmlsZXNcblx0XHRcdGlmIChwcm9jZXNzZWRDb3VudCAlIDEwID09PSAwKSB7XG5cdFx0XHRcdG5ldyBOb3RpY2UoYEluZGV4aW5nLi4uICR7cHJvY2Vzc2VkQ291bnR9LyR7dG90YWxGaWxlc30gZmlsZXNgKTtcblx0XHRcdFx0cmVsYXlFdmVudEJ1cy5lbWl0KCdpbmRleDpwcm9ncmVzcycsIHsgcHJvY2Vzc2VkOiBwcm9jZXNzZWRDb3VudCwgdG90YWw6IHRvdGFsRmlsZXMsIGN1cnJlbnRGaWxlOiBuZXh0IH0pO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBFeGNsdXNpb25zIGNhbiBjaGFuZ2UgYXQgYW55IHRpbWU7IGhvbm9yIHRoZW0gZHVyaW5nIHByb2Nlc3NpbmcuXG5cdFx0XHRpZiAodGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKG5leHQpKSB7XG5cdFx0XHRcdHNraXBwZWRFeGNsdWRlZCsrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChuZXh0KTtcblx0XHRcdC8vIE9ubHkgaW5kZXggbWFya2Rvd24gZmlsZXMuXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSB7XG5cdFx0XHRcdHNraXBwZWROb3RNYXJrZG93bisrO1xuXHRcdFx0XHR0aGlzLl9yZW1vdmVQYXRoKG5leHQpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRDb250ZW50ID0gbm9ybWFsaXplQ2h1bmtUZXh0KGNvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBmaWxlSGFzaCA9IGF3YWl0IHNoYTI1Nihub3JtYWxpemVkQ29udGVudCk7XG5cdFx0XHRcdGNvbnN0IHByZXYgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bbmV4dF07XG5cdFx0XHRcdGNvbnN0IGlzQ3VycmVudGx5SW5kZXhlZCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmhhcyhuZXh0KTtcblx0XHRcdFx0XG5cdFx0XHRcdC8vIFNraXAgb25seSBpZjogaGFzaCBtYXRjaGVzIEFORCBmaWxlIGlzIGFscmVhZHkgaW5kZXhlZFxuXHRcdFx0XHQvLyBJZiBoYXNoIG1hdGNoZXMgYnV0IGZpbGUgaXMgTk9UIGluZGV4ZWQsIHJlLWluZGV4IGl0IChtaWdodCBoYXZlIGJlZW4gcmVtb3ZlZClcblx0XHRcdFx0aWYgKHByZXY/Lmhhc2ggPT09IGZpbGVIYXNoICYmIGlzQ3VycmVudGx5SW5kZXhlZCkge1xuXHRcdFx0XHRcdHNraXBwZWRIYXNoTWF0Y2grKztcblx0XHRcdFx0XHRjb250aW51ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGF3YWl0IHRoaXMuX3JlaW5kZXhGaWxlKG5leHQsIGNvbnRlbnQpO1xuXHRcdFx0XHRpbmRleGVkQ291bnQrKztcblx0XHRcdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSA9IHtcblx0XHRcdFx0XHQuLi4odGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZSB8fCB7fSksXG5cdFx0XHRcdFx0W25leHRdOiB7XG5cdFx0XHRcdFx0XHRoYXNoOiBmaWxlSGFzaCxcblx0XHRcdFx0XHRcdGNodW5rQ291bnQ6IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChuZXh0KT8uc2l6ZSA/PyAwLFxuXHRcdFx0XHRcdFx0dXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKClcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH07XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdC8vIFNraXAgdW5yZWFkYWJsZSBmaWxlcywgYnV0IGxvZyBmb3IgZGVidWdnaW5nXG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19ydW5Xb3JrZXInLCBgUHJvY2Vzc2luZyBmaWxlOiAke25leHR9YCwgZXJyKTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gWWllbGQgdG8ga2VlcCBVSSByZXNwb25zaXZlLlxuXHRcdFx0YXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTApKTtcblx0XHR9XG5cblx0XHQvLyBDYWxjdWxhdGUgZHVyYXRpb24gYW5kIGVtaXQgY29tcGxldGlvblxuXHRcdGNvbnN0IGR1cmF0aW9uID0gKERhdGUubm93KCkgLSBzdGFydFRpbWUpIC8gMTAwMDtcblx0XHRjb25zdCB0b3RhbFNraXBwZWQgPSBza2lwcGVkRXhjbHVkZWQgKyBza2lwcGVkTm90TWFya2Rvd24gKyBza2lwcGVkSGFzaE1hdGNoO1xuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHRcdG5ldyBOb3RpY2UoYOKchSBJbmRleGVkICR7aW5kZXhlZENvdW50fSBmaWxlcyBpbiAke2R1cmF0aW9uLnRvRml4ZWQoMSl9cyAoJHt0aGlzLmNodW5rc0J5S2V5LnNpemV9IGNodW5rcyB0b3RhbClgKTtcblx0XHRcdHJlbGF5RXZlbnRCdXMuZW1pdCgnaW5kZXg6Y29tcGxldGUnLCB7IFxuXHRcdFx0XHRpbmRleGVkOiBpbmRleGVkQ291bnQsIFxuXHRcdFx0XHRjaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSwgXG5cdFx0XHRcdGR1cmF0aW9uLFxuXHRcdFx0XHRza2lwcGVkOiB0b3RhbFNraXBwZWRcblx0XHRcdH0pO1xuXHRcdH1cblxuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcmVpbmRleEZpbGUocGF0aDogc3RyaW5nLCBjb250ZW50OiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXG5cdFx0Ly8gSWYgT2xsYW1hIGlzIG5vdCBhdmFpbGFibGUsIHNraXAgc2VtYW50aWMgaW5kZXhpbmcgZm9yIHRoaXMgZmlsZS5cblx0XHRpZiAoIShhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmlzQXZhaWxhYmxlKCkpKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE9sbGFtYSBub3QgYXZhaWxhYmxlOyBza2lwcGluZyBmaWxlOiAke3BhdGh9YCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0Ly8gU2tpcCBlbXB0eSBmaWxlc1xuXHRcdGlmICghY29udGVudCB8fCBjb250ZW50LnRyaW0oKS5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gU2tpcHBpbmcgZW1wdHkgZmlsZTogJHtwYXRofWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGNmZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcblx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2luZyBmaWxlOiAke3BhdGh9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBCYWNrZW5kOiAke3RoaXMuYmFja2VuZH1gKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENvbnRlbnQgbGVuZ3RoOiAke2NvbnRlbnQubGVuZ3RofSBjaGFycywgJHtjb250ZW50LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3Jkc2ApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQ2h1bmtpbmcgY29uZmlnOiBoZWFkaW5nTGV2ZWw9JHtjZmcuaGVhZGluZ0xldmVsfSwgdGFyZ2V0V29yZHM9JHtjZmcudGFyZ2V0V29yZHN9LCBvdmVybGFwV29yZHM9JHtjZmcub3ZlcmxhcFdvcmRzfWApO1xuXHRcdFxuXHRcdGNvbnN0IGNodW5rcyA9IGJ1aWxkSW5kZXhDaHVua3Moe1xuXHRcdFx0dGV4dDogY29udGVudCxcblx0XHRcdGhlYWRpbmdMZXZlbDogY2ZnLmhlYWRpbmdMZXZlbCxcblx0XHRcdHRhcmdldFdvcmRzOiBjZmcudGFyZ2V0V29yZHMsXG5cdFx0XHRvdmVybGFwV29yZHM6IGNmZy5vdmVybGFwV29yZHNcblx0XHR9KTtcblx0XHRcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5rcyBjcmVhdGVkOiAke2NodW5rcy5sZW5ndGh9YCk7XG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgICAtIEZpcnN0IGNodW5rIHByZXZpZXc6ICR7Y2h1bmtzWzBdLnRleHQuc3Vic3RyaW5nKDAsIDEwMCl9Li4uYCk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIElmIG5vIGNodW5rcyBjcmVhdGVkLCBza2lwIHRoaXMgZmlsZSAobWlnaHQgYmUgdG9vIHNob3J0IG9yIGhhdmUgbm8gaGVhZGluZ3MpXG5cdFx0aWYgKGNodW5rcy5sZW5ndGggPT09IDApIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gTm8gY2h1bmtzIGNyZWF0ZWQgZm9yICR7cGF0aH0gLSBmaWxlIHRvbyBzaG9ydCBvciBubyBoZWFkaW5ncyBtYXRjaCBjaHVua2luZyBjb25maWdgKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRsZXQgc3VjY2Vzc2Z1bENodW5rcyA9IDA7XG5cdFx0bGV0IGZpcnN0RXJyb3I6IEVycm9yIHwgbnVsbCA9IG51bGw7XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBjaHVua3MubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IGNoID0gY2h1bmtzW2ldO1xuXHRcdFx0Y29uc3Qgbm9ybWFsaXplZFRleHQgPSBub3JtYWxpemVDaHVua1RleHQoY2gudGV4dCk7XG5cdFx0XHRjb25zdCB0ZXh0SGFzaCA9IGF3YWl0IHNoYTI1Nihub3JtYWxpemVkVGV4dCk7XG5cdFx0XHRjb25zdCBrZXkgPSBgY2h1bms6JHtwYXRofToke2l9YDtcblx0XHRcdGxldCB2ZWN0b3I6IG51bWJlcltdO1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0Y29uc29sZS5sb2coYCAgLSBHZW5lcmF0aW5nIGVtYmVkZGluZyBmb3IgY2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcykuLi5gKTtcblx0XHRcdFx0Y29uc3QgZW1iZWRTdGFydCA9IERhdGUubm93KCk7XG5cdFx0XHRcdHZlY3RvciA9IGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuZ2V0RW1iZWRkaW5nKG5vcm1hbGl6ZWRUZXh0KTtcblx0XHRcdFx0dGhpcy5haUVycm9yU3RyZWFrID0gMDsgLy8gU3VjY2VzczogcmVzZXQgc3RyZWFrXG5cdFx0XHRcdGlmICghQXJyYXkuaXNBcnJheSh2ZWN0b3IpIHx8IHZlY3Rvci5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmICh0aGlzLmRpbSA9PT0gMCkge1xuXHRcdFx0XHRcdHRoaXMuZGltID0gdmVjdG9yLmxlbmd0aDtcblx0XHRcdFx0fVxuXHRcdFx0XHRjb25zdCBlbWJlZER1cmF0aW9uID0gRGF0ZS5ub3coKSAtIGVtYmVkU3RhcnQ7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0g4pyTIE9sbGFtYSBlbWJlZGRpbmcgZ2VuZXJhdGVkIGluICR7ZW1iZWREdXJhdGlvbn1tczogJHt2ZWN0b3IubGVuZ3RofSBkaW1lbnNpb25zYCk7XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0dGhpcy5haUVycm9yU3RyZWFrKys7XG5cdFx0XHRcdGNvbnN0IGVycm9yTXNnID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuXHRcdFx0XHRjb25zdCBlcnJvclN0YWNrID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0XHRcdGNvbnN0IGNvbnRleHQgPSBgRmlsZTogJHtwYXRofSwgQ2h1bmsgJHtpICsgMX0vJHtjaHVua3MubGVuZ3RofSAoJHtjaC50ZXh0LnNwbGl0KC9cXHMrLykubGVuZ3RofSB3b3JkcywgJHtjaC50ZXh0Lmxlbmd0aH0gY2hhcnMpYDtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmVtYmVkQ2h1bmsnLCBjb250ZXh0LCBlcnIpO1xuXHRcdFx0XHRcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAtIOKclyBFbWJlZGRpbmcgZ2VuZXJhdGlvbiBmYWlsZWQgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH06YCwgZXJyb3JNc2cpO1xuXHRcdFx0XHRcblx0XHRcdFx0aWYgKHRoaXMuYWlFcnJvclN0cmVhayA+PSAzKSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBFbWJlZGRpbmcgYnJlYWtlciB0cmlnZ2VyZWQ6IHBhdXNlZCAxNXMgYW5kIGNsZWFyZWQgcXVldWUgYWZ0ZXIgMyBjb25zZWN1dGl2ZSBmYWlsdXJlcy4nKTtcblx0XHRcdFx0XHR0aGlzLnF1ZXVlLmNsZWFyKCk7XG5cdFx0XHRcdFx0dGhpcy5haUVycm9yU3RyZWFrID0gMDtcblx0XHRcdFx0XHQvLyBZaWVsZCBhbmQgd2FpdCAxNXNcblx0XHRcdFx0XHRhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMTUwMDApKTtcblx0XHRcdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtYmVkZGluZyBicmVha2VyIHRyaWdnZXJlZDsgYmF0Y2ggYWJvcnRlZC4nKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmIChlcnJvclN0YWNrKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIFN0YWNrOiAke2Vycm9yU3RhY2suc3BsaXQoJ1xcbicpLnNsaWNlKDAsIDMpLmpvaW4oJ1xcbiAgICAnKX1gKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoZXJyIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgRXJyb3IgdHlwZTogJHtlcnIuY29uc3RydWN0b3IubmFtZX1gKTtcblx0XHRcdFx0XHRpZiAoJ2NhdXNlJyBpbiBlcnIpIHtcblx0XHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBDYXVzZTogJHtlcnIuY2F1c2V9YCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIElmIEFMTCBjaHVua3MgZmFpbCBmb3IgYSBmaWxlLCB0aGUgZmlsZSB3b24ndCBiZSBpbmRleGVkXG5cdFx0XHRcdC8vIFRoaXMgaXMgYSBjcml0aWNhbCBmYWlsdXJlIHRoYXQgc2hvdWxkIGJlIGxvZ2dlZFxuXHRcdFx0XHRpZiAoaSA9PT0gMCkge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybihgICAtIFdhcm5pbmc6IEZpcnN0IGNodW5rIGZhaWxlZCBmb3IgJHtwYXRofS4gQXR0ZW1wdGluZyBzdWJzZXF1ZW50IGNodW5rcy5gKTtcblx0XHRcdFx0XHRmaXJzdEVycm9yID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIgOiBuZXcgRXJyb3IoU3RyaW5nKGVycikpO1xuXHRcdFx0XHR9XG5cdFx0XHRcdC8vIFNraXAgdGhpcyBjaHVuayBpZiBlbWJlZGRpbmcgZmFpbHMsIGJ1dCBjb250aW51ZSB3aXRoIG90aGVyc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBleGNlcnB0T2YoY2gudGV4dCwgMjUwMCk7XG5cdFx0XHR0aGlzLl9zZXRDaHVuayh7XG5cdFx0XHRcdGtleSxcblx0XHRcdFx0cGF0aCxcblx0XHRcdFx0Y2h1bmtJbmRleDogaSxcblx0XHRcdFx0c3RhcnRXb3JkOiBjaC5zdGFydFdvcmQsXG5cdFx0XHRcdGVuZFdvcmQ6IGNoLmVuZFdvcmQsXG5cdFx0XHRcdHRleHRIYXNoLFxuXHRcdFx0XHR2ZWN0b3IsXG5cdFx0XHRcdGV4Y2VycHRcblx0XHRcdH0pO1xuXHRcdFx0c3VjY2Vzc2Z1bENodW5rcysrO1xuXHRcdH1cblx0XHRcblx0XHRpZiAoc3VjY2Vzc2Z1bENodW5rcyA9PT0gMCAmJiBjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc3QgY3JpdGljYWxDb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIEFsbCAke2NodW5rcy5sZW5ndGh9IGNodW5rcyBmYWlsZWRgO1xuXHRcdFx0aWYgKGZpcnN0RXJyb3IpIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgZmlyc3RFcnJvcik7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYFtFbWJlZGRpbmdzSW5kZXhdIENSSVRJQ0FMOiBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkIGZvciAke3BhdGh9IC0gZmlsZSBub3QgaW5kZXhlZGApO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGAgIFJvb3QgY2F1c2U6ICR7Zmlyc3RFcnJvci5tZXNzYWdlfWApO1xuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0dGhpcy5sb2dFcnJvcignX3JlaW5kZXhGaWxlLmFsbENodW5rc0ZhaWxlZCcsIGNyaXRpY2FsQ29udGV4dCwgbmV3IEVycm9yKCdBbGwgY2h1bmtzIGZhaWxlZCBidXQgbm8gZmlyc3QgZXJyb3IgY2FwdHVyZWQnKSk7XG5cdFx0XHR9XG5cdFx0fSBlbHNlIGlmIChzdWNjZXNzZnVsQ2h1bmtzIDwgY2h1bmtzLmxlbmd0aCkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBQYXJ0aWFsIHN1Y2Nlc3MgZm9yICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30vJHtjaHVua3MubGVuZ3RofSBjaHVua3MgaW5kZXhlZGApO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0g4pyTIFN1Y2Nlc3NmdWxseSBpbmRleGVkICR7cGF0aH06ICR7c3VjY2Vzc2Z1bENodW5rc30gY2h1bmtzYCk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2V0Q2h1bmsoY2h1bms6IEluZGV4ZWRDaHVuayk6IHZvaWQge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuc2V0KGNodW5rLmtleSwgY2h1bmspO1xuXHRcdGNvbnN0IHNldCA9IHRoaXMuY2h1bmtLZXlzQnlQYXRoLmdldChjaHVuay5wYXRoKSA/PyBuZXcgU2V0PHN0cmluZz4oKTtcblx0XHRzZXQuYWRkKGNodW5rLmtleSk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguc2V0KGNodW5rLnBhdGgsIHNldCk7XG5cdH1cblxuXHRwcml2YXRlIF9yZW1vdmVQYXRoKHBhdGg6IHN0cmluZyk6IHZvaWQge1xuXHRcdGNvbnN0IGtleXMgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQocGF0aCk7XG5cdFx0aWYgKGtleXMpIHtcblx0XHRcdGZvciAoY29uc3QgayBvZiBrZXlzKSB0aGlzLmNodW5rc0J5S2V5LmRlbGV0ZShrKTtcblx0XHR9XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguZGVsZXRlKHBhdGgpO1xuXG5cdFx0aWYgKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGU/LltwYXRoXSkge1xuXHRcdFx0Y29uc3QgbmV4dCA9IHsgLi4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pIH07XG5cdFx0XHRkZWxldGUgbmV4dFtwYXRoXTtcblx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSBuZXh0O1xuXHRcdH1cblx0fVxuXG5cdGdldEFsbENodW5rcygpOiBJbmRleGVkQ2h1bmtbXSB7XG5cdFx0cmV0dXJuIEFycmF5LmZyb20odGhpcy5jaHVua3NCeUtleS52YWx1ZXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ29tcHV0ZXMgYSBiaXQtcGVyZmVjdCBjb3JwdXMgaGFzaCBmb3Igc3RyaWN0IHJlcGxheS5cblx0ICogc2hhMjU2KGpvaW4oc29ydChjaHVua19pZCArIFwiOlwiICsgY29udGVudF9oYXNoKSwgXCJcXG5cIikpXG5cdCAqL1xuXHRhc3luYyBnZXRDb3JwdXNIYXNoKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgY2h1bmtzID0gdGhpcy5nZXRBbGxDaHVua3MoKTtcblx0XHRjb25zdCBsaW5lcyA9IGNodW5rcy5tYXAoYyA9PiBgJHtjLmtleX06JHtjLnRleHRIYXNofWApO1xuXHRcdGxpbmVzLnNvcnQoKTtcblx0XHRjb25zdCBqb2luZWQgPSBsaW5lcy5qb2luKCdcXG4nKTtcblx0XHRyZXR1cm4gYXdhaXQgc2hhMjU2KGpvaW5lZCk7XG5cdH1cblxuXHRnZXRJbmRleGVkUGF0aHMoKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtLZXlzQnlQYXRoLmtleXMoKSk7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2tzIGlmIGEgcGF0aCBpcyBjdXJyZW50bHkgbWFya2VkIGFzIHN0YWxlIGluIHRoZSBpbmRleCBzdGF0ZS5cblx0ICovXG5cdGlzU3RhbGUocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0Y29uc3Qgc3RhdGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF07XG5cdFx0aWYgKCFzdGF0ZSkgcmV0dXJuIGZhbHNlO1xuXHRcdFxuXHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcblx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSByZXR1cm4gdHJ1ZTsgLy8gTWlzc2luZyBmaWxlIGlzIGVmZmVjdGl2ZWx5IHN0YWxlXG5cdFx0XG5cdFx0Ly8gSWYgdXBkYXRlZEF0IGlzIG5vdCBzZXQsIHdlIGNhbid0IGJlIHN1cmUsIGFzc3VtZSBub3Qgc3RhbGUgZm9yIG5vd1xuXHRcdGlmICghc3RhdGUudXBkYXRlZEF0KSByZXR1cm4gZmFsc2U7XG5cdFx0XG5cdFx0Y29uc3QgZmlsZU10aW1lID0gZmlsZS5zdGF0Lm10aW1lO1xuXHRcdGNvbnN0IGluZGV4VGltZSA9IG5ldyBEYXRlKHN0YXRlLnVwZGF0ZWRBdCkuZ2V0VGltZSgpO1xuXHRcdFxuXHRcdHJldHVybiBmaWxlTXRpbWUgPiBpbmRleFRpbWU7XG5cdH1cblxuXHQvKipcblx0ICogUXVldWUgYWxsIGN1cnJlbnRseSBpbmRleGVkIHBhdGhzIGZvciByZS1jaGVja2luZy4gVGhpcyBpcyB1c2VmdWwgd2hlbiBleGNsdXNpb25zL3Byb2ZpbGVzIGNoYW5nZS5cblx0ICovXG5cdHF1ZXVlUmVjaGVja0FsbEluZGV4ZWQoKTogdm9pZCB7XG5cdFx0Zm9yIChjb25zdCBwIG9mIHRoaXMuZ2V0SW5kZXhlZFBhdGhzKCkpIHRoaXMucXVldWUuYWRkKHApO1xuXHRcdHRoaXMuX2tpY2tXb3JrZXIoKTtcblx0fVxuXG5cdGdldFZlY3RvckZvcktleShrZXk6IHN0cmluZyk6IG51bWJlcltdIHwgbnVsbCB7XG5cdFx0Y29uc3QgY2ggPSB0aGlzLmNodW5rc0J5S2V5LmdldChrZXkpO1xuXHRcdHJldHVybiBjaD8udmVjdG9yID8/IG51bGw7XG5cdH1cblxuXHRidWlsZFF1ZXJ5VmVjdG9yKHF1ZXJ5VGV4dDogc3RyaW5nKTogbnVtYmVyW10ge1xuXHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gYnVpbGRRdWVyeVZlY3RvciBjYWxsZWQ7IHJldHVybmluZyBlbXB0eSB2ZWN0b3IuIFVzZSBlbWJlZFF1ZXJ5VmVjdG9yIGluc3RlYWQuJyk7XG5cdFx0cmV0dXJuIFtdO1xuXHR9XG5cblx0YXN5bmMgZW1iZWRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IFByb21pc2U8bnVtYmVyW10+IHtcblx0XHRjb25zdCB2ZWMgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhxdWVyeVRleHQpO1xuXHRcdGlmICghQXJyYXkuaXNBcnJheSh2ZWMpIHx8IHZlYy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRocm93IG5ldyBFcnJvcignRW1wdHkgZW1iZWRkaW5nIHJldHVybmVkIGZyb20gT2xsYW1hJyk7XG5cdFx0fVxuXHRcdHJldHVybiB2ZWM7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVBlcnNpc3QoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMucGVyc2lzdFRpbWVyKSB3aW5kb3cuY2xlYXJUaW1lb3V0KHRoaXMucGVyc2lzdFRpbWVyKTtcblx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMucGVyc2lzdFRpbWVyID0gbnVsbDtcblx0XHRcdHZvaWQgdGhpcy5fcGVyc2lzdE5vdygpLmNhdGNoKCgpID0+IHtcblx0XHRcdFx0Ly8gaWdub3JlXG5cdFx0XHR9KTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3BlcnNpc3ROb3coKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0aWYgKHRoaXMuaXNSZWFkT25seSkge1xuXHRcdFx0Y29uc29sZS5sb2coJ1tFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIHBlcnNpc3RlbmNlOiBSZWFkLU9ubHkgbW9kZScpO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdGNvbnN0IGRpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0dHJ5IHtcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoZGlyKSkpIHtcblx0XHRcdFx0Ly8gUmVjdXJzaXZlIG1rZGlyXG5cdFx0XHRcdGNvbnN0IHBhcnRzID0gZGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0Y3VycmVudCArPSAoY3VycmVudCA/ICcvJyA6ICcnKSArIHBhcnQ7XG5cdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIGlnbm9yZSBta2RpciBmYWlsdXJlc1xuXHRcdH1cblxuXHRcdGNvbnN0IHBheWxvYWQ6IFBlcnNpc3RlZEluZGV4VjEgPSB7XG5cdFx0XHR2ZXJzaW9uOiAxLFxuXHRcdFx0ZGltOiB0aGlzLmRpbSxcblx0XHRcdGJhY2tlbmQ6IHRoaXMuYmFja2VuZCxcblx0XHRcdGNodW5raW5nOiBjaHVua2luZ0tleSh0aGlzLnBsdWdpbiksXG5cdFx0XHRjaHVua3M6IHRoaXMuZ2V0QWxsQ2h1bmtzKClcblx0XHR9O1xuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShhd2FpdCB0aGlzLmdldEluZGV4RmlsZVBhdGgoKSwgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCkpO1xuXG5cdFx0Ly8gRW5zdXJlIG1hbmlmZXN0IGV4aXN0cyBpbiB0aGUgaW5kZXggZGlyZWN0b3J5XG5cdFx0Y29uc3QgbWFuaWZlc3RQYXRoID0gYCR7ZGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG1hbmlmZXN0UGF0aCkpKSB7XG5cdFx0XHRjb25zdCBtYW5pZmVzdCA9IHtcblx0XHRcdFx0c2NoZW1hVmVyc2lvbjogMixcblx0XHRcdFx0ZW1iZWRkaW5nUHJvZmlsZTogdGhpcy5nZXRFbWJlZGRpbmdQcm9maWxlKCksXG5cdFx0XHRcdGVuZ2luZTogJ2pzb24nXG5cdFx0XHR9O1xuXHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKG1hbmlmZXN0UGF0aCwgSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QsIG51bGwsIDIpKTtcblx0XHR9XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVNldHRpbmdzU2F2ZSgpOiB2b2lkIHtcblx0XHRpZiAodGhpcy5zZXR0aW5nc1NhdmVUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnNldHRpbmdzU2F2ZVRpbWVyKTtcblx0XHR0aGlzLnNldHRpbmdzU2F2ZVRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpLmNhdGNoKCgpID0+IHtcblx0XHRcdFx0Ly8gaWdub3JlXG5cdFx0XHR9KTtcblx0XHR9LCAxMDAwKTtcblx0fVxuXHRcbn1cblxuXG4iXX0=