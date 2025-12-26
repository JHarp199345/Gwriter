import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import type { App, Vault, WorkspaceLeaf } from 'obsidian';
import { TFile } from 'obsidian';
import WritingDashboardPlugin from '../../main';

/**
 * Smart Connections cache structure.
 */
interface SmartConnectionsCache {
	sourceNotePath?: string;
	vaultId?: string;
	results: Array<{
		path: string;
		score?: number;
		capturedSnippet?: string;
		capturedAt?: number;
	}>;
	capturedAt: number;
	method: 'dom' | 'clipboard';
	sessionId: string;
}

/**
 * Cached result item with scoring information.
 */
interface ScoredCacheItem {
	path: string;
	rankScore: number;
	metadataScore: number;
	fullContentScore?: number;
	finalScore: number;
	capturedAt?: number;
}

/**
 * Retrieval provider that uses Smart Connections plugin via capture and cache system.
 * Captures results from DOM or clipboard, caches them, and uses cached data for retrieval.
 */
export class SmartConnectionsProvider implements RetrievalProvider {
	readonly id = 'smart-connections';

	private readonly vault: Vault;
	private readonly app: App;
	private readonly plugin: WritingDashboardPlugin;
	private readonly isAllowedPath: (path: string) => boolean;
	private currentSessionId: string = '';

	constructor(
		app: App,
		plugin: WritingDashboardPlugin,
		vault: Vault,
		isAllowedPath: (path: string) => boolean
	) {
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
	private generateSessionId(): string {
		return Math.random().toString(36).substring(2, 8);
	}

	/**
	 * Initialize session ID for this instance.
	 */
	private initializeSession(): void {
		this.currentSessionId = this.generateSessionId();
	}

	/**
	 * Structured logging helper with session ID support.
	 */
	private log(level: 'info' | 'warn' | 'error', message: string, context?: Record<string, unknown>, details?: Record<string, unknown>): void {
		const timestamp = new Date().toISOString();
		const methodName = new Error().stack?.split('\n')[2]?.match(/at \w+\.(\w+)/)?.[1] || 'unknown';
		const sessionId = this.currentSessionId;
		
		const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
		const detailsStr = details ? ` | Details: ${JSON.stringify(details)}` : '';
		
		const logMessage = `[SmartConnectionsProvider:${methodName}][sid=${sessionId}] ${level.toUpperCase()}: ${message}${contextStr}${detailsStr}`;
		
		if (level === 'error') {
			console.error(logMessage);
		} else if (level === 'warn') {
			console.warn(logMessage);
		} else {
			console.log(logMessage);
		}
	}

	/**
	 * Log initialization status.
	 */
	private logInitialization(): void {
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
		} else {
			this.log('info', 'Initialization complete', {
				cacheEnabled: enabled,
				cacheExists: false
			});
		}
	}

