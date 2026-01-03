import { TFile } from 'obsidian';
import { buildIndexChunks } from './Chunking';
import { sha256 } from '../ContentHash';
import { CO_AUTHORING_POLICY } from '../policy';
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
            this.workerRunning = false;
            return;
        }
        const policy = CO_AUTHORING_POLICY.PERFORMANCE;
        let processedCount = 0;
        let skippedExcluded = 0;
        let skippedNotMarkdown = 0;
        let skippedHashMatch = 0;
        let indexedCount = 0;
        while (this.queue.size > 0 && indexedCount < policy.MAX_REBUILDS_PER_BATCH) {
            if (this.plugin.settings.retrievalIndexPaused)
                break;
            const next = this.queue.values().next().value;
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
        // Log indexing stats for debugging
        if (processedCount > 0) {
            console.log(`[EmbeddingsIndex] Processed ${processedCount} files: ${indexedCount} indexed, ${skippedExcluded} excluded, ${skippedNotMarkdown} not markdown, ${skippedHashMatch} hash match (already indexed)`);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBVyxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFhaEQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEdBQUcsRUFBRSxH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QU0sQ0FBQyxZQUFZLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDdEQsTUFBTSxRQUFRLEdBQUc7Z0JBQ2hCLGFBQWEsRUFBRSxDQUFDO2dCQUNoQixnQkFBZ0IsRUFBRSxJQUFJLENBQUMsbUJBQW1CLEVBQUU7Z0JBQzVDLE1BQU0sRUFBRSxNQUFNO2FBQ2QsQ0FBQztZQUNGLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUNqRixDQUFDO0lBQ0YsQ0FBQztJQUVPLHFCQUFxQjtRQUM1QixJQUFJLElBQUksQ0FBQyxpQkFBaUI7WUFBRSxNQUFNLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDO1FBQ3hFLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRTtZQUMvQyxJQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDO1lBQzlCLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxZQUFZLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFO2dCQUMxQyxTQUFTO1lBQ1YsQ0FBQyxDQUFDLENBQUM7UUFDSixDQUFDLEVBQUUsSUFBSSxDQUFDLENBQUM7SUFDVixDQUFDO0NBRUQiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IFZhdWx0IH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgVEZpbGUgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcbmltcG9ydCB7IGJ1aWxkSW5kZXhDaHVua3MgfSBmcm9tICcuL0NodW5raW5nJztcbmltcG9ydCB7IGZudjFhMzIsIHNoYTI1NiB9IGZyb20gJy4uL0NvbnRlbnRIYXNoJztcbmltcG9ydCB7IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyIH0gZnJvbSAnLi9PbGxhbWFFbWJlZGRpbmdQcm92aWRlcic7XG5pbXBvcnQgeyBDT19BVVRIT1JJTkdfUE9MSUNZIH0gZnJvbSAnLi4vcG9saWN5JztcblxuZXhwb3J0IGludGVyZmFjZSBJbmRleGVkQ2h1bmsge1xuXHRrZXk6IHN0cmluZztcblx0cGF0aDogc3RyaW5nO1xuXHRjaHVua0luZGV4OiBudW1iZXI7XG5cdHN0YXJ0V29yZDogbnVtYmVyO1xuXHRlbmRXb3JkOiBudW1iZXI7XG5cdHRleHRIYXNoOiBzdHJpbmc7IC8vIFNIQS0yNTZcblx0dmVjdG9yOiBudW1iZXJbXTtcblx0ZXhjZXJwdDogc3RyaW5nO1xufVxuXG4vKipcbiAqIFN0YWJsZSBub3JtYWxpemF0aW9uIGZvciBiaXQtcGVyZmVjdCBoYXNoIGNvbnRpbnVpdHkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVDaHVua1RleHQodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHRleHRcblx0XHQudHJpbSgpXG5cdFx0LnJlcGxhY2UoL1xcclxcbi9nLCAnXFxuJykgLy8gTm9ybWFsaXplIG5ld2xpbmVzXG5cdFx0LnJlcGxhY2UoL1xcci9nLCAnXFxuJylcblx0XHQucmVwbGFjZSgvWyBcXHRdKy9nLCAnICcpOyAvLyBOb3JtYWxpemUgc3BhY2VzL3RhYnNcbn1cblxuaW50ZXJmYWNlIFBlcnNpc3RlZEluZGV4VjEge1xuXHR2ZXJzaW9uOiAxO1xuXHRkaW06IG51bWJlcjtcblx0YmFja2VuZDogJ29sbGFtYSc7XG5cdGNodW5raW5nPzogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfTtcblx0Y2h1bmtzOiBJbmRleGVkQ2h1bmtbXTtcbn1cblxuZnVuY3Rpb24gY2xhbXBJbnQodmFsdWU6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcblx0aWYgKCFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSByZXR1cm4gbWluO1xuXHRyZXR1cm4gTWF0aC5tYXgobWluLCBNYXRoLm1pbihtYXgsIE1hdGguZmxvb3IodmFsdWUpKSk7XG59XG5cbmZ1bmN0aW9uIGNodW5raW5nS2V5KHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbik6IHsgaGVhZGluZ0xldmVsOiAnaDEnIHwgJ2gyJyB8ICdoMycgfCAnbm9uZSc7IHRhcmdldFdvcmRzOiBudW1iZXI7IG92ZXJsYXBXb3JkczogbnVtYmVyIH0ge1xuXHRyZXR1cm4ge1xuXHRcdGhlYWRpbmdMZXZlbDogcGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rSGVhZGluZ0xldmVsID8/ICdoMScsXG5cdFx0dGFyZ2V0V29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua1dvcmRzID8/IDUwMCwgMjAwLCAyMDAwKSxcblx0XHRvdmVybGFwV29yZHM6IGNsYW1wSW50KHBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkcyA/PyAxMDAsIDAsIDUwMClcblx0fTtcbn1cblxuZnVuY3Rpb24gZXhjZXJwdE9mKHRleHQ6IHN0cmluZywgbWF4Q2hhcnM6IG51bWJlcik6IHN0cmluZyB7XG5cdGNvbnN0IHRyaW1tZWQgPSB0ZXh0LnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csICcgJyk7XG5cdGlmICh0cmltbWVkLmxlbmd0aCA8PSBtYXhDaGFycykgcmV0dXJuIHRyaW1tZWQ7XG5cdHJldHVybiBgJHt0cmltbWVkLnNsaWNlKDAsIG1heENoYXJzKX3igKZgO1xufVxuXG5pbnRlcmZhY2UgRXJyb3JMb2dFbnRyeSB7XG5cdHRpbWVzdGFtcDogc3RyaW5nO1xuXHRsb2NhdGlvbjogc3RyaW5nOyAvLyBXaGVyZSB0aGUgZXJyb3Igb2NjdXJyZWQgKG1ldGhvZC9mdW5jdGlvbiBuYW1lKVxuXHRjb250ZXh0OiBzdHJpbmc7IC8vIFdoYXQgd2FzIGhhcHBlbmluZyAoZmlsZSBwYXRoLCBjaHVuayBpbmRleCwgZXRjLilcblx0bWVzc2FnZTogc3RyaW5nO1xuXHRzdGFjaz86IHN0cmluZztcblx0ZXJyb3JUeXBlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgRW1iZWRkaW5nc0luZGV4IHtcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XG5cdHByaXZhdGUgcmVhZG9ubHkgcGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luO1xuXHRwcml2YXRlIGRpbTogbnVtYmVyO1xuXHRwcml2YXRlIHJlYWRvbmx5IGJhY2tlbmQ6ICdvbGxhbWEnO1xuXHRwcml2YXRlIGVtYmVkZGluZ1Byb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcjtcblxuXHRwcml2YXRlIGxvYWRlZCA9IGZhbHNlO1xuXHRwcml2YXRlIGNodW5rc0J5S2V5ID0gbmV3IE1hcDxzdHJpbmcsIEluZGV4ZWRDaHVuaz4oKTtcblx0cHJpdmF0ZSBjaHVua0tleXNCeVBhdGggPSBuZXcgTWFwPHN0cmluZywgU2V0PHN0cmluZz4+KCk7XG5cblx0cHJpdmF0ZSByZWFkb25seSBxdWV1ZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRwcml2YXRlIHdvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0cHJpdmF0ZSByZWJ1aWxkVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIHBlcnNpc3RUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgc2V0dGluZ3NTYXZlVGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5cdC8vIEVycm9yIHRyYWNraW5nXG5cdHByaXZhdGUgcmVhZG9ubHkgZXJyb3JMb2c6IEVycm9yTG9nRW50cnlbXSA9IFtdO1xuXHRwcml2YXRlIHJlYWRvbmx5IG1heFN0b3JlZEVycm9ycyA9IDEwMDtcblx0XG5cdC8vIENpcmN1aXQgYnJlYWtlciBmb3IgQUkgZW1iZWRkaW5nIGZhaWx1cmVzXG5cdHByaXZhdGUgYWlFcnJvclN0cmVhayA9IDA7XG5cdHByaXZhdGUgcmVhZG9ubHkgQUlfRVJST1JfU1RSRUFLX1RIUkVTSE9MRCA9IDM7XG5cdHByaXZhdGUgcmVhZG9ubHkgQUlfUEFVU0VfRFVSQVRJT05fTVMgPSAxNTAwMDtcblxuXHQvLyBTaGFyZWQgQnJhaW4gc3RhdGVcblx0cHJpdmF0ZSBpc1JlYWRPbmx5ID0gZmFsc2U7XG5cdHByaXZhdGUgaGVhcnRiZWF0VGltZXI6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXHRwcml2YXRlIGN1cnJlbnRTdG9yYWdlTW9kZTogJ2lzb2xhdGVkJyB8ICdhdXRvJyB8ICdtYW51YWwnIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgbG9ja0FjcXVpcmVkQXQ6IG51bWJlciB8IG51bGwgPSBudWxsOyAvLyBQcmVzZXJ2ZSBmb3IgaGVhcnRiZWF0XG5cblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0LCBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sIGVtYmVkZGluZ1Byb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHR0aGlzLmJhY2tlbmQgPSAnb2xsYW1hJztcblx0XHR0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyID0gZW1iZWRkaW5nUHJvdmlkZXI7XG5cdFx0dGhpcy5kaW0gPSAwO1xuXHR9XG5cblx0LyoqXG5cdCAqIEhvdC1zd2FwcyB0aGUgZW1iZWRkaW5nIHByb3ZpZGVyIChlLmcuIHdoZW4gdXNlciBjaGFuZ2VzIG1vZGVscykuXG5cdCAqL1xuXHR1cGRhdGVQcm92aWRlcihwcm92aWRlcjogT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXIpIHtcblx0XHR0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyID0gcHJvdmlkZXI7XG5cdH1cblxuXHRhc3luYyBvbnVubG9hZCgpIHtcblx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHQvLyBSZW1vdmUgbG9jayBvbmx5IGlmIHdlIG93biBpdCAoSlNPTiBmb3JtYXQgY2hlY2spXG5cdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRjb25zdCBsb2NrUGF0aCA9IGAke2Rpcn0vaW5kZXgubG9ja2A7XG5cdFx0dHJ5IHtcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxvY2tQYXRoKSkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsb2NrUGF0aCk7XG5cdFx0XHRcdHRyeSB7XG5cdFx0XHRcdFx0Y29uc3QgbG9jayA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdFx0XHRpZiAobG9jay5ob2xkZXIgPT09ICd3cml0aW5nLWRhc2hib2FyZCcpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUobG9ja1BhdGgpO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdFx0Ly8gSlNPTiBwYXJzZSBmYWlsZWQgLSBkbyBub3QgZGVsZXRlIChjb3VsZCBiZSBhbm90aGVyIHBsdWdpbidzIGxvY2spXG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHR9IGNhdGNoIHtcblx0XHRcdC8vIGlnbm9yZSBmaWxlc3lzdGVtIGVycm9yc1xuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBSZXR1cm5zIHRoZSBjYW5vbmljYWwgZW1iZWRkaW5nIHByb2ZpbGUgKHNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGgpLlxuXHQgKiBVc2VkIGZvciBoYW5kc2hha2UgZmlsZXMsIG1hbmlmZXN0IHZhbGlkYXRpb24sIGFuZCBwcm9maWxlIG1hdGNoaW5nLlxuXHQgKi9cblx0Z2V0RW1iZWRkaW5nUHJvZmlsZSgpIHtcblx0XHRyZXR1cm4ge1xuXHRcdFx0cHJvdmlkZXI6ICdvbGxhbWEnIGFzIGNvbnN0LFxuXHRcdFx0bW9kZWxJZDogdGhpcy5wbHVnaW4uc2V0dGluZ3MucmVsYXlFbWJlZGRpbmdNb2RlbCxcblx0XHRcdGRpbWVuc2lvbnM6IHRoaXMuZGltIHx8IDc2OCxcblx0XHRcdG5vcm1hbGl6ZTogdHJ1ZSxcblx0XHRcdGNodW5raW5nVmVyc2lvbjogMixcblx0XHRcdHNjaGVtYVZlcnNpb246IDJcblx0XHR9O1xuXHR9XG5cblx0YXN5bmMgcmVzb2x2ZUluZGV4RGlyKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Y29uc3QgbW9kZSA9IHRoaXMuY3VycmVudFN0b3JhZ2VNb2RlIHx8IHRoaXMucGx1Z2luLnNldHRpbmdzLmVtYmVkZGluZ1N0b3JhZ2VNb2RlIHx8ICdpc29sYXRlZCc7XG5cblx0XHRpZiAobW9kZSA9PT0gJ2lzb2xhdGVkJykge1xuXHRcdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0fVxuXG5cdFx0aWYgKG1vZGUgPT09ICdtYW51YWwnKSB7XG5cdFx0XHRjb25zdCBtYW51YWxQYXRoID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MubWFudWFsU2hhcmVkUGF0aDtcblx0XHRcdGlmIChtYW51YWxQYXRoKSByZXR1cm4gbWFudWFsUGF0aDtcblx0XHRcdHJldHVybiBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHRcdH1cblxuXHRcdC8vIGF1dG8gbW9kZVxuXHRcdGNvbnN0IHN0b3J5Ym9hcmRIYW5kc2hha2VQYXRoID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L2VtYmVkZGluZ3MvaGFuZHNoYWtlL3N0b3J5Ym9hcmQuanNvbmA7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGgpKSB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChzdG9yeWJvYXJkSGFuZHNoYWtlUGF0aCk7XG5cdFx0XHRcdGNvbnN0IHN0b3J5Ym9hcmQgPSBKU09OLnBhcnNlKHJhdyk7XG5cdFx0XHRcdGlmICh0aGlzLnByb2ZpbGVzTWF0Y2goc3Rvcnlib2FyZC5lbWJlZGRpbmdQcm9maWxlKSkge1xuXHRcdFx0XHRcdHJldHVybiAnRW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgnO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gU2hhcmVkIGluZGV4IGRpc2FibGVkOiBlbWJlZGRpbmcgcHJvZmlsZXMgZG8gbm90IG1hdGNoIHN0b3J5Ym9hcmQnKTtcblx0XHRcdFx0fVxuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoJ1tFbWJlZGRpbmdzSW5kZXhdIEZhaWxlZCB0byByZWFkIHN0b3J5Ym9hcmQgaGFuZHNoYWtlOicsIGVycik7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdH1cblxuXHRwcml2YXRlIHByb2ZpbGVzTWF0Y2gob3RoZXI6IGFueSk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IG1pbmUgPSB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKTtcblx0XHRyZXR1cm4gKFxuXHRcdFx0bWluZS5wcm92aWRlciA9PT0gb3RoZXIucHJvdmlkZXIgJiZcblx0XHRcdG1pbmUubW9kZWxJZCA9PT0gb3RoZXIubW9kZWxJZCAmJlxuXHRcdFx0bWluZS5kaW1lbnNpb25zID09PSBvdGhlci5kaW1lbnNpb25zICYmXG5cdFx0XHRtaW5lLm5vcm1hbGl6ZSA9PT0gb3RoZXIubm9ybWFsaXplICYmXG5cdFx0XHRtaW5lLmNodW5raW5nVmVyc2lvbiA9PT0gb3RoZXIuY2h1bmtpbmdWZXJzaW9uICYmXG5cdFx0XHRtaW5lLnNjaGVtYVZlcnNpb24gPT09IG90aGVyLnNjaGVtYVZlcnNpb25cblx0XHQpO1xuXHR9XG5cblx0YXN5bmMgdmFsaWRhdGVNYW5pZmVzdChkaXI6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGAke2Rpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtYW5pZmVzdFBhdGgpKSkgcmV0dXJuIHRydWU7IC8vIE5vIG1hbmlmZXN0IHlldFxuXG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKG1hbmlmZXN0UGF0aCk7XG5cdFx0XHRjb25zdCBtYW5pZmVzdCA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdHJldHVybiB0aGlzLnByb2ZpbGVzTWF0Y2gobWFuaWZlc3QuZW1iZWRkaW5nUHJvZmlsZSk7XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgYWNxdWlyZUxvY2soZGlyOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBsb2NrUGF0aCA9IGAke2Rpcn0vaW5kZXgubG9ja2A7XG5cdFx0Y29uc3QgbXlJZCA9ICd3cml0aW5nLWRhc2hib2FyZCc7XG5cdFx0Y29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcblxuXHRcdHRyeSB7XG5cdFx0XHRsZXQgZXhpc3RpbmdMb2NrOiB7IGhvbGRlcjogc3RyaW5nOyBhY3F1aXJlZEF0OiBudW1iZXI7IHVwZGF0ZWRBdDogbnVtYmVyIH0gfCBudWxsID0gbnVsbDtcblxuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobG9ja1BhdGgpKSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxvY2tQYXRoKTtcblx0XHRcdFx0dHJ5IHtcblx0XHRcdFx0XHRleGlzdGluZ0xvY2sgPSBKU09OLnBhcnNlKHJhdyk7XG5cdFx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHRcdC8vIEludmFsaWQgSlNPTiAobGVnYWN5IHN0cmluZyBmb3JtYXQpIC0gdHJlYXQgYXMgc3RhbGVcblx0XHRcdFx0XHRleGlzdGluZ0xvY2sgPSBudWxsO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdGlmIChleGlzdGluZ0xvY2spIHtcblx0XHRcdFx0Y29uc3QgaXNTdGFsZSA9IChub3cgLSBleGlzdGluZ0xvY2sudXBkYXRlZEF0KSA+IDYwMDAwO1xuXHRcdFx0XHRjb25zdCBpc1NlbGYgPSBleGlzdGluZ0xvY2suaG9sZGVyID09PSBteUlkO1xuXG5cdFx0XHRcdGlmICghaXNTdGFsZSAmJiAhaXNTZWxmKSB7XG5cdFx0XHRcdFx0Ly8gVmFsaWQgbG9jayBoZWxkIGJ5IGFub3RoZXIgcGx1Z2luXG5cdFx0XHRcdFx0dGhpcy5pc1JlYWRPbmx5ID0gdHJ1ZTtcblx0XHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoaXNTZWxmKSB7XG5cdFx0XHRcdFx0Ly8gUmVmcmVzaDogcHJlc2VydmUgYWNxdWlyZWRBdCwgdXBkYXRlIHVwZGF0ZWRBdFxuXHRcdFx0XHRcdHRoaXMubG9ja0FjcXVpcmVkQXQgPSBleGlzdGluZ0xvY2suYWNxdWlyZWRBdDtcblx0XHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0XHQvLyBTdGFsZSB0YWtlb3ZlcjogcmVzZXQgYm90aCB0aW1lc3RhbXBzXG5cdFx0XHRcdFx0dGhpcy5sb2NrQWNxdWlyZWRBdCA9IG5vdztcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIHtcblx0XHRcdFx0Ly8gTmV3IGxvY2tcblx0XHRcdFx0dGhpcy5sb2NrQWNxdWlyZWRBdCA9IG5vdztcblx0XHRcdH1cblxuXHRcdFx0Ly8gV3JpdGUgbG9jayBKU09OXG5cdFx0XHRjb25zdCBsb2NrRGF0YSA9IHtcblx0XHRcdFx0aG9sZGVyOiBteUlkLFxuXHRcdFx0XHRhY3F1aXJlZEF0OiB0aGlzLmxvY2tBY3F1aXJlZEF0LFxuXHRcdFx0XHR1cGRhdGVkQXQ6IG5vd1xuXHRcdFx0fTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShsb2NrUGF0aCwgSlNPTi5zdHJpbmdpZnkobG9ja0RhdGEpKTtcblx0XHRcdHRoaXMuaXNSZWFkT25seSA9IGZhbHNlO1xuXHRcdFx0dGhpcy5zdGFydEhlYXJ0YmVhdChsb2NrUGF0aCk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdHRoaXMuaXNSZWFkT25seSA9IHRydWU7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBzdGFydEhlYXJ0YmVhdChsb2NrUGF0aDogc3RyaW5nKSB7XG5cdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0dGhpcy5oZWFydGJlYXRUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbChhc3luYyAoKSA9PiB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBsb2NrRGF0YSA9IHtcblx0XHRcdFx0XHRob2xkZXI6ICd3cml0aW5nLWRhc2hib2FyZCcsXG5cdFx0XHRcdFx0YWNxdWlyZWRBdDogdGhpcy5sb2NrQWNxdWlyZWRBdCxcblx0XHRcdFx0XHR1cGRhdGVkQXQ6IERhdGUubm93KClcblx0XHRcdFx0fTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGxvY2tQYXRoLCBKU09OLnN0cmluZ2lmeShsb2NrRGF0YSkpO1xuXHRcdFx0fSBjYXRjaCB7XG5cdFx0XHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdFx0fVxuXHRcdH0sIDMwMDAwKTtcblx0fVxuXG5cdHByaXZhdGUgc3RvcEhlYXJ0YmVhdCgpIHtcblx0XHRpZiAodGhpcy5oZWFydGJlYXRUaW1lcikge1xuXHRcdFx0Y2xlYXJJbnRlcnZhbCh0aGlzLmhlYXJ0YmVhdFRpbWVyKTtcblx0XHRcdHRoaXMuaGVhcnRiZWF0VGltZXIgPSBudWxsO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIHNlZWRTaGFyZWRJbmRleChzb3VyY2VEaXI6IHN0cmluZywgdGFyZ2V0RGlyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRjb25zdCBtYW5pZmVzdFBhdGggPSBgJHt0YXJnZXREaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdGNvbnN0IGluZGV4UGF0aCA9IGAke3RhcmdldERpcn0vaW5kZXguanNvbmA7XG5cblx0XHRjb25zdCBpc0VtcHR5ID0gIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG1hbmlmZXN0UGF0aCkpIHx8ICEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhpbmRleFBhdGgpKTtcblx0XHRpZiAoIWlzRW1wdHkpIHJldHVybjtcblxuXHRcdGNvbnN0IHNvdXJjZUluZGV4ID0gYCR7c291cmNlRGlyfS9pbmRleC5qc29uYDtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhzb3VyY2VJbmRleCkpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHModGFyZ2V0RGlyKSkpIHtcblx0XHRcdFx0XHQvLyBSZWN1cnNpdmUgbWtkaXJcblx0XHRcdFx0XHRjb25zdCBwYXJ0cyA9IHRhcmdldERpci5zcGxpdCgnLycpO1xuXHRcdFx0XHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0XHRcdFx0Zm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG5cdFx0XHRcdFx0XHRpZiAoIXBhcnQpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdFx0Y3VycmVudCArPSAoY3VycmVudCA/ICcvJyA6ICcnKSArIHBhcnQ7XG5cdFx0XHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGN1cnJlbnQpKSkge1xuXHRcdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoY3VycmVudCk7XG5cdFx0XHRcdFx0XHR9XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChzb3VyY2VJbmRleCk7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShpbmRleFBhdGgsIGNvbnRlbnQpO1xuXG5cdFx0XHRcdGNvbnN0IG1hbmlmZXN0ID0ge1xuXHRcdFx0XHRcdHNjaGVtYVZlcnNpb246IDIsXG5cdFx0XHRcdFx0ZW1iZWRkaW5nUHJvZmlsZTogdGhpcy5nZXRFbWJlZGRpbmdQcm9maWxlKCksXG5cdFx0XHRcdFx0ZW5naW5lOiAnanNvbidcblx0XHRcdFx0fTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKG1hbmlmZXN0UGF0aCwgSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QsIG51bGwsIDIpKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKCdbRW1iZWRkaW5nc0luZGV4XSBTZWVkaW5nIGZhaWxlZDonLCBlcnIpO1xuXHRcdFx0fVxuXHRcdH1cblx0fVxuXG5cdC8qKlxuXHQgKiBBdG9taWMgbWlncmF0aW9uIGZyb20gbGVnYWN5IC5vYnNpZGlhbi9lbWJlZGRpbmdzL3NoYXJlZC1pbmRleC8gdG8gb3ZlcnQgRW1iZWRkaW5ncy9zaGFyZWQtaW5kZXgvXG5cdCAqIFJldHVybnMgdHJ1ZSBpZiBtaWdyYXRpb24gc3VjY2VlZGVkIG9yIHdhcyBub3QgbmVlZGVkLCBmYWxzZSBpZiBmYWlsZWQuXG5cdCAqL1xuXHRhc3luYyBtaWdyYXRlRnJvbUxlZ2FjeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcblx0XHRjb25zdCBvdmVydERpciA9ICdFbWJlZGRpbmdzL3NoYXJlZC1pbmRleCc7XG5cdFx0Y29uc3QgbGVnYWN5RGlyID0gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L2VtYmVkZGluZ3Mvc2hhcmVkLWluZGV4YDtcblx0XHRjb25zdCBvdmVydEluZGV4ID0gYCR7b3ZlcnREaXJ9L2luZGV4Lmpzb25gO1xuXHRcdGNvbnN0IGxlZ2FjeUluZGV4ID0gYCR7bGVnYWN5RGlyfS9pbmRleC5qc29uYDtcblx0XHRjb25zdCBtaWdyYXRpb25NYXJrZXIgPSBgJHtvdmVydERpcn0vLm1pZ3JhdGVkLWZyb20tbGVnYWN5YDtcblxuXHRcdHRyeSB7XG5cdFx0XHQvLyBDaGVjayBpZiBtaWdyYXRpb24gaXMgbmVlZGVkXG5cdFx0XHRjb25zdCBvdmVydEV4aXN0cyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMob3ZlcnRJbmRleCk7XG5cdFx0XHRjb25zdCBsZWdhY3lFeGlzdHMgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxlZ2FjeUluZGV4KTtcblxuXHRcdFx0Ly8gSWYgb3ZlcnQgYWxyZWFkeSBleGlzdHMgb3IgbGVnYWN5IGRvZXNuJ3QgZXhpc3QsIG5vIG1pZ3JhdGlvbiBuZWVkZWRcblx0XHRcdGlmIChvdmVydEV4aXN0cyB8fCAhbGVnYWN5RXhpc3RzKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBDaGVjayBpZiBhbHJlYWR5IG1pZ3JhdGVkXG5cdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtaWdyYXRpb25NYXJrZXIpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zb2xlLmxvZygnW0VtYmVkZGluZ3NJbmRleF0gU3RhcnRpbmcgYXRvbWljIG1pZ3JhdGlvbiBmcm9tIGxlZ2FjeSB0byBvdmVydCBmb2xkZXIuLi4nKTtcblxuXHRcdFx0Ly8gRW5zdXJlIG92ZXJ0IGZvbGRlciBleGlzdHNcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMob3ZlcnREaXIpKSkge1xuXHRcdFx0XHRjb25zdCBwYXJ0cyA9IG92ZXJ0RGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0XHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuXHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0Y3VycmVudCArPSAoY3VycmVudCA/ICcvJyA6ICcnKSArIHBhcnQ7XG5cdFx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KSkpIHtcblx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gQWNxdWlyZSB3cml0ZXIgbG9jayBvbiBvdmVydCBmb2xkZXJcblx0XHRcdGNvbnN0IGhhc0xvY2sgPSBhd2FpdCB0aGlzLmFjcXVpcmVMb2NrKG92ZXJ0RGlyKTtcblx0XHRcdGlmICghaGFzTG9jaykge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIExlZ2FjeSBtaWdyYXRpb24gYWJvcnRlZDogY291bGQgbm90IGFjcXVpcmUgbG9jayAocmVhZC1vbmx5IG1vZGUpLicpO1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMTogQ29weSBsZWdhY3kgZmlsZXMgdG8gLnRtcCB2ZXJzaW9uc1xuXHRcdFx0Y29uc3QgbGVnYWN5Q29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxlZ2FjeUluZGV4KTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShgJHtvdmVydEluZGV4fS50bXBgLCBsZWdhY3lDb250ZW50KTtcblxuXHRcdFx0Y29uc3QgbGVnYWN5TWFuaWZlc3QgPSBgJHtsZWdhY3lEaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb25gO1xuXHRcdFx0Y29uc3Qgb3ZlcnRNYW5pZmVzdCA9IGAke292ZXJ0RGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRcdGxldCBoYXNNYW5pZmVzdCA9IGZhbHNlO1xuXHRcdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobGVnYWN5TWFuaWZlc3QpKSB7XG5cdFx0XHRcdGNvbnN0IG1hbmlmZXN0Q29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKGxlZ2FjeU1hbmlmZXN0KTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGAke292ZXJ0TWFuaWZlc3R9LnRtcGAsIG1hbmlmZXN0Q29udGVudCk7XG5cdFx0XHRcdGhhc01hbmlmZXN0ID0gdHJ1ZTtcblx0XHRcdH1cblxuXHRcdFx0Ly8gU3RlcCAyOiBSZW5hbWUgLnRtcCB0byBjYW5vbmljYWwgKGF0b21pYyBjb21taXQpXG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGAke292ZXJ0SW5kZXh9LnRtcGAsIG92ZXJ0SW5kZXgpO1xuXHRcdFx0aWYgKGhhc01hbmlmZXN0KSB7XG5cdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW5hbWUoYCR7b3ZlcnRNYW5pZmVzdH0udG1wYCwgb3ZlcnRNYW5pZmVzdCk7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMzogV3JpdGUgbWlncmF0aW9uIG1hcmtlclxuXHRcdFx0Y29uc3QgbWFya2VyQ29udGVudCA9IEpTT04uc3RyaW5naWZ5KHtcblx0XHRcdFx0bWlncmF0ZWRBdDogRGF0ZS5ub3coKSxcblx0XHRcdFx0ZnJvbTogbGVnYWN5RGlyXG5cdFx0XHR9LCBudWxsLCAyKTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtaWdyYXRpb25NYXJrZXIsIG1hcmtlckNvbnRlbnQpO1xuXG5cdFx0XHQvLyBTdGVwIDQ6IERpc2FibGUgbGVnYWN5IGJ5IHJlbmFtaW5nXG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGxlZ2FjeUluZGV4LCBgJHtsZWdhY3lJbmRleH0ubWlncmF0ZWRgKTtcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxlZ2FjeU1hbmlmZXN0KSkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVuYW1lKGxlZ2FjeU1hbmlmZXN0LCBgJHtsZWdhY3lNYW5pZmVzdH0ubWlncmF0ZWRgKTtcblx0XHRcdH1cblxuXHRcdFx0Y29uc29sZS5sb2coJ1tFbWJlZGRpbmdzSW5kZXhdIOKckyBBdG9taWMgbWlncmF0aW9uIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHkuJyk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gTGVnYWN5IG1pZ3JhdGlvbiBmYWlsZWQ7IGZhbGxpbmcgYmFjayB0byBpc29sYXRlZC4nLCBlcnIpO1xuXG5cdFx0XHQvLyBDbGVhbnVwIHRlbXAgZmlsZXMgYmVzdC1lZmZvcnRcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGAke292ZXJ0SW5kZXh9LnRtcGApKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlbW92ZShgJHtvdmVydEluZGV4fS50bXBgKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhgJHtvdmVydERpcn0vaW5kZXgubWFuaWZlc3QuanNvbi50bXBgKSkge1xuXHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUoYCR7b3ZlcnREaXJ9L2luZGV4Lm1hbmlmZXN0Lmpzb24udG1wYCk7XG5cdFx0XHRcdH1cblx0XHRcdH0gY2F0Y2gge1xuXHRcdFx0XHQvLyBpZ25vcmUgY2xlYW51cCBlcnJvcnNcblx0XHRcdH1cblxuXHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGdldEluZGV4RmlsZVBhdGgoKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdHJldHVybiBgJHtkaXJ9L2luZGV4Lmpzb25gO1xuXHR9XG5cblx0YXN5bmMgY2xlYXJJbmRleCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLmNodW5rc0J5S2V5LmNsZWFyKCk7XG5cdFx0dGhpcy5jaHVua0tleXNCeVBhdGguY2xlYXIoKTtcblx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0ge307XG5cdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0Y29uc3QgcGF0aCA9IGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHBhdGgpKSB7XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVtb3ZlKHBhdGgpO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIGVuc3VyZUxvYWRlZCgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHRpZiAodGhpcy5sb2FkZWQpIHJldHVybjtcblx0XHR0aGlzLmxvYWRlZCA9IHRydWU7XG5cblx0XHR0cnkge1xuXHRcdFx0Ly8gU3RlcCAxOiBEZXRlcm1pbmUgbW9kZSBhbmQgYXR0ZW1wdCBtaWdyYXRpb24gaW4gYXV0byBtb2RlXG5cdFx0XHRjb25zdCBtb2RlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MuZW1iZWRkaW5nU3RvcmFnZU1vZGUgfHwgJ2lzb2xhdGVkJztcblx0XHRcdGlmIChtb2RlID09PSAnYXV0bycpIHtcblx0XHRcdFx0Ly8gQXR0ZW1wdCBsZWdhY3kgbWlncmF0aW9uIEJFRk9SRSByZXNvbHZpbmcgZmluYWwgZGlyXG5cdFx0XHRcdGNvbnN0IG1pZ3JhdGlvblN1Y2Nlc3MgPSBhd2FpdCB0aGlzLm1pZ3JhdGVGcm9tTGVnYWN5KCk7XG5cdFx0XHRcdGlmICghbWlncmF0aW9uU3VjY2Vzcykge1xuXHRcdFx0XHRcdC8vIE1pZ3JhdGlvbiBmYWlsZWQgKGxvY2tlZCBieSBvdGhlciBwbHVnaW4gb3IgZXJyb3IpIC0gZmFsbCBiYWNrIHRvIGlzb2xhdGVkXG5cdFx0XHRcdFx0dGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgPSAnaXNvbGF0ZWQnO1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gQXV0byBtb2RlOiBtaWdyYXRpb24gZmFpbGVkLCB1c2luZyBpc29sYXRlZCBtb2RlLicpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIFN0ZXAgMjogUmVzb2x2ZSBpbmRleCBkaXJlY3Rvcnlcblx0XHRcdGNvbnN0IGRpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0XHRjb25zdCBwYXRoID0gYXdhaXQgdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cblx0XHRcdC8vIFN0ZXAgMzogVmFsaWRhdGUgbWFuaWZlc3Rcblx0XHRcdGlmICghKGF3YWl0IHRoaXMudmFsaWRhdGVNYW5pZmVzdChkaXIpKSkge1xuXHRcdFx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIE1hbmlmZXN0IG1pc21hdGNoOyBmYWxsaW5nIGJhY2sgdG8gaXNvbGF0ZWQgbW9kZScpO1xuXHRcdFx0XHR0aGlzLmN1cnJlbnRTdG9yYWdlTW9kZSA9ICdpc29sYXRlZCc7IC8vIEludGVybmFsIG92ZXJyaWRlIGZvciB0aGlzIHNlc3Npb25cblx0XHRcdFx0Ly8gUmUtcmVzb2x2ZSBwYXRoIGFmdGVyIGZhbGxiYWNrXG5cdFx0XHRcdGNvbnN0IG5ld0RpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobmV3RGlyKSkpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIobmV3RGlyKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXG5cdFx0XHQvLyBTdGVwIDQ6IEluIGF1dG8vbWFudWFsLCBhY3F1aXJlIGxvY2sgYW5kIHNlZWQgaWYgbmVlZGVkXG5cdFx0XHRjb25zdCByZXNvbHZlZE1vZGUgPSB0aGlzLmN1cnJlbnRTdG9yYWdlTW9kZSB8fCBtb2RlO1xuXHRcdFx0aWYgKHJlc29sdmVkTW9kZSAhPT0gJ2lzb2xhdGVkJykge1xuXHRcdFx0XHRjb25zdCBzb3VyY2VEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnNlZWRTaGFyZWRJbmRleChzb3VyY2VEaXIsIGRpcik7XG5cdFx0XHRcdGF3YWl0IHRoaXMuYWNxdWlyZUxvY2soZGlyKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkpIHJldHVybjtcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIFBlcnNpc3RlZEluZGV4VjE7XG5cdFx0XHRpZiAocGFyc2VkPy52ZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5jaHVua3MpKSByZXR1cm47XG5cdFx0XHRpZiAocGFyc2VkLmJhY2tlbmQgJiYgcGFyc2VkLmJhY2tlbmQgIT09IHRoaXMuYmFja2VuZCkge1xuXHRcdFx0XHQvLyBCYWNrZW5kIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmICh0eXBlb2YgcGFyc2VkLmRpbSA9PT0gJ251bWJlcicpIHtcblx0XHRcdFx0dGhpcy5kaW0gPSBwYXJzZWQuZGltO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhwZWN0ZWRDaHVua2luZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcblx0XHRcdGlmIChcblx0XHRcdFx0cGFyc2VkLmNodW5raW5nICYmXG5cdFx0XHRcdChwYXJzZWQuY2h1bmtpbmcuaGVhZGluZ0xldmVsICE9PSBleHBlY3RlZENodW5raW5nLmhlYWRpbmdMZXZlbCB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy50YXJnZXRXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy50YXJnZXRXb3JkcyB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy5vdmVybGFwV29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcub3ZlcmxhcFdvcmRzKVxuXHRcdFx0KSB7XG5cdFx0XHRcdC8vIENodW5raW5nIGNvbmZpZyBjaGFuZ2VkOyByZWJ1aWxkIGluZGV4LlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGZvciAoY29uc3QgY2h1bmsgb2YgcGFyc2VkLmNodW5rcykge1xuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xuXHRcdFx0XHR0aGlzLl9zZXRDaHVuayhjaHVuayk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBDb3JydXB0IGluZGV4IHNob3VsZCBub3QgYnJlYWsgdGhlIHBsdWdpbi4gV2UnbGwgcmVidWlsZCBsYXppbHkuXG5cdFx0XHR0aGlzLmNodW5rc0J5S2V5LmNsZWFyKCk7XG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdH1cblx0fVxuXG5cdGdldFN0YXR1cygpOiB7IGluZGV4ZWRGaWxlczogbnVtYmVyOyBpbmRleGVkQ2h1bmtzOiBudW1iZXI7IHBhdXNlZDogYm9vbGVhbjsgcXVldWVkOiBudW1iZXIgfSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcblx0XHRcdGluZGV4ZWRDaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSxcblx0XHRcdHBhdXNlZDogQm9vbGVhbih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCksXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxuXHRcdH07XG5cdH1cblxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogRXJyb3JMb2dFbnRyeVtdIHtcblx0XHRyZXR1cm4gdGhpcy5lcnJvckxvZy5zbGljZSgtbGltaXQpO1xuXHR9XG5cblx0Z2V0RXJyb3JTdW1tYXJ5KCk6IHsgdG90YWw6IG51bWJlcjsgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPjsgcmVjZW50OiBFcnJvckxvZ0VudHJ5W10gfSB7XG5cdFx0Y29uc3QgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuXHRcdGZvciAoY29uc3QgZXJyIG9mIHRoaXMuZXJyb3JMb2cpIHtcblx0XHRcdGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSA9IChieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gfHwgMCkgKyAxO1xuXHRcdH1cblx0XHRyZXR1cm4ge1xuXHRcdFx0dG90YWw6IHRoaXMuZXJyb3JMb2cubGVuZ3RoLFxuXHRcdFx0YnlMb2NhdGlvbixcblx0XHRcdHJlY2VudDogdGhpcy5lcnJvckxvZy5zbGljZSgtMTApXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgbG9nRXJyb3IobG9jYXRpb246IHN0cmluZywgY29udGV4dDogc3RyaW5nLCBlcnJvcjogdW5rbm93bik6IHZvaWQge1xuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgZXJyb3JUeXBlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyb3I7XG5cdFx0XG5cdFx0Y29uc3QgZW50cnk6IEVycm9yTG9nRW50cnkgPSB7XG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGxvY2F0aW9uLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXG5cdFx0XHRlcnJvclR5cGVcblx0XHR9O1xuXHRcdFxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gQWxzbyBsb2cgdG8gY29uc29sZSBmb3IgZGVidWdnaW5nXG5cdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gRVJST1IgWyR7bG9jYXRpb259XSAke2NvbnRleHR9OmAsIGVycm9yTXNnKTtcblx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xuXHRcdH1cblx0fVxuXG5cdGVucXVldWVGdWxsUmVzY2FuKCk6IHZvaWQge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmdldEluY2x1ZGVkTWFya2Rvd25GaWxlcygpO1xuXHRcdGZvciAoY29uc3QgZiBvZiBmaWxlcykgdGhpcy5xdWV1ZS5hZGQoZi5wYXRoKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRxdWV1ZVVwZGF0ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5xdWV1ZS5hZGQocGF0aCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVSZWJ1aWxkKCk7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVJlYnVpbGQoKTogdm9pZCB7XG5cdFx0Y29uc3QgcG9saWN5ID0gQ09fQVVUSE9SSU5HX1BPTElDWS5QRVJGT1JNQU5DRTtcblx0XHRpZiAodGhpcy5yZWJ1aWxkVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5yZWJ1aWxkVGltZXIpO1xuXHRcdHRoaXMucmVidWlsZFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5yZWJ1aWxkVGltZXIgPSBudWxsO1xuXHRcdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHRcdH0sIHBvbGljeS5SRUJVSUxEX1FVRVVFX0RFQk9VTkNFX01TKTtcblx0fVxuXG5cdHF1ZXVlUmVtb3ZlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdH1cblxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSB0cnVlO1xuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cblx0XHRpZiAodGhpcy5pc1JlYWRPbmx5KSB7XG5cdFx0XHRjb25zb2xlLmxvZygnW0VtYmVkZGluZ3NJbmRleF0gU2hhcmVkIGluZGV4IGxvY2tlZDsgb3BlcmF0aW5nIHJlYWQtb25seS4nKTtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIHRvIGF2b2lkIGZhaWx1cmVzLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIHNlbWFudGljIGluZGV4aW5nJyk7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xuXHRcdFxuXHRcdHdoaWxlICh0aGlzLnF1ZXVlLnNpemUgPiAwICYmIGluZGV4ZWRDb3VudCA8IHBvbGljeS5NQVhfUkVCVUlMRFNfUEVSX0JBVENIKSB7XG5cdFx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpIGJyZWFrO1xuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcblx0XHRcdHRoaXMucXVldWUuZGVsZXRlKG5leHQpO1xuXHRcdFx0cHJvY2Vzc2VkQ291bnQrKztcblxuXHRcdFx0Ly8gRXhjbHVzaW9ucyBjYW4gY2hhbmdlIGF0IGFueSB0aW1lOyBob25vciB0aGVtIGR1cmluZyBwcm9jZXNzaW5nLlxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChuZXh0KSkge1xuXHRcdFx0XHRza2lwcGVkRXhjbHVkZWQrKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobmV4dCk7XG5cdFx0XHQvLyBPbmx5IGluZGV4IG1hcmtkb3duIGZpbGVzLlxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCBmaWxlLmV4dGVuc2lvbiAhPT0gJ21kJykge1xuXHRcdFx0XHRza2lwcGVkTm90TWFya2Rvd24rKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xuXHRcdFx0XHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjb250ZW50KTtcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZENvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHR9XG5cblx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIGZvciB0aGlzIGZpbGUuXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBPbGxhbWEgbm90IGF2YWlsYWJsZTsgc2tpcHBpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQmFja2VuZDogJHt0aGlzLmJhY2tlbmR9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDb250ZW50IGxlbmd0aDogJHtjb250ZW50Lmxlbmd0aH0gY2hhcnMsICR7Y29udGVudC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHNgKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5raW5nIGNvbmZpZzogaGVhZGluZ0xldmVsPSR7Y2ZnLmhlYWRpbmdMZXZlbH0sIHRhcmdldFdvcmRzPSR7Y2ZnLnRhcmdldFdvcmRzfSwgb3ZlcmxhcFdvcmRzPSR7Y2ZnLm92ZXJsYXBXb3Jkc31gKTtcblx0XHRcblx0XHRjb25zdCBjaHVua3MgPSBidWlsZEluZGV4Q2h1bmtzKHtcblx0XHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGNmZy5oZWFkaW5nTGV2ZWwsXG5cdFx0XHR0YXJnZXRXb3JkczogY2ZnLnRhcmdldFdvcmRzLFxuXHRcdFx0b3ZlcmxhcFdvcmRzOiBjZmcub3ZlcmxhcFdvcmRzXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua3MgY3JlYXRlZDogJHtjaHVua3MubGVuZ3RofWApO1xuXHRcdGlmIChjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYCAgLSBGaXJzdCBjaHVuayBwcmV2aWV3OiAke2NodW5rc1swXS50ZXh0LnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuXHRcdH1cblx0XHRcblx0XHQvLyBJZiBubyBjaHVua3MgY3JlYXRlZCwgc2tpcCB0aGlzIGZpbGUgKG1pZ2h0IGJlIHRvbyBzaG9ydCBvciBoYXZlIG5vIGhlYWRpbmdzKVxuXHRcdGlmIChjaHVua3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE5vIGNodW5rcyBjcmVhdGVkIGZvciAke3BhdGh9IC0gZmlsZSB0b28gc2hvcnQgb3Igbm8gaGVhZGluZ3MgbWF0Y2ggY2h1bmtpbmcgY29uZmlnYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRUZXh0ID0gbm9ybWFsaXplQ2h1bmtUZXh0KGNoLnRleHQpO1xuXHRcdFx0Y29uc3QgdGV4dEhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0Y29uc3Qga2V5ID0gYGNodW5rOiR7cGF0aH06JHtpfWA7XG5cdFx0XHRsZXQgdmVjdG9yOiBudW1iZXJbXTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XG5cdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhub3JtYWxpemVkVGV4dCk7XG5cdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhayA9IDA7IC8vIFN1Y2Nlc3M6IHJlc2V0IHN0cmVha1xuXHRcdFx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjdG9yKSB8fCB2ZWN0b3IubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAodGhpcy5kaW0gPT09IDApIHtcblx0XHRcdFx0XHR0aGlzLmRpbSA9IHZlY3Rvci5sZW5ndGg7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBPbGxhbWEgZW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhaysrO1xuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRjb25zdCBjb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIENodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMsICR7Y2gudGV4dC5sZW5ndGh9IGNoYXJzKWA7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5lbWJlZENodW5rJywgY29udGV4dCwgZXJyKTtcblx0XHRcdFx0XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9OmAsIGVycm9yTXNnKTtcblx0XHRcdFx0XG5cdFx0XHRcdGlmICh0aGlzLmFpRXJyb3JTdHJlYWsgPj0gMykge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gRW1iZWRkaW5nIGJyZWFrZXIgdHJpZ2dlcmVkOiBwYXVzZWQgMTVzIGFuZCBjbGVhcmVkIHF1ZXVlIGFmdGVyIDMgY29uc2VjdXRpdmUgZmFpbHVyZXMuJyk7XG5cdFx0XHRcdFx0dGhpcy5xdWV1ZS5jbGVhcigpO1xuXHRcdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhayA9IDA7XG5cdFx0XHRcdFx0Ly8gWWllbGQgYW5kIHdhaXQgMTVzXG5cdFx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDE1MDAwKSk7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbWJlZGRpbmcgYnJlYWtlciB0cmlnZ2VyZWQ7IGJhdGNoIGFib3J0ZWQuJyk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XG5cdFx0XHRcdFx0aWYgKCdjYXVzZScgaW4gZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcblx0XHRcdFx0aWYgKGkgPT09IDApIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYCAgLSBXYXJuaW5nOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0uIEF0dGVtcHRpbmcgc3Vic2VxdWVudCBjaHVua3MuYCk7XG5cdFx0XHRcdFx0Zmlyc3RFcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBTa2lwIHRoaXMgY2h1bmsgaWYgZW1iZWRkaW5nIGZhaWxzLCBidXQgY29udGludWUgd2l0aCBvdGhlcnNcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleGNlcnB0ID0gZXhjZXJwdE9mKGNoLnRleHQsIDI1MDApO1xuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xuXHRcdFx0XHRrZXksXG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXG5cdFx0XHRcdHN0YXJ0V29yZDogY2guc3RhcnRXb3JkLFxuXHRcdFx0XHRlbmRXb3JkOiBjaC5lbmRXb3JkLFxuXHRcdFx0XHR0ZXh0SGFzaCxcblx0XHRcdFx0dmVjdG9yLFxuXHRcdFx0XHRleGNlcnB0XG5cdFx0XHR9KTtcblx0XHRcdHN1Y2Nlc3NmdWxDaHVua3MrKztcblx0XHR9XG5cdFx0XG5cdFx0aWYgKHN1Y2Nlc3NmdWxDaHVua3MgPT09IDAgJiYgY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IGNyaXRpY2FsQ29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkYDtcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIGZpcnN0RXJyb3IpO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBDUklUSUNBTDogQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgbm90IGluZGV4ZWRgKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICBSb290IGNhdXNlOiAke2ZpcnN0RXJyb3IubWVzc2FnZX1gKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIG5ldyBFcnJvcignQWxsIGNodW5rcyBmYWlsZWQgYnV0IG5vIGZpcnN0IGVycm9yIGNhcHR1cmVkJykpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoc3VjY2Vzc2Z1bENodW5rcyA8IGNodW5rcy5sZW5ndGgpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gUGFydGlhbCBzdWNjZXNzIGZvciAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9LyR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGluZGV4ZWRgKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIOKckyBTdWNjZXNzZnVsbHkgaW5kZXhlZCAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9IGNodW5rc2ApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX3NldENodW5rKGNodW5rOiBJbmRleGVkQ2h1bmspOiB2b2lkIHtcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcblx0XHRjb25zdCBzZXQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQoY2h1bmsucGF0aCkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0c2V0LmFkZChjaHVuay5rZXkpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrZXlzID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KHBhdGgpO1xuXHRcdGlmIChrZXlzKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XG5cdFx0fVxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmRlbGV0ZShwYXRoKTtcblxuXHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF0pIHtcblx0XHRcdGNvbnN0IG5leHQgPSB7IC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSB9O1xuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XG5cdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0gbmV4dDtcblx0XHR9XG5cdH1cblxuXHRnZXRBbGxDaHVua3MoKTogSW5kZXhlZENodW5rW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbXB1dGVzIGEgYml0LXBlcmZlY3QgY29ycHVzIGhhc2ggZm9yIHN0cmljdCByZXBsYXkuXG5cdCAqIHNoYTI1Nihqb2luKHNvcnQoY2h1bmtfaWQgKyBcIjpcIiArIGNvbnRlbnRfaGFzaCksIFwiXFxuXCIpKVxuXHQgKi9cblx0YXN5bmMgZ2V0Q29ycHVzSGFzaCgpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGNodW5rcyA9IHRoaXMuZ2V0QWxsQ2h1bmtzKCk7XG5cdFx0Y29uc3QgbGluZXMgPSBjaHVua3MubWFwKGMgPT4gYCR7Yy5rZXl9OiR7Yy50ZXh0SGFzaH1gKTtcblx0XHRsaW5lcy5zb3J0KCk7XG5cdFx0Y29uc3Qgam9pbmVkID0gbGluZXMuam9pbignXFxuJyk7XG5cdFx0cmV0dXJuIGF3YWl0IHNoYTI1Nihqb2luZWQpO1xuXHR9XG5cblx0Z2V0SW5kZXhlZFBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rS2V5c0J5UGF0aC5rZXlzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrcyBpZiBhIHBhdGggaXMgY3VycmVudGx5IG1hcmtlZCBhcyBzdGFsZSBpbiB0aGUgaW5kZXggc3RhdGUuXG5cdCAqL1xuXHRpc1N0YWxlKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IHN0YXRlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdO1xuXHRcdGlmICghc3RhdGUpIHJldHVybiBmYWxzZTtcblx0XHRcblx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG5cdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgcmV0dXJuIHRydWU7IC8vIE1pc3NpbmcgZmlsZSBpcyBlZmZlY3RpdmVseSBzdGFsZVxuXHRcdFxuXHRcdC8vIElmIHVwZGF0ZWRBdCBpcyBub3Qgc2V0LCB3ZSBjYW4ndCBiZSBzdXJlLCBhc3N1bWUgbm90IHN0YWxlIGZvciBub3dcblx0XHRpZiAoIXN0YXRlLnVwZGF0ZWRBdCkgcmV0dXJuIGZhbHNlO1xuXHRcdFxuXHRcdGNvbnN0IGZpbGVNdGltZSA9IGZpbGUuc3RhdC5tdGltZTtcblx0XHRjb25zdCBpbmRleFRpbWUgPSBuZXcgRGF0ZShzdGF0ZS51cGRhdGVkQXQpLmdldFRpbWUoKTtcblx0XHRcblx0XHRyZXR1cm4gZmlsZU10aW1lID4gaW5kZXhUaW1lO1xuXHR9XG5cblx0LyoqXG5cdCAqIFF1ZXVlIGFsbCBjdXJyZW50bHkgaW5kZXhlZCBwYXRocyBmb3IgcmUtY2hlY2tpbmcuIFRoaXMgaXMgdXNlZnVsIHdoZW4gZXhjbHVzaW9ucy9wcm9maWxlcyBjaGFuZ2UuXG5cdCAqL1xuXHRxdWV1ZVJlY2hlY2tBbGxJbmRleGVkKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgcCBvZiB0aGlzLmdldEluZGV4ZWRQYXRocygpKSB0aGlzLnF1ZXVlLmFkZChwKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRnZXRWZWN0b3JGb3JLZXkoa2V5OiBzdHJpbmcpOiBudW1iZXJbXSB8IG51bGwge1xuXHRcdGNvbnN0IGNoID0gdGhpcy5jaHVua3NCeUtleS5nZXQoa2V5KTtcblx0XHRyZXR1cm4gY2g/LnZlY3RvciA/PyBudWxsO1xuXHR9XG5cblx0YnVpbGRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IG51bWJlcltdIHtcblx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIGJ1aWxkUXVlcnlWZWN0b3IgY2FsbGVkOyByZXR1cm5pbmcgZW1wdHkgdmVjdG9yLiBVc2UgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLicpO1xuXHRcdHJldHVybiBbXTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgdmVjID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcocXVlcnlUZXh0KTtcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjKSB8fCB2ZWMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xuXHRcdH1cblx0XHRyZXR1cm4gdmVjO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmlzUmVhZE9ubHkpIHtcblx0XHRcdGNvbnNvbGUubG9nKCdbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBwZXJzaXN0ZW5jZTogUmVhZC1Pbmx5IG1vZGUnKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGRpcikpKSB7XG5cdFx0XHRcdC8vIFJlY3Vyc2l2ZSBta2RpclxuXHRcdFx0XHRjb25zdCBwYXJ0cyA9IGRpci5zcGxpdCgnLycpO1xuXHRcdFx0XHRsZXQgY3VycmVudCA9ICcnO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcblx0XHRcdFx0XHRpZiAoIXBhcnQpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdGN1cnJlbnQgKz0gKGN1cnJlbnQgPyAnLycgOiAnJykgKyBwYXJ0O1xuXHRcdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCkpKSB7XG5cdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoY3VycmVudCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoYXdhaXQgdGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblxuXHRcdC8vIEVuc3VyZSBtYW5pZmVzdCBleGlzdHMgaW4gdGhlIGluZGV4IGRpcmVjdG9yeVxuXHRcdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGAke2Rpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtYW5pZmVzdFBhdGgpKSkge1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSB7XG5cdFx0XHRcdHNjaGVtYVZlcnNpb246IDIsXG5cdFx0XHRcdGVtYmVkZGluZ1Byb2ZpbGU6IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpLFxuXHRcdFx0XHRlbmdpbmU6ICdqc29uJ1xuXHRcdFx0fTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtYW5pZmVzdFBhdGgsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XG5cdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblx0XG59XG5cblxuIl19