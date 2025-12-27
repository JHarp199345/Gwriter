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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUVBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFnQ2pDOzs7R0FHRztBQUNILE1BQU0sT0FBTyx3QkFBd0I7SUFTcEMsWUFDQyxHQUFRLEVBQ1IsTUFBOEIsRUFDOUIsS0FBWSxFQUNaLGFBQXdDO1FBWmhDLE9BQUUsR0FBRyxtQkFBbUIsQ0FBQztRQU0xQixxQkFBZ0IsR0FBVyxFQUFFLENBQUM7UUFRckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7UUFDZixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsYUFBYSxHQUFHLGFBQWEsQ0FBQztRQUNuQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUMxQixDQUFDO0lBRUQ7O09BRUc7SUFDSyxpQkFBaUI7UUFDeEIsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDbkQsQ0FBQztJQUVEOztPQUVHO0lBQ0ssaUJBQWlCO1FBQ3hCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUNsRCxDQUFDO0lBRUQ7O09BRUc7SUFDSyxHQUFHLENBQUMsS0FBZ0MsRUFBRSxPQUFlLEVBQUUsT0FBaUMsRUFBRSxPQUFpQztRQUNsSSxNQUFNLFNBQVMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzNDLE1BQU0sVUFBVSxHQUFHLElBQUksS0FB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QUs7Z0JBQ2hCLE9BQU8sRUFBRSx1R0FBdUc7YUFDaEgsQ0FBQztRQUNILENBQUM7UUFFRCxPQUFPO1lBQ04sU0FBUyxFQUFFLElBQUk7U0FDZixDQUFDO0lBQ0gsQ0FBQztJQUVEOzs7T0FHRztJQUNILEtBQUssQ0FBQyxhQUFhO1FBQ2xCLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUM5QixJQUFJLENBQUMsS0FBSztZQUFFLE9BQU8sRUFBRSxDQUFDO1FBRXRCLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLDRCQUE0QixJQUFJLEtBQUssQ0FBQztRQUMzRSxJQUFJLENBQUMsT0FBTztZQUFFLE9BQU8sRUFBRSxDQUFDO1FBRXhCLGtCQUFrQjtRQUNsQixJQUFJLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUM7WUFBRSxPQUFPLEVBQUUsQ0FBQztRQUV6QyxtREFBbUQ7UUFDbkQsT0FBTyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN2QyxDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgdHlwZSB7IENvbnRleHRJdGVtLCBSZXRyaWV2YWxPcHRpb25zLCBSZXRyaWV2YWxQcm92aWRlciwgUmV0cmlldmFsUXVlcnkgfSBmcm9tICcuL3R5cGVzJztcbmltcG9ydCB0eXBlIHsgQXBwLCBWYXVsdCwgV29ya3NwYWNlTGVhZiB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCB7IFRGaWxlIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZnJvbSAnLi4vLi4vbWFpbic7XG5cbi8qKlxuICogU21hcnQgQ29ubmVjdGlvbnMgY2FjaGUgc3RydWN0dXJlLlxuICovXG5pbnRlcmZhY2UgU21hcnRDb25uZWN0aW9uc0NhY2hlIHtcblx0c291cmNlTm90ZVBhdGg/OiBzdHJpbmc7XG5cdHZhdWx0SWQ/OiBzdHJpbmc7XG5cdHJlc3VsdHM6IEFycmF5PHtcblx0XHRwYXRoOiBzdHJpbmc7XG5cdFx0c2NvcmU/OiBudW1iZXI7XG5cdFx0Y2FwdHVyZWRTbmlwcGV0Pzogc3RyaW5nO1xuXHRcdGNhcHR1cmVkQXQ/OiBudW1iZXI7XG5cdH0+O1xuXHRjYXB0dXJlZEF0OiBudW1iZXI7XG5cdG1ldGhvZDogJ2RvbScgfCAnY2xpcGJvYXJkJztcblx0c2Vzc2lvbklkOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ2FjaGVkIHJlc3VsdCBpdGVtIHdpdGggc2NvcmluZyBpbmZvcm1hdGlvbi5cbiAqL1xuaW50ZXJmYWNlIFNjb3JlZENhY2hlSXRlbSB7XG5cdHBhdGg6IHN0cmluZztcblx0cmFua1Njb3JlOiBudW1iZXI7XG5cdG1ldGFkYXRhU2NvcmU6IG51bWJlcjtcblx0ZnVsbENvbnRlbnRTY29yZT86IG51bWJlcjtcblx0ZmluYWxTY29yZTogbnVtYmVyO1xuXHRjYXB0dXJlZEF0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJldHJpZXZhbCBwcm92aWRlciB0aGF0IHVzZXMgU21hcnQgQ29ubmVjdGlvbnMgcGx1Z2luIHZpYSBjYXB0dXJlIGFuZCBjYWNoZSBzeXN0ZW0uXG4gKiBDYXB0dXJlcyByZXN1bHRzIGZyb20gRE9NIG9yIGNsaXBib2FyZCwgY2FjaGVzIHRoZW0sIGFuZCB1c2VzIGNhY2hlZCBkYXRhIGZvciByZXRyaWV2YWwuXG4gKi9cbmV4cG9ydCBjbGFzcyBTbWFydENvbm5lY3Rpb25zUHJvdmlkZXIgaW1wbGVtZW50cyBSZXRyaWV2YWxQcm92aWRlciB7XG5cdHJlYWRvbmx5IGlkID0gJ3NtYXJ0LWNvbm5lY3Rpb25zJztcblxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBhcHA6IEFwcDtcblx0cHJpdmF0ZSByZWFkb25seSBwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW47XG5cdHByaXZhdGUgcmVhZG9ubHkgaXNBbGxvd2VkUGF0aDogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbjtcblx0cHJpdmF0ZSBjdXJyZW50U2Vzc2lvbklkOiBzdHJpbmcgPSAnJztcblxuXHRjb25zdHJ1Y3Rvcihcblx0XHRhcHA6IEFwcCxcblx0XHRwbHVnaW46IFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4sXG5cdFx0dmF1bHQ6IFZhdWx0LFxuXHRcdGlzQWxsb3dlZFBhdGg6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW5cblx0KSB7XG5cdFx0dGhpcy5hcHAgPSBhcHA7XG5cdFx0dGhpcy5wbHVnaW4gPSBwbHVnaW47XG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xuXHRcdHRoaXMuaXNBbGxvd2VkUGF0aCA9IGlzQWxsb3dlZFBhdGg7XG5cdFx0dGhpcy5pbml0aWFsaXplU2Vzc2lvbigpO1xuXHRcdHRoaXMubG9nSW5pdGlhbGl6YXRpb24oKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZW5lcmF0ZSBhIG5ldyBzZXNzaW9uIElEIGZvciBsb2dnaW5nIGdyb3VwaW5nLlxuXHQgKi9cblx0cHJpdmF0ZSBnZW5lcmF0ZVNlc3Npb25JZCgpOiBzdHJpbmcge1xuXHRcdHJldHVybiBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoMiwgOCk7XG5cdH1cblxuXHQvKipcblx0ICogSW5pdGlhbGl6ZSBzZXNzaW9uIElEIGZvciB0aGlzIGluc3RhbmNlLlxuXHQgKi9cblx0cHJpdmF0ZSBpbml0aWFsaXplU2Vzc2lvbigpOiB2b2lkIHtcblx0XHR0aGlzLmN1cnJlbnRTZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XG5cdH1cblxuXHQvKipcblx0ICogU3RydWN0dXJlZCBsb2dnaW5nIGhlbHBlciB3aXRoIHNlc3Npb24gSUQgc3VwcG9ydC5cblx0ICovXG5cdHByaXZhdGUgbG9nKGxldmVsOiAnaW5mbycgfCAnd2FybicgfCAnZXJyb3InLCBtZXNzYWdlOiBzdHJpbmcsIGNvbnRleHQ/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgZGV0YWlscz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogdm9pZCB7XG5cdFx0Y29uc3QgdGltZXN0YW1wID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xuXHRcdGNvbnN0IG1ldGhvZE5hbWUgPSBuZXcgRXJyb3IoKS5zdGFjaz8uc3BsaXQoJ1xcbicpWzJdPy5tYXRjaCgvYXQgXFx3K1xcLihcXHcrKS8pPy5bMV0gfHwgJ3Vua25vd24nO1xuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuY3VycmVudFNlc3Npb25JZDtcblx0XHRcblx0XHRjb25zdCBjb250ZXh0U3RyID0gY29udGV4dCA/IGAgfCBDb250ZXh0OiAke0pTT04uc3RyaW5naWZ5KGNvbnRleHQpfWAgOiAnJztcblx0XHRjb25zdCBkZXRhaWxzU3RyID0gZGV0YWlscyA/IGAgfCBEZXRhaWxzOiAke0pTT04uc3RyaW5naWZ5KGRldGFpbHMpfWAgOiAnJztcblx0XHRcblx0XHRjb25zdCBsb2dNZXNzYWdlID0gYFtTbWFydENvbm5lY3Rpb25zUHJvdmlkZXI6JHttZXRob2ROYW1lfV1bc2lkPSR7c2Vzc2lvbklkfV0gJHtsZXZlbC50b1VwcGVyQ2FzZSgpfTogJHttZXNzYWdlfSR7Y29udGV4dFN0cn0ke2RldGFpbHNTdHJ9YDtcblx0XHRcblx0XHRpZiAobGV2ZWwgPT09ICdlcnJvcicpIHtcblx0XHRcdGNvbnNvbGUuZXJyb3IobG9nTWVzc2FnZSk7XG5cdFx0fSBlbHNlIGlmIChsZXZlbCA9PT0gJ3dhcm4nKSB7XG5cdFx0XHRjb25zb2xlLndhcm4obG9nTWVzc2FnZSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnNvbGUuZGVidWcobG9nTWVzc2FnZSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIExvZyBpbml0aWFsaXphdGlvbiBzdGF0dXMuXG5cdCAqL1xuXHRwcml2YXRlIGxvZ0luaXRpYWxpemF0aW9uKCk6IHZvaWQge1xuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlO1xuXHRcdGNvbnN0IGVuYWJsZWQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVFbmFibGVkID8/IGZhbHNlO1xuXHRcdFxuXHRcdGlmIChjYWNoZSkge1xuXHRcdFx0Y29uc3QgYWdlID0gRGF0ZS5ub3coKSAtIGNhY2hlLmNhcHR1cmVkQXQ7XG5cdFx0XHRjb25zdCBhZ2VIb3VycyA9IE1hdGguZmxvb3IoYWdlIC8gKDEwMDAgKiA2MCAqIDYwKSk7XG5cdFx0XHRjb25zdCBhZ2VNaW51dGVzID0gTWF0aC5mbG9vcigoYWdlICUgKDEwMDAgKiA2MCAqIDYwKSkgLyAoMTAwMCAqIDYwKSk7XG5cdFx0XHRjb25zdCBhZ2VTdHIgPSBhZ2VIb3VycyA+IDAgPyBgJHthZ2VIb3Vyc31oICR7YWdlTWludXRlc31tYCA6IGAke2FnZU1pbnV0ZXN9bWA7XG5cdFx0XHRcblx0XHRcdGNvbnN0IGlzRnJlc2ggPSB0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSk7XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0luaXRpYWxpemF0aW9uIGNvbXBsZXRlJywge1xuXHRcdFx0XHRjYWNoZUVuYWJsZWQ6IGVuYWJsZWQsXG5cdFx0XHRcdGNhY2hlRXhpc3RzOiB0cnVlLFxuXHRcdFx0XHRjYWNoZUFnZTogYWdlU3RyLFxuXHRcdFx0XHRjYWNoZVJlc3VsdHM6IGNhY2hlLnJlc3VsdHMubGVuZ3RoLFxuXHRcdFx0XHRjYWNoZU1ldGhvZDogY2FjaGUubWV0aG9kLFxuXHRcdFx0XHRjYWNoZUZyZXNoOiBpc0ZyZXNoLFxuXHRcdFx0XHRzb3VyY2VOb3RlOiBjYWNoZS5zb3VyY2VOb3RlUGF0aCxcblx0XHRcdFx0dmF1bHRJZDogY2FjaGUudmF1bHRJZFxuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0luaXRpYWxpemF0aW9uIGNvbXBsZXRlJywge1xuXHRcdFx0XHRjYWNoZUVuYWJsZWQ6IGVuYWJsZWQsXG5cdFx0XHRcdGNhY2hlRXhpc3RzOiBmYWxzZVxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB2YXVsdCBJRCAobmFtZSArIG9wdGlvbmFsIGJhc2VQYXRoKS5cblx0ICovXG5cdHByaXZhdGUgZ2V0VmF1bHRJZCgpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHZhdWx0TmFtZSA9IHRoaXMuYXBwLnZhdWx0LmdldE5hbWUoKTtcblx0XHRjb25zdCBhZGFwdGVyID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlciBhcyB7IGJhc2VQYXRoPzogc3RyaW5nIH07XG5cdFx0Y29uc3QgYmFzZVBhdGggPSBhZGFwdGVyLmJhc2VQYXRoIHx8ICcnO1xuXHRcdGNvbnN0IHZhdWx0SWQgPSB2YXVsdE5hbWUgKyAoYmFzZVBhdGggPyBgOiR7YmFzZVBhdGh9YCA6ICcnKTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdWYXVsdCBJRCBnZW5lcmF0ZWQnLCB7XG5cdFx0XHR2YXVsdE5hbWUsXG5cdFx0XHRiYXNlUGF0aDogYmFzZVBhdGggfHwgJyhub3QgYXZhaWxhYmxlKScsXG5cdFx0XHR2YXVsdElkXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIHZhdWx0SWQ7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgY2FjaGUgaXMgZnJlc2ggKHdpdGhpbiBUVEwgaWYgc2V0KS5cblx0ICovXG5cdHByaXZhdGUgaXNDYWNoZUZyZXNoKGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUpOiBib29sZWFuIHtcblx0XHRjb25zdCB0dGwgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVUVEw7XG5cdFx0aWYgKCF0dGwpIHtcblx0XHRcdHJldHVybiB0cnVlOyAvLyBObyBUVEwsIGFsd2F5cyBmcmVzaFxuXHRcdH1cblx0XHRcblx0XHRjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gY2FjaGUuY2FwdHVyZWRBdDtcblx0XHRjb25zdCB0dGxNcyA9IHR0bCAqIDYwICogNjAgKiAxMDAwO1xuXHRcdGNvbnN0IGZyZXNoID0gYWdlIDwgdHRsTXM7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgZnJlc2huZXNzIGNoZWNrJywge1xuXHRcdFx0YWdlOiBgJHtNYXRoLmZsb29yKGFnZSAvICgxMDAwICogNjAgKiA2MCkpfWhgLFxuXHRcdFx0dHRsOiBgJHt0dGx9aGAsXG5cdFx0XHRmcmVzaFxuXHRcdH0pO1xuXHRcdFxuXHRcdHJldHVybiBmcmVzaDtcblx0fVxuXG5cdC8qKlxuXHQgKiBOb3JtYWxpemUgZm9sZGVyIHBhdGggZm9yIGNvbXBhcmlzb24gKHJlbW92ZSBsZWFkaW5nIHNsYXNoLCBlbnN1cmUgdHJhaWxpbmcgc2xhc2gpLlxuXHQgKi9cblx0cHJpdmF0ZSBub3JtYWxpemVGb2xkZXJQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0bGV0IG5vcm1hbGl6ZWQgPSBwYXRoLnJlcGxhY2UoL15cXC8rLywgJycpOyAvLyBSZW1vdmUgbGVhZGluZyBzbGFzaGVzXG5cdFx0aWYgKG5vcm1hbGl6ZWQgJiYgIW5vcm1hbGl6ZWQuZW5kc1dpdGgoJy8nKSkge1xuXHRcdFx0bm9ybWFsaXplZCArPSAnLyc7IC8vIEVuc3VyZSB0cmFpbGluZyBzbGFzaFxuXHRcdH1cblx0XHRyZXR1cm4gbm9ybWFsaXplZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBwYXRoIGlzIGFsbG93ZWQgYmFzZWQgb24gZm9sZGVyIGZpbHRlcnMuXG5cdCAqL1xuXHRwcml2YXRlIGlzUGF0aEFsbG93ZWQocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgYWxsb3dlZCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNBbGxvd2VkRm9sZGVycyB8fCBbXTtcblx0XHRjb25zdCBibG9ja2VkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0Jsb2NrZWRGb2xkZXJzIHx8IFtdO1xuXHRcdFxuXHRcdC8vIE5vcm1hbGl6ZSBwYXRoIGZvciBjb21wYXJpc29uXG5cdFx0Y29uc3Qgbm9ybWFsaXplZFBhdGggPSB0aGlzLm5vcm1hbGl6ZUZvbGRlclBhdGgocGF0aCk7XG5cdFx0XG5cdFx0Ly8gQ2hlY2sgYmxvY2tsaXN0IGZpcnN0XG5cdFx0Zm9yIChjb25zdCBibG9ja2VkRm9sZGVyIG9mIGJsb2NrZWQpIHtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRCbG9ja2VkID0gdGhpcy5ub3JtYWxpemVGb2xkZXJQYXRoKGJsb2NrZWRGb2xkZXIpO1xuXHRcdFx0aWYgKG5vcm1hbGl6ZWRQYXRoID09PSBub3JtYWxpemVkQmxvY2tlZCB8fCBub3JtYWxpemVkUGF0aC5zdGFydHNXaXRoKG5vcm1hbGl6ZWRCbG9ja2VkKSkge1xuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdQYXRoIGJsb2NrZWQgYnkgZmlsdGVyJywge1xuXHRcdFx0XHRcdHBhdGgsXG5cdFx0XHRcdFx0YmxvY2tlZEZvbGRlcixcblx0XHRcdFx0XHRub3JtYWxpemVkUGF0aCxcblx0XHRcdFx0XHRub3JtYWxpemVkQmxvY2tlZFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRcblx0XHQvLyBDaGVjayBhbGxvd2xpc3QgKGlmIHNldCwgcGF0aCBtdXN0IGJlIGluIGFsbG93ZWQgZm9sZGVycylcblx0XHRpZiAoYWxsb3dlZC5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBpc0FsbG93ZWQgPSBhbGxvd2VkLnNvbWUoYWxsb3dlZEZvbGRlciA9PiB7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRBbGxvd2VkID0gdGhpcy5ub3JtYWxpemVGb2xkZXJQYXRoKGFsbG93ZWRGb2xkZXIpO1xuXHRcdFx0XHRyZXR1cm4gbm9ybWFsaXplZFBhdGggPT09IG5vcm1hbGl6ZWRBbGxvd2VkIHx8IG5vcm1hbGl6ZWRQYXRoLnN0YXJ0c1dpdGgobm9ybWFsaXplZEFsbG93ZWQpO1xuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdGlmICghaXNBbGxvd2VkKSB7XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ1BhdGggbm90IGluIGFsbG93ZWQgZm9sZGVycycsIHtcblx0XHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRcdGFsbG93ZWRGb2xkZXJzOiBhbGxvd2VkLFxuXHRcdFx0XHRcdG5vcm1hbGl6ZWRQYXRoXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdFxuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGNhY2hlIGtleWluZyBtYXRjaCAoc29mdC9zdHJpY3QgbW9kZSkuXG5cdCAqL1xuXHRwcml2YXRlIGNoZWNrQ2FjaGVLZXlpbmcoY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSwgY3VycmVudE5vdGVQYXRoPzogc3RyaW5nKTogeyBtYXRjaDogYm9vbGVhbjsgY3VycmVudE5vdGU/OiBzdHJpbmc7IGNhY2hlTm90ZT86IHN0cmluZyB9IHtcblx0XHRpZiAoIWNhY2hlLnNvdXJjZU5vdGVQYXRoKSB7XG5cdFx0XHRyZXR1cm4geyBtYXRjaDogdHJ1ZSB9OyAvLyBObyBrZXlpbmcsIGFsd2F5cyBtYXRjaFxuXHRcdH1cblx0XHRcblx0XHRpZiAoIWN1cnJlbnROb3RlUGF0aCkge1xuXHRcdFx0cmV0dXJuIHsgbWF0Y2g6IHRydWUgfTsgLy8gTm8gY3VycmVudCBub3RlLCBhbGxvdyB1c2Vcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgbWF0Y2ggPSBjYWNoZS5zb3VyY2VOb3RlUGF0aCA9PT0gY3VycmVudE5vdGVQYXRoO1xuXHRcdGlmICghbWF0Y2gpIHtcblx0XHRcdGNvbnN0IG1vZGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zS2V5aW5nTW9kZSB8fCAnc29mdCc7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2gnLCB7XG5cdFx0XHRcdGN1cnJlbnROb3RlOiBjdXJyZW50Tm90ZVBhdGgsXG5cdFx0XHRcdGNhY2hlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXG5cdFx0XHRcdG1vZGVcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHRyZXR1cm4geyBtYXRjaCwgY3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCwgY2FjaGVOb3RlOiBjYWNoZS5zb3VyY2VOb3RlUGF0aCB9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFZhbGlkYXRlIGFuZCBjbGVhbiBjYWNoZSAocmVtb3ZlIG1pc3NpbmcgZmlsZXMsIGluLW1lbW9yeSBvbmx5KS5cblx0ICovXG5cdHByaXZhdGUgdmFsaWRhdGVBbmRDbGVhbkNhY2hlKGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUpOiB7IGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGU7IHdhc01vZGlmaWVkOiBib29sZWFuIH0ge1xuXHRcdGNvbnN0IG9yaWdpbmFsQ291bnQgPSBjYWNoZS5yZXN1bHRzLmxlbmd0aDtcblx0XHRjb25zdCB2YWxpZFJlc3VsdHMgPSBjYWNoZS5yZXN1bHRzLmZpbHRlcihyZXN1bHQgPT4ge1xuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHJlc3VsdC5wYXRoKTtcblx0XHRcdHJldHVybiBmaWxlIGluc3RhbmNlb2YgVEZpbGU7XG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc3Qgd2FzTW9kaWZpZWQgPSB2YWxpZFJlc3VsdHMubGVuZ3RoICE9PSBvcmlnaW5hbENvdW50O1xuXHRcdFxuXHRcdGlmICh3YXNNb2RpZmllZCkge1xuXHRcdFx0Y29uc3QgZHJvcHBlZCA9IG9yaWdpbmFsQ291bnQgLSB2YWxpZFJlc3VsdHMubGVuZ3RoO1xuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnQ2FjaGUgaW52YWxpZGF0aW9uJywge1xuXHRcdFx0XHRkcm9wcGVkLFxuXHRcdFx0XHRvcmlnaW5hbENvdW50LFxuXHRcdFx0XHR2YWxpZDogdmFsaWRSZXN1bHRzLmxlbmd0aFxuXHRcdFx0fSk7XG5cdFx0XHRjYWNoZS5yZXN1bHRzID0gdmFsaWRSZXN1bHRzOyAvLyBJbi1tZW1vcnkgb25seVxuXHRcdH1cblx0XHRcblx0XHRyZXR1cm4geyBjYWNoZSwgd2FzTW9kaWZpZWQgfTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTYXZlIGNhY2hlIHRvIHNldHRpbmdzICh3aXRoIHNhbml0eSBndWFyZCkuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIHNhdmVDYWNoZShjYWNoZTogU21hcnRDb25uZWN0aW9uc0NhY2hlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Ly8gU2FuaXR5IGd1YXJkOiBkb24ndCBvdmVyd3JpdGUgY2FjaGUgaWYgY2FwdHVyZSByZXR1cm5lZCAwIHJlc3VsdHNcblx0XHRpZiAoY2FjaGUucmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0NhcHR1cmUgcmV0dXJuZWQgMCByZXN1bHRzLCBwcmVzZXJ2aW5nIGV4aXN0aW5nIGNhY2hlJywge1xuXHRcdFx0XHRzZXNzaW9uSWQ6IGNhY2hlLnNlc3Npb25JZCxcblx0XHRcdFx0bWV0aG9kOiBjYWNoZS5tZXRob2Rcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuOyAvLyBEb24ndCBvdmVyd3JpdGUgZXhpc3RpbmcgY2FjaGVcblx0XHR9XG5cdFx0XG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlID0gY2FjaGU7XG5cdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgc2F2ZWQnLCB7XG5cdFx0XHRyZXN1bHRzOiBjYWNoZS5yZXN1bHRzLmxlbmd0aCxcblx0XHRcdG1ldGhvZDogY2FjaGUubWV0aG9kLFxuXHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXG5cdFx0XHR2YXVsdElkOiBjYWNoZS52YXVsdElkXG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGNhY2hlIGZyb20gc2V0dGluZ3MuXG5cdCAqL1xuXHRwcml2YXRlIGdldENhY2hlKCk6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSB8IG51bGwge1xuXHRcdHJldHVybiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGUgfHwgbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBGaW5kIFNtYXJ0IENvbm5lY3Rpb25zIHZpZXcgdXNpbmcgaGV1cmlzdGljIGRldGVjdGlvbi5cblx0ICovXG5cdHByaXZhdGUgZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk6IFdvcmtzcGFjZUxlYWYgfCBudWxsIHtcblx0XHRjb25zdCBsZWF2ZXM6IFdvcmtzcGFjZUxlYWZbXSA9IFtdO1xuXHRcdHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKChsZWFmKSA9PiB7XG5cdFx0XHRsZWF2ZXMucHVzaChsZWFmKTtcblx0XHR9KTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTY2FubmluZyB3b3Jrc3BhY2UgbGVhdmVzJywge1xuXHRcdFx0dG90YWxMZWF2ZXM6IGxlYXZlcy5sZW5ndGhcblx0XHR9KTtcblx0XHRcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGxlYXZlcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgbGVhZiA9IGxlYXZlc1tpXTtcblx0XHRcdGNvbnN0IHZpZXdUeXBlID0gbGVhZi52aWV3LmdldFZpZXdUeXBlPy4oKSB8fCAndW5rbm93bic7XG5cdFx0XHRjb25zdCBjb250YWluZXJFbCA9IGxlYWYudmlldy5jb250YWluZXJFbDtcblx0XHRcdFxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2hlY2tpbmcgbGVhZicsIHtcblx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdHZpZXdUeXBlLFxuXHRcdFx0XHRjb250YWluZXJDbGFzc2VzOiBBcnJheS5mcm9tKGNvbnRhaW5lckVsLmNsYXNzTGlzdCB8fCBbXSkuam9pbignLCAnKVxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdC8vIENoZWNrIGZvciBTQyBtYXJrZXJzIHdpdGggY29uZmlkZW5jZSBicmVhZGNydW1ic1xuXHRcdFx0bGV0IGNvbmZpZGVuY2UgPSAnbm9uZSc7XG5cdFx0XHRsZXQgbWFya2VyID0gJyc7XG5cdFx0XHRcblx0XHRcdC8vIE1hcmtlciAxOiBjbGFzcyBjb250YWlucyAnc21hcnQtY29ubmVjdGlvbnMnXG5cdFx0XHRpZiAoY29udGFpbmVyRWwuY2xhc3NMaXN0LmNvbnRhaW5zKCdzbWFydC1jb25uZWN0aW9ucycpIHx8IFxuXHRcdFx0ICAgIEFycmF5LmZyb20oY29udGFpbmVyRWwuY2xhc3NMaXN0KS5zb21lKGMgPT4gYy5pbmNsdWRlcygnc21hcnQtY29ubmVjdGlvbnMnKSkpIHtcblx0XHRcdFx0Y29uZmlkZW5jZSA9ICdoaWdoJztcblx0XHRcdFx0bWFya2VyID0gJ2NsYXNzIGNvbnRhaW5zIHNtYXJ0LWNvbm5lY3Rpb25zJztcblx0XHRcdH1cblx0XHRcdC8vIE1hcmtlciAyOiBjb250YWlucyB0ZXh0ICdDb25uZWN0aW9ucydcblx0XHRcdGVsc2UgaWYgKGNvbnRhaW5lckVsLnRleHRDb250ZW50Py5pbmNsdWRlcygnQ29ubmVjdGlvbnMnKSkge1xuXHRcdFx0XHRjb25maWRlbmNlID0gJ21lZGl1bSc7XG5cdFx0XHRcdG1hcmtlciA9ICdjb250YWlucyB0ZXh0IENvbm5lY3Rpb25zJztcblx0XHRcdH1cblx0XHRcdC8vIE1hcmtlciAzOiByZXN1bHRzIGxpc3QgaGFzIGludGVybmFsIGxpbmtzXG5cdFx0XHRlbHNlIGlmIChjb250YWluZXJFbC5xdWVyeVNlbGVjdG9yQWxsKCdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uZmlkZW5jZSA9ICdoaWdoJztcblx0XHRcdFx0bWFya2VyID0gJ3Jlc3VsdHMgbGlzdCBoYXMgaW50ZXJuYWwgbGlua3MnO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHRpZiAoY29uZmlkZW5jZSAhPT0gJ25vbmUnKSB7XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ1NDIHZpZXcgZGV0ZWN0ZWQnLCB7XG5cdFx0XHRcdFx0bGVhZkluZGV4OiBpLFxuXHRcdFx0XHRcdHZpZXdUeXBlLFxuXHRcdFx0XHRcdG1hcmtlcixcblx0XHRcdFx0XHRjb25maWRlbmNlXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4gbGVhZjtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU0MgdmlldyBub3QgZm91bmQnLCB7XG5cdFx0XHRsZWF2ZXNDaGVja2VkOiBsZWF2ZXMubGVuZ3RoXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHQvKipcblx0ICogQ2FwdHVyZSByZXN1bHRzIGZyb20gU21hcnQgQ29ubmVjdGlvbnMgRE9NLlxuXHQgKi9cblx0YXN5bmMgY2FwdHVyZUZyb21Eb20oc291cmNlTm90ZVBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPEFycmF5PHsgcGF0aDogc3RyaW5nOyBzY29yZTogbnVtYmVyIH0+PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xuXHRcdHRoaXMuY3VycmVudFNlc3Npb25JZCA9IHNlc3Npb25JZDtcblx0XHRhd2FpdCBQcm9taXNlLnJlc29sdmUoKTsgLy8gRW5zdXJlIGFzeW5jXG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU3RhcnRpbmcgRE9NIGNhcHR1cmUnLCB7XG5cdFx0XHRzb3VyY2VOb3RlUGF0aDogc291cmNlTm90ZVBhdGggfHwgJyhub3QgcHJvdmlkZWQpJyxcblx0XHRcdHNlc3Npb25JZFxuXHRcdH0pO1xuXHRcdFxuXHRcdGNvbnN0IHNjVmlldyA9IHRoaXMuZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk7XG5cdFx0aWYgKCFzY1ZpZXcpIHtcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ1NDIHZpZXcgbm90IGZvdW5kIGZvciBET00gY2FwdHVyZScsIHtcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gUG9ydGFibGUgcmVzdWx0cyBkZXRlY3Rpb24gdXNpbmcgaW50ZXJuYWwtbGluayBzZWxlY3RvclxuXHRcdGNvbnN0IGludGVybmFsTGlua3MgPSBzY1ZpZXcudmlldy5jb250YWluZXJFbC5xdWVyeVNlbGVjdG9yQWxsKCdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScpO1xuXHRcdGNvbnN0IHJlc3VsdHNDb3VudCA9IGludGVybmFsTGlua3MubGVuZ3RoO1xuXHRcdFxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1Jlc3VsdHMgZGV0ZWN0aW9uJywge1xuXHRcdFx0dmlld0ZvdW5kOiB0cnVlLFxuXHRcdFx0c2VsZWN0b3I6ICdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScsXG5cdFx0XHRjb3VudDogcmVzdWx0c0NvdW50LFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0aWYgKHJlc3VsdHNDb3VudCA9PT0gMCkge1xuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnVmlldyBmb3VuZCwgcmVzdWx0cyBtaXNzaW5nJywge1xuXHRcdFx0XHR2aWV3Rm91bmQ6IHRydWUsXG5cdFx0XHRcdHJlc3VsdHNGb3VuZDogZmFsc2UsXG5cdFx0XHRcdHNlbGVjdG9yOiAnYS5pbnRlcm5hbC1saW5rW2RhdGEtaHJlZl0nLFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuIFtdOyAvLyBEb24ndCBjYWNoZSBlbXB0eVxuXHRcdH1cblx0XHRcblx0XHQvLyBFeHRyYWN0IGxpbmtzIGFuZCB2YWxpZGF0ZVxuXHRcdGNvbnN0IHJlc3VsdHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBzY29yZTogbnVtYmVyIH0+ID0gW107XG5cdFx0Y29uc3QgbWF4Q2FwdHVyZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNNYXhDYXB0dXJlRmlsZXMgPz8gMjAwO1xuXHRcdFxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4ocmVzdWx0c0NvdW50LCBtYXhDYXB0dXJlKTsgaSsrKSB7XG5cdFx0XHRjb25zdCBsaW5rID0gaW50ZXJuYWxMaW5rc1tpXSBhcyBIVE1MQW5jaG9yRWxlbWVudDtcblx0XHRcdGNvbnN0IGRhdGFIcmVmID0gbGluay5nZXRBdHRyaWJ1dGUoJ2RhdGEtaHJlZicpO1xuXHRcdFx0Y29uc3QgaHJlZiA9IGxpbmsuZ2V0QXR0cmlidXRlKCdocmVmJyk7XG5cdFx0XHRjb25zdCBwYXRoID0gZGF0YUhyZWYgfHwgaHJlZiB8fCAnJztcblx0XHRcdFxuXHRcdFx0aWYgKCFwYXRoKSB7XG5cdFx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0xpbmsgbWlzc2luZyBwYXRoJywge1xuXHRcdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRcdGRhdGFIcmVmLFxuXHRcdFx0XHRcdGhyZWYsXG5cdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gTm9ybWFsaXplIHBhdGggKHJlbW92ZSAubWQgZXh0ZW5zaW9uIGlmIHByZXNlbnQsIGhhbmRsZSBpbnRlcm5hbCBsaW5rIGZvcm1hdClcblx0XHRcdGxldCBub3JtYWxpemVkUGF0aCA9IHBhdGgucmVwbGFjZSgvXFwubWQkLywgJycpO1xuXHRcdFx0aWYgKG5vcm1hbGl6ZWRQYXRoLnN0YXJ0c1dpdGgoJyMnKSkge1xuXHRcdFx0XHQvLyBTa2lwIGFuY2hvcnNcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzIGFuZCBpcyBhbGxvd2VkXG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobm9ybWFsaXplZFBhdGgpO1xuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xuXHRcdFx0XHR0aGlzLmxvZygnd2FybicsICdMaW5rIHJlc29sdmVzIHRvIG5vbi1maWxlJywge1xuXHRcdFx0XHRcdHBhdGg6IG5vcm1hbGl6ZWRQYXRoLFxuXHRcdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIEFwcGx5IGZvbGRlciBmaWx0ZXJzXG5cdFx0XHRpZiAoIXRoaXMuaXNQYXRoQWxsb3dlZChub3JtYWxpemVkUGF0aCkpIHtcblx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnTGluayBmaWx0ZXJlZCBvdXQnLCB7XG5cdFx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXG5cdFx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQXNzaWduIHJhbmstYmFzZWQgc2NvcmUgKDEuMCwgMC45OCwgMC45Ni4uLilcblx0XHRcdGNvbnN0IHJhbmtTY29yZSA9IE1hdGgubWF4KDAuNSwgMS4wIC0gKGkgKiAwLjAyKSk7XG5cdFx0XHRcblx0XHRcdHJlc3VsdHMucHVzaCh7XG5cdFx0XHRcdHBhdGg6IG5vcm1hbGl6ZWRQYXRoLFxuXHRcdFx0XHRzY29yZTogcmFua1Njb3JlXG5cdFx0XHR9KTtcblx0XHRcdFxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnTGluayBjYXB0dXJlZCcsIHtcblx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdHBhdGg6IG5vcm1hbGl6ZWRQYXRoLFxuXHRcdFx0XHRzY29yZTogcmFua1Njb3JlLFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdET00gY2FwdHVyZSBjb21wbGV0ZScsIHtcblx0XHRcdHJlc3VsdHM6IHJlc3VsdHMubGVuZ3RoLFxuXHRcdFx0dGltZTogJ04vQScsIC8vIENvdWxkIGFkZCB0aW1pbmcgaWYgbmVlZGVkXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHRyZXR1cm4gcmVzdWx0cztcblx0fVxuXG5cdC8qKlxuXHQgKiBDYXB0dXJlIHJlc3VsdHMgZnJvbSBjbGlwYm9hcmQuXG5cdCAqL1xuXHRhc3luYyBjYXB0dXJlRnJvbUNsaXBib2FyZChzb3VyY2VOb3RlUGF0aD86IHN0cmluZyk6IFByb21pc2U8QXJyYXk8eyBwYXRoOiBzdHJpbmc7IHNjb3JlOiBudW1iZXIgfT4+IHtcblx0XHRjb25zdCBzZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XG5cdFx0dGhpcy5jdXJyZW50U2Vzc2lvbklkID0gc2Vzc2lvbklkO1xuXHRcdFxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIGNsaXBib2FyZCBjYXB0dXJlJywge1xuXHRcdFx0c291cmNlTm90ZVBhdGg6IHNvdXJjZU5vdGVQYXRoIHx8ICcobm90IHByb3ZpZGVkKScsXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHR0cnkge1xuXHRcdFx0Ly8gQ2hlY2sgY2xpcGJvYXJkIHBlcm1pc3Npb25zXG5cdFx0XHRjb25zdCBjbGlwYm9hcmRUZXh0ID0gYXdhaXQgbmF2aWdhdG9yLmNsaXBib2FyZC5yZWFkVGV4dCgpO1xuXHRcdFx0XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdDbGlwYm9hcmQgcmVhZCcsIHtcblx0XHRcdFx0bGVuZ3RoOiBjbGlwYm9hcmRUZXh0Lmxlbmd0aCxcblx0XHRcdFx0cHJldmlldzogY2xpcGJvYXJkVGV4dC5zdWJzdHJpbmcoMCwgMjAwKSxcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdFxuXHRcdFx0Ly8gUGFyc2UgbWFya2Rvd24gbGlua3M6IFtbbm90ZS1uYW1lXV0gb3IgW3RleHRdKG5vdGUtbmFtZS5tZClcblx0XHRcdGNvbnN0IG1hcmtkb3duTGlua1BhdHRlcm4gPSAvXFxbXFxbKFteXFxdXSspXFxdXFxdfFxcWyhbXlxcXV0rKVxcXVxcKChbXildK1xcLm1kKVxcKS9nO1xuXHRcdFx0Y29uc3QgbGlua3M6IHN0cmluZ1tdID0gW107XG5cdFx0XHRsZXQgbWF0Y2g7XG5cdFx0XHRcblx0XHRcdHdoaWxlICgobWF0Y2ggPSBtYXJrZG93bkxpbmtQYXR0ZXJuLmV4ZWMoY2xpcGJvYXJkVGV4dCkpICE9PSBudWxsKSB7XG5cdFx0XHRcdGNvbnN0IGxpbmsgPSBtYXRjaFsxXSB8fCBtYXRjaFszXSB8fCAnJztcblx0XHRcdFx0aWYgKGxpbmspIHtcblx0XHRcdFx0XHRsaW5rcy5wdXNoKGxpbmsucmVwbGFjZSgvXFwubWQkLywgJycpKTtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdMaW5rcyBwYXJzZWQgZnJvbSBjbGlwYm9hcmQnLCB7XG5cdFx0XHRcdGZvdW5kOiBsaW5rcy5sZW5ndGgsXG5cdFx0XHRcdGxpbmtzOiBsaW5rcy5zbGljZSgwLCAxMCksIC8vIExvZyBmaXJzdCAxMFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHQvLyBWYWxpZGF0ZSBhbmQgZmlsdGVyIGxpbmtzXG5cdFx0XHRjb25zdCByZXN1bHRzOiBBcnJheTx7IHBhdGg6IHN0cmluZzsgc2NvcmU6IG51bWJlciB9PiA9IFtdO1xuXHRcdFx0Y29uc3QgbWF4Q2FwdHVyZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNNYXhDYXB0dXJlRmlsZXMgPz8gMjAwO1xuXHRcdFx0XG5cdFx0XHRmb3IgKGxldCBpID0gMDsgaSA8IE1hdGgubWluKGxpbmtzLmxlbmd0aCwgbWF4Q2FwdHVyZSk7IGkrKykge1xuXHRcdFx0XHRjb25zdCBsaW5rID0gbGlua3NbaV07XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBDaGVjayBpZiBmaWxlIGV4aXN0c1xuXHRcdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgobGluayk7XG5cdFx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHtcblx0XHRcdFx0XHR0aGlzLmxvZygnd2FybicsICdDbGlwYm9hcmQgbGluayByZXNvbHZlcyB0byBub24tZmlsZScsIHtcblx0XHRcdFx0XHRcdGxpbmssXG5cdFx0XHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBBcHBseSBmb2xkZXIgZmlsdGVyc1xuXHRcdFx0XHRpZiAoIXRoaXMuaXNQYXRoQWxsb3dlZChsaW5rKSkge1xuXHRcdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NsaXBib2FyZCBsaW5rIGZpbHRlcmVkIG91dCcsIHtcblx0XHRcdFx0XHRcdGxpbmssXG5cdFx0XHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0XHRcdH0pO1xuXHRcdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdFxuXHRcdFx0XHQvLyBBc3NpZ24gcmFuay1iYXNlZCBzY29yZVxuXHRcdFx0XHRjb25zdCByYW5rU2NvcmUgPSBNYXRoLm1heCgwLjUsIDEuMCAtIChpICogMC4wMikpO1xuXHRcdFx0XHRcblx0XHRcdFx0cmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0XHRwYXRoOiBsaW5rLFxuXHRcdFx0XHRcdHNjb3JlOiByYW5rU2NvcmVcblx0XHRcdFx0fSk7XG5cdFx0XHRcdFxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdDbGlwYm9hcmQgbGluayBjYXB0dXJlZCcsIHtcblx0XHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0XHRsaW5rLFxuXHRcdFx0XHRcdHNjb3JlOiByYW5rU2NvcmUsXG5cdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdDbGlwYm9hcmQgY2FwdHVyZSBjb21wbGV0ZScsIHtcblx0XHRcdFx0cmVzdWx0czogcmVzdWx0cy5sZW5ndGgsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdHJldHVybiByZXN1bHRzO1xuXHRcdFx0XG5cdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdHRoaXMubG9nKCdlcnJvcicsICdDbGlwYm9hcmQgY2FwdHVyZSBmYWlsZWQnLCB7XG5cdFx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG5cdFx0XHRcdHN0YWNrOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3Iuc3RhY2sgOiB1bmRlZmluZWQsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIFRva2VuaXplIHRleHQgKHNpbXBsZSB3b3JkIHNwbGl0dGluZywgbG93ZXJjYXNlKS5cblx0ICovXG5cdHByaXZhdGUgdG9rZW5pemUodGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuXHRcdHJldHVybiB0ZXh0XG5cdFx0XHQudG9Mb3dlckNhc2UoKVxuXHRcdFx0LnNwbGl0KC9bXmEtejAtOV0rL2cpXG5cdFx0XHQubWFwKHQgPT4gdC50cmltKCkpXG5cdFx0XHQuZmlsdGVyKHQgPT4gdC5sZW5ndGggPj0gMik7XG5cdH1cblxuXHQvKipcblx0ICogU2NvcmUgY2FjaGVkIGl0ZW1zIHVzaW5nIG1ldGFkYXRhIGNhY2hlIChmYXN0IHBhdGgpLlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyBzY29yZUNhY2hlZEl0ZW1zV2l0aE1ldGFkYXRhKFxuXHRcdGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUsXG5cdFx0cXVlcnk6IHN0cmluZyxcblx0XHRsaW1pdDogbnVtYmVyXG5cdCk6IFByb21pc2U8U2NvcmVkQ2FjaGVJdGVtW10+IHtcblx0XHRhd2FpdCBQcm9taXNlLnJlc29sdmUoKTsgLy8gRW5zdXJlIGFzeW5jXG5cdFx0Y29uc3QgcXVlcnlUb2tlbnMgPSB0aGlzLnRva2VuaXplKHF1ZXJ5KTtcblx0XHRjb25zdCBtYXhTY29yZUZpbGVzID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heFNjb3JlRmlsZXMgPz8gNTA7XG5cdFx0Y29uc3QgaXRlbXNUb1Njb3JlID0gY2FjaGUucmVzdWx0cy5zbGljZSgwLCBNYXRoLm1pbihjYWNoZS5yZXN1bHRzLmxlbmd0aCwgbWF4U2NvcmVGaWxlcykpO1xuXHRcdFxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIG1ldGFkYXRhIHNjb3JpbmcnLCB7XG5cdFx0XHRxdWVyeVRva2VuczogcXVlcnlUb2tlbnMuc2xpY2UoMCwgMTApLCAvLyBMb2cgZmlyc3QgMTAgdG9rZW5zXG5cdFx0XHRpdGVtc1RvU2NvcmU6IGl0ZW1zVG9TY29yZS5sZW5ndGgsXG5cdFx0XHRtYXhTY29yZUZpbGVzLFxuXHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHRjb25zdCBzY29yZWQ6IFNjb3JlZENhY2hlSXRlbVtdID0gW107XG5cdFx0XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBpdGVtc1RvU2NvcmUubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IGl0ZW0gPSBpdGVtc1RvU2NvcmVbaV07XG5cdFx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgoaXRlbS5wYXRoKTtcblx0XHRcdFxuXHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gR2V0IG1ldGFkYXRhIGNhY2hlXG5cdFx0XHRjb25zdCBtZXRhZGF0YSA9IHRoaXMuYXBwLm1ldGFkYXRhQ2FjaGUuZ2V0RmlsZUNhY2hlKGZpbGUpO1xuXHRcdFx0aWYgKCFtZXRhZGF0YSkge1xuXHRcdFx0XHQvLyBObyBtZXRhZGF0YSwgdXNlIHJhbmsgc2NvcmUgb25seVxuXHRcdFx0XHRzY29yZWQucHVzaCh7XG5cdFx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHRcdHJhbmtTY29yZTogaXRlbS5zY29yZSA/PyAwLjUsXG5cdFx0XHRcdFx0bWV0YWRhdGFTY29yZTogMCxcblx0XHRcdFx0XHRmaW5hbFNjb3JlOiBpdGVtLnNjb3JlID8/IDAuNSxcblx0XHRcdFx0XHRjYXB0dXJlZEF0OiBpdGVtLmNhcHR1cmVkQXRcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBFeHRyYWN0IHRleHQgZnJvbSBtZXRhZGF0YVxuXHRcdFx0Y29uc3QgbWV0YWRhdGFUZXh0OiBzdHJpbmdbXSA9IFtdO1xuXHRcdFx0XG5cdFx0XHQvLyBGcm9udG1hdHRlciB0YWdzXG5cdFx0XHRpZiAobWV0YWRhdGEuZnJvbnRtYXR0ZXI/LnRhZ3MpIHtcblx0XHRcdFx0Y29uc3QgdGFncyA9IEFycmF5LmlzQXJyYXkobWV0YWRhdGEuZnJvbnRtYXR0ZXIudGFncykgXG5cdFx0XHRcdFx0PyBtZXRhZGF0YS5mcm9udG1hdHRlci50YWdzIFxuXHRcdFx0XHRcdDogW21ldGFkYXRhLmZyb250bWF0dGVyLnRhZ3NdO1xuXHRcdFx0XHRtZXRhZGF0YVRleHQucHVzaCguLi50YWdzLm1hcCgodDogc3RyaW5nKSA9PiB0LnRvU3RyaW5nKCkudG9Mb3dlckNhc2UoKSkpO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBIZWFkaW5nc1xuXHRcdFx0aWYgKG1ldGFkYXRhLmhlYWRpbmdzKSB7XG5cdFx0XHRcdG1ldGFkYXRhVGV4dC5wdXNoKC4uLm1ldGFkYXRhLmhlYWRpbmdzLm1hcChoID0+IGguaGVhZGluZy50b0xvd2VyQ2FzZSgpKSk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIFRhZ3Ncblx0XHRcdGlmIChtZXRhZGF0YS50YWdzKSB7XG5cdFx0XHRcdG1ldGFkYXRhVGV4dC5wdXNoKC4uLm1ldGFkYXRhLnRhZ3MubWFwKHQgPT4gdC50YWcudG9Mb3dlckNhc2UoKSkpO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBTY29yZSBieSB0b2tlbiBvdmVybGFwXG5cdFx0XHRjb25zdCBtZXRhZGF0YVRva2VucyA9IHRoaXMudG9rZW5pemUobWV0YWRhdGFUZXh0LmpvaW4oJyAnKSk7XG5cdFx0XHRjb25zdCBvdmVybGFwID0gcXVlcnlUb2tlbnMuZmlsdGVyKHQgPT4gbWV0YWRhdGFUb2tlbnMuaW5jbHVkZXModCkpLmxlbmd0aDtcblx0XHRcdGNvbnN0IG1ldGFkYXRhU2NvcmUgPSBxdWVyeVRva2Vucy5sZW5ndGggPiAwID8gb3ZlcmxhcCAvIHF1ZXJ5VG9rZW5zLmxlbmd0aCA6IDA7XG5cdFx0XHRcblx0XHRcdC8vIENvbWJpbmUgd2l0aCByYW5rIHNjb3JlXG5cdFx0XHRjb25zdCByYW5rU2NvcmUgPSBpdGVtLnNjb3JlID8/IE1hdGgubWF4KDAuNSwgMS4wIC0gKGkgKiAwLjAyKSk7XG5cdFx0XHRjb25zdCBmaW5hbFNjb3JlID0gKG1ldGFkYXRhU2NvcmUgKiAwLjcpICsgKHJhbmtTY29yZSAqIDAuMyk7XG5cdFx0XHRcblx0XHRcdHNjb3JlZC5wdXNoKHtcblx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHRyYW5rU2NvcmUsXG5cdFx0XHRcdG1ldGFkYXRhU2NvcmUsXG5cdFx0XHRcdGZpbmFsU2NvcmUsXG5cdFx0XHRcdGNhcHR1cmVkQXQ6IGl0ZW0uY2FwdHVyZWRBdFxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0l0ZW0gc2NvcmVkIHdpdGggbWV0YWRhdGEnLCB7XG5cdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXG5cdFx0XHRcdG1ldGFkYXRhU2NvcmU6IG1ldGFkYXRhU2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0cmFua1Njb3JlOiByYW5rU2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0ZmluYWxTY29yZTogZmluYWxTY29yZS50b0ZpeGVkKDMpLFxuXHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFNvcnQgYnkgZmluYWwgc2NvcmUgYW5kIHJldHVybiB0b3AgTlxuXHRcdGNvbnN0IHNvcnRlZCA9IHNjb3JlZC5zb3J0KChhLCBiKSA9PiBiLmZpbmFsU2NvcmUgLSBhLmZpbmFsU2NvcmUpO1xuXHRcdGNvbnN0IHRvcE4gPSBNYXRoLm1pbigxMCwgbGltaXQgKiAyKTsgLy8gUG9saWN5OiB0b3BORnVsbFJlYWQgPSBtaW4oMTAsIGxpbWl0ICogMilcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdNZXRhZGF0YSBzY29yaW5nIGNvbXBsZXRlJywge1xuXHRcdFx0c2NvcmVkOiBzb3J0ZWQubGVuZ3RoLFxuXHRcdFx0dG9wTixcblx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIHNvcnRlZC5zbGljZSgwLCB0b3BOKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBMb2FkIGZ1bGwgY29udGVudCBhbmQgcmUtc2NvcmUgdG9wIGl0ZW1zLlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyBsb2FkQW5kU2NvcmVUb3BJdGVtcyhcblx0XHR0b3BJdGVtczogU2NvcmVkQ2FjaGVJdGVtW10sXG5cdFx0cXVlcnk6IHN0cmluZ1xuXHQpOiBQcm9taXNlPFNjb3JlZENhY2hlSXRlbVtdPiB7XG5cdFx0Y29uc3QgcXVlcnlUb2tlbnMgPSB0aGlzLnRva2VuaXplKHF1ZXJ5KTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdMb2FkaW5nIGZ1bGwgY29udGVudCBmb3IgdG9wIGl0ZW1zJywge1xuXHRcdFx0Y291bnQ6IHRvcEl0ZW1zLmxlbmd0aCxcblx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCB0b3BJdGVtcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgaXRlbSA9IHRvcEl0ZW1zW2ldO1xuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGl0ZW0ucGF0aCk7XG5cdFx0XHRcblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdHRyeSB7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRcdGNvbnN0IGNvbnRlbnRUb2tlbnMgPSB0aGlzLnRva2VuaXplKGNvbnRlbnQpO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gU2NvcmUgYnkgdG9rZW4gb3ZlcmxhcFxuXHRcdFx0XHRjb25zdCBvdmVybGFwID0gcXVlcnlUb2tlbnMuZmlsdGVyKHQgPT4gY29udGVudFRva2Vucy5pbmNsdWRlcyh0KSkubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBmdWxsQ29udGVudFNjb3JlID0gcXVlcnlUb2tlbnMubGVuZ3RoID4gMCA/IG92ZXJsYXAgLyBxdWVyeVRva2Vucy5sZW5ndGggOiAwO1xuXHRcdFx0XHRcblx0XHRcdFx0Ly8gQ29tYmluZSBzY29yZXM6IChxdWVyeVNjb3JlICogMC43KSArIChyYW5rU2NvcmUgKiAwLjMpXG5cdFx0XHRcdGl0ZW0uZnVsbENvbnRlbnRTY29yZSA9IGZ1bGxDb250ZW50U2NvcmU7XG5cdFx0XHRcdGl0ZW0uZmluYWxTY29yZSA9IChmdWxsQ29udGVudFNjb3JlICogMC43KSArIChpdGVtLnJhbmtTY29yZSAqIDAuMyk7XG5cdFx0XHRcdFxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdJdGVtIHJlLXNjb3JlZCB3aXRoIGZ1bGwgY29udGVudCcsIHtcblx0XHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXG5cdFx0XHRcdFx0ZnVsbENvbnRlbnRTY29yZTogZnVsbENvbnRlbnRTY29yZS50b0ZpeGVkKDMpLFxuXHRcdFx0XHRcdGZpbmFsU2NvcmU6IGl0ZW0uZmluYWxTY29yZS50b0ZpeGVkKDMpLFxuXHRcdFx0XHRcdGNvbnRlbnRMZW5ndGg6IGNvbnRlbnQubGVuZ3RoLFxuXHRcdFx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnRmFpbGVkIHRvIHJlYWQgZmlsZSBmb3Igc2NvcmluZycsIHtcblx0XHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXG5cdFx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcblx0XHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdFx0XHR9KTtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0Ly8gUmUtc29ydCBieSBmaW5hbCBzY29yZVxuXHRcdHJldHVybiB0b3BJdGVtcy5zb3J0KChhLCBiKSA9PiBiLmZpbmFsU2NvcmUgLSBhLmZpbmFsU2NvcmUpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdlbmVyYXRlIGJlc3QtbWF0Y2hpbmcgcGFyYWdyYXBoIGV4Y2VycHQuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIGdlbmVyYXRlQmVzdE1hdGNoaW5nRXhjZXJwdChwYXRoOiBzdHJpbmcsIHF1ZXJ5OiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuXHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChwYXRoKTtcblx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XG5cdFx0XHRyZXR1cm4gJ1tGaWxlIG5vdCBmb3VuZF0nO1xuXHRcdH1cblx0XHRcblx0XHR0cnkge1xuXHRcdFx0Y29uc3QgY29udGVudCA9IGF3YWl0IHRoaXMudmF1bHQucmVhZChmaWxlKTtcblx0XHRcdGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVyeSk7XG5cdFx0XHRcblx0XHRcdC8vIFBvbGljeTogU3BsaXQgYnkgZG91YmxlIG5ld2xpbmVcblx0XHRcdGNvbnN0IHBhcmFncmFwaHMgPSBjb250ZW50LnNwbGl0KCdcXG5cXG4nKTtcblx0XHRcdFxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBleGNlcnB0Jywge1xuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRwYXJhZ3JhcGhzOiBwYXJhZ3JhcGhzLmxlbmd0aCxcblx0XHRcdFx0cXVlcnlUb2tlbnM6IHF1ZXJ5VG9rZW5zLnNsaWNlKDAsIDUpLFxuXHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdGlmIChwYXJhZ3JhcGhzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0XHQvLyBGYWxsYmFjayB0byBmaXJzdCA1MDAgY2hhcnNcblx0XHRcdFx0cmV0dXJuIGNvbnRlbnQudHJpbSgpLnNsaWNlKDAsIDUwMCkgKyAoY29udGVudC5sZW5ndGggPiA1MDAgPyAn4oCmJyA6ICcnKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gU2NvcmUgZWFjaCBwYXJhZ3JhcGhcblx0XHRcdGxldCBiZXN0UGFyYWdyYXBoID0gcGFyYWdyYXBoc1swXTtcblx0XHRcdGxldCBiZXN0U2NvcmUgPSAwO1xuXHRcdFx0XG5cdFx0XHRmb3IgKGNvbnN0IHBhcmFncmFwaCBvZiBwYXJhZ3JhcGhzKSB7XG5cdFx0XHRcdGNvbnN0IHBhcmFUb2tlbnMgPSB0aGlzLnRva2VuaXplKHBhcmFncmFwaCk7XG5cdFx0XHRcdGNvbnN0IG92ZXJsYXAgPSBxdWVyeVRva2Vucy5maWx0ZXIodCA9PiBwYXJhVG9rZW5zLmluY2x1ZGVzKHQpKS5sZW5ndGg7XG5cdFx0XHRcdGNvbnN0IHNjb3JlID0gcXVlcnlUb2tlbnMubGVuZ3RoID4gMCA/IG92ZXJsYXAgLyBxdWVyeVRva2Vucy5sZW5ndGggOiAwO1xuXHRcdFx0XHRcblx0XHRcdFx0aWYgKHNjb3JlID4gYmVzdFNjb3JlKSB7XG5cdFx0XHRcdFx0YmVzdFNjb3JlID0gc2NvcmU7XG5cdFx0XHRcdFx0YmVzdFBhcmFncmFwaCA9IHBhcmFncmFwaDtcblx0XHRcdFx0fVxuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBUcmltIHRvIDgwMC0xMjAwIGNoYXJzIChwcmVmZXIgMTAwMCwgYnV0IGFsbG93IHJhbmdlKVxuXHRcdFx0bGV0IGV4Y2VycHQgPSBiZXN0UGFyYWdyYXBoLnRyaW0oKTtcblx0XHRcdGNvbnN0IHRhcmdldExlbmd0aCA9IDEwMDA7XG5cdFx0XHRjb25zdCBtaW5MZW5ndGggPSA4MDA7XG5cdFx0XHRjb25zdCBtYXhMZW5ndGggPSAxMjAwO1xuXHRcdFx0XG5cdFx0XHRpZiAoZXhjZXJwdC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcblx0XHRcdFx0Ly8gVHJ5IHRvIHRyaW0gYXQgc2VudGVuY2UgYm91bmRhcnlcblx0XHRcdFx0Y29uc3QgdHJpbW1lZCA9IGV4Y2VycHQuc2xpY2UoMCwgbWF4TGVuZ3RoKTtcblx0XHRcdFx0Y29uc3QgbGFzdFBlcmlvZCA9IHRyaW1tZWQubGFzdEluZGV4T2YoJy4nKTtcblx0XHRcdFx0aWYgKGxhc3RQZXJpb2QgPiBtaW5MZW5ndGgpIHtcblx0XHRcdFx0XHRleGNlcnB0ID0gdHJpbW1lZC5zbGljZSgwLCBsYXN0UGVyaW9kICsgMSk7XG5cdFx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdFx0ZXhjZXJwdCA9IHRyaW1tZWQgKyAn4oCmJztcblx0XHRcdFx0fVxuXHRcdFx0fSBlbHNlIGlmIChleGNlcnB0Lmxlbmd0aCA8IG1pbkxlbmd0aCAmJiBwYXJhZ3JhcGhzLmxlbmd0aCA+IDEpIHtcblx0XHRcdFx0Ly8gVHJ5IHRvIGluY2x1ZGUgbmV4dCBwYXJhZ3JhcGggaWYgdG9vIHNob3J0XG5cdFx0XHRcdGNvbnN0IHBhcmFJbmRleCA9IHBhcmFncmFwaHMuaW5kZXhPZihiZXN0UGFyYWdyYXBoKTtcblx0XHRcdFx0aWYgKHBhcmFJbmRleCA8IHBhcmFncmFwaHMubGVuZ3RoIC0gMSkge1xuXHRcdFx0XHRcdGNvbnN0IGNvbWJpbmVkID0gYmVzdFBhcmFncmFwaCArICdcXG5cXG4nICsgcGFyYWdyYXBoc1twYXJhSW5kZXggKyAxXTtcblx0XHRcdFx0XHRleGNlcnB0ID0gY29tYmluZWQudHJpbSgpLnNsaWNlKDAsIG1heExlbmd0aCk7XG5cdFx0XHRcdFx0aWYgKGNvbWJpbmVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuXHRcdFx0XHRcdFx0ZXhjZXJwdCArPSAn4oCmJztcblx0XHRcdFx0XHR9XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnRXhjZXJwdCBnZW5lcmF0ZWQnLCB7XG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGV4Y2VycHRMZW5ndGg6IGV4Y2VycHQubGVuZ3RoLFxuXHRcdFx0XHRiZXN0U2NvcmU6IGJlc3RTY29yZS50b0ZpeGVkKDMpLFxuXHRcdFx0XHRtZXRob2Q6IGJlc3RTY29yZSA+IDAgPyAnYmVzdC1tYXRjaGluZycgOiAnZmlyc3QtcGFyYWdyYXBoJyxcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHRyZXR1cm4gZXhjZXJwdDtcblx0XHRcdFxuXHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdGYWlsZWQgdG8gZ2VuZXJhdGUgZXhjZXJwdCcsIHtcblx0XHRcdFx0cGF0aCxcblx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuICdbRXJyb3IgcmVhZGluZyBmaWxlXSc7XG5cdFx0fVxuXHR9XG5cblx0YXN5bmMgc2VhcmNoKHF1ZXJ5OiBSZXRyaWV2YWxRdWVyeSwgb3B0czogUmV0cmlldmFsT3B0aW9ucyk6IFByb21pc2U8Q29udGV4dEl0ZW1bXT4ge1xuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcblx0XHR0aGlzLmN1cnJlbnRTZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XG5cdFx0XG5cdFx0Y29uc3QgcSA9IChxdWVyeS50ZXh0ID8/ICcnKS50cmltKCk7XG5cdFx0aWYgKCFxKSB7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHRcdFxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ1N0YXJ0aW5nIHNlYXJjaCcsIHtcblx0XHRcdHF1ZXJ5OiBxLFxuXHRcdFx0bGltaXQ6IG9wdHMubGltaXQsXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHQvLyBDaGVjayBpZiBjYWNoZSBpcyBlbmFibGVkXG5cdFx0Y29uc3QgZW5hYmxlZCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNDYWNoZUVuYWJsZWQgPz8gZmFsc2U7XG5cdFx0aWYgKCFlbmFibGVkKSB7XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdDYWNoZSBkaXNhYmxlZCwgcmV0dXJuaW5nIGVtcHR5Jywge1xuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0XHRcblx0XHQvLyBHZXQgY2FjaGVcblx0XHRjb25zdCBjYWNoZSA9IHRoaXMuZ2V0Q2FjaGUoKTtcblx0XHRpZiAoIWNhY2hlKSB7XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdObyBjYWNoZSBhdmFpbGFibGUsIHJldHVybmluZyBlbXB0eScsIHtcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gQ2hlY2sgY2FjaGUgZnJlc2huZXNzXG5cdFx0aWYgKCF0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSkpIHtcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0NhY2hlIGV4cGlyZWQsIHJldHVybmluZyBlbXB0eScsIHtcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gQ2hlY2sga2V5aW5nIG1hdGNoXG5cdFx0Y29uc3QgY3VycmVudE5vdGVQYXRoID0gcXVlcnkuYWN0aXZlRmlsZVBhdGg7XG5cdFx0Y29uc3Qga2V5aW5nQ2hlY2sgPSB0aGlzLmNoZWNrQ2FjaGVLZXlpbmcoY2FjaGUsIGN1cnJlbnROb3RlUGF0aCk7XG5cdFx0Y29uc3Qga2V5aW5nTW9kZSA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNLZXlpbmdNb2RlIHx8ICdzb2Z0Jztcblx0XHRcblx0XHRpZiAoIWtleWluZ0NoZWNrLm1hdGNoICYmIGtleWluZ01vZGUgPT09ICdzdHJpY3QnKSB7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2ggaW4gc3RyaWN0IG1vZGUsIHJldHVybmluZyBlbXB0eScsIHtcblx0XHRcdFx0Y3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCxcblx0XHRcdFx0Y2FjaGVOb3RlOiBrZXlpbmdDaGVjay5jYWNoZU5vdGUsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHRcdFxuXHRcdGlmICgha2V5aW5nQ2hlY2subWF0Y2gpIHtcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0NhY2hlIGtleWluZyBtaXNtYXRjaCBpbiBzb2Z0IG1vZGUsIGFsbG93aW5nIHVzZScsIHtcblx0XHRcdFx0Y3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCxcblx0XHRcdFx0Y2FjaGVOb3RlOiBrZXlpbmdDaGVjay5jYWNoZU5vdGUsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFZhbGlkYXRlIGFuZCBjbGVhbiBjYWNoZSAoaW4tbWVtb3J5IG9ubHkpXG5cdFx0Y29uc3QgeyBjYWNoZTogY2xlYW5lZENhY2hlLCB3YXNNb2RpZmllZCB9ID0gdGhpcy52YWxpZGF0ZUFuZENsZWFuQ2FjaGUoY2FjaGUpO1xuXHRcdFxuXHRcdC8vIFNjb3JlIHdpdGggbWV0YWRhdGEgZmlyc3QgKGZhc3QpXG5cdFx0Y29uc3QgdG9wSXRlbXMgPSBhd2FpdCB0aGlzLnNjb3JlQ2FjaGVkSXRlbXNXaXRoTWV0YWRhdGEoY2xlYW5lZENhY2hlLCBxLCBvcHRzLmxpbWl0KTtcblx0XHRcblx0XHQvLyBMb2FkIGZ1bGwgY29udGVudCBmb3IgdG9wIE4gYW5kIHJlLXNjb3JlXG5cdFx0Y29uc3QgcmVzY29yZWRJdGVtcyA9IGF3YWl0IHRoaXMubG9hZEFuZFNjb3JlVG9wSXRlbXModG9wSXRlbXMsIHEpO1xuXHRcdFxuXHRcdC8vIEdlbmVyYXRlIGV4Y2VycHRzIHdpdGggY29udGV4dCBjYXBcblx0XHRjb25zdCByZXN1bHRzOiBDb250ZXh0SXRlbVtdID0gW107XG5cdFx0Y29uc3QgbWF4Q29udGV4dENoYXJzID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heENvbnRleHRDaGFycyA/PyAzMDAwMDtcblx0XHRsZXQgdG90YWxDb250ZXh0Q2hhcnMgPSAwO1xuXHRcdGxldCB0cnVuY2F0ZWRDb3VudCA9IDA7XG5cdFx0XG5cdFx0Zm9yIChjb25zdCBpdGVtIG9mIHJlc2NvcmVkSXRlbXMpIHtcblx0XHRcdGlmIChyZXN1bHRzLmxlbmd0aCA+PSBvcHRzLmxpbWl0KSB7XG5cdFx0XHRcdGJyZWFrO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBDaGVjayBjb250ZXh0IGNhcFxuXHRcdFx0Y29uc3QgZXhjZXJwdCA9IGF3YWl0IHRoaXMuZ2VuZXJhdGVCZXN0TWF0Y2hpbmdFeGNlcnB0KGl0ZW0ucGF0aCwgcSk7XG5cdFx0XHRsZXQgZmluYWxFeGNlcnB0ID0gZXhjZXJwdDtcblx0XHRcdFxuXHRcdFx0aWYgKHRvdGFsQ29udGV4dENoYXJzICsgZXhjZXJwdC5sZW5ndGggPiBtYXhDb250ZXh0Q2hhcnMpIHtcblx0XHRcdFx0Ly8gUG9saWN5OiB0cnVuY2F0ZSBjdXJyZW50IGV4Y2VycHQgdG8gZml0XG5cdFx0XHRcdGNvbnN0IHJlbWFpbmluZyA9IG1heENvbnRleHRDaGFycyAtIHRvdGFsQ29udGV4dENoYXJzO1xuXHRcdFx0XHRmaW5hbEV4Y2VycHQgPSBleGNlcnB0LnNsaWNlKDAsIHJlbWFpbmluZykgKyAn4oCmJztcblx0XHRcdFx0dHJ1bmNhdGVkQ291bnQrKztcblx0XHRcdFx0XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NvbnRleHQgY2FwIHJlYWNoZWQsIHRydW5jYXRpbmcgZXhjZXJwdCcsIHtcblx0XHRcdFx0XHR0b3RhbENoYXJzOiB0b3RhbENvbnRleHRDaGFycyArIGZpbmFsRXhjZXJwdC5sZW5ndGgsXG5cdFx0XHRcdFx0cmVtYWluaW5nLFxuXHRcdFx0XHRcdHRydW5jYXRlZDogdHJ1ZSxcblx0XHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdHRvdGFsQ29udGV4dENoYXJzICs9IGZpbmFsRXhjZXJwdC5sZW5ndGg7XG5cdFx0XHRcblx0XHRcdHJlc3VsdHMucHVzaCh7XG5cdFx0XHRcdGtleTogaXRlbS5wYXRoLFxuXHRcdFx0XHRwYXRoOiBpdGVtLnBhdGgsXG5cdFx0XHRcdHRpdGxlOiBpdGVtLnBhdGguc3BsaXQoJy8nKS5wb3AoKSB8fCBpdGVtLnBhdGgsXG5cdFx0XHRcdGV4Y2VycHQ6IGZpbmFsRXhjZXJwdCxcblx0XHRcdFx0c2NvcmU6IGl0ZW0uZmluYWxTY29yZSxcblx0XHRcdFx0c291cmNlOiB0aGlzLmlkLFxuXHRcdFx0XHRyZWFzb25UYWdzOiBbJ3NtYXJ0LWNvbm5lY3Rpb25zLWNhY2hlZCddXG5cdFx0XHR9KTtcblx0XHR9XG5cdFx0XG5cdFx0aWYgKHRydW5jYXRlZENvdW50ID4gMCkge1xuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ29udGV4dCBjYXAgc3VtbWFyeScsIHtcblx0XHRcdFx0dG90YWxDaGFyczogdG90YWxDb250ZXh0Q2hhcnMsXG5cdFx0XHRcdG1heENoYXJzOiBtYXhDb250ZXh0Q2hhcnMsXG5cdFx0XHRcdHRydW5jYXRlZDogdHJ1bmNhdGVkQ291bnQsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFNhdmUgY2FjaGUgaWYgbW9kaWZpZWQgKHNpbmdsZSB3cml0ZWJhY2spXG5cdFx0aWYgKHdhc01vZGlmaWVkKSB7XG5cdFx0XHRhd2FpdCB0aGlzLnNhdmVDYWNoZShjbGVhbmVkQ2FjaGUpO1xuXHRcdH1cblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTZWFyY2ggY29tcGxldGUnLCB7XG5cdFx0XHRyZXN1bHRzOiByZXN1bHRzLmxlbmd0aCxcblx0XHRcdG1ldGhvZDogJ2NhY2hlZCcsXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHRyZXR1cm4gcmVzdWx0cztcblx0fVxuXG5cdC8qKlxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGNhcHR1cmUgZnJvbSBET00gYW5kIHNhdmUgdG8gY2FjaGUuXG5cdCAqL1xuXHRhc3luYyBjYXB0dXJlQW5kU2F2ZUZyb21Eb20oc291cmNlTm90ZVBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPHsgc3VjY2VzczogYm9vbGVhbjsgY291bnQ6IG51bWJlcjsgbWVzc2FnZT86IHN0cmluZyB9PiB7XG5cdFx0Y29uc3QgcmVzdWx0cyA9IGF3YWl0IHRoaXMuY2FwdHVyZUZyb21Eb20oc291cmNlTm90ZVBhdGgpO1xuXHRcdFxuXHRcdGlmIChyZXN1bHRzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0c3VjY2VzczogZmFsc2UsXG5cdFx0XHRcdGNvdW50OiAwLFxuXHRcdFx0XHRtZXNzYWdlOiAnU21hcnQgQ29ubmVjdGlvbnMgdmlldyBpcyBvcGVuIGJ1dCBubyByZXN1bHRzIGZvdW5kLiBUcnkgcnVubmluZyBhIHNlYXJjaCBpbiBTbWFydCBDb25uZWN0aW9ucyBmaXJzdC4nXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRcblx0XHRjb25zdCB2YXVsdElkID0gdGhpcy5nZXRWYXVsdElkKCk7XG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xuXHRcdFxuXHRcdGNvbnN0IGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUgPSB7XG5cdFx0XHRzb3VyY2VOb3RlUGF0aCxcblx0XHRcdHZhdWx0SWQsXG5cdFx0XHRyZXN1bHRzOiByZXN1bHRzLm1hcCgociwgaSkgPT4gKHtcblx0XHRcdFx0cGF0aDogci5wYXRoLFxuXHRcdFx0XHRzY29yZTogci5zY29yZSxcblx0XHRcdFx0Y2FwdHVyZWRBdDogRGF0ZS5ub3coKVxuXHRcdFx0fSkpLFxuXHRcdFx0Y2FwdHVyZWRBdDogRGF0ZS5ub3coKSxcblx0XHRcdG1ldGhvZDogJ2RvbScsXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9O1xuXHRcdFxuXHRcdGF3YWl0IHRoaXMuc2F2ZUNhY2hlKGNhY2hlKTtcblx0XHRcblx0XHRyZXR1cm4ge1xuXHRcdFx0c3VjY2VzczogdHJ1ZSxcblx0XHRcdGNvdW50OiByZXN1bHRzLmxlbmd0aFxuXHRcdH07XG5cdH1cblxuXHQvKipcblx0ICogUHVibGljIG1ldGhvZCB0byBjYXB0dXJlIGZyb20gY2xpcGJvYXJkIGFuZCBzYXZlIHRvIGNhY2hlLlxuXHQgKi9cblx0YXN5bmMgY2FwdHVyZUFuZFNhdmVGcm9tQ2xpcGJvYXJkKHNvdXJjZU5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTx7IHN1Y2Nlc3M6IGJvb2xlYW47IGNvdW50OiBudW1iZXI7IG1lc3NhZ2U/OiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IHJlc3VsdHMgPSBhd2FpdCB0aGlzLmNhcHR1cmVGcm9tQ2xpcGJvYXJkKHNvdXJjZU5vdGVQYXRoKTtcblx0XHRcblx0XHRpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0XHRjb3VudDogMCxcblx0XHRcdFx0bWVzc2FnZTogJ05vIHZhbGlkIGxpbmtzIGZvdW5kIGluIGNsaXBib2FyZC4gRW5zdXJlIGNsaXBib2FyZCBjb250YWlucyBTbWFydCBDb25uZWN0aW9ucyByZXN1bHRzIHdpdGggbWFya2Rvd24gbGlua3MuJ1xuXHRcdFx0fTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgdmF1bHRJZCA9IHRoaXMuZ2V0VmF1bHRJZCgpO1xuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcblx0XHRcblx0XHRjb25zdCBjYWNoZTogU21hcnRDb25uZWN0aW9uc0NhY2hlID0ge1xuXHRcdFx0c291cmNlTm90ZVBhdGgsXG5cdFx0XHR2YXVsdElkLFxuXHRcdFx0cmVzdWx0czogcmVzdWx0cy5tYXAoKHIsIGkpID0+ICh7XG5cdFx0XHRcdHBhdGg6IHIucGF0aCxcblx0XHRcdFx0c2NvcmU6IHIuc2NvcmUsXG5cdFx0XHRcdGNhcHR1cmVkQXQ6IERhdGUubm93KClcblx0XHRcdH0pKSxcblx0XHRcdGNhcHR1cmVkQXQ6IERhdGUubm93KCksXG5cdFx0XHRtZXRob2Q6ICdjbGlwYm9hcmQnLFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fTtcblx0XHRcblx0XHRhd2FpdCB0aGlzLnNhdmVDYWNoZShjYWNoZSk7XG5cdFx0XG5cdFx0cmV0dXJuIHtcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRjb3VudDogcmVzdWx0cy5sZW5ndGhcblx0XHR9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFB1YmxpYyBtZXRob2QgdG8gY2xlYXIgY2FjaGUuXG5cdCAqL1xuXHRhc3luYyBjbGVhckNhY2hlKCk6IFByb21pc2U8dm9pZD4ge1xuXHRcdHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNDYWNoZSA9IHVuZGVmaW5lZDtcblx0XHRhd2FpdCB0aGlzLnBsdWdpbi5zYXZlU2V0dGluZ3MoKTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdDYWNoZSBjbGVhcmVkJywge1xuXHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHR9KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGdldCBjYWNoZSBzdGF0dXMuXG5cdCAqL1xuXHRnZXRDYWNoZVN0YXR1cygpOiB7XG5cdFx0ZXhpc3RzOiBib29sZWFuO1xuXHRcdGVuYWJsZWQ6IGJvb2xlYW47XG5cdFx0Y291bnQ6IG51bWJlcjtcblx0XHRhZ2U/OiBzdHJpbmc7XG5cdFx0bWV0aG9kPzogJ2RvbScgfCAnY2xpcGJvYXJkJztcblx0XHRzb3VyY2VOb3RlPzogc3RyaW5nO1xuXHRcdGZyZXNoOiBib29sZWFuO1xuXHR9IHtcblx0XHRjb25zdCBlbmFibGVkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlRW5hYmxlZCA/PyBmYWxzZTtcblx0XHRjb25zdCBjYWNoZSA9IHRoaXMuZ2V0Q2FjaGUoKTtcblx0XHRcblx0XHRpZiAoIWNhY2hlKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRleGlzdHM6IGZhbHNlLFxuXHRcdFx0XHRlbmFibGVkLFxuXHRcdFx0XHRjb3VudDogMCxcblx0XHRcdFx0ZnJlc2g6IGZhbHNlXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRcblx0XHRjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gY2FjaGUuY2FwdHVyZWRBdDtcblx0XHRjb25zdCBhZ2VIb3VycyA9IE1hdGguZmxvb3IoYWdlIC8gKDEwMDAgKiA2MCAqIDYwKSk7XG5cdFx0Y29uc3QgYWdlTWludXRlcyA9IE1hdGguZmxvb3IoKGFnZSAlICgxMDAwICogNjAgKiA2MCkpIC8gKDEwMDAgKiA2MCkpO1xuXHRcdGNvbnN0IGFnZVN0ciA9IGFnZUhvdXJzID4gMCA/IGAke2FnZUhvdXJzfWggJHthZ2VNaW51dGVzfW1gIDogYCR7YWdlTWludXRlc31tYDtcblx0XHRcblx0XHRyZXR1cm4ge1xuXHRcdFx0ZXhpc3RzOiB0cnVlLFxuXHRcdFx0ZW5hYmxlZCxcblx0XHRcdGNvdW50OiBjYWNoZS5yZXN1bHRzLmxlbmd0aCxcblx0XHRcdGFnZTogYWdlU3RyLFxuXHRcdFx0bWV0aG9kOiBjYWNoZS5tZXRob2QsXG5cdFx0XHRzb3VyY2VOb3RlOiBjYWNoZS5zb3VyY2VOb3RlUGF0aCxcblx0XHRcdGZyZXNoOiB0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSlcblx0XHR9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFB1YmxpYyBtZXRob2QgdG8gY2hlY2sgaWYgU21hcnQgQ29ubmVjdGlvbnMgdmlldyBpcyBhdmFpbGFibGUgZm9yIGNhcHR1cmUuXG5cdCAqL1xuXHRjaGVja1ZpZXdBdmFpbGFibGUoKTogeyBhdmFpbGFibGU6IGJvb2xlYW47IG1lc3NhZ2U/OiBzdHJpbmcgfSB7XG5cdFx0Y29uc3Qgc2NWaWV3ID0gdGhpcy5maW5kU21hcnRDb25uZWN0aW9uc1ZpZXcoKTtcblx0XHRpZiAoIXNjVmlldykge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0YXZhaWxhYmxlOiBmYWxzZSxcblx0XHRcdFx0bWVzc2FnZTogJ1NtYXJ0IENvbm5lY3Rpb25zIHZpZXcgbm90IGZvdW5kLiBPcGVuIFNtYXJ0IENvbm5lY3Rpb25zIGluIGEgcGFuZSBmaXJzdC4nXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRcblx0XHRjb25zdCBpbnRlcm5hbExpbmtzID0gc2NWaWV3LnZpZXcuY29udGFpbmVyRWwucXVlcnlTZWxlY3RvckFsbCgnYS5pbnRlcm5hbC1saW5rW2RhdGEtaHJlZl0nKTtcblx0XHRpZiAoaW50ZXJuYWxMaW5rcy5sZW5ndGggPT09IDApIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGF2YWlsYWJsZTogZmFsc2UsXG5cdFx0XHRcdG1lc3NhZ2U6ICdTbWFydCBDb25uZWN0aW9ucyB2aWV3IGlzIG9wZW4gYnV0IG5vIHJlc3VsdHMgZm91bmQuIFRyeSBydW5uaW5nIGEgc2VhcmNoIGluIFNtYXJ0IENvbm5lY3Rpb25zIGZpcnN0Lidcblx0XHRcdH07XG5cdFx0fVxuXHRcdFxuXHRcdHJldHVybiB7XG5cdFx0XHRhdmFpbGFibGU6IHRydWVcblx0XHR9O1xuXHR9XG5cblx0LyoqXG5cdCAqIEdldCBjYWNoZWQgZmlsZSBwYXRocyBkaXJlY3RseSAobm8gc2VhcmNoLCBubyBBUEkgY2FsbHMpLlxuXHQgKiBVc2VkIGZvciBwdXJlIGJvb3N0L2ZpbHRlciBvcGVyYXRpb25zIGluIGh5YnJpZCByZXRyaWV2YWwuXG5cdCAqL1xuXHRhc3luYyBnZXRDYWNoZVBhdGhzKCk6IFByb21pc2U8c3RyaW5nW10+IHtcblx0XHRjb25zdCBjYWNoZSA9IHRoaXMuZ2V0Q2FjaGUoKTtcblx0XHRpZiAoIWNhY2hlKSByZXR1cm4gW107XG5cdFx0XG5cdFx0Y29uc3QgZW5hYmxlZCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNDYWNoZUVuYWJsZWQgPz8gZmFsc2U7XG5cdFx0aWYgKCFlbmFibGVkKSByZXR1cm4gW107XG5cdFx0XG5cdFx0Ly8gQ2hlY2sgZnJlc2huZXNzXG5cdFx0aWYgKCF0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSkpIHJldHVybiBbXTtcblx0XHRcblx0XHQvLyBSZXR1cm4ganVzdCB0aGUgcGF0aHMgLSBubyBzY29yaW5nLCBubyBBUEkgY2FsbHNcblx0XHRyZXR1cm4gY2FjaGUucmVzdWx0cy5tYXAociA9PiByLnBhdGgpO1xuXHR9XG59XG4iXX0=