	/**
	 * Get vault ID (name + optional basePath).
	 */
	private getVaultId(): string {
		const vaultName = this.app.vault.getName();
		const adapter = this.app.vault.adapter as { basePath?: string };
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
	private isCacheFresh(cache: SmartConnectionsCache): boolean {
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
	private normalizeFolderPath(path: string): string {
		let normalized = path.replace(/^\/+/, ''); // Remove leading slashes
		if (normalized && !normalized.endsWith('/')) {
			normalized += '/'; // Ensure trailing slash
		}
		return normalized;
	}

	/**
	 * Check if path is allowed based on folder filters.
	 */
	private isPathAllowed(path: string): boolean {
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
	private checkCacheKeying(cache: SmartConnectionsCache, currentNotePath?: string): { match: boolean; currentNote?: string; cacheNote?: string } {
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
	private validateAndCleanCache(cache: SmartConnectionsCache): { cache: SmartConnectionsCache; wasModified: boolean } {
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
	private async saveCache(cache: SmartConnectionsCache): Promise<void> {
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
	private getCache(): SmartConnectionsCache | null {
		return this.plugin.settings.smartConnectionsCache || null;
	}

	/**
	 * Find Smart Connections view using heuristic detection.
	 */
	private findSmartConnectionsView(): WorkspaceLeaf | null {
		const leaves: WorkspaceLeaf[] = [];
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
	async captureFromDom(sourceNotePath?: string): Promise<Array<{ path: string; score: number }>> {
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
		const results: Array<{ path: string; score: number }> = [];
		const maxCapture = this.plugin.settings.smartConnectionsMaxCaptureFiles ?? 200;
		
		for (let i = 0; i < Math.min(resultsCount, maxCapture); i++) {
			const link = internalLinks[i] as HTMLAnchorElement;
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
	async captureFromClipboard(sourceNotePath?: string): Promise<Array<{ path: string; score: number }>> {
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
			const links: string[] = [];
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
			const results: Array<{ path: string; score: number }> = [];
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
			
		} catch (error) {
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
	private tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.split(/[^a-z0-9]+/g)
			.map(t => t.trim())
			.filter(t => t.length >= 2);
	}

	/**
	 * Score cached items using metadata cache (fast path).
	 */
	private async scoreCachedItemsWithMetadata(
		cache: SmartConnectionsCache,
		query: string,
		limit: number
	): Promise<ScoredCacheItem[]> {
		const queryTokens = this.tokenize(query);
		const maxScoreFiles = this.plugin.settings.smartConnectionsMaxScoreFiles ?? 50;
		const itemsToScore = cache.results.slice(0, Math.min(cache.results.length, maxScoreFiles));
		
		this.log('info', 'Starting metadata scoring', {
			queryTokens: queryTokens.slice(0, 10), // Log first 10 tokens
			itemsToScore: itemsToScore.length,
			maxScoreFiles,
			sessionId: this.currentSessionId
		});
		
		const scored: ScoredCacheItem[] = [];
		
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
			const metadataText: string[] = [];
			
			// Frontmatter tags
			if (metadata.frontmatter?.tags) {
				const tags = Array.isArray(metadata.frontmatter.tags) 
					? metadata.frontmatter.tags 
					: [metadata.frontmatter.tags];
				metadataText.push(...tags.map((t: string) => t.toString().toLowerCase()));
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
	private async loadAndScoreTopItems(
		topItems: ScoredCacheItem[],
		query: string
	): Promise<ScoredCacheItem[]> {
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
			} catch (error) {
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
	private async generateBestMatchingExcerpt(path: string, query: string): Promise<string> {
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
				} else {
					excerpt = trimmed + '…';
				}
			} else if (excerpt.length < minLength && paragraphs.length > 1) {
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
			
		} catch (error) {
			this.log('warn', 'Failed to generate excerpt', {
				path,
				error: error instanceof Error ? error.message : String(error),
				sessionId: this.currentSessionId
			});
			return '[Error reading file]';
		}
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
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
		const results: ContextItem[] = [];
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
	async captureAndSaveFromDom(sourceNotePath?: string): Promise<{ success: boolean; count: number; message?: string }> {
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
		
		const cache: SmartConnectionsCache = {
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
	async captureAndSaveFromClipboard(sourceNotePath?: string): Promise<{ success: boolean; count: number; message?: string }> {
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
		
		const cache: SmartConnectionsCache = {
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
	async clearCache(): Promise<void> {
		this.plugin.settings.smartConnectionsCache = undefined;
		await this.plugin.saveSettings();
		
		this.log('info', 'Cache cleared', {
			sessionId: this.currentSessionId
		});
	}

	/**
	 * Public method to get cache status.
	 */
	getCacheStatus(): {
		exists: boolean;
		enabled: boolean;
		count: number;
		age?: string;
		method?: 'dom' | 'clipboard';
		sourceNote?: string;
		fresh: boolean;
	} {
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
	checkViewAvailable(): { available: boolean; message?: string } {
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
