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
        // Optionally remove lock if we own it
        const dir = await this.resolveIndexDir();
        const lockPath = `${dir}/index.lock`;
        try {
            if (await this.vault.adapter.exists(lockPath)) {
                const raw = await this.vault.adapter.read(lockPath);
                if (raw.startsWith('writing-dashboard:')) {
                    await this.vault.adapter.remove(lockPath);
                }
            }
        }
        catch {
            // ignore
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
        try {
            if (await this.vault.adapter.exists(lockPath)) {
                const raw = await this.vault.adapter.read(lockPath);
                const [ownerId, tsStr] = raw.split(':');
                const ts = parseInt(tsStr);
                const now = Date.now();
                if (ownerId !== myId && (now - ts) < 60000) {
                    this.isReadOnly = true;
                    return false;
                }
            }
            // Acquire or refresh lock
            await this.vault.adapter.write(lockPath, `${myId}:${Date.now()}`);
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
                await this.vault.adapter.write(lockPath, `writing-dashboard:${Date.now()}`);
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
            const dir = await this.resolveIndexDir();
            const path = await this.getIndexFilePath();
            if (!(await this.validateManifest(dir))) {
                console.warn('[EmbeddingsIndex] Manifest mismatch; falling back to isolated mode');
                this.currentStorageMode = 'isolated'; // Internal override for this session
                // Re-resolve path after fallback
                const newDir = await this.resolveIndexDir();
                if (!(await this.vault.adapter.exists(newDir))) {
                    await this.vault.adapter.mkdir(newDir);
                }
            }
            // In auto/manual, we need to handle read-only state
            const mode = this.plugin.settings.embeddingStorageMode || 'isolated';
            if (mode !== 'isolated') {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRW1iZWRkaW5nc0luZGV4LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiRW1iZWRkaW5nc0luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUNBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFFakMsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sWUFBWSxDQUFDO0FBQzlDLE9BQU8sRUFBVyxNQUFNLEVBQUUsTUFBTSxnQkFBZ0IsQ0FBQztBQUVqRCxPQUFPLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxXQUFXLENBQUM7QUFhaEQ7O0dBRUc7QUFDSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsSUFBWTtJQUM5QyxPQUFPLElBQUk7U0FDVCxJQUFJLEVBQUU7U0FDTixPQUFPLENBQUMsT0FBTyxFQUFFLElBQUksQ0FBQyxDQUFDLHFCQUFxQjtTQUM1QyxPQUFPLENBQUMsS0FBSyxFQUFFLElBQUksQ0FBQztTQUNwQixPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUMsd0JBQXdCO0FBQ3BELENBQUM7QUFVRCxTQUFTLFFBQVEsQ0FBQyxLQUFhLEVBQUUsR0FBVyxFQUFFLEdBQVc7SUFDeEQsSUFBSSxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxHQUFHLENBQUM7SUFDeEMsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RCxDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsTUFBOEI7SUFDbEQsT0FBTztRQUNOLFlBQVksRUFBRSxNQUFNLENBQUMsUUFBUSxDQUFDLDBCQUEwQixJQUFJLElBQUk7UUFDaEUsV0FBVyxFQUFFLFFBQVEsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLG1CQUFtQixJQUFJLEdBQUcsRUFBRSxH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LFlBQVksQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUN0RCxNQUFNLFFBQVEsR0FBRztnQkFDaEIsYUFBYSxFQUFFLENBQUM7Z0JBQ2hCLGdCQUFnQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsRUFBRTtnQkFDNUMsTUFBTSxFQUFFLE1BQU07YUFDZCxDQUFDO1lBQ0YsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsWUFBWSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pGLENBQUM7SUFDRixDQUFDO0lBRU8scUJBQXFCO1FBQzVCLElBQUksSUFBSSxDQUFDLGlCQUFpQjtZQUFFLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLENBQUM7UUFDeEUsSUFBSSxDQUFDLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFO1lBQy9DLElBQUksQ0FBQyxpQkFBaUIsR0FBRyxJQUFJLENBQUM7WUFDOUIsS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLFlBQVksRUFBRSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUU7Z0JBQzFDLFNBQVM7WUFDVixDQUFDLENBQUMsQ0FBQztRQUNKLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQztJQUNWLENBQUM7Q0FFRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBXcml0aW5nRGFzaGJvYXJkUGx1Z2luIGZyb20gJy4uLy4uL21haW4nO1xuaW1wb3J0IHsgYnVpbGRJbmRleENodW5rcyB9IGZyb20gJy4vQ2h1bmtpbmcnO1xuaW1wb3J0IHsgZm52MWEzMiwgc2hhMjU2IH0gZnJvbSAnLi4vQ29udGVudEhhc2gnO1xuaW1wb3J0IHsgT2xsYW1hRW1iZWRkaW5nUHJvdmlkZXIgfSBmcm9tICcuL09sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyJztcbmltcG9ydCB7IENPX0FVVEhPUklOR19QT0xJQ1kgfSBmcm9tICcuLi9wb2xpY3knO1xuXG5leHBvcnQgaW50ZXJmYWNlIEluZGV4ZWRDaHVuayB7XG5cdGtleTogc3RyaW5nO1xuXHRwYXRoOiBzdHJpbmc7XG5cdGNodW5rSW5kZXg6IG51bWJlcjtcblx0c3RhcnRXb3JkOiBudW1iZXI7XG5cdGVuZFdvcmQ6IG51bWJlcjtcblx0dGV4dEhhc2g6IHN0cmluZzsgLy8gU0hBLTI1NlxuXHR2ZWN0b3I6IG51bWJlcltdO1xuXHRleGNlcnB0OiBzdHJpbmc7XG59XG5cbi8qKlxuICogU3RhYmxlIG5vcm1hbGl6YXRpb24gZm9yIGJpdC1wZXJmZWN0IGhhc2ggY29udGludWl0eS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUNodW5rVGV4dCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdGV4dFxuXHRcdC50cmltKClcblx0XHQucmVwbGFjZSgvXFxyXFxuL2csICdcXG4nKSAvLyBOb3JtYWxpemUgbmV3bGluZXNcblx0XHQucmVwbGFjZSgvXFxyL2csICdcXG4nKVxuXHRcdC5yZXBsYWNlKC9bIFxcdF0rL2csICcgJyk7IC8vIE5vcm1hbGl6ZSBzcGFjZXMvdGFic1xufVxuXG5pbnRlcmZhY2UgUGVyc2lzdGVkSW5kZXhWMSB7XG5cdHZlcnNpb246IDE7XG5cdGRpbTogbnVtYmVyO1xuXHRiYWNrZW5kOiAnb2xsYW1hJztcblx0Y2h1bmtpbmc/OiB7IGhlYWRpbmdMZXZlbDogJ2gxJyB8ICdoMicgfCAnaDMnIHwgJ25vbmUnOyB0YXJnZXRXb3JkczogbnVtYmVyOyBvdmVybGFwV29yZHM6IG51bWJlciB9O1xuXHRjaHVua3M6IEluZGV4ZWRDaHVua1tdO1xufVxuXG5mdW5jdGlvbiBjbGFtcEludCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuXHRpZiAoIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHJldHVybiBtaW47XG5cdHJldHVybiBNYXRoLm1heChtaW4sIE1hdGgubWluKG1heCwgTWF0aC5mbG9vcih2YWx1ZSkpKTtcbn1cblxuZnVuY3Rpb24gY2h1bmtpbmdLZXkocGx1Z2luOiBXcml0aW5nRGFzaGJvYXJkUGx1Z2luKTogeyBoZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJzsgdGFyZ2V0V29yZHM6IG51bWJlcjsgb3ZlcmxhcFdvcmRzOiBudW1iZXIgfSB7XG5cdHJldHVybiB7XG5cdFx0aGVhZGluZ0xldmVsOiBwbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWwgPz8gJ2gxJyxcblx0XHR0YXJnZXRXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rV29yZHMgPz8gNTAwLCAyMDAsIDIwMDApLFxuXHRcdG92ZXJsYXBXb3JkczogY2xhbXBJbnQocGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbENodW5rT3ZlcmxhcFdvcmRzID8/IDEwMCwgMCwgNTAwKVxuXHR9O1xufVxuXG5mdW5jdGlvbiBleGNlcnB0T2YodGV4dDogc3RyaW5nLCBtYXhDaGFyczogbnVtYmVyKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IHRleHQudHJpbSgpLnJlcGxhY2UoL1xccysvZywgJyAnKTtcblx0aWYgKHRyaW1tZWQubGVuZ3RoIDw9IG1heENoYXJzKSByZXR1cm4gdHJpbW1lZDtcblx0cmV0dXJuIGAke3RyaW1tZWQuc2xpY2UoMCwgbWF4Q2hhcnMpfeKApmA7XG59XG5cbmludGVyZmFjZSBFcnJvckxvZ0VudHJ5IHtcblx0dGltZXN0YW1wOiBzdHJpbmc7XG5cdGxvY2F0aW9uOiBzdHJpbmc7IC8vIFdoZXJlIHRoZSBlcnJvciBvY2N1cnJlZCAobWV0aG9kL2Z1bmN0aW9uIG5hbWUpXG5cdGNvbnRleHQ6IHN0cmluZzsgLy8gV2hhdCB3YXMgaGFwcGVuaW5nIChmaWxlIHBhdGgsIGNodW5rIGluZGV4LCBldGMuKVxuXHRtZXNzYWdlOiBzdHJpbmc7XG5cdHN0YWNrPzogc3RyaW5nO1xuXHRlcnJvclR5cGU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBFbWJlZGRpbmdzSW5kZXgge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgZGltOiBudW1iZXI7XG5cdHByaXZhdGUgcmVhZG9ubHkgYmFja2VuZDogJ29sbGFtYSc7XG5cdHByaXZhdGUgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyO1xuXG5cdHByaXZhdGUgbG9hZGVkID0gZmFsc2U7XG5cdHByaXZhdGUgY2h1bmtzQnlLZXkgPSBuZXcgTWFwPHN0cmluZywgSW5kZXhlZENodW5rPigpO1xuXHRwcml2YXRlIGNodW5rS2V5c0J5UGF0aCA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8c3RyaW5nPj4oKTtcblxuXHRwcml2YXRlIHJlYWRvbmx5IHF1ZXVlID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cdHByaXZhdGUgd29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRwcml2YXRlIHJlYnVpbGRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgcGVyc2lzdFRpbWVyOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblx0cHJpdmF0ZSBzZXR0aW5nc1NhdmVUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cblx0Ly8gRXJyb3IgdHJhY2tpbmdcblx0cHJpdmF0ZSByZWFkb25seSBlcnJvckxvZzogRXJyb3JMb2dFbnRyeVtdID0gW107XG5cdHByaXZhdGUgcmVhZG9ubHkgbWF4U3RvcmVkRXJyb3JzID0gMTAwO1xuXHRcblx0Ly8gQ2lyY3VpdCBicmVha2VyIGZvciBBSSBlbWJlZGRpbmcgZmFpbHVyZXNcblx0cHJpdmF0ZSBhaUVycm9yU3RyZWFrID0gMDtcblx0cHJpdmF0ZSByZWFkb25seSBBSV9FUlJPUl9TVFJFQUtfVEhSRVNIT0xEID0gMztcblx0cHJpdmF0ZSByZWFkb25seSBBSV9QQVVTRV9EVVJBVElPTl9NUyA9IDE1MDAwO1xuXG5cdC8vIFNoYXJlZCBCcmFpbiBzdGF0ZVxuXHRwcml2YXRlIGlzUmVhZE9ubHkgPSBmYWxzZTtcblx0cHJpdmF0ZSBoZWFydGJlYXRUaW1lcjogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cdHByaXZhdGUgY3VycmVudFN0b3JhZ2VNb2RlOiAnaXNvbGF0ZWQnIHwgJ2F1dG8nIHwgJ21hbnVhbCcgfCBudWxsID0gbnVsbDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQsIHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiwgZW1iZWRkaW5nUHJvdmlkZXI6IE9sbGFtYUVtYmVkZGluZ1Byb3ZpZGVyKSB7XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMucGx1Z2luID0gcGx1Z2luO1xuXHRcdHRoaXMuYmFja2VuZCA9ICdvbGxhbWEnO1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBlbWJlZGRpbmdQcm92aWRlcjtcblx0XHR0aGlzLmRpbSA9IDA7XG5cdH1cblxuXHQvKipcblx0ICogSG90LXN3YXBzIHRoZSBlbWJlZGRpbmcgcHJvdmlkZXIgKGUuZy4gd2hlbiB1c2VyIGNoYW5nZXMgbW9kZWxzKS5cblx0ICovXG5cdHVwZGF0ZVByb3ZpZGVyKHByb3ZpZGVyOiBPbGxhbWFFbWJlZGRpbmdQcm92aWRlcikge1xuXHRcdHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIgPSBwcm92aWRlcjtcblx0fVxuXG5cdGFzeW5jIG9udW5sb2FkKCkge1xuXHRcdHRoaXMuc3RvcEhlYXJ0YmVhdCgpO1xuXHRcdC8vIE9wdGlvbmFsbHkgcmVtb3ZlIGxvY2sgaWYgd2Ugb3duIGl0XG5cdFx0Y29uc3QgZGlyID0gYXdhaXQgdGhpcy5yZXNvbHZlSW5kZXhEaXIoKTtcblx0XHRjb25zdCBsb2NrUGF0aCA9IGAke2Rpcn0vaW5kZXgubG9ja2A7XG5cdFx0dHJ5IHtcblx0XHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGxvY2tQYXRoKSkge1xuXHRcdFx0XHRjb25zdCByYXcgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZChsb2NrUGF0aCk7XG5cdFx0XHRcdGlmIChyYXcuc3RhcnRzV2l0aCgnd3JpdGluZy1kYXNoYm9hcmQ6JykpIHtcblx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVtb3ZlKGxvY2tQYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlXG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFJldHVybnMgdGhlIGNhbm9uaWNhbCBlbWJlZGRpbmcgcHJvZmlsZSAoc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCkuXG5cdCAqIFVzZWQgZm9yIGhhbmRzaGFrZSBmaWxlcywgbWFuaWZlc3QgdmFsaWRhdGlvbiwgYW5kIHByb2ZpbGUgbWF0Y2hpbmcuXG5cdCAqL1xuXHRnZXRFbWJlZGRpbmdQcm9maWxlKCkge1xuXHRcdHJldHVybiB7XG5cdFx0XHRwcm92aWRlcjogJ29sbGFtYScgYXMgY29uc3QsXG5cdFx0XHRtb2RlbElkOiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZWxheUVtYmVkZGluZ01vZGVsLFxuXHRcdFx0ZGltZW5zaW9uczogdGhpcy5kaW0gfHwgNzY4LFxuXHRcdFx0bm9ybWFsaXplOiB0cnVlLFxuXHRcdFx0Y2h1bmtpbmdWZXJzaW9uOiAyLFxuXHRcdFx0c2NoZW1hVmVyc2lvbjogMlxuXHRcdH07XG5cdH1cblxuXHRhc3luYyByZXNvbHZlSW5kZXhEaXIoKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBtb2RlID0gdGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgfHwgdGhpcy5wbHVnaW4uc2V0dGluZ3MuZW1iZWRkaW5nU3RvcmFnZU1vZGUgfHwgJ2lzb2xhdGVkJztcblxuXHRcdGlmIChtb2RlID09PSAnaXNvbGF0ZWQnKSB7XG5cdFx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0XHR9XG5cblx0XHRpZiAobW9kZSA9PT0gJ21hbnVhbCcpIHtcblx0XHRcdGNvbnN0IG1hbnVhbFBhdGggPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5tYW51YWxTaGFyZWRQYXRoO1xuXHRcdFx0aWYgKG1hbnVhbFBhdGgpIHJldHVybiBtYW51YWxQYXRoO1xuXHRcdFx0cmV0dXJuIGAke3RoaXMudmF1bHQuY29uZmlnRGlyfS9wbHVnaW5zLyR7dGhpcy5wbHVnaW4ubWFuaWZlc3QuaWR9L3JhZy1pbmRleGA7XG5cdFx0fVxuXG5cdFx0Ly8gYXV0byBtb2RlXG5cdFx0Y29uc3Qgc3Rvcnlib2FyZEhhbmRzaGFrZVBhdGggPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vZW1iZWRkaW5ncy9oYW5kc2hha2Uvc3Rvcnlib2FyZC5qc29uYDtcblx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhzdG9yeWJvYXJkSGFuZHNoYWtlUGF0aCkpIHtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHN0b3J5Ym9hcmRIYW5kc2hha2VQYXRoKTtcblx0XHRcdFx0Y29uc3Qgc3Rvcnlib2FyZCA9IEpTT04ucGFyc2UocmF3KTtcblx0XHRcdFx0aWYgKHRoaXMucHJvZmlsZXNNYXRjaChzdG9yeWJvYXJkLmVtYmVkZGluZ1Byb2ZpbGUpKSB7XG5cdFx0XHRcdFx0cmV0dXJuICdFbWJlZGRpbmdzL3NoYXJlZC1pbmRleCc7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBTaGFyZWQgaW5kZXggZGlzYWJsZWQ6IGVtYmVkZGluZyBwcm9maWxlcyBkbyBub3QgbWF0Y2ggc3Rvcnlib2FyZCcpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGNhdGNoIChlcnIpIHtcblx0XHRcdFx0Y29uc29sZS5lcnJvcignW0VtYmVkZGluZ3NJbmRleF0gRmFpbGVkIHRvIHJlYWQgc3Rvcnlib2FyZCBoYW5kc2hha2U6JywgZXJyKTtcblx0XHRcdH1cblx0XHR9XG5cblx0XHRyZXR1cm4gYCR7dGhpcy52YXVsdC5jb25maWdEaXJ9L3BsdWdpbnMvJHt0aGlzLnBsdWdpbi5tYW5pZmVzdC5pZH0vcmFnLWluZGV4YDtcblx0fVxuXG5cdHByaXZhdGUgcHJvZmlsZXNNYXRjaChvdGhlcjogYW55KTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgbWluZSA9IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpO1xuXHRcdHJldHVybiAoXG5cdFx0XHRtaW5lLnByb3ZpZGVyID09PSBvdGhlci5wcm92aWRlciAmJlxuXHRcdFx0bWluZS5tb2RlbElkID09PSBvdGhlci5tb2RlbElkICYmXG5cdFx0XHRtaW5lLmRpbWVuc2lvbnMgPT09IG90aGVyLmRpbWVuc2lvbnMgJiZcblx0XHRcdG1pbmUubm9ybWFsaXplID09PSBvdGhlci5ub3JtYWxpemUgJiZcblx0XHRcdG1pbmUuY2h1bmtpbmdWZXJzaW9uID09PSBvdGhlci5jaHVua2luZ1ZlcnNpb24gJiZcblx0XHRcdG1pbmUuc2NoZW1hVmVyc2lvbiA9PT0gb3RoZXIuc2NoZW1hVmVyc2lvblxuXHRcdCk7XG5cdH1cblxuXHRhc3luYyB2YWxpZGF0ZU1hbmlmZXN0KGRpcjogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG5cdFx0Y29uc3QgbWFuaWZlc3RQYXRoID0gYCR7ZGlyfS9pbmRleC5tYW5pZmVzdC5qc29uYDtcblx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG1hbmlmZXN0UGF0aCkpKSByZXR1cm4gdHJ1ZTsgLy8gTm8gbWFuaWZlc3QgeWV0XG5cblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobWFuaWZlc3RQYXRoKTtcblx0XHRcdGNvbnN0IG1hbmlmZXN0ID0gSlNPTi5wYXJzZShyYXcpO1xuXHRcdFx0cmV0dXJuIHRoaXMucHJvZmlsZXNNYXRjaChtYW5pZmVzdC5lbWJlZGRpbmdQcm9maWxlKTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdHJldHVybiBmYWxzZTtcblx0XHR9XG5cdH1cblxuXHRhc3luYyBhY3F1aXJlTG9jayhkaXI6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuXHRcdGNvbnN0IGxvY2tQYXRoID0gYCR7ZGlyfS9pbmRleC5sb2NrYDtcblx0XHRjb25zdCBteUlkID0gJ3dyaXRpbmctZGFzaGJvYXJkJztcblxuXHRcdHRyeSB7XG5cdFx0XHRpZiAoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhsb2NrUGF0aCkpIHtcblx0XHRcdFx0Y29uc3QgcmF3ID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWQobG9ja1BhdGgpO1xuXHRcdFx0XHRjb25zdCBbb3duZXJJZCwgdHNTdHJdID0gcmF3LnNwbGl0KCc6Jyk7XG5cdFx0XHRcdGNvbnN0IHRzID0gcGFyc2VJbnQodHNTdHIpO1xuXHRcdFx0XHRjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuXG5cdFx0XHRcdGlmIChvd25lcklkICE9PSBteUlkICYmIChub3cgLSB0cykgPCA2MDAwMCkge1xuXHRcdFx0XHRcdHRoaXMuaXNSZWFkT25seSA9IHRydWU7XG5cdFx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cblx0XHRcdC8vIEFjcXVpcmUgb3IgcmVmcmVzaCBsb2NrXG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobG9ja1BhdGgsIGAke215SWR9OiR7RGF0ZS5ub3coKX1gKTtcblx0XHRcdHRoaXMuaXNSZWFkT25seSA9IGZhbHNlO1xuXHRcdFx0dGhpcy5zdGFydEhlYXJ0YmVhdChsb2NrUGF0aCk7XG5cdFx0XHRyZXR1cm4gdHJ1ZTtcblx0XHR9IGNhdGNoIHtcblx0XHRcdHRoaXMuaXNSZWFkT25seSA9IHRydWU7XG5cdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBzdGFydEhlYXJ0YmVhdChsb2NrUGF0aDogc3RyaW5nKSB7XG5cdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0dGhpcy5oZWFydGJlYXRUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbChhc3luYyAoKSA9PiB7XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobG9ja1BhdGgsIGB3cml0aW5nLWRhc2hib2FyZDoke0RhdGUubm93KCl9YCk7XG5cdFx0XHR9IGNhdGNoIHtcblx0XHRcdFx0dGhpcy5zdG9wSGVhcnRiZWF0KCk7XG5cdFx0XHR9XG5cdFx0fSwgMzAwMDApO1xuXHR9XG5cblx0cHJpdmF0ZSBzdG9wSGVhcnRiZWF0KCkge1xuXHRcdGlmICh0aGlzLmhlYXJ0YmVhdFRpbWVyKSB7XG5cdFx0XHRjbGVhckludGVydmFsKHRoaXMuaGVhcnRiZWF0VGltZXIpO1xuXHRcdFx0dGhpcy5oZWFydGJlYXRUaW1lciA9IG51bGw7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgc2VlZFNoYXJlZEluZGV4KHNvdXJjZURpcjogc3RyaW5nLCB0YXJnZXREaXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGAke3RhcmdldERpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0Y29uc3QgaW5kZXhQYXRoID0gYCR7dGFyZ2V0RGlyfS9pbmRleC5qc29uYDtcblxuXHRcdGNvbnN0IGlzRW1wdHkgPSAhKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMobWFuaWZlc3RQYXRoKSkgfHwgIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGluZGV4UGF0aCkpO1xuXHRcdGlmICghaXNFbXB0eSkgcmV0dXJuO1xuXG5cdFx0Y29uc3Qgc291cmNlSW5kZXggPSBgJHtzb3VyY2VEaXJ9L2luZGV4Lmpzb25gO1xuXHRcdGlmIChhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKHNvdXJjZUluZGV4KSkge1xuXHRcdFx0dHJ5IHtcblx0XHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyh0YXJnZXREaXIpKSkge1xuXHRcdFx0XHRcdC8vIFJlY3Vyc2l2ZSBta2RpclxuXHRcdFx0XHRcdGNvbnN0IHBhcnRzID0gdGFyZ2V0RGlyLnNwbGl0KCcvJyk7XG5cdFx0XHRcdFx0bGV0IGN1cnJlbnQgPSAnJztcblx0XHRcdFx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcblx0XHRcdFx0XHRcdGlmICghcGFydCkgY29udGludWU7XG5cdFx0XHRcdFx0XHRjdXJyZW50ICs9IChjdXJyZW50ID8gJy8nIDogJycpICsgcGFydDtcblx0XHRcdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCkpKSB7XG5cdFx0XHRcdFx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcblx0XHRcdFx0XHRcdH1cblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHNvdXJjZUluZGV4KTtcblx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlKGluZGV4UGF0aCwgY29udGVudCk7XG5cblx0XHRcdFx0Y29uc3QgbWFuaWZlc3QgPSB7XG5cdFx0XHRcdFx0c2NoZW1hVmVyc2lvbjogMixcblx0XHRcdFx0XHRlbWJlZGRpbmdQcm9maWxlOiB0aGlzLmdldEVtYmVkZGluZ1Byb2ZpbGUoKSxcblx0XHRcdFx0XHRlbmdpbmU6ICdqc29uJ1xuXHRcdFx0XHR9O1xuXHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUobWFuaWZlc3RQYXRoLCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoJ1tFbWJlZGRpbmdzSW5kZXhdIFNlZWRpbmcgZmFpbGVkOicsIGVycik7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZ2V0SW5kZXhGaWxlUGF0aCgpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGRpciA9IGF3YWl0IHRoaXMucmVzb2x2ZUluZGV4RGlyKCk7XG5cdFx0cmV0dXJuIGAke2Rpcn0vaW5kZXguanNvbmA7XG5cdH1cblxuXHRhc3luYyBjbGVhckluZGV4KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMuY2h1bmtzQnlLZXkuY2xlYXIoKTtcblx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7fTtcblx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcblx0XHRjb25zdCBwYXRoID0gYXdhaXQgdGhpcy5nZXRJbmRleEZpbGVQYXRoKCk7XG5cdFx0aWYgKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMocGF0aCkpIHtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZW1vdmUocGF0aCk7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgZW5zdXJlTG9hZGVkKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmxvYWRlZCkgcmV0dXJuO1xuXHRcdHRoaXMubG9hZGVkID0gdHJ1ZTtcblxuXHRcdHRyeSB7XG5cdFx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0Y29uc3QgcGF0aCA9IGF3YWl0IHRoaXMuZ2V0SW5kZXhGaWxlUGF0aCgpO1xuXG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhbGlkYXRlTWFuaWZlc3QoZGlyKSkpIHtcblx0XHRcdFx0Y29uc29sZS53YXJuKCdbRW1iZWRkaW5nc0luZGV4XSBNYW5pZmVzdCBtaXNtYXRjaDsgZmFsbGluZyBiYWNrIHRvIGlzb2xhdGVkIG1vZGUnKTtcblx0XHRcdFx0dGhpcy5jdXJyZW50U3RvcmFnZU1vZGUgPSAnaXNvbGF0ZWQnOyAvLyBJbnRlcm5hbCBvdmVycmlkZSBmb3IgdGhpcyBzZXNzaW9uXG5cdFx0XHRcdC8vIFJlLXJlc29sdmUgcGF0aCBhZnRlciBmYWxsYmFja1xuXHRcdFx0XHRjb25zdCBuZXdEaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKG5ld0RpcikpKSB7XG5cdFx0XHRcdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKG5ld0Rpcik7XG5cdFx0XHRcdH1cblx0XHRcdH1cblxuXHRcdFx0Ly8gSW4gYXV0by9tYW51YWwsIHdlIG5lZWQgdG8gaGFuZGxlIHJlYWQtb25seSBzdGF0ZVxuXHRcdFx0Y29uc3QgbW9kZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLmVtYmVkZGluZ1N0b3JhZ2VNb2RlIHx8ICdpc29sYXRlZCc7XG5cdFx0XHRpZiAobW9kZSAhPT0gJ2lzb2xhdGVkJykge1xuXHRcdFx0XHRjb25zdCBzb3VyY2VEaXIgPSBgJHt0aGlzLnZhdWx0LmNvbmZpZ0Rpcn0vcGx1Z2lucy8ke3RoaXMucGx1Z2luLm1hbmlmZXN0LmlkfS9yYWctaW5kZXhgO1xuXHRcdFx0XHRhd2FpdCB0aGlzLnNlZWRTaGFyZWRJbmRleChzb3VyY2VEaXIsIGRpcik7XG5cdFx0XHRcdGF3YWl0IHRoaXMuYWNxdWlyZUxvY2soZGlyKTtcblx0XHRcdH1cblxuXHRcdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhwYXRoKSkpIHJldHVybjtcblx0XHRcdGNvbnN0IHJhdyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkKHBhdGgpO1xuXHRcdFx0Y29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIFBlcnNpc3RlZEluZGV4VjE7XG5cdFx0XHRpZiAocGFyc2VkPy52ZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZC5jaHVua3MpKSByZXR1cm47XG5cdFx0XHRpZiAocGFyc2VkLmJhY2tlbmQgJiYgcGFyc2VkLmJhY2tlbmQgIT09IHRoaXMuYmFja2VuZCkge1xuXHRcdFx0XHQvLyBCYWNrZW5kIG1pc21hdGNoOiBpZ25vcmUgcGVyc2lzdGVkIGluZGV4IGFuZCByZWJ1aWxkLlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGlmICh0eXBlb2YgcGFyc2VkLmRpbSA9PT0gJ251bWJlcicpIHtcblx0XHRcdFx0dGhpcy5kaW0gPSBwYXJzZWQuZGltO1xuXHRcdFx0fVxuXHRcdFx0Y29uc3QgZXhwZWN0ZWRDaHVua2luZyA9IGNodW5raW5nS2V5KHRoaXMucGx1Z2luKTtcblx0XHRcdGlmIChcblx0XHRcdFx0cGFyc2VkLmNodW5raW5nICYmXG5cdFx0XHRcdChwYXJzZWQuY2h1bmtpbmcuaGVhZGluZ0xldmVsICE9PSBleHBlY3RlZENodW5raW5nLmhlYWRpbmdMZXZlbCB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy50YXJnZXRXb3JkcyAhPT0gZXhwZWN0ZWRDaHVua2luZy50YXJnZXRXb3JkcyB8fFxuXHRcdFx0XHRcdHBhcnNlZC5jaHVua2luZy5vdmVybGFwV29yZHMgIT09IGV4cGVjdGVkQ2h1bmtpbmcub3ZlcmxhcFdvcmRzKVxuXHRcdFx0KSB7XG5cdFx0XHRcdC8vIENodW5raW5nIGNvbmZpZyBjaGFuZ2VkOyByZWJ1aWxkIGluZGV4LlxuXHRcdFx0XHR0aGlzLmVucXVldWVGdWxsUmVzY2FuKCk7XG5cdFx0XHRcdHJldHVybjtcblx0XHRcdH1cblx0XHRcdGZvciAoY29uc3QgY2h1bmsgb2YgcGFyc2VkLmNodW5rcykge1xuXHRcdFx0XHRpZiAoIWNodW5rPy5rZXkgfHwgIWNodW5rPy5wYXRoIHx8ICFBcnJheS5pc0FycmF5KGNodW5rLnZlY3RvcikpIGNvbnRpbnVlO1xuXHRcdFx0XHR0aGlzLl9zZXRDaHVuayhjaHVuayk7XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBDb3JydXB0IGluZGV4IHNob3VsZCBub3QgYnJlYWsgdGhlIHBsdWdpbi4gV2UnbGwgcmVidWlsZCBsYXppbHkuXG5cdFx0XHR0aGlzLmNodW5rc0J5S2V5LmNsZWFyKCk7XG5cdFx0XHR0aGlzLmNodW5rS2V5c0J5UGF0aC5jbGVhcigpO1xuXHRcdH1cblx0fVxuXG5cdGdldFN0YXR1cygpOiB7IGluZGV4ZWRGaWxlczogbnVtYmVyOyBpbmRleGVkQ2h1bmtzOiBudW1iZXI7IHBhdXNlZDogYm9vbGVhbjsgcXVldWVkOiBudW1iZXIgfSB7XG5cdFx0cmV0dXJuIHtcblx0XHRcdGluZGV4ZWRGaWxlczogdGhpcy5jaHVua0tleXNCeVBhdGguc2l6ZSxcblx0XHRcdGluZGV4ZWRDaHVua3M6IHRoaXMuY2h1bmtzQnlLZXkuc2l6ZSxcblx0XHRcdHBhdXNlZDogQm9vbGVhbih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCksXG5cdFx0XHRxdWV1ZWQ6IHRoaXMucXVldWUuc2l6ZVxuXHRcdH07XG5cdH1cblxuXHRnZXRSZWNlbnRFcnJvcnMobGltaXQ6IG51bWJlciA9IDIwKTogRXJyb3JMb2dFbnRyeVtdIHtcblx0XHRyZXR1cm4gdGhpcy5lcnJvckxvZy5zbGljZSgtbGltaXQpO1xuXHR9XG5cblx0Z2V0RXJyb3JTdW1tYXJ5KCk6IHsgdG90YWw6IG51bWJlcjsgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPjsgcmVjZW50OiBFcnJvckxvZ0VudHJ5W10gfSB7XG5cdFx0Y29uc3QgYnlMb2NhdGlvbjogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuXHRcdGZvciAoY29uc3QgZXJyIG9mIHRoaXMuZXJyb3JMb2cpIHtcblx0XHRcdGJ5TG9jYXRpb25bZXJyLmxvY2F0aW9uXSA9IChieUxvY2F0aW9uW2Vyci5sb2NhdGlvbl0gfHwgMCkgKyAxO1xuXHRcdH1cblx0XHRyZXR1cm4ge1xuXHRcdFx0dG90YWw6IHRoaXMuZXJyb3JMb2cubGVuZ3RoLFxuXHRcdFx0YnlMb2NhdGlvbixcblx0XHRcdHJlY2VudDogdGhpcy5lcnJvckxvZy5zbGljZSgtMTApXG5cdFx0fTtcblx0fVxuXG5cdHByaXZhdGUgbG9nRXJyb3IobG9jYXRpb246IHN0cmluZywgY29udGV4dDogc3RyaW5nLCBlcnJvcjogdW5rbm93bik6IHZvaWQge1xuXHRcdGNvbnN0IGVycm9yTXNnID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuXHRcdGNvbnN0IGVycm9yU3RhY2sgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQ7XG5cdFx0Y29uc3QgZXJyb3JUeXBlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLmNvbnN0cnVjdG9yLm5hbWUgOiB0eXBlb2YgZXJyb3I7XG5cdFx0XG5cdFx0Y29uc3QgZW50cnk6IEVycm9yTG9nRW50cnkgPSB7XG5cdFx0XHR0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcblx0XHRcdGxvY2F0aW9uLFxuXHRcdFx0Y29udGV4dCxcblx0XHRcdG1lc3NhZ2U6IGVycm9yTXNnLFxuXHRcdFx0c3RhY2s6IGVycm9yU3RhY2ssXG5cdFx0XHRlcnJvclR5cGVcblx0XHR9O1xuXHRcdFxuXHRcdHRoaXMuZXJyb3JMb2cucHVzaChlbnRyeSk7XG5cdFx0aWYgKHRoaXMuZXJyb3JMb2cubGVuZ3RoID4gdGhpcy5tYXhTdG9yZWRFcnJvcnMpIHtcblx0XHRcdHRoaXMuZXJyb3JMb2cuc2hpZnQoKTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gQWxzbyBsb2cgdG8gY29uc29sZSBmb3IgZGVidWdnaW5nXG5cdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gRVJST1IgWyR7bG9jYXRpb259XSAke2NvbnRleHR9OmAsIGVycm9yTXNnKTtcblx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0Y29uc29sZS5lcnJvcihgW0VtYmVkZGluZ3NJbmRleF0gU3RhY2s6YCwgZXJyb3JTdGFjay5zcGxpdCgnXFxuJykuc2xpY2UoMCwgMykuam9pbignXFxuJykpO1xuXHRcdH1cblx0fVxuXG5cdGVucXVldWVGdWxsUmVzY2FuKCk6IHZvaWQge1xuXHRcdGNvbnN0IGZpbGVzID0gdGhpcy5wbHVnaW4udmF1bHRTZXJ2aWNlLmdldEluY2x1ZGVkTWFya2Rvd25GaWxlcygpO1xuXHRcdGZvciAoY29uc3QgZiBvZiBmaWxlcykgdGhpcy5xdWV1ZS5hZGQoZi5wYXRoKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRxdWV1ZVVwZGF0ZUZpbGUocGF0aDogc3RyaW5nKTogdm9pZCB7XG5cdFx0aWYgKCFwYXRoKSByZXR1cm47XG5cdFx0dGhpcy5xdWV1ZS5hZGQocGF0aCk7XG5cdFx0dGhpcy5fc2NoZWR1bGVSZWJ1aWxkKCk7XG5cdH1cblxuXHRwcml2YXRlIF9zY2hlZHVsZVJlYnVpbGQoKTogdm9pZCB7XG5cdFx0Y29uc3QgcG9saWN5ID0gQ09fQVVUSE9SSU5HX1BPTElDWS5QRVJGT1JNQU5DRTtcblx0XHRpZiAodGhpcy5yZWJ1aWxkVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5yZWJ1aWxkVGltZXIpO1xuXHRcdHRoaXMucmVidWlsZFRpbWVyID0gd2luZG93LnNldFRpbWVvdXQoKCkgPT4ge1xuXHRcdFx0dGhpcy5yZWJ1aWxkVGltZXIgPSBudWxsO1xuXHRcdFx0dGhpcy5fa2lja1dvcmtlcigpO1xuXHRcdH0sIHBvbGljeS5SRUJVSUxEX1FVRVVFX0RFQk9VTkNFX01TKTtcblx0fVxuXG5cdHF1ZXVlUmVtb3ZlRmlsZShwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRpZiAoIXBhdGgpIHJldHVybjtcblx0XHR0aGlzLl9yZW1vdmVQYXRoKHBhdGgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlUGVyc2lzdCgpO1xuXHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdH1cblxuXHRwcml2YXRlIF9raWNrV29ya2VyKCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLndvcmtlclJ1bm5pbmcpIHJldHVybjtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSB0cnVlO1xuXHRcdC8vIEZpcmUgYW5kIGZvcmdldCwgYnV0IGVuc3VyZSBlcnJvcnMgYXJlIHN3YWxsb3dlZC5cblx0XHR2b2lkIHRoaXMuX3J1bldvcmtlcigpLmNhdGNoKCgpID0+IHtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdH0pO1xuXHR9XG5cblx0cHJpdmF0ZSBhc3luYyBfcnVuV29ya2VyKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGF3YWl0IHRoaXMuZW5zdXJlTG9hZGVkKCk7XG5cblx0XHRpZiAodGhpcy5pc1JlYWRPbmx5KSB7XG5cdFx0XHRjb25zb2xlLmxvZygnW0VtYmVkZGluZ3NJbmRleF0gU2hhcmVkIGluZGV4IGxvY2tlZDsgb3BlcmF0aW5nIHJlYWQtb25seS4nKTtcblx0XHRcdHRoaXMud29ya2VyUnVubmluZyA9IGZhbHNlO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIHRvIGF2b2lkIGZhaWx1cmVzLlxuXHRcdGlmICghKGF3YWl0IHRoaXMuZW1iZWRkaW5nUHJvdmlkZXIuaXNBdmFpbGFibGUoKSkpIHtcblx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gT2xsYW1hIG5vdCBhdmFpbGFibGU7IHNraXBwaW5nIHNlbWFudGljIGluZGV4aW5nJyk7XG5cdFx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBwb2xpY3kgPSBDT19BVVRIT1JJTkdfUE9MSUNZLlBFUkZPUk1BTkNFO1xuXHRcdGxldCBwcm9jZXNzZWRDb3VudCA9IDA7XG5cdFx0bGV0IHNraXBwZWRFeGNsdWRlZCA9IDA7XG5cdFx0bGV0IHNraXBwZWROb3RNYXJrZG93biA9IDA7XG5cdFx0bGV0IHNraXBwZWRIYXNoTWF0Y2ggPSAwO1xuXHRcdGxldCBpbmRleGVkQ291bnQgPSAwO1xuXHRcdFxuXHRcdHdoaWxlICh0aGlzLnF1ZXVlLnNpemUgPiAwICYmIGluZGV4ZWRDb3VudCA8IHBvbGljeS5NQVhfUkVCVUlMRFNfUEVSX0JBVENIKSB7XG5cdFx0XHRpZiAodGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhQYXVzZWQpIGJyZWFrO1xuXHRcdFx0Y29uc3QgbmV4dCA9IHRoaXMucXVldWUudmFsdWVzKCkubmV4dCgpLnZhbHVlIGFzIHN0cmluZztcblx0XHRcdHRoaXMucXVldWUuZGVsZXRlKG5leHQpO1xuXHRcdFx0cHJvY2Vzc2VkQ291bnQrKztcblxuXHRcdFx0Ly8gRXhjbHVzaW9ucyBjYW4gY2hhbmdlIGF0IGFueSB0aW1lOyBob25vciB0aGVtIGR1cmluZyBwcm9jZXNzaW5nLlxuXHRcdFx0aWYgKHRoaXMucGx1Z2luLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChuZXh0KSkge1xuXHRcdFx0XHRza2lwcGVkRXhjbHVkZWQrKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobmV4dCk7XG5cdFx0XHQvLyBPbmx5IGluZGV4IG1hcmtkb3duIGZpbGVzLlxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSB8fCBmaWxlLmV4dGVuc2lvbiAhPT0gJ21kJykge1xuXHRcdFx0XHRza2lwcGVkTm90TWFya2Rvd24rKztcblx0XHRcdFx0dGhpcy5fcmVtb3ZlUGF0aChuZXh0KTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVQZXJzaXN0KCk7XG5cdFx0XHRcdHRoaXMuX3NjaGVkdWxlU2V0dGluZ3NTYXZlKCk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xuXHRcdFx0XHRjb25zdCBub3JtYWxpemVkQ29udGVudCA9IG5vcm1hbGl6ZUNodW5rVGV4dChjb250ZW50KTtcblx0XHRcdFx0Y29uc3QgZmlsZUhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZENvbnRlbnQpO1xuXHRcdFx0XHRjb25zdCBwcmV2ID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW25leHRdO1xuXHRcdFx0XHRjb25zdCBpc0N1cnJlbnRseUluZGV4ZWQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5oYXMobmV4dCk7XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBTa2lwIG9ubHkgaWY6IGhhc2ggbWF0Y2hlcyBBTkQgZmlsZSBpcyBhbHJlYWR5IGluZGV4ZWRcblx0XHRcdFx0Ly8gSWYgaGFzaCBtYXRjaGVzIGJ1dCBmaWxlIGlzIE5PVCBpbmRleGVkLCByZS1pbmRleCBpdCAobWlnaHQgaGF2ZSBiZWVuIHJlbW92ZWQpXG5cdFx0XHRcdGlmIChwcmV2Py5oYXNoID09PSBmaWxlSGFzaCAmJiBpc0N1cnJlbnRseUluZGV4ZWQpIHtcblx0XHRcdFx0XHRza2lwcGVkSGFzaE1hdGNoKys7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRhd2FpdCB0aGlzLl9yZWluZGV4RmlsZShuZXh0LCBjb250ZW50KTtcblx0XHRcdFx0aW5kZXhlZENvdW50Kys7XG5cdFx0XHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgPSB7XG5cdFx0XHRcdFx0Li4uKHRoaXMucGx1Z2luLnNldHRpbmdzLnJldHJpZXZhbEluZGV4U3RhdGUgfHwge30pLFxuXHRcdFx0XHRcdFtuZXh0XToge1xuXHRcdFx0XHRcdFx0aGFzaDogZmlsZUhhc2gsXG5cdFx0XHRcdFx0XHRjaHVua0NvdW50OiB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQobmV4dCk/LnNpemUgPz8gMCxcblx0XHRcdFx0XHRcdHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9O1xuXHRcdFx0XHR0aGlzLl9zY2hlZHVsZVBlcnNpc3QoKTtcblx0XHRcdFx0dGhpcy5fc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTtcblx0XHRcdH0gY2F0Y2ggKGVycikge1xuXHRcdFx0XHQvLyBTa2lwIHVucmVhZGFibGUgZmlsZXMsIGJ1dCBsb2cgZm9yIGRlYnVnZ2luZ1xuXHRcdFx0XHR0aGlzLmxvZ0Vycm9yKCdfcnVuV29ya2VyJywgYFByb2Nlc3NpbmcgZmlsZTogJHtuZXh0fWAsIGVycik7XG5cdFx0XHR9XG5cblx0XHRcdC8vIFlpZWxkIHRvIGtlZXAgVUkgcmVzcG9uc2l2ZS5cblx0XHRcdGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwKSk7XG5cdFx0fVxuXG5cdFx0Ly8gTG9nIGluZGV4aW5nIHN0YXRzIGZvciBkZWJ1Z2dpbmdcblx0XHRpZiAocHJvY2Vzc2VkQ291bnQgPiAwKSB7XG5cdFx0XHRjb25zb2xlLmxvZyhgW0VtYmVkZGluZ3NJbmRleF0gUHJvY2Vzc2VkICR7cHJvY2Vzc2VkQ291bnR9IGZpbGVzOiAke2luZGV4ZWRDb3VudH0gaW5kZXhlZCwgJHtza2lwcGVkRXhjbHVkZWR9IGV4Y2x1ZGVkLCAke3NraXBwZWROb3RNYXJrZG93bn0gbm90IG1hcmtkb3duLCAke3NraXBwZWRIYXNoTWF0Y2h9IGhhc2ggbWF0Y2ggKGFscmVhZHkgaW5kZXhlZClgKTtcblx0XHR9XG5cblx0XHR0aGlzLnN0b3BIZWFydGJlYXQoKTtcblx0XHR0aGlzLndvcmtlclJ1bm5pbmcgPSBmYWxzZTtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgX3JlaW5kZXhGaWxlKHBhdGg6IHN0cmluZywgY29udGVudDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0dGhpcy5fcmVtb3ZlUGF0aChwYXRoKTtcblxuXHRcdC8vIElmIE9sbGFtYSBpcyBub3QgYXZhaWxhYmxlLCBza2lwIHNlbWFudGljIGluZGV4aW5nIGZvciB0aGlzIGZpbGUuXG5cdFx0aWYgKCEoYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5pc0F2YWlsYWJsZSgpKSkge1xuXHRcdFx0Y29uc29sZS53YXJuKGBbRW1iZWRkaW5nc0luZGV4XSBPbGxhbWEgbm90IGF2YWlsYWJsZTsgc2tpcHBpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblxuXHRcdC8vIFNraXAgZW1wdHkgZmlsZXNcblx0XHRpZiAoIWNvbnRlbnQgfHwgY29udGVudC50cmltKCkubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIFNraXBwaW5nIGVtcHR5IGZpbGU6ICR7cGF0aH1gKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBjZmcgPSBjaHVua2luZ0tleSh0aGlzLnBsdWdpbik7XG5cdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIFByb2Nlc3NpbmcgZmlsZTogJHtwYXRofWApO1xuXHRcdGNvbnNvbGUubG9nKGAgIC0gQmFja2VuZDogJHt0aGlzLmJhY2tlbmR9YCk7XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDb250ZW50IGxlbmd0aDogJHtjb250ZW50Lmxlbmd0aH0gY2hhcnMsICR7Y29udGVudC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHNgKTtcblx0XHRjb25zb2xlLmxvZyhgICAtIENodW5raW5nIGNvbmZpZzogaGVhZGluZ0xldmVsPSR7Y2ZnLmhlYWRpbmdMZXZlbH0sIHRhcmdldFdvcmRzPSR7Y2ZnLnRhcmdldFdvcmRzfSwgb3ZlcmxhcFdvcmRzPSR7Y2ZnLm92ZXJsYXBXb3Jkc31gKTtcblx0XHRcblx0XHRjb25zdCBjaHVua3MgPSBidWlsZEluZGV4Q2h1bmtzKHtcblx0XHRcdHRleHQ6IGNvbnRlbnQsXG5cdFx0XHRoZWFkaW5nTGV2ZWw6IGNmZy5oZWFkaW5nTGV2ZWwsXG5cdFx0XHR0YXJnZXRXb3JkczogY2ZnLnRhcmdldFdvcmRzLFxuXHRcdFx0b3ZlcmxhcFdvcmRzOiBjZmcub3ZlcmxhcFdvcmRzXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc29sZS5sb2coYCAgLSBDaHVua3MgY3JlYXRlZDogJHtjaHVua3MubGVuZ3RofWApO1xuXHRcdGlmIChjaHVua3MubGVuZ3RoID4gMCkge1xuXHRcdFx0Y29uc29sZS5sb2coYCAgLSBGaXJzdCBjaHVuayBwcmV2aWV3OiAke2NodW5rc1swXS50ZXh0LnN1YnN0cmluZygwLCAxMDApfS4uLmApO1xuXHRcdH1cblx0XHRcblx0XHQvLyBJZiBubyBjaHVua3MgY3JlYXRlZCwgc2tpcCB0aGlzIGZpbGUgKG1pZ2h0IGJlIHRvbyBzaG9ydCBvciBoYXZlIG5vIGhlYWRpbmdzKVxuXHRcdGlmIChjaHVua3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRjb25zb2xlLndhcm4oYFtFbWJlZGRpbmdzSW5kZXhdIE5vIGNodW5rcyBjcmVhdGVkIGZvciAke3BhdGh9IC0gZmlsZSB0b28gc2hvcnQgb3Igbm8gaGVhZGluZ3MgbWF0Y2ggY2h1bmtpbmcgY29uZmlnYCk7XG5cdFx0XHRyZXR1cm47XG5cdFx0fVxuXG5cdFx0bGV0IHN1Y2Nlc3NmdWxDaHVua3MgPSAwO1xuXHRcdGxldCBmaXJzdEVycm9yOiBFcnJvciB8IG51bGwgPSBudWxsO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgY2h1bmtzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IGNodW5rc1tpXTtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRUZXh0ID0gbm9ybWFsaXplQ2h1bmtUZXh0KGNoLnRleHQpO1xuXHRcdFx0Y29uc3QgdGV4dEhhc2ggPSBhd2FpdCBzaGEyNTYobm9ybWFsaXplZFRleHQpO1xuXHRcdFx0Y29uc3Qga2V5ID0gYGNodW5rOiR7cGF0aH06JHtpfWA7XG5cdFx0XHRsZXQgdmVjdG9yOiBudW1iZXJbXTtcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnNvbGUubG9nKGAgIC0gR2VuZXJhdGluZyBlbWJlZGRpbmcgZm9yIGNodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMpLi4uYCk7XG5cdFx0XHRcdGNvbnN0IGVtYmVkU3RhcnQgPSBEYXRlLm5vdygpO1xuXHRcdFx0XHR2ZWN0b3IgPSBhd2FpdCB0aGlzLmVtYmVkZGluZ1Byb3ZpZGVyLmdldEVtYmVkZGluZyhub3JtYWxpemVkVGV4dCk7XG5cdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhayA9IDA7IC8vIFN1Y2Nlc3M6IHJlc2V0IHN0cmVha1xuXHRcdFx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjdG9yKSB8fCB2ZWN0b3IubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbXB0eSBlbWJlZGRpbmcgcmV0dXJuZWQgZnJvbSBPbGxhbWEnKTtcblx0XHRcdFx0fVxuXHRcdFx0XHRpZiAodGhpcy5kaW0gPT09IDApIHtcblx0XHRcdFx0XHR0aGlzLmRpbSA9IHZlY3Rvci5sZW5ndGg7XG5cdFx0XHRcdH1cblx0XHRcdFx0Y29uc3QgZW1iZWREdXJhdGlvbiA9IERhdGUubm93KCkgLSBlbWJlZFN0YXJ0O1xuXHRcdFx0XHRjb25zb2xlLmxvZyhgICAtIOKckyBPbGxhbWEgZW1iZWRkaW5nIGdlbmVyYXRlZCBpbiAke2VtYmVkRHVyYXRpb259bXM6ICR7dmVjdG9yLmxlbmd0aH0gZGltZW5zaW9uc2ApO1xuXHRcdFx0fSBjYXRjaCAoZXJyKSB7XG5cdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhaysrO1xuXHRcdFx0XHRjb25zdCBlcnJvck1zZyA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcblx0XHRcdFx0Y29uc3QgZXJyb3JTdGFjayA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLnN0YWNrIDogdW5kZWZpbmVkO1xuXHRcdFx0XHRjb25zdCBjb250ZXh0ID0gYEZpbGU6ICR7cGF0aH0sIENodW5rICR7aSArIDF9LyR7Y2h1bmtzLmxlbmd0aH0gKCR7Y2gudGV4dC5zcGxpdCgvXFxzKy8pLmxlbmd0aH0gd29yZHMsICR7Y2gudGV4dC5sZW5ndGh9IGNoYXJzKWA7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5lbWJlZENodW5rJywgY29udGV4dCwgZXJyKTtcblx0XHRcdFx0XG5cdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgLSDinJcgRW1iZWRkaW5nIGdlbmVyYXRpb24gZmFpbGVkIGZvciBjaHVuayAke2kgKyAxfS8ke2NodW5rcy5sZW5ndGh9OmAsIGVycm9yTXNnKTtcblx0XHRcdFx0XG5cdFx0XHRcdGlmICh0aGlzLmFpRXJyb3JTdHJlYWsgPj0gMykge1xuXHRcdFx0XHRcdGNvbnNvbGUud2FybignW0VtYmVkZGluZ3NJbmRleF0gRW1iZWRkaW5nIGJyZWFrZXIgdHJpZ2dlcmVkOiBwYXVzZWQgMTVzIGFuZCBjbGVhcmVkIHF1ZXVlIGFmdGVyIDMgY29uc2VjdXRpdmUgZmFpbHVyZXMuJyk7XG5cdFx0XHRcdFx0dGhpcy5xdWV1ZS5jbGVhcigpO1xuXHRcdFx0XHRcdHRoaXMuYWlFcnJvclN0cmVhayA9IDA7XG5cdFx0XHRcdFx0Ly8gWWllbGQgYW5kIHdhaXQgMTVzXG5cdFx0XHRcdFx0YXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDE1MDAwKSk7XG5cdFx0XHRcdFx0dGhyb3cgbmV3IEVycm9yKCdFbWJlZGRpbmcgYnJlYWtlciB0cmlnZ2VyZWQ7IGJhdGNoIGFib3J0ZWQuJyk7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoZXJyb3JTdGFjaykge1xuXHRcdFx0XHRcdGNvbnNvbGUuZXJyb3IoYCAgICBTdGFjazogJHtlcnJvclN0YWNrLnNwbGl0KCdcXG4nKS5zbGljZSgwLCAzKS5qb2luKCdcXG4gICAgJyl9YCk7XG5cdFx0XHRcdH1cblx0XHRcdFx0aWYgKGVyciBpbnN0YW5jZW9mIEVycm9yKSB7XG5cdFx0XHRcdFx0Y29uc29sZS5lcnJvcihgICAgIEVycm9yIHR5cGU6ICR7ZXJyLmNvbnN0cnVjdG9yLm5hbWV9YCk7XG5cdFx0XHRcdFx0aWYgKCdjYXVzZScgaW4gZXJyKSB7XG5cdFx0XHRcdFx0XHRjb25zb2xlLmVycm9yKGAgICAgQ2F1c2U6ICR7ZXJyLmNhdXNlfWApO1xuXHRcdFx0XHRcdH1cblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBJZiBBTEwgY2h1bmtzIGZhaWwgZm9yIGEgZmlsZSwgdGhlIGZpbGUgd29uJ3QgYmUgaW5kZXhlZFxuXHRcdFx0XHQvLyBUaGlzIGlzIGEgY3JpdGljYWwgZmFpbHVyZSB0aGF0IHNob3VsZCBiZSBsb2dnZWRcblx0XHRcdFx0aWYgKGkgPT09IDApIHtcblx0XHRcdFx0XHRjb25zb2xlLndhcm4oYCAgLSBXYXJuaW5nOiBGaXJzdCBjaHVuayBmYWlsZWQgZm9yICR7cGF0aH0uIEF0dGVtcHRpbmcgc3Vic2VxdWVudCBjaHVua3MuYCk7XG5cdFx0XHRcdFx0Zmlyc3RFcnJvciA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyIDogbmV3IEVycm9yKFN0cmluZyhlcnIpKTtcblx0XHRcdFx0fVxuXHRcdFx0XHQvLyBTa2lwIHRoaXMgY2h1bmsgaWYgZW1iZWRkaW5nIGZhaWxzLCBidXQgY29udGludWUgd2l0aCBvdGhlcnNcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRjb25zdCBleGNlcnB0ID0gZXhjZXJwdE9mKGNoLnRleHQsIDI1MDApO1xuXHRcdFx0dGhpcy5fc2V0Q2h1bmsoe1xuXHRcdFx0XHRrZXksXG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGNodW5rSW5kZXg6IGksXG5cdFx0XHRcdHN0YXJ0V29yZDogY2guc3RhcnRXb3JkLFxuXHRcdFx0XHRlbmRXb3JkOiBjaC5lbmRXb3JkLFxuXHRcdFx0XHR0ZXh0SGFzaCxcblx0XHRcdFx0dmVjdG9yLFxuXHRcdFx0XHRleGNlcnB0XG5cdFx0XHR9KTtcblx0XHRcdHN1Y2Nlc3NmdWxDaHVua3MrKztcblx0XHR9XG5cdFx0XG5cdFx0aWYgKHN1Y2Nlc3NmdWxDaHVua3MgPT09IDAgJiYgY2h1bmtzLmxlbmd0aCA+IDApIHtcblx0XHRcdGNvbnN0IGNyaXRpY2FsQ29udGV4dCA9IGBGaWxlOiAke3BhdGh9LCBBbGwgJHtjaHVua3MubGVuZ3RofSBjaHVua3MgZmFpbGVkYDtcblx0XHRcdGlmIChmaXJzdEVycm9yKSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIGZpcnN0RXJyb3IpO1xuXHRcdFx0XHRjb25zb2xlLmVycm9yKGBbRW1iZWRkaW5nc0luZGV4XSBDUklUSUNBTDogQWxsICR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGZhaWxlZCBmb3IgJHtwYXRofSAtIGZpbGUgbm90IGluZGV4ZWRgKTtcblx0XHRcdFx0Y29uc29sZS5lcnJvcihgICBSb290IGNhdXNlOiAke2ZpcnN0RXJyb3IubWVzc2FnZX1gKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdHRoaXMubG9nRXJyb3IoJ19yZWluZGV4RmlsZS5hbGxDaHVua3NGYWlsZWQnLCBjcml0aWNhbENvbnRleHQsIG5ldyBFcnJvcignQWxsIGNodW5rcyBmYWlsZWQgYnV0IG5vIGZpcnN0IGVycm9yIGNhcHR1cmVkJykpO1xuXHRcdFx0fVxuXHRcdH0gZWxzZSBpZiAoc3VjY2Vzc2Z1bENodW5rcyA8IGNodW5rcy5sZW5ndGgpIHtcblx0XHRcdGNvbnNvbGUud2FybihgW0VtYmVkZGluZ3NJbmRleF0gUGFydGlhbCBzdWNjZXNzIGZvciAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9LyR7Y2h1bmtzLmxlbmd0aH0gY2h1bmtzIGluZGV4ZWRgKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc29sZS5sb2coYFtFbWJlZGRpbmdzSW5kZXhdIOKckyBTdWNjZXNzZnVsbHkgaW5kZXhlZCAke3BhdGh9OiAke3N1Y2Nlc3NmdWxDaHVua3N9IGNodW5rc2ApO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgX3NldENodW5rKGNodW5rOiBJbmRleGVkQ2h1bmspOiB2b2lkIHtcblx0XHR0aGlzLmNodW5rc0J5S2V5LnNldChjaHVuay5rZXksIGNodW5rKTtcblx0XHRjb25zdCBzZXQgPSB0aGlzLmNodW5rS2V5c0J5UGF0aC5nZXQoY2h1bmsucGF0aCkgPz8gbmV3IFNldDxzdHJpbmc+KCk7XG5cdFx0c2V0LmFkZChjaHVuay5rZXkpO1xuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLnNldChjaHVuay5wYXRoLCBzZXQpO1xuXHR9XG5cblx0cHJpdmF0ZSBfcmVtb3ZlUGF0aChwYXRoOiBzdHJpbmcpOiB2b2lkIHtcblx0XHRjb25zdCBrZXlzID0gdGhpcy5jaHVua0tleXNCeVBhdGguZ2V0KHBhdGgpO1xuXHRcdGlmIChrZXlzKSB7XG5cdFx0XHRmb3IgKGNvbnN0IGsgb2Yga2V5cykgdGhpcy5jaHVua3NCeUtleS5kZWxldGUoayk7XG5cdFx0fVxuXHRcdHRoaXMuY2h1bmtLZXlzQnlQYXRoLmRlbGV0ZShwYXRoKTtcblxuXHRcdGlmICh0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlPy5bcGF0aF0pIHtcblx0XHRcdGNvbnN0IG5leHQgPSB7IC4uLih0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlIHx8IHt9KSB9O1xuXHRcdFx0ZGVsZXRlIG5leHRbcGF0aF07XG5cdFx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFN0YXRlID0gbmV4dDtcblx0XHR9XG5cdH1cblxuXHRnZXRBbGxDaHVua3MoKTogSW5kZXhlZENodW5rW10ge1xuXHRcdHJldHVybiBBcnJheS5mcm9tKHRoaXMuY2h1bmtzQnlLZXkudmFsdWVzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENvbXB1dGVzIGEgYml0LXBlcmZlY3QgY29ycHVzIGhhc2ggZm9yIHN0cmljdCByZXBsYXkuXG5cdCAqIHNoYTI1Nihqb2luKHNvcnQoY2h1bmtfaWQgKyBcIjpcIiArIGNvbnRlbnRfaGFzaCksIFwiXFxuXCIpKVxuXHQgKi9cblx0YXN5bmMgZ2V0Q29ycHVzSGFzaCgpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGNodW5rcyA9IHRoaXMuZ2V0QWxsQ2h1bmtzKCk7XG5cdFx0Y29uc3QgbGluZXMgPSBjaHVua3MubWFwKGMgPT4gYCR7Yy5rZXl9OiR7Yy50ZXh0SGFzaH1gKTtcblx0XHRsaW5lcy5zb3J0KCk7XG5cdFx0Y29uc3Qgam9pbmVkID0gbGluZXMuam9pbignXFxuJyk7XG5cdFx0cmV0dXJuIGF3YWl0IHNoYTI1Nihqb2luZWQpO1xuXHR9XG5cblx0Z2V0SW5kZXhlZFBhdGhzKCk6IHN0cmluZ1tdIHtcblx0XHRyZXR1cm4gQXJyYXkuZnJvbSh0aGlzLmNodW5rS2V5c0J5UGF0aC5rZXlzKCkpO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrcyBpZiBhIHBhdGggaXMgY3VycmVudGx5IG1hcmtlZCBhcyBzdGFsZSBpbiB0aGUgaW5kZXggc3RhdGUuXG5cdCAqL1xuXHRpc1N0YWxlKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuXHRcdGNvbnN0IHN0YXRlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3MucmV0cmlldmFsSW5kZXhTdGF0ZT8uW3BhdGhdO1xuXHRcdGlmICghc3RhdGUpIHJldHVybiBmYWxzZTtcblx0XHRcblx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG5cdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkgcmV0dXJuIHRydWU7IC8vIE1pc3NpbmcgZmlsZSBpcyBlZmZlY3RpdmVseSBzdGFsZVxuXHRcdFxuXHRcdC8vIElmIHVwZGF0ZWRBdCBpcyBub3Qgc2V0LCB3ZSBjYW4ndCBiZSBzdXJlLCBhc3N1bWUgbm90IHN0YWxlIGZvciBub3dcblx0XHRpZiAoIXN0YXRlLnVwZGF0ZWRBdCkgcmV0dXJuIGZhbHNlO1xuXHRcdFxuXHRcdGNvbnN0IGZpbGVNdGltZSA9IGZpbGUuc3RhdC5tdGltZTtcblx0XHRjb25zdCBpbmRleFRpbWUgPSBuZXcgRGF0ZShzdGF0ZS51cGRhdGVkQXQpLmdldFRpbWUoKTtcblx0XHRcblx0XHRyZXR1cm4gZmlsZU10aW1lID4gaW5kZXhUaW1lO1xuXHR9XG5cblx0LyoqXG5cdCAqIFF1ZXVlIGFsbCBjdXJyZW50bHkgaW5kZXhlZCBwYXRocyBmb3IgcmUtY2hlY2tpbmcuIFRoaXMgaXMgdXNlZnVsIHdoZW4gZXhjbHVzaW9ucy9wcm9maWxlcyBjaGFuZ2UuXG5cdCAqL1xuXHRxdWV1ZVJlY2hlY2tBbGxJbmRleGVkKCk6IHZvaWQge1xuXHRcdGZvciAoY29uc3QgcCBvZiB0aGlzLmdldEluZGV4ZWRQYXRocygpKSB0aGlzLnF1ZXVlLmFkZChwKTtcblx0XHR0aGlzLl9raWNrV29ya2VyKCk7XG5cdH1cblxuXHRnZXRWZWN0b3JGb3JLZXkoa2V5OiBzdHJpbmcpOiBudW1iZXJbXSB8IG51bGwge1xuXHRcdGNvbnN0IGNoID0gdGhpcy5jaHVua3NCeUtleS5nZXQoa2V5KTtcblx0XHRyZXR1cm4gY2g/LnZlY3RvciA/PyBudWxsO1xuXHR9XG5cblx0YnVpbGRRdWVyeVZlY3RvcihxdWVyeVRleHQ6IHN0cmluZyk6IG51bWJlcltdIHtcblx0XHRjb25zb2xlLndhcm4oJ1tFbWJlZGRpbmdzSW5kZXhdIGJ1aWxkUXVlcnlWZWN0b3IgY2FsbGVkOyByZXR1cm5pbmcgZW1wdHkgdmVjdG9yLiBVc2UgZW1iZWRRdWVyeVZlY3RvciBpbnN0ZWFkLicpO1xuXHRcdHJldHVybiBbXTtcblx0fVxuXG5cdGFzeW5jIGVtYmVkUXVlcnlWZWN0b3IocXVlcnlUZXh0OiBzdHJpbmcpOiBQcm9taXNlPG51bWJlcltdPiB7XG5cdFx0Y29uc3QgdmVjID0gYXdhaXQgdGhpcy5lbWJlZGRpbmdQcm92aWRlci5nZXRFbWJlZGRpbmcocXVlcnlUZXh0KTtcblx0XHRpZiAoIUFycmF5LmlzQXJyYXkodmVjKSB8fCB2ZWMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHR0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IGVtYmVkZGluZyByZXR1cm5lZCBmcm9tIE9sbGFtYScpO1xuXHRcdH1cblx0XHRyZXR1cm4gdmVjO1xuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVQZXJzaXN0KCk6IHZvaWQge1xuXHRcdGlmICh0aGlzLnBlcnNpc3RUaW1lcikgd2luZG93LmNsZWFyVGltZW91dCh0aGlzLnBlcnNpc3RUaW1lcik7XG5cdFx0dGhpcy5wZXJzaXN0VGltZXIgPSB3aW5kb3cuc2V0VGltZW91dCgoKSA9PiB7XG5cdFx0XHR0aGlzLnBlcnNpc3RUaW1lciA9IG51bGw7XG5cdFx0XHR2b2lkIHRoaXMuX3BlcnNpc3ROb3coKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblxuXHRwcml2YXRlIGFzeW5jIF9wZXJzaXN0Tm93KCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdGlmICh0aGlzLmlzUmVhZE9ubHkpIHtcblx0XHRcdGNvbnNvbGUubG9nKCdbRW1iZWRkaW5nc0luZGV4XSBTa2lwcGluZyBwZXJzaXN0ZW5jZTogUmVhZC1Pbmx5IG1vZGUnKTtcblx0XHRcdHJldHVybjtcblx0XHR9XG5cblx0XHRjb25zdCBkaXIgPSBhd2FpdCB0aGlzLnJlc29sdmVJbmRleERpcigpO1xuXHRcdHRyeSB7XG5cdFx0XHRpZiAoIShhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGRpcikpKSB7XG5cdFx0XHRcdC8vIFJlY3Vyc2l2ZSBta2RpclxuXHRcdFx0XHRjb25zdCBwYXJ0cyA9IGRpci5zcGxpdCgnLycpO1xuXHRcdFx0XHRsZXQgY3VycmVudCA9ICcnO1xuXHRcdFx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcblx0XHRcdFx0XHRpZiAoIXBhcnQpIGNvbnRpbnVlO1xuXHRcdFx0XHRcdGN1cnJlbnQgKz0gKGN1cnJlbnQgPyAnLycgOiAnJykgKyBwYXJ0O1xuXHRcdFx0XHRcdGlmICghKGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCkpKSB7XG5cdFx0XHRcdFx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoY3VycmVudCk7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0fSBjYXRjaCB7XG5cdFx0XHQvLyBpZ25vcmUgbWtkaXIgZmFpbHVyZXNcblx0XHR9XG5cblx0XHRjb25zdCBwYXlsb2FkOiBQZXJzaXN0ZWRJbmRleFYxID0ge1xuXHRcdFx0dmVyc2lvbjogMSxcblx0XHRcdGRpbTogdGhpcy5kaW0sXG5cdFx0XHRiYWNrZW5kOiB0aGlzLmJhY2tlbmQsXG5cdFx0XHRjaHVua2luZzogY2h1bmtpbmdLZXkodGhpcy5wbHVnaW4pLFxuXHRcdFx0Y2h1bmtzOiB0aGlzLmdldEFsbENodW5rcygpXG5cdFx0fTtcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGUoYXdhaXQgdGhpcy5nZXRJbmRleEZpbGVQYXRoKCksIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpKTtcblxuXHRcdC8vIEVuc3VyZSBtYW5pZmVzdCBleGlzdHMgaW4gdGhlIGluZGV4IGRpcmVjdG9yeVxuXHRcdGNvbnN0IG1hbmlmZXN0UGF0aCA9IGAke2Rpcn0vaW5kZXgubWFuaWZlc3QuanNvbmA7XG5cdFx0aWYgKCEoYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhtYW5pZmVzdFBhdGgpKSkge1xuXHRcdFx0Y29uc3QgbWFuaWZlc3QgPSB7XG5cdFx0XHRcdHNjaGVtYVZlcnNpb246IDIsXG5cdFx0XHRcdGVtYmVkZGluZ1Byb2ZpbGU6IHRoaXMuZ2V0RW1iZWRkaW5nUHJvZmlsZSgpLFxuXHRcdFx0XHRlbmdpbmU6ICdqc29uJ1xuXHRcdFx0fTtcblx0XHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZShtYW5pZmVzdFBhdGgsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG5cdFx0fVxuXHR9XG5cblx0cHJpdmF0ZSBfc2NoZWR1bGVTZXR0aW5nc1NhdmUoKTogdm9pZCB7XG5cdFx0aWYgKHRoaXMuc2V0dGluZ3NTYXZlVGltZXIpIHdpbmRvdy5jbGVhclRpbWVvdXQodGhpcy5zZXR0aW5nc1NhdmVUaW1lcik7XG5cdFx0dGhpcy5zZXR0aW5nc1NhdmVUaW1lciA9IHdpbmRvdy5zZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdHRoaXMuc2V0dGluZ3NTYXZlVGltZXIgPSBudWxsO1xuXHRcdFx0dm9pZCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKS5jYXRjaCgoKSA9PiB7XG5cdFx0XHRcdC8vIGlnbm9yZVxuXHRcdFx0fSk7XG5cdFx0fSwgMTAwMCk7XG5cdH1cblx0XG59XG5cblxuIl19