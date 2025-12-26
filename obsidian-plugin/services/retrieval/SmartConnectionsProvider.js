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
            console.log(logMessage);
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
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiU21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUVBLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxVQUFVLENBQUM7QUFnQ2pDOzs7R0FHRztBQUNILE1BQU0sT0FBTyx3QkFBd0I7SUFTcEMsWUFDQyxHQUFRLEVBQ1IsTUFBOEIsRUFDOUIsS0FBWSxFQUNaLGFBQXdDO1FBWmhDLE9BQUUsR0FBRyxtQkFBbUIsQ0FBQztRQU0xQixxQkFBZ0IsR0FBVyxFQUFFLENBQUM7UUFRckMsSUFBSSxDQUFDLEdBQUcsR0FBRyxHQUFHLENBQUM7UUFDZixJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztRQUNyQixJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsYUFBYSxHQUFHLGFBQWEsQ0FBQztRQUNuQyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUMxQixDQUFDO0lBRUQ7O09BRUc7SUFDSyxpQkFBaUI7UUFDeEIsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7SUFDbkQsQ0FBQztJQUVEOztPQUVHO0lBQ0ssaUJBQWlCO1FBQ3hCLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztJQUNsRCxDQUFDO0lBRUQ7O09BRUc7SUFDSyxHQUFHLENBQUMsS0FBZ0MsRUFBRSxPQUFlLEVBQUUsT0FBaUMsRUFBRSxPQUFpQztRQUNsSSxNQUFNLFNBQVMsR0FBRyxJQUFJLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQzNDLE1BQU0sVUFBVSxHQUFHLElBQUksS0FB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LENBQUM7Q0FDRCIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgQ29udGV4dEl0ZW0sIFJldHJpZXZhbE9wdGlvbnMsIFJldHJpZXZhbFByb3ZpZGVyLCBSZXRyaWV2YWxRdWVyeSB9IGZyb20gJy4vdHlwZXMnO1xuaW1wb3J0IHR5cGUgeyBBcHAsIFZhdWx0LCBXb3Jrc3BhY2VMZWFmIH0gZnJvbSAnb2JzaWRpYW4nO1xuaW1wb3J0IHsgVEZpbGUgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgV3JpdGluZ0Rhc2hib2FyZFBsdWdpbiBmcm9tICcuLi8uLi9tYWluJztcblxuLyoqXG4gKiBTbWFydCBDb25uZWN0aW9ucyBjYWNoZSBzdHJ1Y3R1cmUuXG4gKi9cbmludGVyZmFjZSBTbWFydENvbm5lY3Rpb25zQ2FjaGUge1xuXHRzb3VyY2VOb3RlUGF0aD86IHN0cmluZztcblx0dmF1bHRJZD86IHN0cmluZztcblx0cmVzdWx0czogQXJyYXk8e1xuXHRcdHBhdGg6IHN0cmluZztcblx0XHRzY29yZT86IG51bWJlcjtcblx0XHRjYXB0dXJlZFNuaXBwZXQ/OiBzdHJpbmc7XG5cdFx0Y2FwdHVyZWRBdD86IG51bWJlcjtcblx0fT47XG5cdGNhcHR1cmVkQXQ6IG51bWJlcjtcblx0bWV0aG9kOiAnZG9tJyB8ICdjbGlwYm9hcmQnO1xuXHRzZXNzaW9uSWQ6IHN0cmluZztcbn1cblxuLyoqXG4gKiBDYWNoZWQgcmVzdWx0IGl0ZW0gd2l0aCBzY29yaW5nIGluZm9ybWF0aW9uLlxuICovXG5pbnRlcmZhY2UgU2NvcmVkQ2FjaGVJdGVtIHtcblx0cGF0aDogc3RyaW5nO1xuXHRyYW5rU2NvcmU6IG51bWJlcjtcblx0bWV0YWRhdGFTY29yZTogbnVtYmVyO1xuXHRmdWxsQ29udGVudFNjb3JlPzogbnVtYmVyO1xuXHRmaW5hbFNjb3JlOiBudW1iZXI7XG5cdGNhcHR1cmVkQXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogUmV0cmlldmFsIHByb3ZpZGVyIHRoYXQgdXNlcyBTbWFydCBDb25uZWN0aW9ucyBwbHVnaW4gdmlhIGNhcHR1cmUgYW5kIGNhY2hlIHN5c3RlbS5cbiAqIENhcHR1cmVzIHJlc3VsdHMgZnJvbSBET00gb3IgY2xpcGJvYXJkLCBjYWNoZXMgdGhlbSwgYW5kIHVzZXMgY2FjaGVkIGRhdGEgZm9yIHJldHJpZXZhbC5cbiAqL1xuZXhwb3J0IGNsYXNzIFNtYXJ0Q29ubmVjdGlvbnNQcm92aWRlciBpbXBsZW1lbnRzIFJldHJpZXZhbFByb3ZpZGVyIHtcblx0cmVhZG9ubHkgaWQgPSAnc21hcnQtY29ubmVjdGlvbnMnO1xuXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xuXHRwcml2YXRlIHJlYWRvbmx5IGFwcDogQXBwO1xuXHRwcml2YXRlIHJlYWRvbmx5IHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbjtcblx0cHJpdmF0ZSByZWFkb25seSBpc0FsbG93ZWRQYXRoOiAocGF0aDogc3RyaW5nKSA9PiBib29sZWFuO1xuXHRwcml2YXRlIGN1cnJlbnRTZXNzaW9uSWQ6IHN0cmluZyA9ICcnO1xuXG5cdGNvbnN0cnVjdG9yKFxuXHRcdGFwcDogQXBwLFxuXHRcdHBsdWdpbjogV3JpdGluZ0Rhc2hib2FyZFBsdWdpbixcblx0XHR2YXVsdDogVmF1bHQsXG5cdFx0aXNBbGxvd2VkUGF0aDogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhblxuXHQpIHtcblx0XHR0aGlzLmFwcCA9IGFwcDtcblx0XHR0aGlzLnBsdWdpbiA9IHBsdWdpbjtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5pc0FsbG93ZWRQYXRoID0gaXNBbGxvd2VkUGF0aDtcblx0XHR0aGlzLmluaXRpYWxpemVTZXNzaW9uKCk7XG5cdFx0dGhpcy5sb2dJbml0aWFsaXphdGlvbigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIEdlbmVyYXRlIGEgbmV3IHNlc3Npb24gSUQgZm9yIGxvZ2dpbmcgZ3JvdXBpbmcuXG5cdCAqL1xuXHRwcml2YXRlIGdlbmVyYXRlU2Vzc2lvbklkKCk6IHN0cmluZyB7XG5cdFx0cmV0dXJuIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnN1YnN0cmluZygyLCA4KTtcblx0fVxuXG5cdC8qKlxuXHQgKiBJbml0aWFsaXplIHNlc3Npb24gSUQgZm9yIHRoaXMgaW5zdGFuY2UuXG5cdCAqL1xuXHRwcml2YXRlIGluaXRpYWxpemVTZXNzaW9uKCk6IHZvaWQge1xuXHRcdHRoaXMuY3VycmVudFNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTdHJ1Y3R1cmVkIGxvZ2dpbmcgaGVscGVyIHdpdGggc2Vzc2lvbiBJRCBzdXBwb3J0LlxuXHQgKi9cblx0cHJpdmF0ZSBsb2cobGV2ZWw6ICdpbmZvJyB8ICd3YXJuJyB8ICdlcnJvcicsIG1lc3NhZ2U6IHN0cmluZywgY29udGV4dD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBkZXRhaWxzPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB2b2lkIHtcblx0XHRjb25zdCB0aW1lc3RhbXAgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG5cdFx0Y29uc3QgbWV0aG9kTmFtZSA9IG5ldyBFcnJvcigpLnN0YWNrPy5zcGxpdCgnXFxuJylbMl0/Lm1hdGNoKC9hdCBcXHcrXFwuKFxcdyspLyk/LlsxXSB8fCAndW5rbm93bic7XG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5jdXJyZW50U2Vzc2lvbklkO1xuXHRcdFxuXHRcdGNvbnN0IGNvbnRleHRTdHIgPSBjb250ZXh0ID8gYCB8IENvbnRleHQ6ICR7SlNPTi5zdHJpbmdpZnkoY29udGV4dCl9YCA6ICcnO1xuXHRcdGNvbnN0IGRldGFpbHNTdHIgPSBkZXRhaWxzID8gYCB8IERldGFpbHM6ICR7SlNPTi5zdHJpbmdpZnkoZGV0YWlscyl9YCA6ICcnO1xuXHRcdFxuXHRcdGNvbnN0IGxvZ01lc3NhZ2UgPSBgW1NtYXJ0Q29ubmVjdGlvbnNQcm92aWRlcjoke21ldGhvZE5hbWV9XVtzaWQ9JHtzZXNzaW9uSWR9XSAke2xldmVsLnRvVXBwZXJDYXNlKCl9OiAke21lc3NhZ2V9JHtjb250ZXh0U3RyfSR7ZGV0YWlsc1N0cn1gO1xuXHRcdFxuXHRcdGlmIChsZXZlbCA9PT0gJ2Vycm9yJykge1xuXHRcdFx0Y29uc29sZS5lcnJvcihsb2dNZXNzYWdlKTtcblx0XHR9IGVsc2UgaWYgKGxldmVsID09PSAnd2FybicpIHtcblx0XHRcdGNvbnNvbGUud2Fybihsb2dNZXNzYWdlKTtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc29sZS5sb2cobG9nTWVzc2FnZSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIExvZyBpbml0aWFsaXphdGlvbiBzdGF0dXMuXG5cdCAqL1xuXHRwcml2YXRlIGxvZ0luaXRpYWxpemF0aW9uKCk6IHZvaWQge1xuXHRcdGNvbnN0IGNhY2hlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlO1xuXHRcdGNvbnN0IGVuYWJsZWQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVFbmFibGVkID8/IGZhbHNlO1xuXHRcdFxuXHRcdGlmIChjYWNoZSkge1xuXHRcdFx0Y29uc3QgYWdlID0gRGF0ZS5ub3coKSAtIGNhY2hlLmNhcHR1cmVkQXQ7XG5cdFx0XHRjb25zdCBhZ2VIb3VycyA9IE1hdGguZmxvb3IoYWdlIC8gKDEwMDAgKiA2MCAqIDYwKSk7XG5cdFx0XHRjb25zdCBhZ2VNaW51dGVzID0gTWF0aC5mbG9vcigoYWdlICUgKDEwMDAgKiA2MCAqIDYwKSkgLyAoMTAwMCAqIDYwKSk7XG5cdFx0XHRjb25zdCBhZ2VTdHIgPSBhZ2VIb3VycyA+IDAgPyBgJHthZ2VIb3Vyc31oICR7YWdlTWludXRlc31tYCA6IGAke2FnZU1pbnV0ZXN9bWA7XG5cdFx0XHRcblx0XHRcdGNvbnN0IGlzRnJlc2ggPSB0aGlzLmlzQ2FjaGVGcmVzaChjYWNoZSk7XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0luaXRpYWxpemF0aW9uIGNvbXBsZXRlJywge1xuXHRcdFx0XHRjYWNoZUVuYWJsZWQ6IGVuYWJsZWQsXG5cdFx0XHRcdGNhY2hlRXhpc3RzOiB0cnVlLFxuXHRcdFx0XHRjYWNoZUFnZTogYWdlU3RyLFxuXHRcdFx0XHRjYWNoZVJlc3VsdHM6IGNhY2hlLnJlc3VsdHMubGVuZ3RoLFxuXHRcdFx0XHRjYWNoZU1ldGhvZDogY2FjaGUubWV0aG9kLFxuXHRcdFx0XHRjYWNoZUZyZXNoOiBpc0ZyZXNoLFxuXHRcdFx0XHRzb3VyY2VOb3RlOiBjYWNoZS5zb3VyY2VOb3RlUGF0aCxcblx0XHRcdFx0dmF1bHRJZDogY2FjaGUudmF1bHRJZFxuXHRcdFx0fSk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0luaXRpYWxpemF0aW9uIGNvbXBsZXRlJywge1xuXHRcdFx0XHRjYWNoZUVuYWJsZWQ6IGVuYWJsZWQsXG5cdFx0XHRcdGNhY2hlRXhpc3RzOiBmYWxzZVxuXHRcdFx0fSk7XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCAqIEdldCB2YXVsdCBJRCAobmFtZSArIG9wdGlvbmFsIGJhc2VQYXRoKS5cblx0ICovXG5cdHByaXZhdGUgZ2V0VmF1bHRJZCgpOiBzdHJpbmcge1xuXHRcdGNvbnN0IHZhdWx0TmFtZSA9IHRoaXMuYXBwLnZhdWx0LmdldE5hbWUoKTtcblx0XHRjb25zdCBhZGFwdGVyID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlciBhcyB7IGJhc2VQYXRoPzogc3RyaW5nIH07XG5cdFx0Y29uc3QgYmFzZVBhdGggPSBhZGFwdGVyLmJhc2VQYXRoIHx8ICcnO1xuXHRcdGNvbnN0IHZhdWx0SWQgPSB2YXVsdE5hbWUgKyAoYmFzZVBhdGggPyBgOiR7YmFzZVBhdGh9YCA6ICcnKTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdWYXVsdCBJRCBnZW5lcmF0ZWQnLCB7XG5cdFx0XHR2YXVsdE5hbWUsXG5cdFx0XHRiYXNlUGF0aDogYmFzZVBhdGggfHwgJyhub3QgYXZhaWxhYmxlKScsXG5cdFx0XHR2YXVsdElkXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIHZhdWx0SWQ7XG5cdH1cblxuXHQvKipcblx0ICogQ2hlY2sgaWYgY2FjaGUgaXMgZnJlc2ggKHdpdGhpbiBUVEwgaWYgc2V0KS5cblx0ICovXG5cdHByaXZhdGUgaXNDYWNoZUZyZXNoKGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUpOiBib29sZWFuIHtcblx0XHRjb25zdCB0dGwgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVUVEw7XG5cdFx0aWYgKCF0dGwpIHtcblx0XHRcdHJldHVybiB0cnVlOyAvLyBObyBUVEwsIGFsd2F5cyBmcmVzaFxuXHRcdH1cblx0XHRcblx0XHRjb25zdCBhZ2UgPSBEYXRlLm5vdygpIC0gY2FjaGUuY2FwdHVyZWRBdDtcblx0XHRjb25zdCB0dGxNcyA9IHR0bCAqIDYwICogNjAgKiAxMDAwO1xuXHRcdGNvbnN0IGZyZXNoID0gYWdlIDwgdHRsTXM7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgZnJlc2huZXNzIGNoZWNrJywge1xuXHRcdFx0YWdlOiBgJHtNYXRoLmZsb29yKGFnZSAvICgxMDAwICogNjAgKiA2MCkpfWhgLFxuXHRcdFx0dHRsOiBgJHt0dGx9aGAsXG5cdFx0XHRmcmVzaFxuXHRcdH0pO1xuXHRcdFxuXHRcdHJldHVybiBmcmVzaDtcblx0fVxuXG5cdC8qKlxuXHQgKiBOb3JtYWxpemUgZm9sZGVyIHBhdGggZm9yIGNvbXBhcmlzb24gKHJlbW92ZSBsZWFkaW5nIHNsYXNoLCBlbnN1cmUgdHJhaWxpbmcgc2xhc2gpLlxuXHQgKi9cblx0cHJpdmF0ZSBub3JtYWxpemVGb2xkZXJQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0bGV0IG5vcm1hbGl6ZWQgPSBwYXRoLnJlcGxhY2UoL15cXC8rLywgJycpOyAvLyBSZW1vdmUgbGVhZGluZyBzbGFzaGVzXG5cdFx0aWYgKG5vcm1hbGl6ZWQgJiYgIW5vcm1hbGl6ZWQuZW5kc1dpdGgoJy8nKSkge1xuXHRcdFx0bm9ybWFsaXplZCArPSAnLyc7IC8vIEVuc3VyZSB0cmFpbGluZyBzbGFzaFxuXHRcdH1cblx0XHRyZXR1cm4gbm9ybWFsaXplZDtcblx0fVxuXG5cdC8qKlxuXHQgKiBDaGVjayBpZiBwYXRoIGlzIGFsbG93ZWQgYmFzZWQgb24gZm9sZGVyIGZpbHRlcnMuXG5cdCAqL1xuXHRwcml2YXRlIGlzUGF0aEFsbG93ZWQocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG5cdFx0Y29uc3QgYWxsb3dlZCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNBbGxvd2VkRm9sZGVycyB8fCBbXTtcblx0XHRjb25zdCBibG9ja2VkID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0Jsb2NrZWRGb2xkZXJzIHx8IFtdO1xuXHRcdFxuXHRcdC8vIE5vcm1hbGl6ZSBwYXRoIGZvciBjb21wYXJpc29uXG5cdFx0Y29uc3Qgbm9ybWFsaXplZFBhdGggPSB0aGlzLm5vcm1hbGl6ZUZvbGRlclBhdGgocGF0aCk7XG5cdFx0XG5cdFx0Ly8gQ2hlY2sgYmxvY2tsaXN0IGZpcnN0XG5cdFx0Zm9yIChjb25zdCBibG9ja2VkRm9sZGVyIG9mIGJsb2NrZWQpIHtcblx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRCbG9ja2VkID0gdGhpcy5ub3JtYWxpemVGb2xkZXJQYXRoKGJsb2NrZWRGb2xkZXIpO1xuXHRcdFx0aWYgKG5vcm1hbGl6ZWRQYXRoID09PSBub3JtYWxpemVkQmxvY2tlZCB8fCBub3JtYWxpemVkUGF0aC5zdGFydHNXaXRoKG5vcm1hbGl6ZWRCbG9ja2VkKSkge1xuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdQYXRoIGJsb2NrZWQgYnkgZmlsdGVyJywge1xuXHRcdFx0XHRcdHBhdGgsXG5cdFx0XHRcdFx0YmxvY2tlZEZvbGRlcixcblx0XHRcdFx0XHRub3JtYWxpemVkUGF0aCxcblx0XHRcdFx0XHRub3JtYWxpemVkQmxvY2tlZFxuXHRcdFx0XHR9KTtcblx0XHRcdFx0cmV0dXJuIGZhbHNlO1xuXHRcdFx0fVxuXHRcdH1cblx0XHRcblx0XHQvLyBDaGVjayBhbGxvd2xpc3QgKGlmIHNldCwgcGF0aCBtdXN0IGJlIGluIGFsbG93ZWQgZm9sZGVycylcblx0XHRpZiAoYWxsb3dlZC5sZW5ndGggPiAwKSB7XG5cdFx0XHRjb25zdCBpc0FsbG93ZWQgPSBhbGxvd2VkLnNvbWUoYWxsb3dlZEZvbGRlciA9PiB7XG5cdFx0XHRcdGNvbnN0IG5vcm1hbGl6ZWRBbGxvd2VkID0gdGhpcy5ub3JtYWxpemVGb2xkZXJQYXRoKGFsbG93ZWRGb2xkZXIpO1xuXHRcdFx0XHRyZXR1cm4gbm9ybWFsaXplZFBhdGggPT09IG5vcm1hbGl6ZWRBbGxvd2VkIHx8IG5vcm1hbGl6ZWRQYXRoLnN0YXJ0c1dpdGgobm9ybWFsaXplZEFsbG93ZWQpO1xuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdGlmICghaXNBbGxvd2VkKSB7XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ1BhdGggbm90IGluIGFsbG93ZWQgZm9sZGVycycsIHtcblx0XHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRcdGFsbG93ZWRGb2xkZXJzOiBhbGxvd2VkLFxuXHRcdFx0XHRcdG5vcm1hbGl6ZWRQYXRoXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdFxuXHRcdHJldHVybiB0cnVlO1xuXHR9XG5cblx0LyoqXG5cdCAqIENoZWNrIGNhY2hlIGtleWluZyBtYXRjaCAoc29mdC9zdHJpY3QgbW9kZSkuXG5cdCAqL1xuXHRwcml2YXRlIGNoZWNrQ2FjaGVLZXlpbmcoY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSwgY3VycmVudE5vdGVQYXRoPzogc3RyaW5nKTogeyBtYXRjaDogYm9vbGVhbjsgY3VycmVudE5vdGU/OiBzdHJpbmc7IGNhY2hlTm90ZT86IHN0cmluZyB9IHtcblx0XHRpZiAoIWNhY2hlLnNvdXJjZU5vdGVQYXRoKSB7XG5cdFx0XHRyZXR1cm4geyBtYXRjaDogdHJ1ZSB9OyAvLyBObyBrZXlpbmcsIGFsd2F5cyBtYXRjaFxuXHRcdH1cblx0XHRcblx0XHRpZiAoIWN1cnJlbnROb3RlUGF0aCkge1xuXHRcdFx0cmV0dXJuIHsgbWF0Y2g6IHRydWUgfTsgLy8gTm8gY3VycmVudCBub3RlLCBhbGxvdyB1c2Vcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgbWF0Y2ggPSBjYWNoZS5zb3VyY2VOb3RlUGF0aCA9PT0gY3VycmVudE5vdGVQYXRoO1xuXHRcdGlmICghbWF0Y2gpIHtcblx0XHRcdGNvbnN0IG1vZGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zS2V5aW5nTW9kZSB8fCAnc29mdCc7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2gnLCB7XG5cdFx0XHRcdGN1cnJlbnROb3RlOiBjdXJyZW50Tm90ZVBhdGgsXG5cdFx0XHRcdGNhY2hlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXG5cdFx0XHRcdG1vZGVcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHRyZXR1cm4geyBtYXRjaCwgY3VycmVudE5vdGU6IGN1cnJlbnROb3RlUGF0aCwgY2FjaGVOb3RlOiBjYWNoZS5zb3VyY2VOb3RlUGF0aCB9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFZhbGlkYXRlIGFuZCBjbGVhbiBjYWNoZSAocmVtb3ZlIG1pc3NpbmcgZmlsZXMsIGluLW1lbW9yeSBvbmx5KS5cblx0ICovXG5cdHByaXZhdGUgdmFsaWRhdGVBbmRDbGVhbkNhY2hlKGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGUpOiB7IGNhY2hlOiBTbWFydENvbm5lY3Rpb25zQ2FjaGU7IHdhc01vZGlmaWVkOiBib29sZWFuIH0ge1xuXHRcdGNvbnN0IG9yaWdpbmFsQ291bnQgPSBjYWNoZS5yZXN1bHRzLmxlbmd0aDtcblx0XHRjb25zdCB2YWxpZFJlc3VsdHMgPSBjYWNoZS5yZXN1bHRzLmZpbHRlcihyZXN1bHQgPT4ge1xuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHJlc3VsdC5wYXRoKTtcblx0XHRcdHJldHVybiBmaWxlIGluc3RhbmNlb2YgVEZpbGU7XG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc3Qgd2FzTW9kaWZpZWQgPSB2YWxpZFJlc3VsdHMubGVuZ3RoICE9PSBvcmlnaW5hbENvdW50O1xuXHRcdFxuXHRcdGlmICh3YXNNb2RpZmllZCkge1xuXHRcdFx0Y29uc3QgZHJvcHBlZCA9IG9yaWdpbmFsQ291bnQgLSB2YWxpZFJlc3VsdHMubGVuZ3RoO1xuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnQ2FjaGUgaW52YWxpZGF0aW9uJywge1xuXHRcdFx0XHRkcm9wcGVkLFxuXHRcdFx0XHRvcmlnaW5hbENvdW50LFxuXHRcdFx0XHR2YWxpZDogdmFsaWRSZXN1bHRzLmxlbmd0aFxuXHRcdFx0fSk7XG5cdFx0XHRjYWNoZS5yZXN1bHRzID0gdmFsaWRSZXN1bHRzOyAvLyBJbi1tZW1vcnkgb25seVxuXHRcdH1cblx0XHRcblx0XHRyZXR1cm4geyBjYWNoZSwgd2FzTW9kaWZpZWQgfTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTYXZlIGNhY2hlIHRvIHNldHRpbmdzICh3aXRoIHNhbml0eSBndWFyZCkuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIHNhdmVDYWNoZShjYWNoZTogU21hcnRDb25uZWN0aW9uc0NhY2hlKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Ly8gU2FuaXR5IGd1YXJkOiBkb24ndCBvdmVyd3JpdGUgY2FjaGUgaWYgY2FwdHVyZSByZXR1cm5lZCAwIHJlc3VsdHNcblx0XHRpZiAoY2FjaGUucmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0NhcHR1cmUgcmV0dXJuZWQgMCByZXN1bHRzLCBwcmVzZXJ2aW5nIGV4aXN0aW5nIGNhY2hlJywge1xuXHRcdFx0XHRzZXNzaW9uSWQ6IGNhY2hlLnNlc3Npb25JZCxcblx0XHRcdFx0bWV0aG9kOiBjYWNoZS5tZXRob2Rcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuOyAvLyBEb24ndCBvdmVyd3JpdGUgZXhpc3RpbmcgY2FjaGVcblx0XHR9XG5cdFx0XG5cdFx0dGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc0NhY2hlID0gY2FjaGU7XG5cdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgc2F2ZWQnLCB7XG5cdFx0XHRyZXN1bHRzOiBjYWNoZS5yZXN1bHRzLmxlbmd0aCxcblx0XHRcdG1ldGhvZDogY2FjaGUubWV0aG9kLFxuXHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXG5cdFx0XHR2YXVsdElkOiBjYWNoZS52YXVsdElkXG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogR2V0IGNhY2hlIGZyb20gc2V0dGluZ3MuXG5cdCAqL1xuXHRwcml2YXRlIGdldENhY2hlKCk6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSB8IG51bGwge1xuXHRcdHJldHVybiB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGUgfHwgbnVsbDtcblx0fVxuXG5cdC8qKlxuXHQgKiBGaW5kIFNtYXJ0IENvbm5lY3Rpb25zIHZpZXcgdXNpbmcgaGV1cmlzdGljIGRldGVjdGlvbi5cblx0ICovXG5cdHByaXZhdGUgZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk6IFdvcmtzcGFjZUxlYWYgfCBudWxsIHtcblx0XHRjb25zdCBsZWF2ZXM6IFdvcmtzcGFjZUxlYWZbXSA9IFtdO1xuXHRcdHRoaXMuYXBwLndvcmtzcGFjZS5pdGVyYXRlQWxsTGVhdmVzKChsZWFmKSA9PiB7XG5cdFx0XHRsZWF2ZXMucHVzaChsZWFmKTtcblx0XHR9KTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTY2FubmluZyB3b3Jrc3BhY2UgbGVhdmVzJywge1xuXHRcdFx0dG90YWxMZWF2ZXM6IGxlYXZlcy5sZW5ndGhcblx0XHR9KTtcblx0XHRcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IGxlYXZlcy5sZW5ndGg7IGkrKykge1xuXHRcdFx0Y29uc3QgbGVhZiA9IGxlYXZlc1tpXTtcblx0XHRcdGNvbnN0IHZpZXdUeXBlID0gbGVhZi52aWV3LmdldFZpZXdUeXBlPy4oKSB8fCAndW5rbm93bic7XG5cdFx0XHRjb25zdCBjb250YWluZXJFbCA9IGxlYWYudmlldy5jb250YWluZXJFbDtcblx0XHRcdFxuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2hlY2tpbmcgbGVhZicsIHtcblx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdHZpZXdUeXBlLFxuXHRcdFx0XHRjb250YWluZXJDbGFzc2VzOiBBcnJheS5mcm9tKGNvbnRhaW5lckVsLmNsYXNzTGlzdCB8fCBbXSkuam9pbignLCAnKVxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdC8vIENoZWNrIGZvciBTQyBtYXJrZXJzIHdpdGggY29uZmlkZW5jZSBicmVhZGNydW1ic1xuXHRcdFx0bGV0IGNvbmZpZGVuY2UgPSAnbm9uZSc7XG5cdFx0XHRsZXQgbWFya2VyID0gJyc7XG5cdFx0XHRcblx0XHRcdC8vIE1hcmtlciAxOiBjbGFzcyBjb250YWlucyAnc21hcnQtY29ubmVjdGlvbnMnXG5cdFx0XHRpZiAoY29udGFpbmVyRWwuY2xhc3NMaXN0LmNvbnRhaW5zKCdzbWFydC1jb25uZWN0aW9ucycpIHx8IFxuXHRcdFx0ICAgIEFycmF5LmZyb20oY29udGFpbmVyRWwuY2xhc3NMaXN0KS5zb21lKGMgPT4gYy5pbmNsdWRlcygnc21hcnQtY29ubmVjdGlvbnMnKSkpIHtcblx0XHRcdFx0Y29uZmlkZW5jZSA9ICdoaWdoJztcblx0XHRcdFx0bWFya2VyID0gJ2NsYXNzIGNvbnRhaW5zIHNtYXJ0LWNvbm5lY3Rpb25zJztcblx0XHRcdH1cblx0XHRcdC8vIE1hcmtlciAyOiBjb250YWlucyB0ZXh0ICdDb25uZWN0aW9ucydcblx0XHRcdGVsc2UgaWYgKGNvbnRhaW5lckVsLnRleHRDb250ZW50Py5pbmNsdWRlcygnQ29ubmVjdGlvbnMnKSkge1xuXHRcdFx0XHRjb25maWRlbmNlID0gJ21lZGl1bSc7XG5cdFx0XHRcdG1hcmtlciA9ICdjb250YWlucyB0ZXh0IENvbm5lY3Rpb25zJztcblx0XHRcdH1cblx0XHRcdC8vIE1hcmtlciAzOiByZXN1bHRzIGxpc3QgaGFzIGludGVybmFsIGxpbmtzXG5cdFx0XHRlbHNlIGlmIChjb250YWluZXJFbC5xdWVyeVNlbGVjdG9yQWxsKCdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScpLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0Y29uZmlkZW5jZSA9ICdoaWdoJztcblx0XHRcdFx0bWFya2VyID0gJ3Jlc3VsdHMgbGlzdCBoYXMgaW50ZXJuYWwgbGlua3MnO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHRpZiAoY29uZmlkZW5jZSAhPT0gJ25vbmUnKSB7XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ1NDIHZpZXcgZGV0ZWN0ZWQnLCB7XG5cdFx0XHRcdFx0bGVhZkluZGV4OiBpLFxuXHRcdFx0XHRcdHZpZXdUeXBlLFxuXHRcdFx0XHRcdG1hcmtlcixcblx0XHRcdFx0XHRjb25maWRlbmNlXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRyZXR1cm4gbGVhZjtcblx0XHRcdH1cblx0XHR9XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU0MgdmlldyBub3QgZm91bmQnLCB7XG5cdFx0XHRsZWF2ZXNDaGVja2VkOiBsZWF2ZXMubGVuZ3RoXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIG51bGw7XG5cdH1cblxuXHQvKipcblx0ICogQ2FwdHVyZSByZXN1bHRzIGZyb20gU21hcnQgQ29ubmVjdGlvbnMgRE9NLlxuXHQgKi9cblx0YXN5bmMgY2FwdHVyZUZyb21Eb20oc291cmNlTm90ZVBhdGg/OiBzdHJpbmcpOiBQcm9taXNlPEFycmF5PHsgcGF0aDogc3RyaW5nOyBzY29yZTogbnVtYmVyIH0+PiB7XG5cdFx0Y29uc3Qgc2Vzc2lvbklkID0gdGhpcy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xuXHRcdHRoaXMuY3VycmVudFNlc3Npb25JZCA9IHNlc3Npb25JZDtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTdGFydGluZyBET00gY2FwdHVyZScsIHtcblx0XHRcdHNvdXJjZU5vdGVQYXRoOiBzb3VyY2VOb3RlUGF0aCB8fCAnKG5vdCBwcm92aWRlZCknLFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc3Qgc2NWaWV3ID0gdGhpcy5maW5kU21hcnRDb25uZWN0aW9uc1ZpZXcoKTtcblx0XHRpZiAoIXNjVmlldykge1xuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnU0MgdmlldyBub3QgZm91bmQgZm9yIERPTSBjYXB0dXJlJywge1xuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0XHRcblx0XHQvLyBQb3J0YWJsZSByZXN1bHRzIGRldGVjdGlvbiB1c2luZyBpbnRlcm5hbC1saW5rIHNlbGVjdG9yXG5cdFx0Y29uc3QgaW50ZXJuYWxMaW5rcyA9IHNjVmlldy52aWV3LmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EuaW50ZXJuYWwtbGlua1tkYXRhLWhyZWZdJyk7XG5cdFx0Y29uc3QgcmVzdWx0c0NvdW50ID0gaW50ZXJuYWxMaW5rcy5sZW5ndGg7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnUmVzdWx0cyBkZXRlY3Rpb24nLCB7XG5cdFx0XHR2aWV3Rm91bmQ6IHRydWUsXG5cdFx0XHRzZWxlY3RvcjogJ2EuaW50ZXJuYWwtbGlua1tkYXRhLWhyZWZdJyxcblx0XHRcdGNvdW50OiByZXN1bHRzQ291bnQsXG5cdFx0XHRzZXNzaW9uSWRcblx0XHR9KTtcblx0XHRcblx0XHRpZiAocmVzdWx0c0NvdW50ID09PSAwKSB7XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdWaWV3IGZvdW5kLCByZXN1bHRzIG1pc3NpbmcnLCB7XG5cdFx0XHRcdHZpZXdGb3VuZDogdHJ1ZSxcblx0XHRcdFx0cmVzdWx0c0ZvdW5kOiBmYWxzZSxcblx0XHRcdFx0c2VsZWN0b3I6ICdhLmludGVybmFsLWxpbmtbZGF0YS1ocmVmXScsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gW107IC8vIERvbid0IGNhY2hlIGVtcHR5XG5cdFx0fVxuXHRcdFxuXHRcdC8vIEV4dHJhY3QgbGlua3MgYW5kIHZhbGlkYXRlXG5cdFx0Y29uc3QgcmVzdWx0czogQXJyYXk8eyBwYXRoOiBzdHJpbmc7IHNjb3JlOiBudW1iZXIgfT4gPSBbXTtcblx0XHRjb25zdCBtYXhDYXB0dXJlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heENhcHR1cmVGaWxlcyA/PyAyMDA7XG5cdFx0XG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBNYXRoLm1pbihyZXN1bHRzQ291bnQsIG1heENhcHR1cmUpOyBpKyspIHtcblx0XHRcdGNvbnN0IGxpbmsgPSBpbnRlcm5hbExpbmtzW2ldIGFzIEhUTUxBbmNob3JFbGVtZW50O1xuXHRcdFx0Y29uc3QgZGF0YUhyZWYgPSBsaW5rLmdldEF0dHJpYnV0ZSgnZGF0YS1ocmVmJyk7XG5cdFx0XHRjb25zdCBocmVmID0gbGluay5nZXRBdHRyaWJ1dGUoJ2hyZWYnKTtcblx0XHRcdGNvbnN0IHBhdGggPSBkYXRhSHJlZiB8fCBocmVmIHx8ICcnO1xuXHRcdFx0XG5cdFx0XHRpZiAoIXBhdGgpIHtcblx0XHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnTGluayBtaXNzaW5nIHBhdGgnLCB7XG5cdFx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdFx0ZGF0YUhyZWYsXG5cdFx0XHRcdFx0aHJlZixcblx0XHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBOb3JtYWxpemUgcGF0aCAocmVtb3ZlIC5tZCBleHRlbnNpb24gaWYgcHJlc2VudCwgaGFuZGxlIGludGVybmFsIGxpbmsgZm9ybWF0KVxuXHRcdFx0bGV0IG5vcm1hbGl6ZWRQYXRoID0gcGF0aC5yZXBsYWNlKC9cXC5tZCQvLCAnJyk7XG5cdFx0XHRpZiAobm9ybWFsaXplZFBhdGguc3RhcnRzV2l0aCgnIycpKSB7XG5cdFx0XHRcdC8vIFNraXAgYW5jaG9yc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQ2hlY2sgaWYgZmlsZSBleGlzdHMgYW5kIGlzIGFsbG93ZWRcblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChub3JtYWxpemVkUGF0aCk7XG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XG5cdFx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0xpbmsgcmVzb2x2ZXMgdG8gbm9uLWZpbGUnLCB7XG5cdFx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXG5cdFx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQXBwbHkgZm9sZGVyIGZpbHRlcnNcblx0XHRcdGlmICghdGhpcy5pc1BhdGhBbGxvd2VkKG5vcm1hbGl6ZWRQYXRoKSkge1xuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdMaW5rIGZpbHRlcmVkIG91dCcsIHtcblx0XHRcdFx0XHRwYXRoOiBub3JtYWxpemVkUGF0aCxcblx0XHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdFx0fSk7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBBc3NpZ24gcmFuay1iYXNlZCBzY29yZSAoMS4wLCAwLjk4LCAwLjk2Li4uKVxuXHRcdFx0Y29uc3QgcmFua1Njb3JlID0gTWF0aC5tYXgoMC41LCAxLjAgLSAoaSAqIDAuMDIpKTtcblx0XHRcdFxuXHRcdFx0cmVzdWx0cy5wdXNoKHtcblx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXG5cdFx0XHRcdHNjb3JlOiByYW5rU2NvcmVcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdMaW5rIGNhcHR1cmVkJywge1xuXHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0cGF0aDogbm9ybWFsaXplZFBhdGgsXG5cdFx0XHRcdHNjb3JlOiByYW5rU2NvcmUsXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdFxuXHRcdHRoaXMubG9nKCdpbmZvJywgJ0RPTSBjYXB0dXJlIGNvbXBsZXRlJywge1xuXHRcdFx0cmVzdWx0czogcmVzdWx0cy5sZW5ndGgsXG5cdFx0XHR0aW1lOiAnTi9BJywgLy8gQ291bGQgYWRkIHRpbWluZyBpZiBuZWVkZWRcblx0XHRcdHNlc3Npb25JZFxuXHRcdH0pO1xuXHRcdFxuXHRcdHJldHVybiByZXN1bHRzO1xuXHR9XG5cblx0LyoqXG5cdCAqIENhcHR1cmUgcmVzdWx0cyBmcm9tIGNsaXBib2FyZC5cblx0ICovXG5cdGFzeW5jIGNhcHR1cmVGcm9tQ2xpcGJvYXJkKHNvdXJjZU5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTxBcnJheTx7IHBhdGg6IHN0cmluZzsgc2NvcmU6IG51bWJlciB9Pj4ge1xuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcblx0XHR0aGlzLmN1cnJlbnRTZXNzaW9uSWQgPSBzZXNzaW9uSWQ7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU3RhcnRpbmcgY2xpcGJvYXJkIGNhcHR1cmUnLCB7XG5cdFx0XHRzb3VyY2VOb3RlUGF0aDogc291cmNlTm90ZVBhdGggfHwgJyhub3QgcHJvdmlkZWQpJyxcblx0XHRcdHNlc3Npb25JZFxuXHRcdH0pO1xuXHRcdFxuXHRcdHRyeSB7XG5cdFx0XHQvLyBDaGVjayBjbGlwYm9hcmQgcGVybWlzc2lvbnNcblx0XHRcdGNvbnN0IGNsaXBib2FyZFRleHQgPSBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLnJlYWRUZXh0KCk7XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NsaXBib2FyZCByZWFkJywge1xuXHRcdFx0XHRsZW5ndGg6IGNsaXBib2FyZFRleHQubGVuZ3RoLFxuXHRcdFx0XHRwcmV2aWV3OiBjbGlwYm9hcmRUZXh0LnN1YnN0cmluZygwLCAyMDApLFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHQvLyBQYXJzZSBtYXJrZG93biBsaW5rczogW1tub3RlLW5hbWVdXSBvciBbdGV4dF0obm90ZS1uYW1lLm1kKVxuXHRcdFx0Y29uc3QgbWFya2Rvd25MaW5rUGF0dGVybiA9IC9cXFtcXFsoW15cXF1dKylcXF1cXF18XFxbKFteXFxdXSspXFxdXFwoKFteKV0rXFwubWQpXFwpL2c7XG5cdFx0XHRjb25zdCBsaW5rczogc3RyaW5nW10gPSBbXTtcblx0XHRcdGxldCBtYXRjaDtcblx0XHRcdFxuXHRcdFx0d2hpbGUgKChtYXRjaCA9IG1hcmtkb3duTGlua1BhdHRlcm4uZXhlYyhjbGlwYm9hcmRUZXh0KSkgIT09IG51bGwpIHtcblx0XHRcdFx0Y29uc3QgbGluayA9IG1hdGNoWzFdIHx8IG1hdGNoWzNdIHx8ICcnO1xuXHRcdFx0XHRpZiAobGluaykge1xuXHRcdFx0XHRcdGxpbmtzLnB1c2gobGluay5yZXBsYWNlKC9cXC5tZCQvLCAnJykpO1xuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0xpbmtzIHBhcnNlZCBmcm9tIGNsaXBib2FyZCcsIHtcblx0XHRcdFx0Zm91bmQ6IGxpbmtzLmxlbmd0aCxcblx0XHRcdFx0bGlua3M6IGxpbmtzLnNsaWNlKDAsIDEwKSwgLy8gTG9nIGZpcnN0IDEwXG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRcblx0XHRcdC8vIFZhbGlkYXRlIGFuZCBmaWx0ZXIgbGlua3Ncblx0XHRcdGNvbnN0IHJlc3VsdHM6IEFycmF5PHsgcGF0aDogc3RyaW5nOyBzY29yZTogbnVtYmVyIH0+ID0gW107XG5cdFx0XHRjb25zdCBtYXhDYXB0dXJlID0gdGhpcy5wbHVnaW4uc2V0dGluZ3Muc21hcnRDb25uZWN0aW9uc01heENhcHR1cmVGaWxlcyA/PyAyMDA7XG5cdFx0XHRcblx0XHRcdGZvciAobGV0IGkgPSAwOyBpIDwgTWF0aC5taW4obGlua3MubGVuZ3RoLCBtYXhDYXB0dXJlKTsgaSsrKSB7XG5cdFx0XHRcdGNvbnN0IGxpbmsgPSBsaW5rc1tpXTtcblx0XHRcdFx0XG5cdFx0XHRcdC8vIENoZWNrIGlmIGZpbGUgZXhpc3RzXG5cdFx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChsaW5rKTtcblx0XHRcdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xuXHRcdFx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0NsaXBib2FyZCBsaW5rIHJlc29sdmVzIHRvIG5vbi1maWxlJywge1xuXHRcdFx0XHRcdFx0bGluayxcblx0XHRcdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0XG5cdFx0XHRcdC8vIEFwcGx5IGZvbGRlciBmaWx0ZXJzXG5cdFx0XHRcdGlmICghdGhpcy5pc1BhdGhBbGxvd2VkKGxpbmspKSB7XG5cdFx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2xpcGJvYXJkIGxpbmsgZmlsdGVyZWQgb3V0Jywge1xuXHRcdFx0XHRcdFx0bGluayxcblx0XHRcdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdFx0fSk7XG5cdFx0XHRcdFx0Y29udGludWU7XG5cdFx0XHRcdH1cblx0XHRcdFx0XG5cdFx0XHRcdC8vIEFzc2lnbiByYW5rLWJhc2VkIHNjb3JlXG5cdFx0XHRcdGNvbnN0IHJhbmtTY29yZSA9IE1hdGgubWF4KDAuNSwgMS4wIC0gKGkgKiAwLjAyKSk7XG5cdFx0XHRcdFxuXHRcdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRcdHBhdGg6IGxpbmssXG5cdFx0XHRcdFx0c2NvcmU6IHJhbmtTY29yZVxuXHRcdFx0XHR9KTtcblx0XHRcdFx0XG5cdFx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NsaXBib2FyZCBsaW5rIGNhcHR1cmVkJywge1xuXHRcdFx0XHRcdGluZGV4OiBpLFxuXHRcdFx0XHRcdGxpbmssXG5cdFx0XHRcdFx0c2NvcmU6IHJhbmtTY29yZSxcblx0XHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NsaXBib2FyZCBjYXB0dXJlIGNvbXBsZXRlJywge1xuXHRcdFx0XHRyZXN1bHRzOiByZXN1bHRzLmxlbmd0aCxcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdFxuXHRcdFx0cmV0dXJuIHJlc3VsdHM7XG5cdFx0XHRcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0dGhpcy5sb2coJ2Vycm9yJywgJ0NsaXBib2FyZCBjYXB0dXJlIGZhaWxlZCcsIHtcblx0XHRcdFx0ZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSxcblx0XHRcdFx0c3RhY2s6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5zdGFjayA6IHVuZGVmaW5lZCxcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdH1cblxuXHQvKipcblx0ICogVG9rZW5pemUgdGV4dCAoc2ltcGxlIHdvcmQgc3BsaXR0aW5nLCBsb3dlcmNhc2UpLlxuXHQgKi9cblx0cHJpdmF0ZSB0b2tlbml6ZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG5cdFx0cmV0dXJuIHRleHRcblx0XHRcdC50b0xvd2VyQ2FzZSgpXG5cdFx0XHQuc3BsaXQoL1teYS16MC05XSsvZylcblx0XHRcdC5tYXAodCA9PiB0LnRyaW0oKSlcblx0XHRcdC5maWx0ZXIodCA9PiB0Lmxlbmd0aCA+PSAyKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBTY29yZSBjYWNoZWQgaXRlbXMgdXNpbmcgbWV0YWRhdGEgY2FjaGUgKGZhc3QgcGF0aCkuXG5cdCAqL1xuXHRwcml2YXRlIGFzeW5jIHNjb3JlQ2FjaGVkSXRlbXNXaXRoTWV0YWRhdGEoXG5cdFx0Y2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSxcblx0XHRxdWVyeTogc3RyaW5nLFxuXHRcdGxpbWl0OiBudW1iZXJcblx0KTogUHJvbWlzZTxTY29yZWRDYWNoZUl0ZW1bXT4ge1xuXHRcdGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVyeSk7XG5cdFx0Y29uc3QgbWF4U2NvcmVGaWxlcyA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNNYXhTY29yZUZpbGVzID8/IDUwO1xuXHRcdGNvbnN0IGl0ZW1zVG9TY29yZSA9IGNhY2hlLnJlc3VsdHMuc2xpY2UoMCwgTWF0aC5taW4oY2FjaGUucmVzdWx0cy5sZW5ndGgsIG1heFNjb3JlRmlsZXMpKTtcblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTdGFydGluZyBtZXRhZGF0YSBzY29yaW5nJywge1xuXHRcdFx0cXVlcnlUb2tlbnM6IHF1ZXJ5VG9rZW5zLnNsaWNlKDAsIDEwKSwgLy8gTG9nIGZpcnN0IDEwIHRva2Vuc1xuXHRcdFx0aXRlbXNUb1Njb3JlOiBpdGVtc1RvU2NvcmUubGVuZ3RoLFxuXHRcdFx0bWF4U2NvcmVGaWxlcyxcblx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0Y29uc3Qgc2NvcmVkOiBTY29yZWRDYWNoZUl0ZW1bXSA9IFtdO1xuXHRcdFxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgaXRlbXNUb1Njb3JlLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBpdGVtID0gaXRlbXNUb1Njb3JlW2ldO1xuXHRcdFx0Y29uc3QgZmlsZSA9IHRoaXMudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKGl0ZW0ucGF0aCk7XG5cdFx0XHRcblx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHtcblx0XHRcdFx0Y29udGludWU7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIEdldCBtZXRhZGF0YSBjYWNoZVxuXHRcdFx0Y29uc3QgbWV0YWRhdGEgPSB0aGlzLmFwcC5tZXRhZGF0YUNhY2hlLmdldEZpbGVDYWNoZShmaWxlKTtcblx0XHRcdGlmICghbWV0YWRhdGEpIHtcblx0XHRcdFx0Ly8gTm8gbWV0YWRhdGEsIHVzZSByYW5rIHNjb3JlIG9ubHlcblx0XHRcdFx0c2NvcmVkLnB1c2goe1xuXHRcdFx0XHRcdHBhdGg6IGl0ZW0ucGF0aCxcblx0XHRcdFx0XHRyYW5rU2NvcmU6IGl0ZW0uc2NvcmUgPz8gMC41LFxuXHRcdFx0XHRcdG1ldGFkYXRhU2NvcmU6IDAsXG5cdFx0XHRcdFx0ZmluYWxTY29yZTogaXRlbS5zY29yZSA/PyAwLjUsXG5cdFx0XHRcdFx0Y2FwdHVyZWRBdDogaXRlbS5jYXB0dXJlZEF0XG5cdFx0XHRcdH0pO1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gRXh0cmFjdCB0ZXh0IGZyb20gbWV0YWRhdGFcblx0XHRcdGNvbnN0IG1ldGFkYXRhVGV4dDogc3RyaW5nW10gPSBbXTtcblx0XHRcdFxuXHRcdFx0Ly8gRnJvbnRtYXR0ZXIgdGFnc1xuXHRcdFx0aWYgKG1ldGFkYXRhLmZyb250bWF0dGVyPy50YWdzKSB7XG5cdFx0XHRcdGNvbnN0IHRhZ3MgPSBBcnJheS5pc0FycmF5KG1ldGFkYXRhLmZyb250bWF0dGVyLnRhZ3MpIFxuXHRcdFx0XHRcdD8gbWV0YWRhdGEuZnJvbnRtYXR0ZXIudGFncyBcblx0XHRcdFx0XHQ6IFttZXRhZGF0YS5mcm9udG1hdHRlci50YWdzXTtcblx0XHRcdFx0bWV0YWRhdGFUZXh0LnB1c2goLi4udGFncy5tYXAoKHQ6IHN0cmluZykgPT4gdC50b1N0cmluZygpLnRvTG93ZXJDYXNlKCkpKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gSGVhZGluZ3Ncblx0XHRcdGlmIChtZXRhZGF0YS5oZWFkaW5ncykge1xuXHRcdFx0XHRtZXRhZGF0YVRleHQucHVzaCguLi5tZXRhZGF0YS5oZWFkaW5ncy5tYXAoaCA9PiBoLmhlYWRpbmcudG9Mb3dlckNhc2UoKSkpO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHQvLyBUYWdzXG5cdFx0XHRpZiAobWV0YWRhdGEudGFncykge1xuXHRcdFx0XHRtZXRhZGF0YVRleHQucHVzaCguLi5tZXRhZGF0YS50YWdzLm1hcCh0ID0+IHQudGFnLnRvTG93ZXJDYXNlKCkpKTtcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gU2NvcmUgYnkgdG9rZW4gb3ZlcmxhcFxuXHRcdFx0Y29uc3QgbWV0YWRhdGFUb2tlbnMgPSB0aGlzLnRva2VuaXplKG1ldGFkYXRhVGV4dC5qb2luKCcgJykpO1xuXHRcdFx0Y29uc3Qgb3ZlcmxhcCA9IHF1ZXJ5VG9rZW5zLmZpbHRlcih0ID0+IG1ldGFkYXRhVG9rZW5zLmluY2x1ZGVzKHQpKS5sZW5ndGg7XG5cdFx0XHRjb25zdCBtZXRhZGF0YVNjb3JlID0gcXVlcnlUb2tlbnMubGVuZ3RoID4gMCA/IG92ZXJsYXAgLyBxdWVyeVRva2Vucy5sZW5ndGggOiAwO1xuXHRcdFx0XG5cdFx0XHQvLyBDb21iaW5lIHdpdGggcmFuayBzY29yZVxuXHRcdFx0Y29uc3QgcmFua1Njb3JlID0gaXRlbS5zY29yZSA/PyBNYXRoLm1heCgwLjUsIDEuMCAtIChpICogMC4wMikpO1xuXHRcdFx0Y29uc3QgZmluYWxTY29yZSA9IChtZXRhZGF0YVNjb3JlICogMC43KSArIChyYW5rU2NvcmUgKiAwLjMpO1xuXHRcdFx0XG5cdFx0XHRzY29yZWQucHVzaCh7XG5cdFx0XHRcdHBhdGg6IGl0ZW0ucGF0aCxcblx0XHRcdFx0cmFua1Njb3JlLFxuXHRcdFx0XHRtZXRhZGF0YVNjb3JlLFxuXHRcdFx0XHRmaW5hbFNjb3JlLFxuXHRcdFx0XHRjYXB0dXJlZEF0OiBpdGVtLmNhcHR1cmVkQXRcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHR0aGlzLmxvZygnaW5mbycsICdJdGVtIHNjb3JlZCB3aXRoIG1ldGFkYXRhJywge1xuXHRcdFx0XHRpbmRleDogaSxcblx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHRtZXRhZGF0YVNjb3JlOiBtZXRhZGF0YVNjb3JlLnRvRml4ZWQoMyksXG5cdFx0XHRcdHJhbmtTY29yZTogcmFua1Njb3JlLnRvRml4ZWQoMyksXG5cdFx0XHRcdGZpbmFsU2NvcmU6IGZpbmFsU2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHQvLyBTb3J0IGJ5IGZpbmFsIHNjb3JlIGFuZCByZXR1cm4gdG9wIE5cblx0XHRjb25zdCBzb3J0ZWQgPSBzY29yZWQuc29ydCgoYSwgYikgPT4gYi5maW5hbFNjb3JlIC0gYS5maW5hbFNjb3JlKTtcblx0XHRjb25zdCB0b3BOID0gTWF0aC5taW4oMTAsIGxpbWl0ICogMik7IC8vIFBvbGljeTogdG9wTkZ1bGxSZWFkID0gbWluKDEwLCBsaW1pdCAqIDIpXG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnTWV0YWRhdGEgc2NvcmluZyBjb21wbGV0ZScsIHtcblx0XHRcdHNjb3JlZDogc29ydGVkLmxlbmd0aCxcblx0XHRcdHRvcE4sXG5cdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdH0pO1xuXHRcdFxuXHRcdHJldHVybiBzb3J0ZWQuc2xpY2UoMCwgdG9wTik7XG5cdH1cblxuXHQvKipcblx0ICogTG9hZCBmdWxsIGNvbnRlbnQgYW5kIHJlLXNjb3JlIHRvcCBpdGVtcy5cblx0ICovXG5cdHByaXZhdGUgYXN5bmMgbG9hZEFuZFNjb3JlVG9wSXRlbXMoXG5cdFx0dG9wSXRlbXM6IFNjb3JlZENhY2hlSXRlbVtdLFxuXHRcdHF1ZXJ5OiBzdHJpbmdcblx0KTogUHJvbWlzZTxTY29yZWRDYWNoZUl0ZW1bXT4ge1xuXHRcdGNvbnN0IHF1ZXJ5VG9rZW5zID0gdGhpcy50b2tlbml6ZShxdWVyeSk7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnTG9hZGluZyBmdWxsIGNvbnRlbnQgZm9yIHRvcCBpdGVtcycsIHtcblx0XHRcdGNvdW50OiB0b3BJdGVtcy5sZW5ndGgsXG5cdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdH0pO1xuXHRcdFxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgdG9wSXRlbXMubGVuZ3RoOyBpKyspIHtcblx0XHRcdGNvbnN0IGl0ZW0gPSB0b3BJdGVtc1tpXTtcblx0XHRcdGNvbnN0IGZpbGUgPSB0aGlzLnZhdWx0LmdldEFic3RyYWN0RmlsZUJ5UGF0aChpdGVtLnBhdGgpO1xuXHRcdFx0XG5cdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XG5cdFx0XHRcdGNvbnRpbnVlO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHR0cnkge1xuXHRcdFx0XHRjb25zdCBjb250ZW50ID0gYXdhaXQgdGhpcy52YXVsdC5yZWFkKGZpbGUpO1xuXHRcdFx0XHRjb25zdCBjb250ZW50VG9rZW5zID0gdGhpcy50b2tlbml6ZShjb250ZW50KTtcblx0XHRcdFx0XG5cdFx0XHRcdC8vIFNjb3JlIGJ5IHRva2VuIG92ZXJsYXBcblx0XHRcdFx0Y29uc3Qgb3ZlcmxhcCA9IHF1ZXJ5VG9rZW5zLmZpbHRlcih0ID0+IGNvbnRlbnRUb2tlbnMuaW5jbHVkZXModCkpLmxlbmd0aDtcblx0XHRcdFx0Y29uc3QgZnVsbENvbnRlbnRTY29yZSA9IHF1ZXJ5VG9rZW5zLmxlbmd0aCA+IDAgPyBvdmVybGFwIC8gcXVlcnlUb2tlbnMubGVuZ3RoIDogMDtcblx0XHRcdFx0XG5cdFx0XHRcdC8vIENvbWJpbmUgc2NvcmVzOiAocXVlcnlTY29yZSAqIDAuNykgKyAocmFua1Njb3JlICogMC4zKVxuXHRcdFx0XHRpdGVtLmZ1bGxDb250ZW50U2NvcmUgPSBmdWxsQ29udGVudFNjb3JlO1xuXHRcdFx0XHRpdGVtLmZpbmFsU2NvcmUgPSAoZnVsbENvbnRlbnRTY29yZSAqIDAuNykgKyAoaXRlbS5yYW5rU2NvcmUgKiAwLjMpO1xuXHRcdFx0XHRcblx0XHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnSXRlbSByZS1zY29yZWQgd2l0aCBmdWxsIGNvbnRlbnQnLCB7XG5cdFx0XHRcdFx0aW5kZXg6IGksXG5cdFx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHRcdGZ1bGxDb250ZW50U2NvcmU6IGZ1bGxDb250ZW50U2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0XHRmaW5hbFNjb3JlOiBpdGVtLmZpbmFsU2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0XHRjb250ZW50TGVuZ3RoOiBjb250ZW50Lmxlbmd0aCxcblx0XHRcdFx0XHRzZXNzaW9uSWQ6IHRoaXMuY3VycmVudFNlc3Npb25JZFxuXHRcdFx0XHR9KTtcblx0XHRcdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0XHRcdHRoaXMubG9nKCd3YXJuJywgJ0ZhaWxlZCB0byByZWFkIGZpbGUgZm9yIHNjb3JpbmcnLCB7XG5cdFx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG5cdFx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHRcdFx0fSk7XG5cdFx0XHR9XG5cdFx0fVxuXHRcdFxuXHRcdC8vIFJlLXNvcnQgYnkgZmluYWwgc2NvcmVcblx0XHRyZXR1cm4gdG9wSXRlbXMuc29ydCgoYSwgYikgPT4gYi5maW5hbFNjb3JlIC0gYS5maW5hbFNjb3JlKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBHZW5lcmF0ZSBiZXN0LW1hdGNoaW5nIHBhcmFncmFwaCBleGNlcnB0LlxuXHQgKi9cblx0cHJpdmF0ZSBhc3luYyBnZW5lcmF0ZUJlc3RNYXRjaGluZ0V4Y2VycHQocGF0aDogc3RyaW5nLCBxdWVyeTogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBmaWxlID0gdGhpcy52YXVsdC5nZXRBYnN0cmFjdEZpbGVCeVBhdGgocGF0aCk7XG5cdFx0aWYgKCEoZmlsZSBpbnN0YW5jZW9mIFRGaWxlKSkge1xuXHRcdFx0cmV0dXJuICdbRmlsZSBub3QgZm91bmRdJztcblx0XHR9XG5cdFx0XG5cdFx0dHJ5IHtcblx0XHRcdGNvbnN0IGNvbnRlbnQgPSBhd2FpdCB0aGlzLnZhdWx0LnJlYWQoZmlsZSk7XG5cdFx0XHRjb25zdCBxdWVyeVRva2VucyA9IHRoaXMudG9rZW5pemUocXVlcnkpO1xuXHRcdFx0XG5cdFx0XHQvLyBQb2xpY3k6IFNwbGl0IGJ5IGRvdWJsZSBuZXdsaW5lXG5cdFx0XHRjb25zdCBwYXJhZ3JhcGhzID0gY29udGVudC5zcGxpdCgnXFxuXFxuJyk7XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgZXhjZXJwdCcsIHtcblx0XHRcdFx0cGF0aCxcblx0XHRcdFx0cGFyYWdyYXBoczogcGFyYWdyYXBocy5sZW5ndGgsXG5cdFx0XHRcdHF1ZXJ5VG9rZW5zOiBxdWVyeVRva2Vucy5zbGljZSgwLCA1KSxcblx0XHRcdFx0c2Vzc2lvbklkOiB0aGlzLmN1cnJlbnRTZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0XG5cdFx0XHRpZiAocGFyYWdyYXBocy5sZW5ndGggPT09IDApIHtcblx0XHRcdFx0Ly8gRmFsbGJhY2sgdG8gZmlyc3QgNTAwIGNoYXJzXG5cdFx0XHRcdHJldHVybiBjb250ZW50LnRyaW0oKS5zbGljZSgwLCA1MDApICsgKGNvbnRlbnQubGVuZ3RoID4gNTAwID8gJ+KApicgOiAnJyk7XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdC8vIFNjb3JlIGVhY2ggcGFyYWdyYXBoXG5cdFx0XHRsZXQgYmVzdFBhcmFncmFwaCA9IHBhcmFncmFwaHNbMF07XG5cdFx0XHRsZXQgYmVzdFNjb3JlID0gMDtcblx0XHRcdFxuXHRcdFx0Zm9yIChjb25zdCBwYXJhZ3JhcGggb2YgcGFyYWdyYXBocykge1xuXHRcdFx0XHRjb25zdCBwYXJhVG9rZW5zID0gdGhpcy50b2tlbml6ZShwYXJhZ3JhcGgpO1xuXHRcdFx0XHRjb25zdCBvdmVybGFwID0gcXVlcnlUb2tlbnMuZmlsdGVyKHQgPT4gcGFyYVRva2Vucy5pbmNsdWRlcyh0KSkubGVuZ3RoO1xuXHRcdFx0XHRjb25zdCBzY29yZSA9IHF1ZXJ5VG9rZW5zLmxlbmd0aCA+IDAgPyBvdmVybGFwIC8gcXVlcnlUb2tlbnMubGVuZ3RoIDogMDtcblx0XHRcdFx0XG5cdFx0XHRcdGlmIChzY29yZSA+IGJlc3RTY29yZSkge1xuXHRcdFx0XHRcdGJlc3RTY29yZSA9IHNjb3JlO1xuXHRcdFx0XHRcdGJlc3RQYXJhZ3JhcGggPSBwYXJhZ3JhcGg7XG5cdFx0XHRcdH1cblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gVHJpbSB0byA4MDAtMTIwMCBjaGFycyAocHJlZmVyIDEwMDAsIGJ1dCBhbGxvdyByYW5nZSlcblx0XHRcdGxldCBleGNlcnB0ID0gYmVzdFBhcmFncmFwaC50cmltKCk7XG5cdFx0XHRjb25zdCB0YXJnZXRMZW5ndGggPSAxMDAwO1xuXHRcdFx0Y29uc3QgbWluTGVuZ3RoID0gODAwO1xuXHRcdFx0Y29uc3QgbWF4TGVuZ3RoID0gMTIwMDtcblx0XHRcdFxuXHRcdFx0aWYgKGV4Y2VycHQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG5cdFx0XHRcdC8vIFRyeSB0byB0cmltIGF0IHNlbnRlbmNlIGJvdW5kYXJ5XG5cdFx0XHRcdGNvbnN0IHRyaW1tZWQgPSBleGNlcnB0LnNsaWNlKDAsIG1heExlbmd0aCk7XG5cdFx0XHRcdGNvbnN0IGxhc3RQZXJpb2QgPSB0cmltbWVkLmxhc3RJbmRleE9mKCcuJyk7XG5cdFx0XHRcdGlmIChsYXN0UGVyaW9kID4gbWluTGVuZ3RoKSB7XG5cdFx0XHRcdFx0ZXhjZXJwdCA9IHRyaW1tZWQuc2xpY2UoMCwgbGFzdFBlcmlvZCArIDEpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHRcdGV4Y2VycHQgPSB0cmltbWVkICsgJ+KApic7XG5cdFx0XHRcdH1cblx0XHRcdH0gZWxzZSBpZiAoZXhjZXJwdC5sZW5ndGggPCBtaW5MZW5ndGggJiYgcGFyYWdyYXBocy5sZW5ndGggPiAxKSB7XG5cdFx0XHRcdC8vIFRyeSB0byBpbmNsdWRlIG5leHQgcGFyYWdyYXBoIGlmIHRvbyBzaG9ydFxuXHRcdFx0XHRjb25zdCBwYXJhSW5kZXggPSBwYXJhZ3JhcGhzLmluZGV4T2YoYmVzdFBhcmFncmFwaCk7XG5cdFx0XHRcdGlmIChwYXJhSW5kZXggPCBwYXJhZ3JhcGhzLmxlbmd0aCAtIDEpIHtcblx0XHRcdFx0XHRjb25zdCBjb21iaW5lZCA9IGJlc3RQYXJhZ3JhcGggKyAnXFxuXFxuJyArIHBhcmFncmFwaHNbcGFyYUluZGV4ICsgMV07XG5cdFx0XHRcdFx0ZXhjZXJwdCA9IGNvbWJpbmVkLnRyaW0oKS5zbGljZSgwLCBtYXhMZW5ndGgpO1xuXHRcdFx0XHRcdGlmIChjb21iaW5lZC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcblx0XHRcdFx0XHRcdGV4Y2VycHQgKz0gJ+KApic7XG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9XG5cdFx0XHRcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0V4Y2VycHQgZ2VuZXJhdGVkJywge1xuXHRcdFx0XHRwYXRoLFxuXHRcdFx0XHRleGNlcnB0TGVuZ3RoOiBleGNlcnB0Lmxlbmd0aCxcblx0XHRcdFx0YmVzdFNjb3JlOiBiZXN0U2NvcmUudG9GaXhlZCgzKSxcblx0XHRcdFx0bWV0aG9kOiBiZXN0U2NvcmUgPiAwID8gJ2Jlc3QtbWF0Y2hpbmcnIDogJ2ZpcnN0LXBhcmFncmFwaCcsXG5cdFx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdFxuXHRcdFx0cmV0dXJuIGV4Y2VycHQ7XG5cdFx0XHRcblx0XHR9IGNhdGNoIChlcnJvcikge1xuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnRmFpbGVkIHRvIGdlbmVyYXRlIGV4Y2VycHQnLCB7XG5cdFx0XHRcdHBhdGgsXG5cdFx0XHRcdGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciksXG5cdFx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiAnW0Vycm9yIHJlYWRpbmcgZmlsZV0nO1xuXHRcdH1cblx0fVxuXG5cdGFzeW5jIHNlYXJjaChxdWVyeTogUmV0cmlldmFsUXVlcnksIG9wdHM6IFJldHJpZXZhbE9wdGlvbnMpOiBQcm9taXNlPENvbnRleHRJdGVtW10+IHtcblx0XHRjb25zdCBzZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XG5cdFx0dGhpcy5jdXJyZW50U2Vzc2lvbklkID0gc2Vzc2lvbklkO1xuXHRcdFxuXHRcdGNvbnN0IHEgPSAocXVlcnkudGV4dCA/PyAnJykudHJpbSgpO1xuXHRcdGlmICghcSkge1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0XHRcblx0XHR0aGlzLmxvZygnaW5mbycsICdTdGFydGluZyBzZWFyY2gnLCB7XG5cdFx0XHRxdWVyeTogcSxcblx0XHRcdGxpbWl0OiBvcHRzLmxpbWl0LFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0Ly8gQ2hlY2sgaWYgY2FjaGUgaXMgZW5hYmxlZFxuXHRcdGNvbnN0IGVuYWJsZWQgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGVFbmFibGVkID8/IGZhbHNlO1xuXHRcdGlmICghZW5hYmxlZCkge1xuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgZGlzYWJsZWQsIHJldHVybmluZyBlbXB0eScsIHtcblx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHR9KTtcblx0XHRcdHJldHVybiBbXTtcblx0XHR9XG5cdFx0XG5cdFx0Ly8gR2V0IGNhY2hlXG5cdFx0Y29uc3QgY2FjaGUgPSB0aGlzLmdldENhY2hlKCk7XG5cdFx0aWYgKCFjYWNoZSkge1xuXHRcdFx0dGhpcy5sb2coJ2luZm8nLCAnTm8gY2FjaGUgYXZhaWxhYmxlLCByZXR1cm5pbmcgZW1wdHknLCB7XG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHRcdFxuXHRcdC8vIENoZWNrIGNhY2hlIGZyZXNobmVzc1xuXHRcdGlmICghdGhpcy5pc0NhY2hlRnJlc2goY2FjaGUpKSB7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBleHBpcmVkLCByZXR1cm5pbmcgZW1wdHknLCB7XG5cdFx0XHRcdHNlc3Npb25JZFxuXHRcdFx0fSk7XG5cdFx0XHRyZXR1cm4gW107XG5cdFx0fVxuXHRcdFxuXHRcdC8vIENoZWNrIGtleWluZyBtYXRjaFxuXHRcdGNvbnN0IGN1cnJlbnROb3RlUGF0aCA9IHF1ZXJ5LmFjdGl2ZUZpbGVQYXRoO1xuXHRcdGNvbnN0IGtleWluZ0NoZWNrID0gdGhpcy5jaGVja0NhY2hlS2V5aW5nKGNhY2hlLCBjdXJyZW50Tm90ZVBhdGgpO1xuXHRcdGNvbnN0IGtleWluZ01vZGUgPSB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zS2V5aW5nTW9kZSB8fCAnc29mdCc7XG5cdFx0XG5cdFx0aWYgKCFrZXlpbmdDaGVjay5tYXRjaCAmJiBrZXlpbmdNb2RlID09PSAnc3RyaWN0Jykge1xuXHRcdFx0dGhpcy5sb2coJ3dhcm4nLCAnQ2FjaGUga2V5aW5nIG1pc21hdGNoIGluIHN0cmljdCBtb2RlLCByZXR1cm5pbmcgZW1wdHknLCB7XG5cdFx0XHRcdGN1cnJlbnROb3RlOiBjdXJyZW50Tm90ZVBhdGgsXG5cdFx0XHRcdGNhY2hlTm90ZToga2V5aW5nQ2hlY2suY2FjaGVOb3RlLFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdFx0cmV0dXJuIFtdO1xuXHRcdH1cblx0XHRcblx0XHRpZiAoIWtleWluZ0NoZWNrLm1hdGNoKSB7XG5cdFx0XHR0aGlzLmxvZygnd2FybicsICdDYWNoZSBrZXlpbmcgbWlzbWF0Y2ggaW4gc29mdCBtb2RlLCBhbGxvd2luZyB1c2UnLCB7XG5cdFx0XHRcdGN1cnJlbnROb3RlOiBjdXJyZW50Tm90ZVBhdGgsXG5cdFx0XHRcdGNhY2hlTm90ZToga2V5aW5nQ2hlY2suY2FjaGVOb3RlLFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHQvLyBWYWxpZGF0ZSBhbmQgY2xlYW4gY2FjaGUgKGluLW1lbW9yeSBvbmx5KVxuXHRcdGNvbnN0IHsgY2FjaGU6IGNsZWFuZWRDYWNoZSwgd2FzTW9kaWZpZWQgfSA9IHRoaXMudmFsaWRhdGVBbmRDbGVhbkNhY2hlKGNhY2hlKTtcblx0XHRcblx0XHQvLyBTY29yZSB3aXRoIG1ldGFkYXRhIGZpcnN0IChmYXN0KVxuXHRcdGNvbnN0IHRvcEl0ZW1zID0gYXdhaXQgdGhpcy5zY29yZUNhY2hlZEl0ZW1zV2l0aE1ldGFkYXRhKGNsZWFuZWRDYWNoZSwgcSwgb3B0cy5saW1pdCk7XG5cdFx0XG5cdFx0Ly8gTG9hZCBmdWxsIGNvbnRlbnQgZm9yIHRvcCBOIGFuZCByZS1zY29yZVxuXHRcdGNvbnN0IHJlc2NvcmVkSXRlbXMgPSBhd2FpdCB0aGlzLmxvYWRBbmRTY29yZVRvcEl0ZW1zKHRvcEl0ZW1zLCBxKTtcblx0XHRcblx0XHQvLyBHZW5lcmF0ZSBleGNlcnB0cyB3aXRoIGNvbnRleHQgY2FwXG5cdFx0Y29uc3QgcmVzdWx0czogQ29udGV4dEl0ZW1bXSA9IFtdO1xuXHRcdGNvbnN0IG1heENvbnRleHRDaGFycyA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNNYXhDb250ZXh0Q2hhcnMgPz8gMzAwMDA7XG5cdFx0bGV0IHRvdGFsQ29udGV4dENoYXJzID0gMDtcblx0XHRsZXQgdHJ1bmNhdGVkQ291bnQgPSAwO1xuXHRcdFxuXHRcdGZvciAoY29uc3QgaXRlbSBvZiByZXNjb3JlZEl0ZW1zKSB7XG5cdFx0XHRpZiAocmVzdWx0cy5sZW5ndGggPj0gb3B0cy5saW1pdCkge1xuXHRcdFx0XHRicmVhaztcblx0XHRcdH1cblx0XHRcdFxuXHRcdFx0Ly8gQ2hlY2sgY29udGV4dCBjYXBcblx0XHRcdGNvbnN0IGV4Y2VycHQgPSBhd2FpdCB0aGlzLmdlbmVyYXRlQmVzdE1hdGNoaW5nRXhjZXJwdChpdGVtLnBhdGgsIHEpO1xuXHRcdFx0bGV0IGZpbmFsRXhjZXJwdCA9IGV4Y2VycHQ7XG5cdFx0XHRcblx0XHRcdGlmICh0b3RhbENvbnRleHRDaGFycyArIGV4Y2VycHQubGVuZ3RoID4gbWF4Q29udGV4dENoYXJzKSB7XG5cdFx0XHRcdC8vIFBvbGljeTogdHJ1bmNhdGUgY3VycmVudCBleGNlcnB0IHRvIGZpdFxuXHRcdFx0XHRjb25zdCByZW1haW5pbmcgPSBtYXhDb250ZXh0Q2hhcnMgLSB0b3RhbENvbnRleHRDaGFycztcblx0XHRcdFx0ZmluYWxFeGNlcnB0ID0gZXhjZXJwdC5zbGljZSgwLCByZW1haW5pbmcpICsgJ+KApic7XG5cdFx0XHRcdHRydW5jYXRlZENvdW50Kys7XG5cdFx0XHRcdFxuXHRcdFx0XHR0aGlzLmxvZygnaW5mbycsICdDb250ZXh0IGNhcCByZWFjaGVkLCB0cnVuY2F0aW5nIGV4Y2VycHQnLCB7XG5cdFx0XHRcdFx0dG90YWxDaGFyczogdG90YWxDb250ZXh0Q2hhcnMgKyBmaW5hbEV4Y2VycHQubGVuZ3RoLFxuXHRcdFx0XHRcdHJlbWFpbmluZyxcblx0XHRcdFx0XHR0cnVuY2F0ZWQ6IHRydWUsXG5cdFx0XHRcdFx0c2Vzc2lvbklkXG5cdFx0XHRcdH0pO1xuXHRcdFx0fVxuXHRcdFx0XG5cdFx0XHR0b3RhbENvbnRleHRDaGFycyArPSBmaW5hbEV4Y2VycHQubGVuZ3RoO1xuXHRcdFx0XG5cdFx0XHRyZXN1bHRzLnB1c2goe1xuXHRcdFx0XHRrZXk6IGl0ZW0ucGF0aCxcblx0XHRcdFx0cGF0aDogaXRlbS5wYXRoLFxuXHRcdFx0XHR0aXRsZTogaXRlbS5wYXRoLnNwbGl0KCcvJykucG9wKCkgfHwgaXRlbS5wYXRoLFxuXHRcdFx0XHRleGNlcnB0OiBmaW5hbEV4Y2VycHQsXG5cdFx0XHRcdHNjb3JlOiBpdGVtLmZpbmFsU2NvcmUsXG5cdFx0XHRcdHNvdXJjZTogdGhpcy5pZCxcblx0XHRcdFx0cmVhc29uVGFnczogWydzbWFydC1jb25uZWN0aW9ucy1jYWNoZWQnXVxuXHRcdFx0fSk7XG5cdFx0fVxuXHRcdFxuXHRcdGlmICh0cnVuY2F0ZWRDb3VudCA+IDApIHtcblx0XHRcdHRoaXMubG9nKCdpbmZvJywgJ0NvbnRleHQgY2FwIHN1bW1hcnknLCB7XG5cdFx0XHRcdHRvdGFsQ2hhcnM6IHRvdGFsQ29udGV4dENoYXJzLFxuXHRcdFx0XHRtYXhDaGFyczogbWF4Q29udGV4dENoYXJzLFxuXHRcdFx0XHR0cnVuY2F0ZWQ6IHRydW5jYXRlZENvdW50LFxuXHRcdFx0XHRzZXNzaW9uSWRcblx0XHRcdH0pO1xuXHRcdH1cblx0XHRcblx0XHQvLyBTYXZlIGNhY2hlIGlmIG1vZGlmaWVkIChzaW5nbGUgd3JpdGViYWNrKVxuXHRcdGlmICh3YXNNb2RpZmllZCkge1xuXHRcdFx0YXdhaXQgdGhpcy5zYXZlQ2FjaGUoY2xlYW5lZENhY2hlKTtcblx0XHR9XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnU2VhcmNoIGNvbXBsZXRlJywge1xuXHRcdFx0cmVzdWx0czogcmVzdWx0cy5sZW5ndGgsXG5cdFx0XHRtZXRob2Q6ICdjYWNoZWQnLFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fSk7XG5cdFx0XG5cdFx0cmV0dXJuIHJlc3VsdHM7XG5cdH1cblxuXHQvKipcblx0ICogUHVibGljIG1ldGhvZCB0byBjYXB0dXJlIGZyb20gRE9NIGFuZCBzYXZlIHRvIGNhY2hlLlxuXHQgKi9cblx0YXN5bmMgY2FwdHVyZUFuZFNhdmVGcm9tRG9tKHNvdXJjZU5vdGVQYXRoPzogc3RyaW5nKTogUHJvbWlzZTx7IHN1Y2Nlc3M6IGJvb2xlYW47IGNvdW50OiBudW1iZXI7IG1lc3NhZ2U/OiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IHJlc3VsdHMgPSBhd2FpdCB0aGlzLmNhcHR1cmVGcm9tRG9tKHNvdXJjZU5vdGVQYXRoKTtcblx0XHRcblx0XHRpZiAocmVzdWx0cy5sZW5ndGggPT09IDApIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdHN1Y2Nlc3M6IGZhbHNlLFxuXHRcdFx0XHRjb3VudDogMCxcblx0XHRcdFx0bWVzc2FnZTogJ1NtYXJ0IENvbm5lY3Rpb25zIHZpZXcgaXMgb3BlbiBidXQgbm8gcmVzdWx0cyBmb3VuZC4gVHJ5IHJ1bm5pbmcgYSBzZWFyY2ggaW4gU21hcnQgQ29ubmVjdGlvbnMgZmlyc3QuJ1xuXHRcdFx0fTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgdmF1bHRJZCA9IHRoaXMuZ2V0VmF1bHRJZCgpO1xuXHRcdGNvbnN0IHNlc3Npb25JZCA9IHRoaXMuZ2VuZXJhdGVTZXNzaW9uSWQoKTtcblx0XHRcblx0XHRjb25zdCBjYWNoZTogU21hcnRDb25uZWN0aW9uc0NhY2hlID0ge1xuXHRcdFx0c291cmNlTm90ZVBhdGgsXG5cdFx0XHR2YXVsdElkLFxuXHRcdFx0cmVzdWx0czogcmVzdWx0cy5tYXAoKHIsIGkpID0+ICh7XG5cdFx0XHRcdHBhdGg6IHIucGF0aCxcblx0XHRcdFx0c2NvcmU6IHIuc2NvcmUsXG5cdFx0XHRcdGNhcHR1cmVkQXQ6IERhdGUubm93KClcblx0XHRcdH0pKSxcblx0XHRcdGNhcHR1cmVkQXQ6IERhdGUubm93KCksXG5cdFx0XHRtZXRob2Q6ICdkb20nLFxuXHRcdFx0c2Vzc2lvbklkXG5cdFx0fTtcblx0XHRcblx0XHRhd2FpdCB0aGlzLnNhdmVDYWNoZShjYWNoZSk7XG5cdFx0XG5cdFx0cmV0dXJuIHtcblx0XHRcdHN1Y2Nlc3M6IHRydWUsXG5cdFx0XHRjb3VudDogcmVzdWx0cy5sZW5ndGhcblx0XHR9O1xuXHR9XG5cblx0LyoqXG5cdCAqIFB1YmxpYyBtZXRob2QgdG8gY2FwdHVyZSBmcm9tIGNsaXBib2FyZCBhbmQgc2F2ZSB0byBjYWNoZS5cblx0ICovXG5cdGFzeW5jIGNhcHR1cmVBbmRTYXZlRnJvbUNsaXBib2FyZChzb3VyY2VOb3RlUGF0aD86IHN0cmluZyk6IFByb21pc2U8eyBzdWNjZXNzOiBib29sZWFuOyBjb3VudDogbnVtYmVyOyBtZXNzYWdlPzogc3RyaW5nIH0+IHtcblx0XHRjb25zdCByZXN1bHRzID0gYXdhaXQgdGhpcy5jYXB0dXJlRnJvbUNsaXBib2FyZChzb3VyY2VOb3RlUGF0aCk7XG5cdFx0XG5cdFx0aWYgKHJlc3VsdHMubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRzdWNjZXNzOiBmYWxzZSxcblx0XHRcdFx0Y291bnQ6IDAsXG5cdFx0XHRcdG1lc3NhZ2U6ICdObyB2YWxpZCBsaW5rcyBmb3VuZCBpbiBjbGlwYm9hcmQuIEVuc3VyZSBjbGlwYm9hcmQgY29udGFpbnMgU21hcnQgQ29ubmVjdGlvbnMgcmVzdWx0cyB3aXRoIG1hcmtkb3duIGxpbmtzLidcblx0XHRcdH07XG5cdFx0fVxuXHRcdFxuXHRcdGNvbnN0IHZhdWx0SWQgPSB0aGlzLmdldFZhdWx0SWQoKTtcblx0XHRjb25zdCBzZXNzaW9uSWQgPSB0aGlzLmdlbmVyYXRlU2Vzc2lvbklkKCk7XG5cdFx0XG5cdFx0Y29uc3QgY2FjaGU6IFNtYXJ0Q29ubmVjdGlvbnNDYWNoZSA9IHtcblx0XHRcdHNvdXJjZU5vdGVQYXRoLFxuXHRcdFx0dmF1bHRJZCxcblx0XHRcdHJlc3VsdHM6IHJlc3VsdHMubWFwKChyLCBpKSA9PiAoe1xuXHRcdFx0XHRwYXRoOiByLnBhdGgsXG5cdFx0XHRcdHNjb3JlOiByLnNjb3JlLFxuXHRcdFx0XHRjYXB0dXJlZEF0OiBEYXRlLm5vdygpXG5cdFx0XHR9KSksXG5cdFx0XHRjYXB0dXJlZEF0OiBEYXRlLm5vdygpLFxuXHRcdFx0bWV0aG9kOiAnY2xpcGJvYXJkJyxcblx0XHRcdHNlc3Npb25JZFxuXHRcdH07XG5cdFx0XG5cdFx0YXdhaXQgdGhpcy5zYXZlQ2FjaGUoY2FjaGUpO1xuXHRcdFxuXHRcdHJldHVybiB7XG5cdFx0XHRzdWNjZXNzOiB0cnVlLFxuXHRcdFx0Y291bnQ6IHJlc3VsdHMubGVuZ3RoXG5cdFx0fTtcblx0fVxuXG5cdC8qKlxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGNsZWFyIGNhY2hlLlxuXHQgKi9cblx0YXN5bmMgY2xlYXJDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcblx0XHR0aGlzLnBsdWdpbi5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zQ2FjaGUgPSB1bmRlZmluZWQ7XG5cdFx0YXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG5cdFx0XG5cdFx0dGhpcy5sb2coJ2luZm8nLCAnQ2FjaGUgY2xlYXJlZCcsIHtcblx0XHRcdHNlc3Npb25JZDogdGhpcy5jdXJyZW50U2Vzc2lvbklkXG5cdFx0fSk7XG5cdH1cblxuXHQvKipcblx0ICogUHVibGljIG1ldGhvZCB0byBnZXQgY2FjaGUgc3RhdHVzLlxuXHQgKi9cblx0Z2V0Q2FjaGVTdGF0dXMoKToge1xuXHRcdGV4aXN0czogYm9vbGVhbjtcblx0XHRlbmFibGVkOiBib29sZWFuO1xuXHRcdGNvdW50OiBudW1iZXI7XG5cdFx0YWdlPzogc3RyaW5nO1xuXHRcdG1ldGhvZD86ICdkb20nIHwgJ2NsaXBib2FyZCc7XG5cdFx0c291cmNlTm90ZT86IHN0cmluZztcblx0XHRmcmVzaDogYm9vbGVhbjtcblx0fSB7XG5cdFx0Y29uc3QgZW5hYmxlZCA9IHRoaXMucGx1Z2luLnNldHRpbmdzLnNtYXJ0Q29ubmVjdGlvbnNDYWNoZUVuYWJsZWQgPz8gZmFsc2U7XG5cdFx0Y29uc3QgY2FjaGUgPSB0aGlzLmdldENhY2hlKCk7XG5cdFx0XG5cdFx0aWYgKCFjYWNoZSkge1xuXHRcdFx0cmV0dXJuIHtcblx0XHRcdFx0ZXhpc3RzOiBmYWxzZSxcblx0XHRcdFx0ZW5hYmxlZCxcblx0XHRcdFx0Y291bnQ6IDAsXG5cdFx0XHRcdGZyZXNoOiBmYWxzZVxuXHRcdFx0fTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgYWdlID0gRGF0ZS5ub3coKSAtIGNhY2hlLmNhcHR1cmVkQXQ7XG5cdFx0Y29uc3QgYWdlSG91cnMgPSBNYXRoLmZsb29yKGFnZSAvICgxMDAwICogNjAgKiA2MCkpO1xuXHRcdGNvbnN0IGFnZU1pbnV0ZXMgPSBNYXRoLmZsb29yKChhZ2UgJSAoMTAwMCAqIDYwICogNjApKSAvICgxMDAwICogNjApKTtcblx0XHRjb25zdCBhZ2VTdHIgPSBhZ2VIb3VycyA+IDAgPyBgJHthZ2VIb3Vyc31oICR7YWdlTWludXRlc31tYCA6IGAke2FnZU1pbnV0ZXN9bWA7XG5cdFx0XG5cdFx0cmV0dXJuIHtcblx0XHRcdGV4aXN0czogdHJ1ZSxcblx0XHRcdGVuYWJsZWQsXG5cdFx0XHRjb3VudDogY2FjaGUucmVzdWx0cy5sZW5ndGgsXG5cdFx0XHRhZ2U6IGFnZVN0cixcblx0XHRcdG1ldGhvZDogY2FjaGUubWV0aG9kLFxuXHRcdFx0c291cmNlTm90ZTogY2FjaGUuc291cmNlTm90ZVBhdGgsXG5cdFx0XHRmcmVzaDogdGhpcy5pc0NhY2hlRnJlc2goY2FjaGUpXG5cdFx0fTtcblx0fVxuXG5cdC8qKlxuXHQgKiBQdWJsaWMgbWV0aG9kIHRvIGNoZWNrIGlmIFNtYXJ0IENvbm5lY3Rpb25zIHZpZXcgaXMgYXZhaWxhYmxlIGZvciBjYXB0dXJlLlxuXHQgKi9cblx0Y2hlY2tWaWV3QXZhaWxhYmxlKCk6IHsgYXZhaWxhYmxlOiBib29sZWFuOyBtZXNzYWdlPzogc3RyaW5nIH0ge1xuXHRcdGNvbnN0IHNjVmlldyA9IHRoaXMuZmluZFNtYXJ0Q29ubmVjdGlvbnNWaWV3KCk7XG5cdFx0aWYgKCFzY1ZpZXcpIHtcblx0XHRcdHJldHVybiB7XG5cdFx0XHRcdGF2YWlsYWJsZTogZmFsc2UsXG5cdFx0XHRcdG1lc3NhZ2U6ICdTbWFydCBDb25uZWN0aW9ucyB2aWV3IG5vdCBmb3VuZC4gT3BlbiBTbWFydCBDb25uZWN0aW9ucyBpbiBhIHBhbmUgZmlyc3QuJ1xuXHRcdFx0fTtcblx0XHR9XG5cdFx0XG5cdFx0Y29uc3QgaW50ZXJuYWxMaW5rcyA9IHNjVmlldy52aWV3LmNvbnRhaW5lckVsLnF1ZXJ5U2VsZWN0b3JBbGwoJ2EuaW50ZXJuYWwtbGlua1tkYXRhLWhyZWZdJyk7XG5cdFx0aWYgKGludGVybmFsTGlua3MubGVuZ3RoID09PSAwKSB7XG5cdFx0XHRyZXR1cm4ge1xuXHRcdFx0XHRhdmFpbGFibGU6IGZhbHNlLFxuXHRcdFx0XHRtZXNzYWdlOiAnU21hcnQgQ29ubmVjdGlvbnMgdmlldyBpcyBvcGVuIGJ1dCBubyByZXN1bHRzIGZvdW5kLiBUcnkgcnVubmluZyBhIHNlYXJjaCBpbiBTbWFydCBDb25uZWN0aW9ucyBmaXJzdC4nXG5cdFx0XHR9O1xuXHRcdH1cblx0XHRcblx0XHRyZXR1cm4ge1xuXHRcdFx0YXZhaWxhYmxlOiB0cnVlXG5cdFx0fTtcblx0fVxufVxuIl19