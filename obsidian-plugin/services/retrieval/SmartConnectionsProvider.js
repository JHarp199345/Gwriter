import { TFile } from 'obsidian';
/**
 * Retrieval provider that uses Smart Connections plugin via capture and cache system.
 * Captures results from DOM or clipboard, caches them, and uses cached data for retrieval.
 */
export class SmartConnectionsProvider {
    constructor(app, plugin, vault, isAllowedPath) {
        this.id = 'smart-connections';
        this.currentSessionId = '';
        this.app = app;
        this.plugin = plugin;
        this.vault = vault;
        this.isAllowedPath = isAllowedPath;
        this.initializeSession();
        this.logInitialization();
    }
    /**
     * Generate a new session ID for logging grouping.
     */
    generateSessionId() {
        return Math.random().toString(36).substring(2, 8);
    }
    /**
     * Initialize session ID for this instance.
     */
    initializeSession() {
        this.currentSessionId = this.generateSessionId();
    }
    /**
     * Structured logging helper with session ID support.
     */
    log(level, message, context, details) {
        const timestamp = new Date().toISOString();
        const methodName = new Error().stack?.split('\n')[2]?.match(/at \w+\.(\w+)/)?.[1] || 'unknown';
        const sessionId = this.currentSessionId;
        const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
        const detailsStr = details ? ` | Details: ${JSON.stringify(details)}` : '';
        const logMessage = `[SmartConnectionsProvider:${methodName}][sid=${sessionId}] ${level.toUpperCase()}: ${message}${contextStr}${detailsStr}`;
        if (level === 'error') {
            console.error(logMessage);
        }
        else if (level === 'warn') {
            console.warn(logMessage);
        }
        else {
            console.debug(logMessage);
        }
    }
    /**
     * Log initialization status.
     */
    logInitialization() {
        const cache = this.plugin.settings.smartConnectionsCache;
        const enabled = this.plugin.settings.smartConnectionsCacheEnabled ?? false;
        if (cache) {
            const age = Date.now() - cache.capturedAt;
            const ageHours = Math.floor(age / (1000 * 60 * 60));
            const ageMinutes = Math.floor((age % (1000 * 60 * 60)) / (1000 * 60));
            const ageStr = ageHours > 0 ? `${ageHours}h ${ageMinutes}m` : `${ageMinutes}m`;
            const isFresh = this.isCacheFresh(cache);
            this.log('info', 'Initialization complete', {
                cacheEnabled: enabled,
                cacheExists: true,
                cacheAge: ageStr,
                cacheResults: cache.results.length,
                cacheMethod: cache.method,
                cacheFresh: isFresh,
                sourceNote: cache.sourceNotePath,
                vaultId: cache.vaultId
            });
        }
        else {
            this.log('info', 'Initialization complete', {
                cacheEnabled: enabled,
                cacheExists: false
            });
        }
    }
    /**
     * Get vault ID (name + optional basePath).
     */
    getVaultId() {
        const vaultName = this.app.vault.getName();
        const adapter = this.app.vault.adapter;
        const basePath = adapter.basePath || '';
        const vaultId = vaultName + (basePath ? `:${basePath}` : '');
        this.log('info', 'Vault ID generated', {
            vaultName,
            basePath: basePath || '(not available)',
            vaultId
        });
        return vaultId;
    }
    /**
     * Check if cache is fresh (within TTL if set).
     */
    isCacheFresh(cache) {
        const ttl = this.plugin.settings.smartConnectionsCacheTTL;
        if (!ttl) {
            return true; // No TTL, always fresh
        }
        const age = Date.now() - cache.capturedAt;
        const ttlMs = ttl * 60 * 60 * 1000;
        const fresh = age < ttlMs;
        this.log('info', 'Cache freshness check', {
            age: `${Math.floor(age / (1000 * 60 * 60))}h`,
            ttl: `${ttl}h`,
            fresh
        });
        return fresh;
    }
    /**
     * Normalize folder path for comparison (remove leading slash, ensure trailing slash).
     */
    normalizeFolderPath(path) {
        let normalized = path.replace(/^\/+/, ''); // Remove leading slashes
        if (normalized && !normalized.endsWith('/')) {
            normalized += '/'; // Ensure trailing slash
        }
        return normalized;
    }
    /**
     * Check if path is allowed based on folder filters.
     */
    isPathAllowed(path) {
        const allowed = this.plugin.settings.smartConnectionsAllowedFolders || [];
        const blocked = this.plugin.settings.smartConnectionsBlockedFolders || [];
        // Normalize path for comparison
        const normalizedPath = this.normalizeFolderPath(path);
        // Check blocklist first
        for (const blockedFolder of blocked) {
            const normalizedBlocked = this.normalizeFolderPath(blockedFolder);
            if (normalizedPath === normalizedBlocked || normalizedPath.startsWith(normalizedBlocked)) {
                this.log('info', 'Path blocked by filter', {
                    path,
                    blockedFolder,
                    normalizedPath,
                    normalizedBlocked
                });
                return false;
            }
        }
        // Check allowlist (if set, path must be in allowed folders)
        if (allowed.length > 0) {
            const isAllowed = allowed.some(allowedFolder => {
                const normalizedAllowed = this.normalizeFolderPath(allowedFolder);
                return normalizedPath === normalizedAllowed || normalizedPath.startsWith(normalizedAllowed);
            });
            if (!isAllowed) {
                this.log('info', 'Path not in allowed folders', {
                    path,
                    allowedFolders: allowed,
                    normalizedPath
                });
                return false;
            }
        }
        return true;
    }
    /**
     * Check cache keying match (soft/strict mode).
     */
    checkCacheKeying(cache, currentNotePath) {
        if (!cache.sourceNotePath) {
            return { match: true }; // No keying, always match
        }
        if (!currentNotePath) {
            return { match: true }; // No current note, allow use
        }
        const match = cache.sourceNotePath === currentNotePath;
        if (!match) {
            const mode = this.plugin.settings.smartConnectionsKeyingMode || 'soft';
            this.log('warn', 'Cache keying mismatch', {
                currentNote: currentNotePath,
                cacheNote: cache.sourceNotePath,
                mode
            });
        }
        return { match, currentNote: currentNotePath, cacheNote: cache.sourceNotePath };
    }
    /**
     * Validate and clean cache (remove missing files, in-memory only).
     */
    validateAndCleanCache(cache) {
        const originalCount = cache.results.length;
        const validResults = cache.results.filter(result => {
            const file = this.vault.getAbstractFileByPath(result.path);
            return file instanceof TFile;
        });
        const wasModified = validResults.length !== originalCount;
        if (wasModified) {
            const dropped = originalCount - validResults.length;
            this.log('warn', 'Cache invalidation', {
                dropped,
                originalCount,
                valid: validResults.length
            });
            cache.results = validResults; // In-memory only
        }
        return { cache, wasModified };
    }
    /**
     * Save cache to settings (with sanity guard).
     */
    async saveCache(cache) {
        // Sanity guard: don't overwrite cache if capture returned 0 results
        if (cache.results.length === 0) {
            this.log('warn', 'Capture returned 0 results, preserving existing cache', {
                sessionId: cache.sessionId,
                method: cache.method
            });
            return; // Don't overwrite existing cache
        }
        this.plugin.settings.smartConnectionsCache = cache;
        await this.plugin.saveSettings();
        this.log('info', 'Cache saved', {
            results: cache.results.length,
            method: cache.method,
            sourceNote: cache.sourceNotePath,
            vaultId: cache.vaultId
        });
    }
    /**
     * Get cache from settings.
     */
    getCache() {
        return this.plugin.settings.smartConnectionsCache || null;
    }
    /**
     * Find Smart Connections view using heuristic detection.
     */
    findSmartConnectionsView() {
        const leaves = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
            leaves.push(leaf);
        });
        this.log('info', 'Scanning workspace leaves', {
            totalLeaves: leaves.length
        });
        for (let i = 0; i < leaves.length; i++) {
            const leaf = leaves[i];
            const viewType = leaf.view.getViewType?.() || 'unknown';
            const containerEl = leaf.view.containerEl;
            this.log('info', 'Checking leaf', {
                index: i,
                viewType,
                containerClasses: Array.from(containerEl.classList || []).join(', ')
            });
            // Check for SC markers with confidence breadcrumbs
            let confidence = 'none';
            let marker = '';
            // Marker 1: class contains 'smart-connections'
            if (containerEl.classList.contains('smart-connections') ||
                Array.from(containerEl.classList).some(c => c.includes('smart-connections'))) {
                confidence = 'high';
                marker = 'class contains smart-connections';
            }
            // Marker 2: contains text 'Connections'
            else if (containerEl.textContent?.includes('Connections')) {
                confidence = 'medium';
                marker = 'contains text Connections';
            }
            // Marker 3: results list has internal links
            else if (containerEl.querySelectorAll('a.internal-link[data-href]').length > 0) {
                confidence = 'high';
                marker = 'results list has internal links';
            }
            if (confidence !== 'none') {
                this.log('info', 'SC view detected', {
                    leafIndex: i,
                    viewType,
                    marker,
                    confidence
                });
                return leaf;
            }
        }
        this.log('info', 'SC view not found', {
            leavesChecked: leaves.length
        });
        return null;
    }
    /**
     * Capture results from Smart Connections DOM.
     */
    async captureFromDom(sourceNotePath) {
        const sessionId = this.generateSessionId();
        this.currentSessionId = sessionId;
        await Promise.resolve(); // Ensure async
        this.log('info', 'Starting DOM capture', {
            sourceNotePath: sourceNotePath || '(not provided)',
            sessionId
        });
        const scView = this.findSmartConnectionsView();
        if (!scView) {
            this.log('warn', 'SC view not found for DOM capture', {
                sessionId
            });
            return [];
        }
        // Portable results detection using internal-link selector
        const internalLinks = scView.view.containerEl.querySelectorAll('a.internal-link[data-href]');
        const resultsCount = internalLinks.length;
        this.log('info', 'Results detection', {
            viewFound: true,
            selector: 'a.internal-link[data-href]',
            count: resultsCount,
            sessionId
        });
        if (resultsCount === 0) {
            this.log('info', 'View found, results missing', {
                viewFound: true,
                resultsFound: false,
                selector: 'a.internal-link[data-href]',
                sessionId
            });
            return []; // Don't cache empty
        }
        // Extract links and validate
        const results = [];
        const maxCapture = this.plugin.settings.smartConnectionsMaxCaptureFiles ?? 200;
        for (let i = 0; i < Math.min(resultsCount, maxCapture); i++) {
            const link = internalLinks[i];
            const dataHref = link.getAttribute('data-href');
            const href = link.getAttribute('href');
            const path = dataHref || href || '';
            if (!path) {
                this.log('warn', 'Link missing path', {
                    index: i,
                    dataHref,
                    href,
                    sessionId
                });
                continue;
            }
            // Normalize path (remove .md extension if present, handle internal link format)
            let normalizedPath = path.replace(/\.md$/, '');
            if (normalizedPath.startsWith('#')) {
                // Skip anchors
                continue;
            }
            // Check if file exists and is allowed
            const file = this.vault.getAbstractFileByPath(normalizedPath);
            if (!(file instanceof TFile)) {
                this.log('warn', 'Link resolves to non-file', {
                    path: normalizedPath,
                    index: i,
                    sessionId
                });
                continue;
            }
            // Apply folder filters
            if (!this.isPathAllowed(normalizedPath)) {
                this.log('info', 'Link filtered out', {
                    path: normalizedPath,
                    index: i,
                    sessionId
                });
                continue;
            }
            // Assign rank-based score (1.0, 0.98, 0.96...)
            const rankScore = Math.max(0.5, 1.0 - (i * 0.02));
            results.push({
                path: normalizedPath,
                score: rankScore
            });
            this.log('info', 'Link captured', {
                index: i,
                path: normalizedPath,
                score: rankScore,
                sessionId
            });
        }
        this.log('info', 'DOM capture complete', {
            results: results.length,
            time: 'N/A', // Could add timing if needed
            sessionId
        });
        return results;
    }
    /**
     * Capture results from clipboard.
     */
    async captureFromClipboard(sourceNotePath) {
        const sessionId = this.generateSessionId();
        this.currentSessionId = sessionId;
        this.log('info', 'Starting clipboard capture', {
            sourceNotePath: sourceNotePath || '(not provided)',
            sessionId
        });
        try {
            // Check clipboard permissions
            const clipboardText = await navigator.clipboard.readText();
            this.log('info', 'Clipboard read', {
                length: clipboardText.length,
                preview: clipboardText.substring(0, 200),
                sessionId
            });
            // Parse markdown links: [[note-name]] or [text](note-name.md)
            const markdownLinkPattern = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+\.md)\)/g;
            const links = [];
            let match;
            while ((match = markdownLinkPattern.exec(clipboardText)) !== null) {
                const link = match[1] || match[3] || '';
                if (link) {
                    links.push(link.replace(/\.md$/, ''));
                }
            }
            this.log('info', 'Links parsed from clipboard', {
                found: links.length,
                links: links.slice(0, 10), // Log first 10
                sessionId
            });
            // Validate and filter links
            const results = [];
            const maxCapture = this.plugin.settings.smartConnectionsMaxCaptureFiles ?? 200;
            for (let i = 0; i < Math.min(links.length, maxCapture); i++) {
                const link = links[i];
                // Check if file exists
                const file = this.vault.getAbstractFileByPath(link);
                if (!(file instanceof TFile)) {
                    this.log('warn', 'Clipboard link resolves to non-file', {
                        link,
                        index: i,
                        sessionId
                    });
                    continue;
                }
                // Apply folder filters
                if (!this.isPathAllowed(link)) {
                    this.log('info', 'Clipboard link filtered out', {
                        link,
                        index: i,
                        sessionId
                    });
                    continue;
                }
                // Assign rank-based score
                const rankScore = Math.max(0.5, 1.0 - (i * 0.02));
                results.push({
                    path: link,
                    score: rankScore
                });
                this.log('info', 'Clipboard link captured', {
                    index: i,
                    link,
                    score: rankScore,
                    sessionId
                });
            }
            this.log('info', 'Clipboard capture complete', {
                results: results.length,
                sessionId
            });
            return results;
        }
        catch (error) {
            this.log('error', 'Clipboard capture failed', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                sessionId
            });
            return [];
        }
    }
    /**
     * Tokenize text (simple word splitting, lowercase).
     */
    tokenize(text) {
        return text
            .toLowerCase()
            .split(/[^a-z0-9]+/g)
            .map(t => t.trim())
            .filter(t => t.length >= 2);
    }
    /**
     * Score cached items using metadata cache (fast path).
     */
    async scoreCachedItemsWithMetadata(cache, query, limit) {
        await Promise.resolve(); // Ensure async
        const queryTokens = this.tokenize(query);
        const maxScoreFiles = this.plugin.settings.smartConnectionsMaxScoreFiles ?? 50;
        const itemsToScore = cache.results.slice(0, Math.min(cache.results.length, maxScoreFiles));
        this.log('info', 'Starting metadata scoring', {
            queryTokens: queryTokens.slice(0, 10), // Log first 10 tokens
            itemsToScore: itemsToScore.length,
            maxScoreFiles,
            sessionId: this.currentSessionId
        });
        const scored = [];
        for (let i = 0; i < itemsToScore.length; i++) {
            const item = itemsToScore[i];
            const file = this.vault.getAbstractFileByPath(item.path);
            if (!(file instanceof TFile)) {
                continue;
            }
            // Get metadata cache
            const metadata = this.app.metadataCache.getFileCache(file);
            if (!metadata) {
                // No metadata, use rank score only
                scored.push({
                    path: item.path,
                    rankScore: item.score ?? 0.5,
                    metadataScore: 0,
                    finalScore: item.score ?? 0.5,
                    capturedAt: item.capturedAt
                });
                continue;
            }
            // Extract text from metadata
            const metadataText = [];
            // Frontmatter tags
            if (metadata.frontmatter?.tags) {
                const tags = Array.isArray(metadata.frontmatter.tags)
                    ? metadata.frontmatter.tags
                    : [metadata.frontmatter.tags];
                metadataText.push(...tags.map((t) => t.toString().toLowerCase()));
            }
            // Headings
            if (metadata.headings) {
                metadataText.push(...metadata.headings.map(h => h.heading.toLowerCase()));
            }
            // Tags
            if (metadata.tags) {
                metadataText.push(...metadata.tags.map(t => t.tag.toLowerCase()));
            }
            // Score by token overlap
            const metadataTokens = this.tokenize(metadataText.join(' '));
            const overlap = queryTokens.filter(t => metadataTokens.includes(t)).length;
            const metadataScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
            // Combine with rank score
            const rankScore = item.score ?? Math.max(0.5, 1.0 - (i * 0.02));
            const finalScore = (metadataScore * 0.7) + (rankScore * 0.3);
            scored.push({
                path: item.path,
                rankScore,
                metadataScore,
                finalScore,
                capturedAt: item.capturedAt
            });
            this.log('info', 'Item scored with metadata', {
                index: i,
                path: item.path,
                metadataScore: metadataScore.toFixed(3),
                rankScore: rankScore.toFixed(3),
                finalScore: finalScore.toFixed(3),
                sessionId: this.currentSessionId
            });
        }
        // Sort by final score and return top N
        const sorted = scored.sort((a, b) => b.finalScore - a.finalScore);
        const topN = Math.min(10, limit * 2); // Policy: topNFullRead = min(10, limit * 2)
        this.log('info', 'Metadata scoring complete', {
            scored: sorted.length,
            topN,
            sessionId: this.currentSessionId
        });
        return sorted.slice(0, topN);
    }
    /**
     * Load full content and re-score top items.
     */
    async loadAndScoreTopItems(topItems, query) {
        const queryTokens = this.tokenize(query);
        this.log('info', 'Loading full content for top items', {
            count: topItems.length,
            sessionId: this.currentSessionId
        });
        for (let i = 0; i < topItems.length; i++) {
            const item = topItems[i];
            const file = this.vault.getAbstractFileByPath(item.path);
            if (!(file instanceof TFile)) {
                continue;
            }
            try {
                const content = await this.vault.read(file);
                const contentTokens = this.tokenize(content);
                // Score by token overlap
                const overlap = queryTokens.filter(t => contentTokens.includes(t)).length;
                const fullContentScore = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
                // Combine scores: (queryScore * 0.7) + (rankScore * 0.3)
                item.fullContentScore = fullContentScore;
                item.finalScore = (fullContentScore * 0.7) + (item.rankScore * 0.3);
                this.log('info', 'Item re-scored with full content', {
                    index: i,
                    path: item.path,
                    fullContentScore: fullContentScore.toFixed(3),
                    finalScore: item.finalScore.toFixed(3),
                    contentLength: content.length,
                    sessionId: this.currentSessionId
                });
            }
            catch (error) {
                this.log('warn', 'Failed to read file for scoring', {
                    path: item.path,
                    error: error instanceof Error ? error.message : String(error),
                    sessionId: this.currentSessionId
                });
            }
        }
        // Re-sort by final score
        return topItems.sort((a, b) => b.finalScore - a.finalScore);
    }
    /**
     * Generate best-matching paragraph excerpt.
     */
    async generateBestMatchingExcerpt(path, query) {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            return '[File not found]';
        }
        try {
            const content = await this.vault.read(file);
            const queryTokens = this.tokenize(query);
            // Policy: Split by double newline
            const paragraphs = content.split('\n\n');
            this.log('info', 'Generating excerpt', {
                path,
                paragraphs: paragraphs.length,
                queryTokens: queryTokens.slice(0, 5),
                sessionId: this.currentSessionId
            });
            if (paragraphs.length === 0) {
                // Fallback to first 500 chars
                return content.trim().slice(0, 500) + (content.length > 500 ? '…' : '');
            }
            // Score each paragraph
            let bestParagraph = paragraphs[0];
            let bestScore = 0;
            for (const paragraph of paragraphs) {
                const paraTokens = this.tokenize(paragraph);
                const overlap = queryTokens.filter(t => paraTokens.includes(t)).length;
                const score = queryTokens.length > 0 ? overlap / queryTokens.length : 0;
                if (score > bestScore) {
                    bestScore = score;
                    bestParagraph = paragraph;
                }
            }
            // Trim to 800-1200 chars (prefer 1000, but allow range)
            let excerpt = bestParagraph.trim();
            const targetLength = 1000;
            const minLength = 800;
            const maxLength = 1200;
            if (excerpt.length > maxLength) {
                // Try to trim at sentence boundary
                const trimmed = excerpt.slice(0, maxLength);
                const lastPeriod = trimmed.lastIndexOf('.');
                if (lastPeriod > minLength) {
                    excerpt = trimmed.slice(0, lastPeriod + 1);
                }
                else {
                    excerpt = trimmed + '…';
                }
            }
            else if (excerpt.length < minLength && paragraphs.length > 1) {
                // Try to include next paragraph if too short
                const paraIndex = paragraphs.indexOf(bestParagraph);
                if (paraIndex < paragraphs.length - 1) {
                    const combined = bestParagraph + '\n\n' + paragraphs[paraIndex + 1];
                    excerpt = combined.trim().slice(0, maxLength);
                    if (combined.length > maxLength) {
                        excerpt += '…';
                    }
                }
            }
            this.log('info', 'Excerpt generated', {
                path,
                excerptLength: excerpt.length,
                bestScore: bestScore.toFixed(3),
                method: bestScore > 0 ? 'best-matching' : 'first-paragraph',
                sessionId: this.currentSessionId
            });
            return excerpt;
        }
        catch (error) {
            this.log('warn', 'Failed to generate excerpt', {
                path,
                error: error instanceof Error ? error.message : String(error),
                sessionId: this.currentSessionId
            });
            return '[Error reading file]';
        }
    }
    async search(query, opts) {
        const sessionId = this.generateSessionId();
        this.currentSessionId = sessionId;
        const q = (query.text ?? '').trim();
        if (!q) {
            return [];
        }
        this.log('info', 'Starting search', {
            query: q,
            limit: opts.limit,
            sessionId
        });
        // Check if cache is enabled
        const enabled = this.plugin.settings.smartConnectionsCacheEnabled ?? false;
        if (!enabled) {
            this.log('info', 'Cache disabled, returning empty', {
                sessionId
            });
            return [];
        }
        // Get cache
        const cache = this.getCache();
        if (!cache) {
            this.log('info', 'No cache available, returning empty', {
                sessionId
            });
            return [];
        }
        // Check cache freshness
        if (!this.isCacheFresh(cache)) {
            this.log('warn', 'Cache expired, returning empty', {
                sessionId
            });
            return [];
        }
        // Check keying match
        const currentNotePath = query.activeFilePath;
        const keyingCheck = this.checkCacheKeying(cache, currentNotePath);
        const keyingMode = this.plugin.settings.smartConnectionsKeyingMode || 'soft';
        if (!keyingCheck.match && keyingMode === 'strict') {
            this.log('warn', 'Cache keying mismatch in strict mode, returning empty', {
                currentNote: currentNotePath,
                cacheNote: keyingCheck.cacheNote,
                sessionId
            });
            return [];
        }
        if (!keyingCheck.match) {
            this.log('warn', 'Cache keying mismatch in soft mode, allowing use', {
                currentNote: currentNotePath,
                cacheNote: keyingCheck.cacheNote,
                sessionId
            });
        }
        // Validate and clean cache (in-memory only)
        const { cache: cleanedCache, wasModified } = this.validateAndCleanCache(cache);
        // Score with metadata first (fast)
        const topItems = await this.scoreCachedItemsWithMetadata(cleanedCache, q, opts.limit);
        // Load full content for top N and re-score
        const rescoredItems = await this.loadAndScoreTopItems(topItems, q);
        // Generate excerpts with context cap
        const results = [];
        const maxContextChars = this.plugin.settings.smartConnectionsMaxContextChars ?? 30000;
        let totalContextChars = 0;
        let truncatedCount = 0;
        for (const item of rescoredItems) {
            if (results.length >= opts.limit) {
                break;
            }
            // Check context cap
            const excerpt = await this.generateBestMatchingExcerpt(item.path, q);
            let finalExcerpt = excerpt;
            if (totalContextChars + excerpt.length > maxContextChars) {
                // Policy: truncate current excerpt to fit
                const remaining = maxContextChars - totalContextChars;
                finalExcerpt = excerpt.slice(0, remaining) + '…';
                truncatedCount++;
                this.log('info', 'Context cap reached, truncating excerpt', {
                    totalChars: totalContextChars + finalExcerpt.length,
                    remaining,
                    truncated: true,
                    sessionId
                });
            }
            totalContextChars += finalExcerpt.length;
            results.push({
                key: item.path,
                path: item.path,
                title: item.path.split('/').pop() || item.path,
                excerpt: finalExcerpt,
                score: item.finalScore,
                source: this.id,
                reasonTags: ['smart-connections-cached']
            });
        }
        if (truncatedCount > 0) {
            this.log('info', 'Context cap summary', {
                totalChars: totalContextChars,
                maxChars: maxContextChars,
                truncated: truncatedCount,
                sessionId
            });
        }
        // Save cache if modified (single writeback)
        if (wasModified) {
            await this.saveCache(cleanedCache);
        }
        this.log('info', 'Search complete', {
            results: results.length,
            method: 'cached',
            sessionId
        });
        return results;
    }
    /**
     * Public method to capture from DOM and save to cache.
     */
    async captureAndSaveFromDom(sourceNotePath) {
        const results = await this.captureFromDom(sourceNotePath);
        if (results.length === 0) {
            return {
                success: false,
                count: 0,
                message: 'Smart Connections view is open but no results found. Try running a search in Smart Connections first.'
            };
        }
        const vaultId = this.getVaultId();
        const sessionId = this.generateSessionId();
        const cache = {
            sourceNotePath,
            vaultId,
            results: results.map((r, i) => ({
                path: r.path,
                score: r.score,
                capturedAt: Date.now()
            })),
            capturedAt: Date.now(),
            method: 'dom',
            sessionId
        };
        await this.saveCache(cache);
        return {
            success: true,
            count: results.length
        };
    }
    /**
     * Public method to capture from clipboard and save to cache.
     */
    async captureAndSaveFromClipboard(sourceNotePath) {
        const results = await this.captureFromClipboard(sourceNotePath);
        if (results.length === 0) {
            return {
                success: false,
                count: 0,
                message: 'No valid links found in clipboard. Ensure clipboard contains Smart Connections results with markdown links.'
            };
        }
        const vaultId = this.getVaultId();
        const sessionId = this.generateSessionId();
        const cache = {
            sourceNotePath,
            vaultId,
            results: results.map((r, i) => ({
                path: r.path,
                score: r.score,
                capturedAt: Date.now()
            })),
            capturedAt: Date.now(),
            method: 'clipboard',
            sessionId
        };
        await this.saveCache(cache);
        return {
            success: true,
            count: results.length
        };
    }
    /**
     * Public method to clear cache.
     */
    async clearCache() {
        this.plugin.settings.smartConnectionsCache = undefined;
        await this.plugin.saveSettings();
        this.log('info', 'Cache cleared', {
            sessionId: this.currentSessionId
        });
    }
    /**
     * Public method to get cache status.
     */
    getCacheStatus() {
        const enabled = this.plugin.settings.smartConnectionsCacheEnabled ?? false;
        const cache = this.getCache();
        if (!cache) {
            return {
                exists: false,
                enabled,
                count: 0,
                fresh: false
            };
        }
        const age = Date.now() - cache.capturedAt;
        const ageHours = Math.floor(age / (1000 * 60 * 60));
        const ageMinutes = Math.floor((age % (1000 * 60 * 60)) / (1000 * 60));
        const ageStr = ageHours > 0 ? `${ageHours}h ${ageMinutes}m` : `${ageMinutes}m`;
        return {
            exists: true,
            enabled,
            count: cache.results.length,
            age: ageStr,
            method: cache.method,
            sourceNote: cache.sourceNotePath,
            fresh: this.isCacheFresh(cache)
        };
    }
    /**
     * Public method to check if Smart Connections view is available for capture.
     */
    checkViewAvailable() {
        const scView = this.findSmartConnectionsView();
        if (!scView) {
            return {
                available: false,
                message: 'Smart Connections view not found. Open Smart Connections in a pane first.'
            };
        }
        const internalLinks = scView.view.containerEl.querySelectorAll('a.internal-link[data-href]');
        if (internalLinks.length === 0) {
            return {
                available: false,
                message: 'Smart Connections view is open but no results found. Try running a search in Smart Connections first.'
            };
        }
        return {
            available: true
        };
    }
    /**
     * Get cached file paths directly (no search, no API calls).
     * Used for pure boost/filter operations in hybrid retrieval.
     */
    async getCachePaths() {
        const cache = this.getCache();
        if (!cache)
            return [];
        const enabled = this.plugin.settings.smartConnectionsCacheEnabled ?? false;
        if (!enabled)
            return [];
        // Check freshness
        if (!this.isCacheFresh(cache))
            return [];
        // Return just the paths - no scoring, no API calls
        return cache.results.map(r => r.path);
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUVBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFnQ2pDOzs7R0FHRztBQUNILE1BQU0sT0FBTyx3QkFBd0I7SUFTcEMsWUFDQyxHQUFRLEVBQ1IsTUFBOEIsRUFDOUIsS0FBWSxFQUNaLGFBQXdDO1FBWmhDLE9BQUUsR0FBRyxtQkFBbUIsQ0FBQztRQU0xQixxQkFBZ0IsR0FBVyxFQUFFLENBQUM7UUFRckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7UUFDZixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsYUFBYSxHQUFHLGFBQWEsQ0FBQztRQUNuQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUMxQixDQUFDO0lBRUQ7O09BRUc7SUFDSyxpQkFBaUI7UUFDeEIsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDbkQsQ0FBQztJQUVEOztPQUVHO0lBQ0ssaUJBQWlCO1FBQ3hCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUNsRCxDQUFDO0lBRUQ7O09BRUc7SUFDSyxHQUFHLENBQUMsS0FBZ0MsRUFBRSxPQUFlLEVBQUUsT0FBaUMsRUFBRSxPQUFpQztRQUNsSSxNQUFNLFNBQVMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzNDLE1BQU0sVUFBVSxHQUFHLElBQUksS0FB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QUs7Z0JBQ2hCLE9BQU8sRUFBRSx1R0FBdUc7YUFDaEgsQ0FBQztRQUNILENBQUM7UUFFRCxPQUFPO1lBQ04sU0FBUyxFQUFFLElBQUk7U0FDZixDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7T0FHRztJQUNILEtBQUssQ0FBQyxhQUFhO1FBQ2xCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUM5QixJQUFJLENBQUMsS0FBSztZQUFFLE9BQU8sRUFBRSxDQUFDO1FBRXRCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLDRCQUE0QixJQUFJLEtBQUssQ0FBQztRQUMzRSxJQUFJLENBQUMsT0FBTztZQUFFLE9BQU8sRUFBRSxDQUFDO1FBRXhCLGtCQUFrQjtRQUNsQixJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUM7WUFBRSxPQUFPLEVBQUUsQ0FBQztRQUV6QyxtREFBbUQ7UUFDbkQsT0FBTyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QyxDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IENvbnRleHRJdGVtLCBSZXRyaWV2YWxPcHRpb25zLCBSZXRyaWV2YWxQcm92aWRlciwgUmV0cmlldmFsUXVlcnkgfSBmcm9tICcuL3R5cGVzJztcclxuaW1wb3J0IHR5cGUgeyBBcHAsIFZhdWx0LCBXb3Jrc3BhY2VMZWFmIH0gZnJvbSAnb2JzaWRpYW4nO1xyXG5pbXBvcnQgeyBURmlsZSB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XHJcblxyXG4vKipcclxuICogU21hcnQgQ29ubmVjdGlvbnMgY2FjaGUgc3RydWN0dXJlLlxyXG4gKi9cclxuaW50ZXJmYWNlIFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSB7XHJcblx0c291cmNlTm90ZVBhdGg/OiBzdHJpbmc7XHJcblx0dmF1bHRJZD86IHN0cmluZztcclxuXHRyZXN1bHRzOiBBcnJheTx7XHJcblx0XHRwYXRoOiBzdHJpbmc7XHJcblx0XHRzY29yZT86IG51bWJlcjtcclxuXHRcdGNhcHR1cmVkU25pcHBldD86IHN0cmluZztcclxuXHRcdGNhcHR1cmVkQXQ/OiBudW1iZXI7XHJcblx0fT47XHJcblx0Y2FwdHVyZWRBdDogbnVtYmVyO1xyXG5cdG1ldGhvZDogJ2RvbScgfCAnY2xpcGJvYXJkJztcclxuXHRzZXNzaW9uSWQ6IHN0cmluZztcclxufVxyXG5cclxuLyoqXHJcbiAqIENhY2hlZCByZXN1bHQgaXRlbSB3aXRoIHNjb3JpbmcgaW5mb3JtYXRpb24uXHJcbiAqL1xyXG5pbnRlcmZhY2UgU2NvcmVkQ2FjaGVJdGVtIHtcclxuXHRwYXRoOiBzdHJpbmc7XHJcblx0cmFua1Njb3JlOiBudW1iZXI7XHJcblx0bWV0YWRhdGFTY29yZTogbnVtYmVyO1xyXG5cdGZ1bGxDb250ZW50U2NvcmU/OiBudW1iZXI7XHJcblx0ZmluYWxTY29yZTogbnVtYmVyO1xyXG5cdGNhcHR1cmVkQXQ/OiBudW1iZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBSZXRyaWV2YWwgcHJvdmlkZXIgdGhhdCB1c2VzIFNtYXJ0IENvbm5lY3Rpb25zIHBsdWdpbiB2aWEgY2FwdHVyZSBhbmQgY2FjaGUgc3lzdGVtLlxyXG4gKiBDYXB0dXJlcyByZXN1bHRzIGZyb20gRE9NIG9yIGNsaXBib2FyZCwgY2FjaGVzIHRoZW0sIGFuZCB1c2VzIGNhY2hlZCBkYXRhIGZvciByZXRyaWV2YWwuXHJcbiAqL1xyXG5leHBvcnQgY2xhc3MgU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyIGltcGxlbWVudHMgUmV0cmlldmFsUHJvdmlkZXIge1xyXG5cdHJlYWRvbmx5IGlkID0gJ3NtYXJ0LWNvbm5lY3Rpb25zJztcclxuXHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBhcHA6IEFwcDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcclxuXHRwcml2YXRlIHJlYWRvbmx5IGlzQWxsb3dlZFBhdGg6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW47XHJcblx0cHJpdmF0ZSBjdXJyZW50U2Vzc2lvbklkOiBzdHJpbmcgPSAnJztcclxuXHJcblx0Y29uc3RydWN0b3IoXHJcblx0XHRhcHA6IEFwcCxcclxuXHRcdHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbixcclxuXHRcdHZhdWx0OiBWYXVsdCxcclxuXHRcdGlzQWxsb3dlZFBhdGg6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW5cclxuXHQpIHtcclxuXHRcdHRoaXMuYXBwID0gYXBwO1xyXG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLmlzQWxsb3dlZFBhdGggPSBpc0FsbG93ZWRQYXRoO1xyXG5cdFx0dGhpcy5pbml0aWFsaXplU2Vzc2lvbigpO1xyXG5cdFx0dGhpcy5sb2dJbml0aWFsaXphdGlvbigpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogR2VuZXJhdGUgYSBuZXcgc2Vzc2lvbiBJRCBmb3IgbG9nZ2luZyBncm91cGluZy5cclxuXHQgKi9cclxuXHRwcml2YXRlIGdlbmVyYXRlU2Vzc2lvbklkKCk6IHN0cmluZyB7XHJcblx0XHRyZXR1cm4gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc3Vic3RyaW5nKDIsIDgpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogSW5pdGlhbGl6ZSBzZXNzaW9uIElEIGZvciB0aGlzIGluc3RhbmNlLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgaW5pdGlhbGl6ZVNlc3Npb24oKTogdm9pZCB7XHJcblx0XHR0aGlzLmN1cnJlbnRTZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBTdHJ1Y3R1cmVkIGxvZ2dpbmcgaGVscGVyIHdpdGggc2Vzc2lvbiBJRCBzdXBwb3J0LlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgbG9nKGxldmVsOiAnaW5mbycgfCAnd2FybicgfCAnZXJyb3InLCBtZXNzYWdlOiBzdHJpbmcsIGNvbnRleHQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGV0YWlscz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XHJcblx0XHRjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcblx0XHRjb25zdCBtZXRob2ROYW1lID0gbmV3IEVycm9yKCkuc3RhY2s/LnNwbGl0KCdcXG4nKVsyXT8ubWF0Y2goL2F0IFxcdytcXC4oXFx3KykvKT8uWzFdIHx8ICd1bmtub3duJztcclxuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuY3VycmVudFNlc3Npb25JZDtcclxuXHRcdFxyXG5cdFx0Y29uc3QgY29udGV4dFN0ciA9IGNvbnRleHQgPyBgIHwgQ29udGV4dDogJHtKU09OLnN0cmluZ2lmeShjb250ZXh0KX1gIDogJyc7XHJcblx0XHRjb25zdCBkZXRhaWxzU3RyID0gZGV0YWlscyA/IGAgfCBEZXRhaWxzOiAke0pTT04uc3RyaW5naWZ5KGRldGFpbHMpfWAgOiAnJztcclxuXHRcdFxyXG5cdFx0Y29uc3QgbG9nTWVzc2FnZSA9IGBbU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyOiR7bWV0aG9kTmFtZX1dW3NpZD0ke3Nlc3Npb25JZH1dICR7bGV2ZWwudG9VcHBlckNhc2UoKX06ICR7bWVzc2FnZX0ke2NvbnRleHRTdHJ9JHtkZXRhaWxzU3RyfWA7XHJcblx0XHRcclxuXHRcdGlmIChsZXZlbCA9PT0gJ2Vycm9yJykge1xyXG5cdFx0XHRjb25zb2xlLmVycm9yKGxvZ01lc3NhZ2UpO1xyXG5cdFx0fSBlbHNlIGlmIChsZXZlbCA9PT0gJ3dhcm4nKSB7XHJcblx0XHRcdGNvbnNvbGUud2Fybihsb2dNZXNzYWdlKTtcclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdGNvbnNvbGUuZGVidWcobG9nTWVzc2FnZSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBMb2cgaW5pdGlhbGl6YXRpb24gc3RhdHVzLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgbG9nSW5pdGlhbGl6YXRpb24oKTogdm9pZCB7XHJcblx0XHRjb25zdCBjYWNoZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNDYWNoZTtcclxuXHRcdGNvbnN0IGVuYWJsZWQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVFbmFibGVkID8/IGZhbHNlO1xyXG5cdFx0XHJcblx0XHRpZiAoY2FjaGUpIHtcclxuXHRcdFx0Y29uc3QgYWdlID0gRGF0ZS5ub3coKSAtIGNhY2hlLmNhcHR1cmVkQXQ7XHJcblx0XHRcdGNvbnN0IGFnZUhvdXJzID0gTWF0aC5mbG9vcihhZ2UgLyAoMTAwMCAqIDYwICogNjApKTtcclxuXHRcdFx0Y29uc3QgYWdlTWludXRlcyA9IE1hdGguZmxvb3IoKGFnZSAlICgxMDAwICogNjAgKiA2MCkpIC8gKDEwMDAgKiA2MCkpO1xyXG5cdFx0XHRjb25zdCBhZ2VTdHIgPSBhZ2VIb3VycyA+IDAgPyBgJHthZ2VIb3Vyc31oICR7YWdlTWludXRlc31tYCA6IGAke2FnZU1pbnV0ZXN9bWA7XHJcblx0XHRcdFxyXG5cdFx0XHRjb25zdCBpc0ZyZXNoID0gdGhpcy5pc0NhY2hlRnJlc2goY2FjaGUpO1xyXG5cdFx0XHRcclxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnSW5pdGlhbGl6YXRpb24gY29tcGxldGUnLCB7XHJcblx0XHRcdFx0Y2FjaGVFbmFibGVkOiBlbmFibGVkLFxyXG5cdFx0XHRcdGNhY2hlRXhpc3RzOiB0cnVlLFxyXG5cdFx0XHRcdGNhY2hlQWdlOiBhZ2VTdHIsXHJcblx0XHRcdFx0Y2FjaGVSZXN1bHRzOiBjYWNoZS5yZXN1bHRzLmxlbmd0aCxcclxuXHRcdFx0XHRjYWNoZU1ldGhvZDogY2FjaGUubWV0aG9kLFxyXG5cdFx0XHRcdGNhY2hlRnJlc2g6IGlzRnJlc2gsXHJcblx0XHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXHJcblx0XHRcdFx0dmF1bHRJZDogY2FjaGUudmF1bHRJZFxyXG5cdFx0XHR9KTtcclxuXHRcdH0gZWxzZSB7XHJcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0luaXRpYWxpemF0aW9uIGNvbXBsZXRlJywge1xyXG5cdFx0XHRcdGNhY2hlRW5hYmxlZDogZW5hYmxlZCxcclxuXHRcdFx0XHRjYWNoZUV4aXN0czogZmFsc2VcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBHZXQgdmF1bHQgSUQgKG5hbWUgKyBvcHRpb25hbCBiYXNlUGF0aCkuXHJcblx0ICovXHJcblx0cHJpdmF0ZSBnZXRWYXVsdElkKCk6IHN0cmluZyB7XHJcblx0XHRjb25zdCB2YXVsdE5hbWUgPSB0aGlzLmFwcC52YXVsdC5nZXROYW1lKCk7XHJcblx0XHRjb25zdCBhZGFwdGVyID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlciBhcyB7IGJhc2VQYXRoPzogc3RyaW5nIH07XHJcblx0XHRjb25zdCBiYXNlUGF0aCA9IGFkYXB0ZXIuYmFzZVBhdGggfHwgJyc7XHJcblx0XHRjb25zdCB2YXVsdElkID0gdmF1bHROYW1lICsgKGJhc2VQYXRoID8gYDoke2Jhc2VQYXRofWAgOiAnJyk7XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1ZhdWx0IElEIGdlbmVyYXRlZCcsIHtcclxuXHRcdFx0dmF1bHROYW1lLFxyXG5cdFx0XHRiYXNlUGF0aDogYmFzZVBhdGggfHwgJyhub3QgYXZhaWxhYmxlKScsXHJcblx0XHRcdHZhdWx0SWRcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHRyZXR1cm4gdmF1bHRJZDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIENoZWNrIGlmIGNhY2hlIGlzIGZyZXNoICh3aXRoaW4gVFRMIGlmIHNldCkuXHJcblx0ICovXHJcblx0cHJpdmF0ZSBpc0NhY2hlRnJlc2goY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSk6IGJvb2xlYW4ge1xyXG5cdFx0Y29uc3QgdHRsID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlVFRMO1xyXG5cdFx0aWYgKCF0dGwpIHtcclxuXHRcdFx0cmV0dXJuIHRydWU7IC8vIE5vIFRUTCwgYWx3YXlzIGZyZXNoXHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnN0IGFnZSA9IERhdGUubm93KCkgLSBjYWNoZS5jYXB0dXJlZEF0O1xyXG5cdFx0Y29uc3QgdHRsTXMgPSB0dGwgKiA2MCAqIDYwICogMTAwMDtcclxuXHRcdGNvbnN0IGZyZXNoID0gYWdlIDwgdHRsTXM7XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ0NhY2hlIGZyZXNobmVzcyBjaGVjaycsIHtcclxuXHRcdFx0YWdlOiBgJHtNYXRoLmZsb29yKGFnZSAvICgxMDAwICogNjAgKiA2MCkpfWhgLFxyXG5cdFx0XHR0dGw6IGAke3R0bH1oYCxcclxuXHRcdFx0ZnJlc2hcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHRyZXR1cm4gZnJlc2g7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBOb3JtYWxpemUgZm9sZGVyIHBhdGggZm9yIGNvbXBhcmlzb24gKHJlbW92ZSBsZWFkaW5nIHNsYXNoLCBlbnN1cmUgdHJhaWxpbmcgc2xhc2gpLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgbm9ybWFsaXplRm9sZGVyUGF0aChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdFx0bGV0IG5vcm1hbGl6ZWQgPSBwYXRoLnJlcGxhY2UoL15cXC8rLywgJycpOyAvLyBSZW1vdmUgbGVhZGluZyBzbGFzaGVzXHJcblx0XHRpZiAobm9ybWFsaXplZCAmJiAhbm9ybWFsaXplZC5lbmRzV2l0aCgnLycpKSB7XHJcblx0XHRcdG5vcm1hbGl6ZWQgKz0gJy8nOyAvLyBFbnN1cmUgdHJhaWxpbmcgc2xhc2hcclxuXHRcdH1cclxuXHRcdHJldHVybiBub3JtYWxpemVkO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ2hlY2sgaWYgcGF0aCBpcyBhbGxvd2VkIGJhc2VkIG9uIGZvbGRlciBmaWx0ZXJzLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgaXNQYXRoQWxsb3dlZChwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcclxuXHRcdGNvbnN0IGFsbG93ZWQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQWxsb3dlZEZvbGRlcnMgfHwgW107XHJcblx0XHRjb25zdCBibG9ja2VkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0Jsb2NrZWRGb2xkZXJzIHx8IFtdO1xyXG5cdFx0XHJcblx0XHQvLyBOb3JtYWxpemUgcGF0aCBmb3IgY29tcGFyaXNvblxyXG5cdFx0Y29uc3Qgbm9ybWFsaXplZFBhdGggPSB0aGlzLm5vcm1hbGl6ZUZvbGRlclBhdGgocGF0aCk7XHJcblx0XHRcclxuXHRcdC8vIENoZWNrIGJsb2NrbGlzdCBmaXJzdFxyXG5cdFx0Zm9yIChjb25zdCBibG9ja2VkRm9sZGVyIG9mIGJsb2NrZWQpIHtcclxuXHRcdFx0Y29uc3Qgbm9ybWFsaXplZEJsb2NrZWQgPSB0aGlzLm5vcm1hbGl6ZUZvbGRlclBhdGgoYmxvY2tlZEZvbGRlcik7XHJcblx0XHRcdGlmIChub3JtYWxpemVkUGF0aCA9PT0gbm9ybWFsaXplZEJsb2NrZWQgfHwgbm9ybWFsaXplZFBhdGguc3RhcnRzV2l0aChub3JtYWxpemVkQmxvY2tlZCkpIHtcclxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdQYXRoIGJsb2NrZWQgYnkgZmlsdGVyJywge1xyXG5cdFx0XHRcdFx0cGF0aCxcclxuXHRcdFx0XHRcdGJsb2NrZWRGb2xkZXIsXHJcblx0XHRcdFx0XHRub3JtYWxpemVkUGF0aCxcclxuXHRcdFx0XHRcdG5vcm1hbGl6ZWRCbG9ja2VkXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIENoZWNrIGFsbG93bGlzdCAoaWYgc2V0LCBwYXRoIG11c3QgYmUgaW4gYWxsb3dlZCBmb2xkZXJzKVxyXG5cdFx0aWYgKGFsbG93ZWQubGVuZ3RoID4gMCkge1xyXG5cdFx0XHRjb25zdCBpc0FsbG93ZWQgPSBhbGxvd2VkLnNvbWUoYWxsb3dlZEZvbGRlciA9PiB7XHJcblx0XHRcdFx0Y29uc3Qgbm9ybWFsaXplZEFsbG93ZWQgPSB0aGlzLm5vcm1hbGl6ZUZvbGRlclBhdGgoYWxsb3dlZEZvbGRlcik7XHJcblx0XHRcdFx0cmV0dXJuIG5vcm1hbGl6ZWRQYXRoID09PSBub3JtYWxpemVkQWxsb3dlZCB8fCBub3JtYWxpemVkUGF0aC5zdGFydHNXaXRoKG5vcm1hbGl6ZWRBbGxvd2VkKTtcclxuXHRcdFx0fSk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoIWlzQWxsb3dlZCkge1xyXG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ1BhdGggbm90IGluIGFsbG93ZWQgZm9sZGVycycsIHtcclxuXHRcdFx0XHRcdHBhdGgsXHJcblx0XHRcdFx0XHRhbGxvd2VkRm9sZGVyczogYWxsb3dlZCxcclxuXHRcdFx0XHRcdG5vcm1hbGl6ZWRQYXRoXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHJldHVybiB0cnVlO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ2hlY2sgY2FjaGUga2V5aW5nIG1hdGNoIChzb2Z0L3N0cmljdCBtb2RlKS5cclxuXHQgKi9cclxuXHRwcml2YXRlIGNoZWNrQ2FjaGVLZXlpbmcoY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSwgY3VycmVudE5vdGVQYXRoPzogc3RyaW5nKTogeyBtYXRjaDogYm9vbGVhbjsgY3VycmVudE5vdGU/OiBzdHJpbmc7IGNhY2hlTm90ZT86IHN0cmluZyB9IHtcclxuXHRcdGlmICghY2FjaGUuc291cmNlTm90ZVBhdGgpIHtcclxuXHRcdFx0cmV0dXJuIHsgbWF0Y2g6IHRydWUgfTsgLy8gTm8ga2V5aW5nLCBhbHdheXMgbWF0Y2hcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0aWYgKCFjdXJyZW50Tm90ZVBhdGgpIHtcclxuXHRcdFx0cmV0dXJuIHsgbWF0Y2g6IHRydWUgfTsgLy8gTm8gY3VycmVudCBub3RlLCBhbGxvdyB1c2VcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc3QgbWF0Y2ggPSBjYWNoZS5zb3VyY2VOb3RlUGF0aCA9PT0gY3VycmVudE5vdGVQYXRoO1xyXG5cdFx0aWYgKCFtYXRjaCkge1xyXG5cdFx0XHRjb25zdCBtb2RlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0tleWluZ01vZGUgfHwgJ3NvZnQnO1xyXG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2gnLCB7XHJcblx0XHRcdFx0Y3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCxcclxuXHRcdFx0XHRjYWNoZU5vdGU6IGNhY2hlLnNvdXJjZU5vdGVQYXRoLFxyXG5cdFx0XHRcdG1vZGVcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHJldHVybiB7IG1hdGNoLCBjdXJyZW50Tm90ZTogY3VycmVudE5vdGVQYXRoLCBjYWNoZU5vdGU6IGNhY2hlLnNvdXJjZU5vdGVQYXRoIH07XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBWYWxpZGF0ZSBhbmQgY2xlYW4gY2FjaGUgKHJlbW92ZSBtaXNzaW5nIGZpbGVzLCBpbi1tZW1vcnkgb25seSkuXHJcblx0ICovXHJcblx0cHJpdmF0ZSB2YWxpZGF0ZUFuZENsZWFuQ2FjaGUoY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSk6IHsgY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZTsgd2FzTW9kaWZpZWQ6IGJvb2xlYW4gfSB7XHJcblx0XHRjb25zdCBvcmlnaW5hbENvdW50ID0gY2FjaGUucmVzdWx0cy5sZW5ndGg7XHJcblx0XHRjb25zdCB2YWxpZFJlc3VsdHMgPSBjYWNoZS5yZXN1bHRzLmZpbHRlcihyZXN1bHQgPT4ge1xyXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocmVzdWx0LnBhdGgpO1xyXG5cdFx0XHRyZXR1cm4gZmlsZSBpbnN0YW5jZW9mIFRGaWxlO1xyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdGNvbnN0IHdhc01vZGlmaWVkID0gdmFsaWRSZXN1bHRzLmxlbmd0aCAhPT0gb3JpZ2luYWxDb3VudDtcclxuXHRcdFxyXG5cdFx0aWYgKHdhc01vZGlmaWVkKSB7XHJcblx0XHRcdGNvbnN0IGRyb3BwZWQgPSBvcmlnaW5hbENvdW50IC0gdmFsaWRSZXN1bHRzLmxlbmd0aDtcclxuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnQ2FjaGUgaW52YWxpZGF0aW9uJywge1xyXG5cdFx0XHRcdGRyb3BwZWQsXHJcblx0XHRcdFx0b3JpZ2luYWxDb3VudCxcclxuXHRcdFx0XHR2YWxpZDogdmFsaWRSZXN1bHRzLmxlbmd0aFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0Y2FjaGUucmVzdWx0cyA9IHZhbGlkUmVzdWx0czsgLy8gSW4tbWVtb3J5IG9ubHlcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0cmV0dXJuIHsgY2FjaGUsIHdhc01vZGlmaWVkIH07XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBTYXZlIGNhY2hlIHRvIHNldHRpbmdzICh3aXRoIHNhbml0eSBndWFyZCkuXHJcblx0ICovXHJcblx0cHJpdmF0ZSBhc3luYyBzYXZlQ2FjaGUoY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0Ly8gU2FuaXR5IGd1YXJkOiBkb24ndCBvdmVyd3JpdGUgY2FjaGUgaWYgY2FwdHVyZSByZXR1cm5lZCAwIHJlc3VsdHNcclxuXHRcdGlmIChjYWNoZS5yZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYXB0dXJlIHJldHVybmVkIDAgcmVzdWx0cywgcHJlc2VydmluZyBleGlzdGluZyBjYWNoZScsIHtcclxuXHRcdFx0XHRzZXNzaW9uSWQ6IGNhY2hlLnNlc3Npb25JZCxcclxuXHRcdFx0XHRtZXRob2Q6IGNhY2hlLm1ldGhvZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0cmV0dXJuOyAvLyBEb24ndCBvdmVyd3JpdGUgZXhpc3RpbmcgY2FjaGVcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlID0gY2FjaGU7XHJcblx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcclxuXHRcdFxyXG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgc2F2ZWQnLCB7XHJcblx0XHRcdHJlc3VsdHM6IGNhY2hlLnJlc3VsdHMubGVuZ3RoLFxyXG5cdFx0XHRtZXRob2Q6IGNhY2hlLm1ldGhvZCxcclxuXHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXHJcblx0XHRcdHZhdWx0SWQ6IGNhY2hlLnZhdWx0SWRcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogR2V0IGNhY2hlIGZyb20gc2V0dGluZ3MuXHJcblx0ICovXHJcblx0cHJpdmF0ZSBnZXRDYWNoZSgpOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUgfCBudWxsIHtcclxuXHRcdHJldHVybiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGUgfHwgbnVsbDtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIEZpbmQgU21hcnQgQ29ubmVjdGlvbnMgdmlldyB1c2luZyBoZXVyaXN0aWMgZGV0ZWN0aW9uLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk6IFdvcmtzcGFjZUxlYWYgfCBudWxsIHtcclxuXHRcdGNvbnN0IGxlYXZlczogV29ya3NwYWNlTGVhZltdID0gW107XHJcblx0XHR0aGlzLmFwcC53b3Jrc3BhY2UuaXRlcmF0ZUFsbExlYXZlcygobGVhZikgPT4ge1xyXG5cdFx0XHRsZWF2ZXMucHVzaChsZWFmKTtcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHR0aGlzLmxvZygnaW5mbycsICdTY2FubmluZyB3b3Jrc3BhY2UgbGVhdmVzJywge1xyXG5cdFx0XHR0b3RhbExlYXZlczogbGVhdmVzLmxlbmd0aFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgbGVhdmVzLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRcdGNvbnN0IGxlYWYgPSBsZWF2ZXNbaV07XHJcblx0XHRcdGNvbnN0IHZpZXdUeXBlID0gbGVhZi52aWV3LmdldFZpZXdUeXBlPy4oKSB8fCAndW5rbm93bic7XHJcblx0XHRcdGNvbnN0IGNvbnRhaW5lckVsID0gbGVhZi52aWV3LmNvbnRhaW5lckVsO1xyXG5cdFx0XHRcclxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2hlY2tpbmcgbGVhZicsIHtcclxuXHRcdFx0XHRpbmRleDogaSxcclxuXHRcdFx0XHR2aWV3VHlwZSxcclxuXHRcdFx0XHRjb250YWluZXJDbGFzc2VzOiBBcnJheS5mcm9tKGNvbnRhaW5lckVsLmNsYXNzTGlzdCB8fCBbXSkuam9pbignLCAnKVxyXG5cdFx0XHR9KTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIENoZWNrIGZvciBTQyBtYXJrZXJzIHdpdGggY29uZmlkZW5jZSBicmVhZGNydW1ic1xyXG5cdFx0XHRsZXQgY29uZmlkZW5jZSA9ICdub25lJztcclxuXHRcdFx0bGV0IG1hcmtlciA9ICcnO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gTWFya2VyIDE6IGNsYXNzIGNvbnRhaW5zICdzbWFydC1jb25uZWN0aW9ucydcclxuXHRcdFx0aWYgKGNvbnRhaW5lckVsLmNsYXNzTGlzdC5jb250YWlucygnc21hcnQtY29ubmVjdGlvbnMnKSB8fCBcclxuXHRcdFx0ICAgIEFycmF5LmZyb20oY29udGFpbmVyRWwuY2xhc3NMaXN0KS5zb21lKGMgPT4gYy5pbmNsdWRlcygnc21hcnQtY29ubmVjdGlvbnMnKSkpIHtcclxuXHRcdFx0XHRjb25maWRlbmNlID0gJ2hpZ2gnO1xyXG5cdFx0XHRcdG1hcmtlciA9ICdjbGFzcyBjb250YWlucyBzbWFydC1jb25uZWN0aW9ucyc7XHJcblx0XHRcdH1cclxuXHRcdFx0Ly8gTWFya2VyIDI6IGNvbnRhaW5zIHRleHQgJ0Nvbm5lY3Rpb25zJ1xyXG5cdFx0XHRlbHNlIGlmIChjb250YWluZXJFbC50ZXh0Q29udGVudD8uaW5jbHVkZXMoJ0Nvbm5lY3Rpb25zJykpIHtcclxuXHRcdFx0XHRjb25maWRlbmNlID0gJ21lZGl1bSc7XHJcblx0XHRcdFx0bWFya2VyID0gJ2NvbnRhaW5zIHRleHQgQ29ubmVjdGlvbnMnO1xyXG5cdFx0XHR9XHJcblx0XHRcdC8vIE1hcmtlciAzOiByZXN1bHRzIGxpc3QgaGFzIGludGVybmFsIGxpbmtzXHJcblx0XHRcdGVsc2UgaWYgKGNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EuaW50ZXJuYWwtbGlua1tkYXRhLWhyZWZdJykubGVuZ3RoID4gMCkge1xyXG5cdFx0XHRcdGNvbmZpZGVuY2UgPSAnaGlnaCc7XHJcblx0XHRcdFx0bWFya2VyID0gJ3Jlc3VsdHMgbGlzdCBoYXMgaW50ZXJuYWwgbGlua3MnO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoY29uZmlkZW5jZSAhPT0gJ25vbmUnKSB7XHJcblx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnU0MgdmlldyBkZXRlY3RlZCcsIHtcclxuXHRcdFx0XHRcdGxlYWZJbmRleDogaSxcclxuXHRcdFx0XHRcdHZpZXdUeXBlLFxyXG5cdFx0XHRcdFx0bWFya2VyLFxyXG5cdFx0XHRcdFx0Y29uZmlkZW5jZVxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0XHRcdHJldHVybiBsZWFmO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1NDIHZpZXcgbm90IGZvdW5kJywge1xyXG5cdFx0XHRsZWF2ZXNDaGVja2VkOiBsZWF2ZXMubGVuZ3RoXHJcblx0XHR9KTtcclxuXHRcdFxyXG5cdFx0cmV0dXJuIG51bGw7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBDYXB0dXJlIHJlc3VsdHMgZnJvbSBTbWFydCBDb25uZWN0aW9ucyBET00uXHJcblx0ICovXHJcblx0YXN5bmMgY2FwdHVyZUZyb21Eb20oc291cmNlTm90ZVBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPEFycmF5PHsgcGF0aDogc3RyaW5nOyBzY29yZTogbnVtYmVyIH0+PiB7XHJcblx0XHRjb25zdCBzZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XHJcblx0XHR0aGlzLmN1cnJlbnRTZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XHJcblx0XHRhd2FpdCBQcm9taXNlLnJlc29sdmUoKTsgLy8gRW5zdXJlIGFzeW5jXHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIERPTSBjYXB0dXJlJywge1xyXG5cdFx0XHRzb3VyY2VOb3RlUGF0aDogc291cmNlTm90ZVBhdGggfHwgJyhub3QgcHJvdmlkZWQpJyxcclxuXHRcdFx0c2Vzc2lvbklkXHJcblx0XHR9KTtcclxuXHRcdFxyXG5cdFx0Y29uc3Qgc2NWaWV3ID0gdGhpcy5maW5kU21hcnRDb25uZWN0aW9uc1ZpZXcoKTtcclxuXHRcdGlmICghc2NWaWV3KSB7XHJcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ1NDIHZpZXcgbm90IGZvdW5kIGZvciBET00gY2FwdHVyZScsIHtcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdHJldHVybiBbXTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gUG9ydGFibGUgcmVzdWx0cyBkZXRlY3Rpb24gdXNpbmcgaW50ZXJuYWwtbGluayBzZWxlY3RvclxyXG5cdFx0Y29uc3QgaW50ZXJuYWxMaW5rcyA9IHNjVmlldy52aWV3LmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EuaW50ZXJuYWwtbGlua1tkYXRhLWhyZWZdJyk7XHJcblx0XHRjb25zdCByZXN1bHRzQ291bnQgPSBpbnRlcm5hbExpbmtzLmxlbmd0aDtcclxuXHRcdFxyXG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnUmVzdWx0cyBkZXRlY3Rpb24nLCB7XHJcblx0XHRcdHZpZXdGb3VuZDogdHJ1ZSxcclxuXHRcdFx0c2VsZWN0b3I6ICdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScsXHJcblx0XHRcdGNvdW50OiByZXN1bHRzQ291bnQsXHJcblx0XHRcdHNlc3Npb25JZFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdGlmIChyZXN1bHRzQ291bnQgPT09IDApIHtcclxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnVmlldyBmb3VuZCwgcmVzdWx0cyBtaXNzaW5nJywge1xyXG5cdFx0XHRcdHZpZXdGb3VuZDogdHJ1ZSxcclxuXHRcdFx0XHRyZXN1bHRzRm91bmQ6IGZhbHNlLFxyXG5cdFx0XHRcdHNlbGVjdG9yOiAnYS5pbnRlcm5hbC1saW5rW2RhdGEtaHJlZl0nLFxyXG5cdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0cmV0dXJuIFtdOyAvLyBEb24ndCBjYWNoZSBlbXB0eVxyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBFeHRyYWN0IGxpbmtzIGFuZCB2YWxpZGF0ZVxyXG5cdFx0Y29uc3QgcmVzdWx0czogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IHNjb3JlOiBudW1iZXIgfT4gPSBbXTtcclxuXHRcdGNvbnN0IG1heENhcHR1cmUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zTWF4Q2FwdHVyZUZpbGVzID8/IDIwMDtcclxuXHRcdFxyXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBNYXRoLm1pbihyZXN1bHRzQ291bnQsIG1heENhcHR1cmUpOyBpKyspIHtcclxuXHRcdFx0Y29uc3QgbGluayA9IGludGVybmFsTGlua3NbaV0gYXMgSFRNTEFuY2hvckVsZW1lbnQ7XHJcblx0XHRcdGNvbnN0IGRhdGFIcmVmID0gbGluay5nZXRBdHRyaWJ1dGUoJ2RhdGEtaHJlZicpO1xyXG5cdFx0XHRjb25zdCBocmVmID0gbGluay5nZXRBdHRyaWJ1dGUoJ2hyZWYnKTtcclxuXHRcdFx0Y29uc3QgcGF0aCA9IGRhdGFIcmVmIHx8IGhyZWYgfHwgJyc7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoIXBhdGgpIHtcclxuXHRcdFx0XHR0aGlzLmxvZygnd2FybicsICdMaW5rIG1pc3NpbmcgcGF0aCcsIHtcclxuXHRcdFx0XHRcdGluZGV4OiBpLFxyXG5cdFx0XHRcdFx0ZGF0YUhyZWYsXHJcblx0XHRcdFx0XHRocmVmLFxyXG5cdFx0XHRcdFx0c2Vzc2lvbklkXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIE5vcm1hbGl6ZSBwYXRoIChyZW1vdmUgLm1kIGV4dGVuc2lvbiBpZiBwcmVzZW50LCBoYW5kbGUgaW50ZXJuYWwgbGluayBmb3JtYXQpXHJcblx0XHRcdGxldCBub3JtYWxpemVkUGF0aCA9IHBhdGgucmVwbGFjZSgvXFwubWQkLywgJycpO1xyXG5cdFx0XHRpZiAobm9ybWFsaXplZFBhdGguc3RhcnRzV2l0aCgnIycpKSB7XHJcblx0XHRcdFx0Ly8gU2tpcCBhbmNob3JzXHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzIGFuZCBpcyBhbGxvd2VkXHJcblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChub3JtYWxpemVkUGF0aCk7XHJcblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHtcclxuXHRcdFx0XHR0aGlzLmxvZygnd2FybicsICdMaW5rIHJlc29sdmVzIHRvIG5vbi1maWxlJywge1xyXG5cdFx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXHJcblx0XHRcdFx0XHRpbmRleDogaSxcclxuXHRcdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBBcHBseSBmb2xkZXIgZmlsdGVyc1xyXG5cdFx0XHRpZiAoIXRoaXMuaXNQYXRoQWxsb3dlZChub3JtYWxpemVkUGF0aCkpIHtcclxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdMaW5rIGZpbHRlcmVkIG91dCcsIHtcclxuXHRcdFx0XHRcdHBhdGg6IG5vcm1hbGl6ZWRQYXRoLFxyXG5cdFx0XHRcdFx0aW5kZXg6IGksXHJcblx0XHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0XHR9KTtcclxuXHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQXNzaWduIHJhbmstYmFzZWQgc2NvcmUgKDEuMCwgMC45OCwgMC45Ni4uLilcclxuXHRcdFx0Y29uc3QgcmFua1Njb3JlID0gTWF0aC5tYXgoMC41LCAxLjAgLSAoaSAqIDAuMDIpKTtcclxuXHRcdFx0XHJcblx0XHRcdHJlc3VsdHMucHVzaCh7XHJcblx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXHJcblx0XHRcdFx0c2NvcmU6IHJhbmtTY29yZVxyXG5cdFx0XHR9KTtcclxuXHRcdFx0XHJcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0xpbmsgY2FwdHVyZWQnLCB7XHJcblx0XHRcdFx0aW5kZXg6IGksXHJcblx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXHJcblx0XHRcdFx0c2NvcmU6IHJhbmtTY29yZSxcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ0RPTSBjYXB0dXJlIGNvbXBsZXRlJywge1xyXG5cdFx0XHRyZXN1bHRzOiByZXN1bHRzLmxlbmd0aCxcclxuXHRcdFx0dGltZTogJ04vQScsIC8vIENvdWxkIGFkZCB0aW1pbmcgaWYgbmVlZGVkXHJcblx0XHRcdHNlc3Npb25JZFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdHJldHVybiByZXN1bHRzO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogQ2FwdHVyZSByZXN1bHRzIGZyb20gY2xpcGJvYXJkLlxyXG5cdCAqL1xyXG5cdGFzeW5jIGNhcHR1cmVGcm9tQ2xpcGJvYXJkKHNvdXJjZU5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTxBcnJheTx7IHBhdGg6IHN0cmluZzsgc2NvcmU6IG51bWJlciB9Pj4ge1xyXG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xyXG5cdFx0dGhpcy5jdXJyZW50U2Vzc2lvbklkID0gc2Vzc2lvbklkO1xyXG5cdFx0XHJcblx0XHR0aGlzLmxvZygnaW5mbycsICdTdGFydGluZyBjbGlwYm9hcmQgY2FwdHVyZScsIHtcclxuXHRcdFx0c291cmNlTm90ZVBhdGg6IHNvdXJjZU5vdGVQYXRoIHx8ICcobm90IHByb3ZpZGVkKScsXHJcblx0XHRcdHNlc3Npb25JZFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdHRyeSB7XHJcblx0XHRcdC8vIENoZWNrIGNsaXBib2FyZCBwZXJtaXNzaW9uc1xyXG5cdFx0XHRjb25zdCBjbGlwYm9hcmRUZXh0ID0gYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC5yZWFkVGV4dCgpO1xyXG5cdFx0XHRcclxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2xpcGJvYXJkIHJlYWQnLCB7XHJcblx0XHRcdFx0bGVuZ3RoOiBjbGlwYm9hcmRUZXh0Lmxlbmd0aCxcclxuXHRcdFx0XHRwcmV2aWV3OiBjbGlwYm9hcmRUZXh0LnN1YnN0cmluZygwLCAyMDApLFxyXG5cdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIFBhcnNlIG1hcmtkb3duIGxpbmtzOiBbW25vdGUtbmFtZV1dIG9yIFt0ZXh0XShub3RlLW5hbWUubWQpXHJcblx0XHRcdGNvbnN0IG1hcmtkb3duTGlua1BhdHRlcm4gPSAvXFxbXFxbKFteXFxdXSspXFxdXFxdfFxcWyhbXlxcXV0rKVxcXVxcKChbXildK1xcLm1kKVxcKS9nO1xyXG5cdFx0XHRjb25zdCBsaW5rczogc3RyaW5nW10gPSBbXTtcclxuXHRcdFx0bGV0IG1hdGNoO1xyXG5cdFx0XHRcclxuXHRcdFx0d2hpbGUgKChtYXRjaCA9IG1hcmtkb3duTGlua1BhdHRlcm4uZXhlYyhjbGlwYm9hcmRUZXh0KSkgIT09IG51bGwpIHtcclxuXHRcdFx0XHRjb25zdCBsaW5rID0gbWF0Y2hbMV0gfHwgbWF0Y2hbM10gfHwgJyc7XHJcblx0XHRcdFx0aWYgKGxpbmspIHtcclxuXHRcdFx0XHRcdGxpbmtzLnB1c2gobGluay5yZXBsYWNlKC9cXC5tZCQvLCAnJykpO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnTGlua3MgcGFyc2VkIGZyb20gY2xpcGJvYXJkJywge1xyXG5cdFx0XHRcdGZvdW5kOiBsaW5rcy5sZW5ndGgsXHJcblx0XHRcdFx0bGlua3M6IGxpbmtzLnNsaWNlKDAsIDEwKSwgLy8gTG9nIGZpcnN0IDEwXHJcblx0XHRcdFx0c2Vzc2lvbklkXHJcblx0XHRcdH0pO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gVmFsaWRhdGUgYW5kIGZpbHRlciBsaW5rc1xyXG5cdFx0XHRjb25zdCByZXN1bHRzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgc2NvcmU6IG51bWJlciB9PiA9IFtdO1xyXG5cdFx0XHRjb25zdCBtYXhDYXB0dXJlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heENhcHR1cmVGaWxlcyA/PyAyMDA7XHJcblx0XHRcdFxyXG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IE1hdGgubWluKGxpbmtzLmxlbmd0aCwgbWF4Q2FwdHVyZSk7IGkrKykge1xyXG5cdFx0XHRcdGNvbnN0IGxpbmsgPSBsaW5rc1tpXTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBDaGVjayBpZiBmaWxlIGV4aXN0c1xyXG5cdFx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChsaW5rKTtcclxuXHRcdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XHJcblx0XHRcdFx0XHR0aGlzLmxvZygnd2FybicsICdDbGlwYm9hcmQgbGluayByZXNvbHZlcyB0byBub24tZmlsZScsIHtcclxuXHRcdFx0XHRcdFx0bGluayxcclxuXHRcdFx0XHRcdFx0aW5kZXg6IGksXHJcblx0XHRcdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHRjb250aW51ZTtcclxuXHRcdFx0XHR9XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0Ly8gQXBwbHkgZm9sZGVyIGZpbHRlcnNcclxuXHRcdFx0XHRpZiAoIXRoaXMuaXNQYXRoQWxsb3dlZChsaW5rKSkge1xyXG5cdFx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2xpcGJvYXJkIGxpbmsgZmlsdGVyZWQgb3V0Jywge1xyXG5cdFx0XHRcdFx0XHRsaW5rLFxyXG5cdFx0XHRcdFx0XHRpbmRleDogaSxcclxuXHRcdFx0XHRcdFx0c2Vzc2lvbklkXHJcblx0XHRcdFx0XHR9KTtcclxuXHRcdFx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0XHRcdH1cclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBBc3NpZ24gcmFuay1iYXNlZCBzY29yZVxyXG5cdFx0XHRcdGNvbnN0IHJhbmtTY29yZSA9IE1hdGgubWF4KDAuNSwgMS4wIC0gKGkgKiAwLjAyKSk7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0cmVzdWx0cy5wdXNoKHtcclxuXHRcdFx0XHRcdHBhdGg6IGxpbmssXHJcblx0XHRcdFx0XHRzY29yZTogcmFua1Njb3JlXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdFx0XHJcblx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2xpcGJvYXJkIGxpbmsgY2FwdHVyZWQnLCB7XHJcblx0XHRcdFx0XHRpbmRleDogaSxcclxuXHRcdFx0XHRcdGxpbmssXHJcblx0XHRcdFx0XHRzY29yZTogcmFua1Njb3JlLFxyXG5cdFx0XHRcdFx0c2Vzc2lvbklkXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NsaXBib2FyZCBjYXB0dXJlIGNvbXBsZXRlJywge1xyXG5cdFx0XHRcdHJlc3VsdHM6IHJlc3VsdHMubGVuZ3RoLFxyXG5cdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0XHJcblx0XHRcdHJldHVybiByZXN1bHRzO1xyXG5cdFx0XHRcclxuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XHJcblx0XHRcdHRoaXMubG9nKCdlcnJvcicsICdDbGlwYm9hcmQgY2FwdHVyZSBmYWlsZWQnLCB7XHJcblx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcclxuXHRcdFx0XHRzdGFjazogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLnN0YWNrIDogdW5kZWZpbmVkLFxyXG5cdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0cmV0dXJuIFtdO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogVG9rZW5pemUgdGV4dCAoc2ltcGxlIHdvcmQgc3BsaXR0aW5nLCBsb3dlcmNhc2UpLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgdG9rZW5pemUodGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xyXG5cdFx0cmV0dXJuIHRleHRcclxuXHRcdFx0LnRvTG93ZXJDYXNlKClcclxuXHRcdFx0LnNwbGl0KC9bXmEtejAtOV0rL2cpXHJcblx0XHRcdC5tYXAodCA9PiB0LnRyaW0oKSlcclxuXHRcdFx0LmZpbHRlcih0ID0+IHQubGVuZ3RoID49IDIpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogU2NvcmUgY2FjaGVkIGl0ZW1zIHVzaW5nIG1ldGFkYXRhIGNhY2hlIChmYXN0IHBhdGgpLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgYXN5bmMgc2NvcmVDYWNoZWRJdGVtc1dpdGhNZXRhZGF0YShcclxuXHRcdGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUsXHJcblx0XHRxdWVyeTogc3RyaW5nLFxyXG5cdFx0bGltaXQ6IG51bWJlclxyXG5cdCk6IFByb21pc2U8U2NvcmVkQ2FjaGVJdGVtW10+IHtcclxuXHRcdGF3YWl0IFByb21pc2UucmVzb2x2ZSgpOyAvLyBFbnN1cmUgYXN5bmNcclxuXHRcdGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVyeSk7XHJcblx0XHRjb25zdCBtYXhTY29yZUZpbGVzID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heFNjb3JlRmlsZXMgPz8gNTA7XHJcblx0XHRjb25zdCBpdGVtc1RvU2NvcmUgPSBjYWNoZS5yZXN1bHRzLnNsaWNlKDAsIE1hdGgubWluKGNhY2hlLnJlc3VsdHMubGVuZ3RoLCBtYXhTY29yZUZpbGVzKSk7XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIG1ldGFkYXRhIHNjb3JpbmcnLCB7XHJcblx0XHRcdHF1ZXJ5VG9rZW5zOiBxdWVyeVRva2Vucy5zbGljZSgwLCAxMCksIC8vIExvZyBmaXJzdCAxMCB0b2tlbnNcclxuXHRcdFx0aXRlbXNUb1Njb3JlOiBpdGVtc1RvU2NvcmUubGVuZ3RoLFxyXG5cdFx0XHRtYXhTY29yZUZpbGVzLFxyXG5cdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdGNvbnN0IHNjb3JlZDogU2NvcmVkQ2FjaGVJdGVtW10gPSBbXTtcclxuXHRcdFxyXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBpdGVtc1RvU2NvcmUubGVuZ3RoOyBpKyspIHtcclxuXHRcdFx0Y29uc3QgaXRlbSA9IGl0ZW1zVG9TY29yZVtpXTtcclxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGl0ZW0ucGF0aCk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIEdldCBtZXRhZGF0YSBjYWNoZVxyXG5cdFx0XHRjb25zdCBtZXRhZGF0YSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xyXG5cdFx0XHRpZiAoIW1ldGFkYXRhKSB7XHJcblx0XHRcdFx0Ly8gTm8gbWV0YWRhdGEsIHVzZSByYW5rIHNjb3JlIG9ubHlcclxuXHRcdFx0XHRzY29yZWQucHVzaCh7XHJcblx0XHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXHJcblx0XHRcdFx0XHRyYW5rU2NvcmU6IGl0ZW0uc2NvcmUgPz8gMC41LFxyXG5cdFx0XHRcdFx0bWV0YWRhdGFTY29yZTogMCxcclxuXHRcdFx0XHRcdGZpbmFsU2NvcmU6IGl0ZW0uc2NvcmUgPz8gMC41LFxyXG5cdFx0XHRcdFx0Y2FwdHVyZWRBdDogaXRlbS5jYXB0dXJlZEF0XHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIEV4dHJhY3QgdGV4dCBmcm9tIG1ldGFkYXRhXHJcblx0XHRcdGNvbnN0IG1ldGFkYXRhVGV4dDogc3RyaW5nW10gPSBbXTtcclxuXHRcdFx0XHJcblx0XHRcdC8vIEZyb250bWF0dGVyIHRhZ3NcclxuXHRcdFx0aWYgKG1ldGFkYXRhLmZyb250bWF0dGVyPy50YWdzKSB7XHJcblx0XHRcdFx0Y29uc3QgdGFncyA9IEFycmF5LmlzQXJyYXkobWV0YWRhdGEuZnJvbnRtYXR0ZXIudGFncykgXHJcblx0XHRcdFx0XHQ/IG1ldGFkYXRhLmZyb250bWF0dGVyLnRhZ3MgXHJcblx0XHRcdFx0XHQ6IFttZXRhZGF0YS5mcm9udG1hdHRlci50YWdzXTtcclxuXHRcdFx0XHRtZXRhZGF0YVRleHQucHVzaCguLi50YWdzLm1hcCgodDogc3RyaW5nKSA9PiB0LnRvU3RyaW5nKCkudG9Mb3dlckNhc2UoKSkpO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBIZWFkaW5nc1xyXG5cdFx0XHRpZiAobWV0YWRhdGEuaGVhZGluZ3MpIHtcclxuXHRcdFx0XHRtZXRhZGF0YVRleHQucHVzaCguLi5tZXRhZGF0YS5oZWFkaW5ncy5tYXAoaCA9PiBoLmhlYWRpbmcudG9Mb3dlckNhc2UoKSkpO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBUYWdzXHJcblx0XHRcdGlmIChtZXRhZGF0YS50YWdzKSB7XHJcblx0XHRcdFx0bWV0YWRhdGFUZXh0LnB1c2goLi4ubWV0YWRhdGEudGFncy5tYXAodCA9PiB0LnRhZy50b0xvd2VyQ2FzZSgpKSk7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIFNjb3JlIGJ5IHRva2VuIG92ZXJsYXBcclxuXHRcdFx0Y29uc3QgbWV0YWRhdGFUb2tlbnMgPSB0aGlzLnRva2VuaXplKG1ldGFkYXRhVGV4dC5qb2luKCcgJykpO1xyXG5cdFx0XHRjb25zdCBvdmVybGFwID0gcXVlcnlUb2tlbnMuZmlsdGVyKHQgPT4gbWV0YWRhdGFUb2tlbnMuaW5jbHVkZXModCkpLmxlbmd0aDtcclxuXHRcdFx0Y29uc3QgbWV0YWRhdGFTY29yZSA9IHF1ZXJ5VG9rZW5zLmxlbmd0aCA+IDAgPyBvdmVybGFwIC8gcXVlcnlUb2tlbnMubGVuZ3RoIDogMDtcclxuXHRcdFx0XHJcblx0XHRcdC8vIENvbWJpbmUgd2l0aCByYW5rIHNjb3JlXHJcblx0XHRcdGNvbnN0IHJhbmtTY29yZSA9IGl0ZW0uc2NvcmUgPz8gTWF0aC5tYXgoMC41LCAxLjAgLSAoaSAqIDAuMDIpKTtcclxuXHRcdFx0Y29uc3QgZmluYWxTY29yZSA9IChtZXRhZGF0YVNjb3JlICogMC43KSArIChyYW5rU2NvcmUgKiAwLjMpO1xyXG5cdFx0XHRcclxuXHRcdFx0c2NvcmVkLnB1c2goe1xyXG5cdFx0XHRcdHBhdGg6IGl0ZW0ucGF0aCxcclxuXHRcdFx0XHRyYW5rU2NvcmUsXHJcblx0XHRcdFx0bWV0YWRhdGFTY29yZSxcclxuXHRcdFx0XHRmaW5hbFNjb3JlLFxyXG5cdFx0XHRcdGNhcHR1cmVkQXQ6IGl0ZW0uY2FwdHVyZWRBdFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0XHJcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0l0ZW0gc2NvcmVkIHdpdGggbWV0YWRhdGEnLCB7XHJcblx0XHRcdFx0aW5kZXg6IGksXHJcblx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxyXG5cdFx0XHRcdG1ldGFkYXRhU2NvcmU6IG1ldGFkYXRhU2NvcmUudG9GaXhlZCgzKSxcclxuXHRcdFx0XHRyYW5rU2NvcmU6IHJhbmtTY29yZS50b0ZpeGVkKDMpLFxyXG5cdFx0XHRcdGZpbmFsU2NvcmU6IGZpbmFsU2NvcmUudG9GaXhlZCgzKSxcclxuXHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gU29ydCBieSBmaW5hbCBzY29yZSBhbmQgcmV0dXJuIHRvcCBOXHJcblx0XHRjb25zdCBzb3J0ZWQgPSBzY29yZWQuc29ydCgoYSwgYikgPT4gYi5maW5hbFNjb3JlIC0gYS5maW5hbFNjb3JlKTtcclxuXHRcdGNvbnN0IHRvcE4gPSBNYXRoLm1pbigxMCwgbGltaXQgKiAyKTsgLy8gUG9saWN5OiB0b3BORnVsbFJlYWQgPSBtaW4oMTAsIGxpbWl0ICogMilcclxuXHRcdFxyXG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnTWV0YWRhdGEgc2NvcmluZyBjb21wbGV0ZScsIHtcclxuXHRcdFx0c2NvcmVkOiBzb3J0ZWQubGVuZ3RoLFxyXG5cdFx0XHR0b3BOLFxyXG5cdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxyXG5cdFx0fSk7XHJcblx0XHRcclxuXHRcdHJldHVybiBzb3J0ZWQuc2xpY2UoMCwgdG9wTik7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBMb2FkIGZ1bGwgY29udGVudCBhbmQgcmUtc2NvcmUgdG9wIGl0ZW1zLlxyXG5cdCAqL1xyXG5cdHByaXZhdGUgYXN5bmMgbG9hZEFuZFNjb3JlVG9wSXRlbXMoXHJcblx0XHR0b3BJdGVtczogU2NvcmVkQ2FjaGVJdGVtW10sXHJcblx0XHRxdWVyeTogc3RyaW5nXHJcblx0KTogUHJvbWlzZTxTY29yZWRDYWNoZUl0ZW1bXT4ge1xyXG5cdFx0Y29uc3QgcXVlcnlUb2tlbnMgPSB0aGlzLnRva2VuaXplKHF1ZXJ5KTtcclxuXHRcdFxyXG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnTG9hZGluZyBmdWxsIGNvbnRlbnQgZm9yIHRvcCBpdGVtcycsIHtcclxuXHRcdFx0Y291bnQ6IHRvcEl0ZW1zLmxlbmd0aCxcclxuXHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHRvcEl0ZW1zLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRcdGNvbnN0IGl0ZW0gPSB0b3BJdGVtc1tpXTtcclxuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGl0ZW0ucGF0aCk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XHJcblx0XHRcdFx0Y29udGludWU7XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdHRyeSB7XHJcblx0XHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcclxuXHRcdFx0XHRjb25zdCBjb250ZW50VG9rZW5zID0gdGhpcy50b2tlbml6ZShjb250ZW50KTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHQvLyBTY29yZSBieSB0b2tlbiBvdmVybGFwXHJcblx0XHRcdFx0Y29uc3Qgb3ZlcmxhcCA9IHF1ZXJ5VG9rZW5zLmZpbHRlcih0ID0+IGNvbnRlbnRUb2tlbnMuaW5jbHVkZXModCkpLmxlbmd0aDtcclxuXHRcdFx0XHRjb25zdCBmdWxsQ29udGVudFNjb3JlID0gcXVlcnlUb2tlbnMubGVuZ3RoID4gMCA/IG92ZXJsYXAgLyBxdWVyeVRva2Vucy5sZW5ndGggOiAwO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdC8vIENvbWJpbmUgc2NvcmVzOiAocXVlcnlTY29yZSAqIDAuNykgKyAocmFua1Njb3JlICogMC4zKVxyXG5cdFx0XHRcdGl0ZW0uZnVsbENvbnRlbnRTY29yZSA9IGZ1bGxDb250ZW50U2NvcmU7XHJcblx0XHRcdFx0aXRlbS5maW5hbFNjb3JlID0gKGZ1bGxDb250ZW50U2NvcmUgKiAwLjcpICsgKGl0ZW0ucmFua1Njb3JlICogMC4zKTtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdJdGVtIHJlLXNjb3JlZCB3aXRoIGZ1bGwgY29udGVudCcsIHtcclxuXHRcdFx0XHRcdGluZGV4OiBpLFxyXG5cdFx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxyXG5cdFx0XHRcdFx0ZnVsbENvbnRlbnRTY29yZTogZnVsbENvbnRlbnRTY29yZS50b0ZpeGVkKDMpLFxyXG5cdFx0XHRcdFx0ZmluYWxTY29yZTogaXRlbS5maW5hbFNjb3JlLnRvRml4ZWQoMyksXHJcblx0XHRcdFx0XHRjb250ZW50TGVuZ3RoOiBjb250ZW50Lmxlbmd0aCxcclxuXHRcdFx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXHJcblx0XHRcdFx0fSk7XHJcblx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XHJcblx0XHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnRmFpbGVkIHRvIHJlYWQgZmlsZSBmb3Igc2NvcmluZycsIHtcclxuXHRcdFx0XHRcdHBhdGg6IGl0ZW0ucGF0aCxcclxuXHRcdFx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXHJcblx0XHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIFJlLXNvcnQgYnkgZmluYWwgc2NvcmVcclxuXHRcdHJldHVybiB0b3BJdGVtcy5zb3J0KChhLCBiKSA9PiBiLmZpbmFsU2NvcmUgLSBhLmZpbmFsU2NvcmUpO1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogR2VuZXJhdGUgYmVzdC1tYXRjaGluZyBwYXJhZ3JhcGggZXhjZXJwdC5cclxuXHQgKi9cclxuXHRwcml2YXRlIGFzeW5jIGdlbmVyYXRlQmVzdE1hdGNoaW5nRXhjZXJwdChwYXRoOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xyXG5cdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHBhdGgpO1xyXG5cdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xyXG5cdFx0XHRyZXR1cm4gJ1tGaWxlIG5vdCBmb3VuZF0nO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHR0cnkge1xyXG5cdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xyXG5cdFx0XHRjb25zdCBxdWVyeVRva2VucyA9IHRoaXMudG9rZW5pemUocXVlcnkpO1xyXG5cdFx0XHRcclxuXHRcdFx0Ly8gUG9saWN5OiBTcGxpdCBieSBkb3VibGUgbmV3bGluZVxyXG5cdFx0XHRjb25zdCBwYXJhZ3JhcGhzID0gY29udGVudC5zcGxpdCgnXFxuXFxuJyk7XHJcblx0XHRcdFxyXG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIGV4Y2VycHQnLCB7XHJcblx0XHRcdFx0cGF0aCxcclxuXHRcdFx0XHRwYXJhZ3JhcGhzOiBwYXJhZ3JhcGhzLmxlbmd0aCxcclxuXHRcdFx0XHRxdWVyeVRva2VuczogcXVlcnlUb2tlbnMuc2xpY2UoMCwgNSksXHJcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdFxyXG5cdFx0XHRpZiAocGFyYWdyYXBocy5sZW5ndGggPT09IDApIHtcclxuXHRcdFx0XHQvLyBGYWxsYmFjayB0byBmaXJzdCA1MDAgY2hhcnNcclxuXHRcdFx0XHRyZXR1cm4gY29udGVudC50cmltKCkuc2xpY2UoMCwgNTAwKSArIChjb250ZW50Lmxlbmd0aCA+IDUwMCA/ICfigKYnIDogJycpO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHQvLyBTY29yZSBlYWNoIHBhcmFncmFwaFxyXG5cdFx0XHRsZXQgYmVzdFBhcmFncmFwaCA9IHBhcmFncmFwaHNbMF07XHJcblx0XHRcdGxldCBiZXN0U2NvcmUgPSAwO1xyXG5cdFx0XHRcclxuXHRcdFx0Zm9yIChjb25zdCBwYXJhZ3JhcGggb2YgcGFyYWdyYXBocykge1xyXG5cdFx0XHRcdGNvbnN0IHBhcmFUb2tlbnMgPSB0aGlzLnRva2VuaXplKHBhcmFncmFwaCk7XHJcblx0XHRcdFx0Y29uc3Qgb3ZlcmxhcCA9IHF1ZXJ5VG9rZW5zLmZpbHRlcih0ID0+IHBhcmFUb2tlbnMuaW5jbHVkZXModCkpLmxlbmd0aDtcclxuXHRcdFx0XHRjb25zdCBzY29yZSA9IHF1ZXJ5VG9rZW5zLmxlbmd0aCA+IDAgPyBvdmVybGFwIC8gcXVlcnlUb2tlbnMubGVuZ3RoIDogMDtcclxuXHRcdFx0XHRcclxuXHRcdFx0XHRpZiAoc2NvcmUgPiBiZXN0U2NvcmUpIHtcclxuXHRcdFx0XHRcdGJlc3RTY29yZSA9IHNjb3JlO1xyXG5cdFx0XHRcdFx0YmVzdFBhcmFncmFwaCA9IHBhcmFncmFwaDtcclxuXHRcdFx0XHR9XHJcblx0XHRcdH1cclxuXHRcdFx0XHJcblx0XHRcdC8vIFRyaW0gdG8gODAwLTEyMDAgY2hhcnMgKHByZWZlciAxMDAwLCBidXQgYWxsb3cgcmFuZ2UpXHJcblx0XHRcdGxldCBleGNlcnB0ID0gYmVzdFBhcmFncmFwaC50cmltKCk7XHJcblx0XHRcdGNvbnN0IHRhcmdldExlbmd0aCA9IDEwMDA7XHJcblx0XHRcdGNvbnN0IG1pbkxlbmd0aCA9IDgwMDtcclxuXHRcdFx0Y29uc3QgbWF4TGVuZ3RoID0gMTIwMDtcclxuXHRcdFx0XHJcblx0XHRcdGlmIChleGNlcnB0Lmxlbmd0aCA+IG1heExlbmd0aCkge1xyXG5cdFx0XHRcdC8vIFRyeSB0byB0cmltIGF0IHNlbnRlbmNlIGJvdW5kYXJ5XHJcblx0XHRcdFx0Y29uc3QgdHJpbW1lZCA9IGV4Y2VycHQuc2xpY2UoMCwgbWF4TGVuZ3RoKTtcclxuXHRcdFx0XHRjb25zdCBsYXN0UGVyaW9kID0gdHJpbW1lZC5sYXN0SW5kZXhPZignLicpO1xyXG5cdFx0XHRcdGlmIChsYXN0UGVyaW9kID4gbWluTGVuZ3RoKSB7XHJcblx0XHRcdFx0XHRleGNlcnB0ID0gdHJpbW1lZC5zbGljZSgwLCBsYXN0UGVyaW9kICsgMSk7XHJcblx0XHRcdFx0fSBlbHNlIHtcclxuXHRcdFx0XHRcdGV4Y2VycHQgPSB0cmltbWVkICsgJ+KApic7XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9IGVsc2UgaWYgKGV4Y2VycHQubGVuZ3RoIDwgbWluTGVuZ3RoICYmIHBhcmFncmFwaHMubGVuZ3RoID4gMSkge1xyXG5cdFx0XHRcdC8vIFRyeSB0byBpbmNsdWRlIG5leHQgcGFyYWdyYXBoIGlmIHRvbyBzaG9ydFxyXG5cdFx0XHRcdGNvbnN0IHBhcmFJbmRleCA9IHBhcmFncmFwaHMuaW5kZXhPZihiZXN0UGFyYWdyYXBoKTtcclxuXHRcdFx0XHRpZiAocGFyYUluZGV4IDwgcGFyYWdyYXBocy5sZW5ndGggLSAxKSB7XHJcblx0XHRcdFx0XHRjb25zdCBjb21iaW5lZCA9IGJlc3RQYXJhZ3JhcGggKyAnXFxuXFxuJyArIHBhcmFncmFwaHNbcGFyYUluZGV4ICsgMV07XHJcblx0XHRcdFx0XHRleGNlcnB0ID0gY29tYmluZWQudHJpbSgpLnNsaWNlKDAsIG1heExlbmd0aCk7XHJcblx0XHRcdFx0XHRpZiAoY29tYmluZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XHJcblx0XHRcdFx0XHRcdGV4Y2VycHQgKz0gJ+KApic7XHJcblx0XHRcdFx0XHR9XHJcblx0XHRcdFx0fVxyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdFeGNlcnB0IGdlbmVyYXRlZCcsIHtcclxuXHRcdFx0XHRwYXRoLFxyXG5cdFx0XHRcdGV4Y2VycHRMZW5ndGg6IGV4Y2VycHQubGVuZ3RoLFxyXG5cdFx0XHRcdGJlc3RTY29yZTogYmVzdFNjb3JlLnRvRml4ZWQoMyksXHJcblx0XHRcdFx0bWV0aG9kOiBiZXN0U2NvcmUgPiAwID8gJ2Jlc3QtbWF0Y2hpbmcnIDogJ2ZpcnN0LXBhcmFncmFwaCcsXHJcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdFxyXG5cdFx0XHRyZXR1cm4gZXhjZXJwdDtcclxuXHRcdFx0XHJcblx0XHR9IGNhdGNoIChlcnJvcikge1xyXG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdGYWlsZWQgdG8gZ2VuZXJhdGUgZXhjZXJwdCcsIHtcclxuXHRcdFx0XHRwYXRoLFxyXG5cdFx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXHJcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdHJldHVybiAnW0Vycm9yIHJlYWRpbmcgZmlsZV0nO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0YXN5bmMgc2VhcmNoKHF1ZXJ5OiBSZXRyaWV2YWxRdWVyeSwgb3B0czogUmV0cmlldmFsT3B0aW9ucyk6IFByb21pc2U8Q29udGV4dEl0ZW1bXT4ge1xyXG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xyXG5cdFx0dGhpcy5jdXJyZW50U2Vzc2lvbklkID0gc2Vzc2lvbklkO1xyXG5cdFx0XHJcblx0XHRjb25zdCBxID0gKHF1ZXJ5LnRleHQgPz8gJycpLnRyaW0oKTtcclxuXHRcdGlmICghcSkge1xyXG5cdFx0XHRyZXR1cm4gW107XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIHNlYXJjaCcsIHtcclxuXHRcdFx0cXVlcnk6IHEsXHJcblx0XHRcdGxpbWl0OiBvcHRzLmxpbWl0LFxyXG5cdFx0XHRzZXNzaW9uSWRcclxuXHRcdH0pO1xyXG5cdFx0XHJcblx0XHQvLyBDaGVjayBpZiBjYWNoZSBpcyBlbmFibGVkXHJcblx0XHRjb25zdCBlbmFibGVkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlRW5hYmxlZCA/PyBmYWxzZTtcclxuXHRcdGlmICghZW5hYmxlZCkge1xyXG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdDYWNoZSBkaXNhYmxlZCwgcmV0dXJuaW5nIGVtcHR5Jywge1xyXG5cdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHR9KTtcclxuXHRcdFx0cmV0dXJuIFtdO1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHQvLyBHZXQgY2FjaGVcclxuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy5nZXRDYWNoZSgpO1xyXG5cdFx0aWYgKCFjYWNoZSkge1xyXG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdObyBjYWNoZSBhdmFpbGFibGUsIHJldHVybmluZyBlbXB0eScsIHtcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdHJldHVybiBbXTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Ly8gQ2hlY2sgY2FjaGUgZnJlc2huZXNzXHJcblx0XHRpZiAoIXRoaXMuaXNDYWNoZUZyZXNoKGNhY2hlKSkge1xyXG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBleHBpcmVkLCByZXR1cm5pbmcgZW1wdHknLCB7XHJcblx0XHRcdFx0c2Vzc2lvbklkXHJcblx0XHRcdH0pO1xyXG5cdFx0XHRyZXR1cm4gW107XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIENoZWNrIGtleWluZyBtYXRjaFxyXG5cdFx0Y29uc3QgY3VycmVudE5vdGVQYXRoID0gcXVlcnkuYWN0aXZlRmlsZVBhdGg7XHJcblx0XHRjb25zdCBrZXlpbmdDaGVjayA9IHRoaXMuY2hlY2tDYWNoZUtleWluZyhjYWNoZSwgY3VycmVudE5vdGVQYXRoKTtcclxuXHRcdGNvbnN0IGtleWluZ01vZGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zS2V5aW5nTW9kZSB8fCAnc29mdCc7XHJcblx0XHRcclxuXHRcdGlmICgha2V5aW5nQ2hlY2subWF0Y2ggJiYga2V5aW5nTW9kZSA9PT0gJ3N0cmljdCcpIHtcclxuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnQ2FjaGUga2V5aW5nIG1pc21hdGNoIGluIHN0cmljdCBtb2RlLCByZXR1cm5pbmcgZW1wdHknLCB7XHJcblx0XHRcdFx0Y3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCxcclxuXHRcdFx0XHRjYWNoZU5vdGU6IGtleWluZ0NoZWNrLmNhY2hlTm90ZSxcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHRcdHJldHVybiBbXTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0aWYgKCFrZXlpbmdDaGVjay5tYXRjaCkge1xyXG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2ggaW4gc29mdCBtb2RlLCBhbGxvd2luZyB1c2UnLCB7XHJcblx0XHRcdFx0Y3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCxcclxuXHRcdFx0XHRjYWNoZU5vdGU6IGtleWluZ0NoZWNrLmNhY2hlTm90ZSxcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIFZhbGlkYXRlIGFuZCBjbGVhbiBjYWNoZSAoaW4tbWVtb3J5IG9ubHkpXHJcblx0XHRjb25zdCB7IGNhY2hlOiBjbGVhbmVkQ2FjaGUsIHdhc01vZGlmaWVkIH0gPSB0aGlzLnZhbGlkYXRlQW5kQ2xlYW5DYWNoZShjYWNoZSk7XHJcblx0XHRcclxuXHRcdC8vIFNjb3JlIHdpdGggbWV0YWRhdGEgZmlyc3QgKGZhc3QpXHJcblx0XHRjb25zdCB0b3BJdGVtcyA9IGF3YWl0IHRoaXMuc2NvcmVDYWNoZWRJdGVtc1dpdGhNZXRhZGF0YShjbGVhbmVkQ2FjaGUsIHEsIG9wdHMubGltaXQpO1xyXG5cdFx0XHJcblx0XHQvLyBMb2FkIGZ1bGwgY29udGVudCBmb3IgdG9wIE4gYW5kIHJlLXNjb3JlXHJcblx0XHRjb25zdCByZXNjb3JlZEl0ZW1zID0gYXdhaXQgdGhpcy5sb2FkQW5kU2NvcmVUb3BJdGVtcyh0b3BJdGVtcywgcSk7XHJcblx0XHRcclxuXHRcdC8vIEdlbmVyYXRlIGV4Y2VycHRzIHdpdGggY29udGV4dCBjYXBcclxuXHRcdGNvbnN0IHJlc3VsdHM6IENvbnRleHRJdGVtW10gPSBbXTtcclxuXHRcdGNvbnN0IG1heENvbnRleHRDaGFycyA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNNYXhDb250ZXh0Q2hhcnMgPz8gMzAwMDA7XHJcblx0XHRsZXQgdG90YWxDb250ZXh0Q2hhcnMgPSAwO1xyXG5cdFx0bGV0IHRydW5jYXRlZENvdW50ID0gMDtcclxuXHRcdFxyXG5cdFx0Zm9yIChjb25zdCBpdGVtIG9mIHJlc2NvcmVkSXRlbXMpIHtcclxuXHRcdFx0aWYgKHJlc3VsdHMubGVuZ3RoID49IG9wdHMubGltaXQpIHtcclxuXHRcdFx0XHRicmVhaztcclxuXHRcdFx0fVxyXG5cdFx0XHRcclxuXHRcdFx0Ly8gQ2hlY2sgY29udGV4dCBjYXBcclxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGF3YWl0IHRoaXMuZ2VuZXJhdGVCZXN0TWF0Y2hpbmdFeGNlcnB0KGl0ZW0ucGF0aCwgcSk7XHJcblx0XHRcdGxldCBmaW5hbEV4Y2VycHQgPSBleGNlcnB0O1xyXG5cdFx0XHRcclxuXHRcdFx0aWYgKHRvdGFsQ29udGV4dENoYXJzICsgZXhjZXJwdC5sZW5ndGggPiBtYXhDb250ZXh0Q2hhcnMpIHtcclxuXHRcdFx0XHQvLyBQb2xpY3k6IHRydW5jYXRlIGN1cnJlbnQgZXhjZXJwdCB0byBmaXRcclxuXHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBtYXhDb250ZXh0Q2hhcnMgLSB0b3RhbENvbnRleHRDaGFycztcclxuXHRcdFx0XHRmaW5hbEV4Y2VycHQgPSBleGNlcnB0LnNsaWNlKDAsIHJlbWFpbmluZykgKyAn4oCmJztcclxuXHRcdFx0XHR0cnVuY2F0ZWRDb3VudCsrO1xyXG5cdFx0XHRcdFxyXG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NvbnRleHQgY2FwIHJlYWNoZWQsIHRydW5jYXRpbmcgZXhjZXJwdCcsIHtcclxuXHRcdFx0XHRcdHRvdGFsQ2hhcnM6IHRvdGFsQ29udGV4dENoYXJzICsgZmluYWxFeGNlcnB0Lmxlbmd0aCxcclxuXHRcdFx0XHRcdHJlbWFpbmluZyxcclxuXHRcdFx0XHRcdHRydW5jYXRlZDogdHJ1ZSxcclxuXHRcdFx0XHRcdHNlc3Npb25JZFxyXG5cdFx0XHRcdH0pO1xyXG5cdFx0XHR9XHJcblx0XHRcdFxyXG5cdFx0XHR0b3RhbENvbnRleHRDaGFycyArPSBmaW5hbEV4Y2VycHQubGVuZ3RoO1xyXG5cdFx0XHRcclxuXHRcdFx0cmVzdWx0cy5wdXNoKHtcclxuXHRcdFx0XHRrZXk6IGl0ZW0ucGF0aCxcclxuXHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXHJcblx0XHRcdFx0dGl0bGU6IGl0ZW0ucGF0aC5zcGxpdCgnLycpLnBvcCgpIHx8IGl0ZW0ucGF0aCxcclxuXHRcdFx0XHRleGNlcnB0OiBmaW5hbEV4Y2VycHQsXHJcblx0XHRcdFx0c2NvcmU6IGl0ZW0uZmluYWxTY29yZSxcclxuXHRcdFx0XHRzb3VyY2U6IHRoaXMuaWQsXHJcblx0XHRcdFx0cmVhc29uVGFnczogWydzbWFydC1jb25uZWN0aW9ucy1jYWNoZWQnXVxyXG5cdFx0XHR9KTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0aWYgKHRydW5jYXRlZENvdW50ID4gMCkge1xyXG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdDb250ZXh0IGNhcCBzdW1tYXJ5Jywge1xyXG5cdFx0XHRcdHRvdGFsQ2hhcnM6IHRvdGFsQ29udGV4dENoYXJzLFxyXG5cdFx0XHRcdG1heENoYXJzOiBtYXhDb250ZXh0Q2hhcnMsXHJcblx0XHRcdFx0dHJ1bmNhdGVkOiB0cnVuY2F0ZWRDb3VudCxcclxuXHRcdFx0XHRzZXNzaW9uSWRcclxuXHRcdFx0fSk7XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdC8vIFNhdmUgY2FjaGUgaWYgbW9kaWZpZWQgKHNpbmdsZSB3cml0ZWJhY2spXHJcblx0XHRpZiAod2FzTW9kaWZpZWQpIHtcclxuXHRcdFx0YXdhaXQgdGhpcy5zYXZlQ2FjaGUoY2xlYW5lZENhY2hlKTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU2VhcmNoIGNvbXBsZXRlJywge1xyXG5cdFx0XHRyZXN1bHRzOiByZXN1bHRzLmxlbmd0aCxcclxuXHRcdFx0bWV0aG9kOiAnY2FjaGVkJyxcclxuXHRcdFx0c2Vzc2lvbklkXHJcblx0XHR9KTtcclxuXHRcdFxyXG5cdFx0cmV0dXJuIHJlc3VsdHM7XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGNhcHR1cmUgZnJvbSBET00gYW5kIHNhdmUgdG8gY2FjaGUuXHJcblx0ICovXHJcblx0YXN5bmMgY2FwdHVyZUFuZFNhdmVGcm9tRG9tKHNvdXJjZU5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTx7IHN1Y2Nlc3M6IGJvb2xlYW47IGNvdW50OiBudW1iZXI7IG1lc3NhZ2U/OiBzdHJpbmcgfT4ge1xyXG5cdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IHRoaXMuY2FwdHVyZUZyb21Eb20oc291cmNlTm90ZVBhdGgpO1xyXG5cdFx0XHJcblx0XHRpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHtcclxuXHRcdFx0cmV0dXJuIHtcclxuXHRcdFx0XHRzdWNjZXNzOiBmYWxzZSxcclxuXHRcdFx0XHRjb3VudDogMCxcclxuXHRcdFx0XHRtZXNzYWdlOiAnU21hcnQgQ29ubmVjdGlvbnMgdmlldyBpcyBvcGVuIGJ1dCBubyByZXN1bHRzIGZvdW5kLiBUcnkgcnVubmluZyBhIHNlYXJjaCBpbiBTbWFydCBDb25uZWN0aW9ucyBmaXJzdC4nXHJcblx0XHRcdH07XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnN0IHZhdWx0SWQgPSB0aGlzLmdldFZhdWx0SWQoKTtcclxuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcclxuXHRcdFxyXG5cdFx0Y29uc3QgY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSA9IHtcclxuXHRcdFx0c291cmNlTm90ZVBhdGgsXHJcblx0XHRcdHZhdWx0SWQsXHJcblx0XHRcdHJlc3VsdHM6IHJlc3VsdHMubWFwKChyLCBpKSA9PiAoe1xyXG5cdFx0XHRcdHBhdGg6IHIucGF0aCxcclxuXHRcdFx0XHRzY29yZTogci5zY29yZSxcclxuXHRcdFx0XHRjYXB0dXJlZEF0OiBEYXRlLm5vdygpXHJcblx0XHRcdH0pKSxcclxuXHRcdFx0Y2FwdHVyZWRBdDogRGF0ZS5ub3coKSxcclxuXHRcdFx0bWV0aG9kOiAnZG9tJyxcclxuXHRcdFx0c2Vzc2lvbklkXHJcblx0XHR9O1xyXG5cdFx0XHJcblx0XHRhd2FpdCB0aGlzLnNhdmVDYWNoZShjYWNoZSk7XHJcblx0XHRcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXHJcblx0XHRcdGNvdW50OiByZXN1bHRzLmxlbmd0aFxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIFB1YmxpYyBtZXRob2QgdG8gY2FwdHVyZSBmcm9tIGNsaXBib2FyZCBhbmQgc2F2ZSB0byBjYWNoZS5cclxuXHQgKi9cclxuXHRhc3luYyBjYXB0dXJlQW5kU2F2ZUZyb21DbGlwYm9hcmQoc291cmNlTm90ZVBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPHsgc3VjY2VzczogYm9vbGVhbjsgY291bnQ6IG51bWJlcjsgbWVzc2FnZT86IHN0cmluZyB9PiB7XHJcblx0XHRjb25zdCByZXN1bHRzID0gYXdhaXQgdGhpcy5jYXB0dXJlRnJvbUNsaXBib2FyZChzb3VyY2VOb3RlUGF0aCk7XHJcblx0XHRcclxuXHRcdGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xyXG5cdFx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxyXG5cdFx0XHRcdGNvdW50OiAwLFxyXG5cdFx0XHRcdG1lc3NhZ2U6ICdObyB2YWxpZCBsaW5rcyBmb3VuZCBpbiBjbGlwYm9hcmQuIEVuc3VyZSBjbGlwYm9hcmQgY29udGFpbnMgU21hcnQgQ29ubmVjdGlvbnMgcmVzdWx0cyB3aXRoIG1hcmtkb3duIGxpbmtzLidcclxuXHRcdFx0fTtcclxuXHRcdH1cclxuXHRcdFxyXG5cdFx0Y29uc3QgdmF1bHRJZCA9IHRoaXMuZ2V0VmF1bHRJZCgpO1xyXG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xyXG5cdFx0XHJcblx0XHRjb25zdCBjYWNoZTogU21hcnRDb25uZWN0aW9uc0NhY2hlID0ge1xyXG5cdFx0XHRzb3VyY2VOb3RlUGF0aCxcclxuXHRcdFx0dmF1bHRJZCxcclxuXHRcdFx0cmVzdWx0czogcmVzdWx0cy5tYXAoKHIsIGkpID0+ICh7XHJcblx0XHRcdFx0cGF0aDogci5wYXRoLFxyXG5cdFx0XHRcdHNjb3JlOiByLnNjb3JlLFxyXG5cdFx0XHRcdGNhcHR1cmVkQXQ6IERhdGUubm93KClcclxuXHRcdFx0fSkpLFxyXG5cdFx0XHRjYXB0dXJlZEF0OiBEYXRlLm5vdygpLFxyXG5cdFx0XHRtZXRob2Q6ICdjbGlwYm9hcmQnLFxyXG5cdFx0XHRzZXNzaW9uSWRcclxuXHRcdH07XHJcblx0XHRcclxuXHRcdGF3YWl0IHRoaXMuc2F2ZUNhY2hlKGNhY2hlKTtcclxuXHRcdFxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0c3VjY2VzczogdHJ1ZSxcclxuXHRcdFx0Y291bnQ6IHJlc3VsdHMubGVuZ3RoXHJcblx0XHR9O1xyXG5cdH1cclxuXHJcblx0LyoqXHJcblx0ICogUHVibGljIG1ldGhvZCB0byBjbGVhciBjYWNoZS5cclxuXHQgKi9cclxuXHRhc3luYyBjbGVhckNhY2hlKCk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlID0gdW5kZWZpbmVkO1xyXG5cdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XHJcblx0XHRcclxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ0NhY2hlIGNsZWFyZWQnLCB7XHJcblx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIFB1YmxpYyBtZXRob2QgdG8gZ2V0IGNhY2hlIHN0YXR1cy5cclxuXHQgKi9cclxuXHRnZXRDYWNoZVN0YXR1cygpOiB7XHJcblx0XHRleGlzdHM6IGJvb2xlYW47XHJcblx0XHRlbmFibGVkOiBib29sZWFuO1xyXG5cdFx0Y291bnQ6IG51bWJlcjtcclxuXHRcdGFnZT86IHN0cmluZztcclxuXHRcdG1ldGhvZD86ICdkb20nIHwgJ2NsaXBib2FyZCc7XHJcblx0XHRzb3VyY2VOb3RlPzogc3RyaW5nO1xyXG5cdFx0ZnJlc2g6IGJvb2xlYW47XHJcblx0fSB7XHJcblx0XHRjb25zdCBlbmFibGVkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlRW5hYmxlZCA/PyBmYWxzZTtcclxuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy5nZXRDYWNoZSgpO1xyXG5cdFx0XHJcblx0XHRpZiAoIWNhY2hlKSB7XHJcblx0XHRcdHJldHVybiB7XHJcblx0XHRcdFx0ZXhpc3RzOiBmYWxzZSxcclxuXHRcdFx0XHRlbmFibGVkLFxyXG5cdFx0XHRcdGNvdW50OiAwLFxyXG5cdFx0XHRcdGZyZXNoOiBmYWxzZVxyXG5cdFx0XHR9O1xyXG5cdFx0fVxyXG5cdFx0XHJcblx0XHRjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gY2FjaGUuY2FwdHVyZWRBdDtcclxuXHRcdGNvbnN0IGFnZUhvdXJzID0gTWF0aC5mbG9vcihhZ2UgLyAoMTAwMCAqIDYwICogNjApKTtcclxuXHRcdGNvbnN0IGFnZU1pbnV0ZXMgPSBNYXRoLmZsb29yKChhZ2UgJSAoMTAwMCAqIDYwICogNjApKSAvICgxMDAwICogNjApKTtcclxuXHRcdGNvbnN0IGFnZVN0ciA9IGFnZUhvdXJzID4gMCA/IGAke2FnZUhvdXJzfWggJHthZ2VNaW51dGVzfW1gIDogYCR7YWdlTWludXRlc31tYDtcclxuXHRcdFxyXG5cdFx0cmV0dXJuIHtcclxuXHRcdFx0ZXhpc3RzOiB0cnVlLFxyXG5cdFx0XHRlbmFibGVkLFxyXG5cdFx0XHRjb3VudDogY2FjaGUucmVzdWx0cy5sZW5ndGgsXHJcblx0XHRcdGFnZTogYWdlU3RyLFxyXG5cdFx0XHRtZXRob2Q6IGNhY2hlLm1ldGhvZCxcclxuXHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXHJcblx0XHRcdGZyZXNoOiB0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSlcclxuXHRcdH07XHJcblx0fVxyXG5cclxuXHQvKipcclxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGNoZWNrIGlmIFNtYXJ0IENvbm5lY3Rpb25zIHZpZXcgaXMgYXZhaWxhYmxlIGZvciBjYXB0dXJlLlxyXG5cdCAqL1xyXG5cdGNoZWNrVmlld0F2YWlsYWJsZSgpOiB7IGF2YWlsYWJsZTogYm9vbGVhbjsgbWVzc2FnZT86IHN0cmluZyB9IHtcclxuXHRcdGNvbnN0IHNjVmlldyA9IHRoaXMuZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk7XHJcblx0XHRpZiAoIXNjVmlldykge1xyXG5cdFx0XHRyZXR1cm4ge1xyXG5cdFx0XHRcdGF2YWlsYWJsZTogZmFsc2UsXHJcblx0XHRcdFx0bWVzc2FnZTogJ1NtYXJ0IENvbm5lY3Rpb25zIHZpZXcgbm90IGZvdW5kLiBPcGVuIFNtYXJ0IENvbm5lY3Rpb25zIGluIGEgcGFuZSBmaXJzdC4nXHJcblx0XHRcdH07XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdGNvbnN0IGludGVybmFsTGlua3MgPSBzY1ZpZXcudmlldy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yQWxsKCdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScpO1xyXG5cdFx0aWYgKGludGVybmFsTGlua3MubGVuZ3RoID09PSAwKSB7XHJcblx0XHRcdHJldHVybiB7XHJcblx0XHRcdFx0YXZhaWxhYmxlOiBmYWxzZSxcclxuXHRcdFx0XHRtZXNzYWdlOiAnU21hcnQgQ29ubmVjdGlvbnMgdmlldyBpcyBvcGVuIGJ1dCBubyByZXN1bHRzIGZvdW5kLiBUcnkgcnVubmluZyBhIHNlYXJjaCBpbiBTbWFydCBDb25uZWN0aW9ucyBmaXJzdC4nXHJcblx0XHRcdH07XHJcblx0XHR9XHJcblx0XHRcclxuXHRcdHJldHVybiB7XHJcblx0XHRcdGF2YWlsYWJsZTogdHJ1ZVxyXG5cdFx0fTtcclxuXHR9XHJcblxyXG5cdC8qKlxyXG5cdCAqIEdldCBjYWNoZWQgZmlsZSBwYXRocyBkaXJlY3RseSAobm8gc2VhcmNoLCBubyBBUEkgY2FsbHMpLlxyXG5cdCAqIFVzZWQgZm9yIHB1cmUgYm9vc3QvZmlsdGVyIG9wZXJhdGlvbnMgaW4gaHlicmlkIHJldHJpZXZhbC5cclxuXHQgKi9cclxuXHRhc3luYyBnZXRDYWNoZVBhdGhzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcclxuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy5nZXRDYWNoZSgpO1xyXG5cdFx0aWYgKCFjYWNoZSkgcmV0dXJuIFtdO1xyXG5cdFx0XHJcblx0XHRjb25zdCBlbmFibGVkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlRW5hYmxlZCA/PyBmYWxzZTtcclxuXHRcdGlmICghZW5hYmxlZCkgcmV0dXJuIFtdO1xyXG5cdFx0XHJcblx0XHQvLyBDaGVjayBmcmVzaG5lc3NcclxuXHRcdGlmICghdGhpcy5pc0NhY2hlRnJlc2goY2FjaGUpKSByZXR1cm4gW107XHJcblx0XHRcclxuXHRcdC8vIFJldHVybiBqdXN0IHRoZSBwYXRocyAtIG5vIHNjb3JpbmcsIG5vIEFQSSBjYWxsc1xyXG5cdFx0cmV0dXJuIGNhY2hlLnJlc3VsdHMubWFwKHIgPT4gci5wYXRoKTtcclxuXHR9XHJcbn1cclxuIl19