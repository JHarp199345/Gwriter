import type { ContextItem, RetrievalOptions, RetrievalProvider, RetrievalQuery } from './types';
import { pluginApi } from '@vanakat/plugin-api';
import type { Vault } from 'obsidian';
import { TFile } from 'obsidian';

/**
 * Smart Connections API result format (inferred from common patterns).
 * The actual API may return different structure, but we'll handle it gracefully.
 */
interface SmartConnectionsResult {
	path?: string;
	file?: string;
	filePath?: string;
	score?: number;
	similarity?: number;
	excerpt?: string;
	content?: string;
	[key: string]: unknown;
}

/**
 * Retrieval provider that uses Smart Connections plugin's similarity search API.
 * Gracefully degrades if Smart Connections is not installed or doesn't expose an API.
 */
export class SmartConnectionsProvider implements RetrievalProvider {
	readonly id = 'smart-connections';

	private readonly vault: Vault;
	private scApi: unknown | null = null;
	private readonly isAllowedPath: (path: string) => boolean;

	constructor(vault: Vault, isAllowedPath: (path: string) => boolean) {
		this.vault = vault;
		this.isAllowedPath = isAllowedPath;
		this.initializeApi();
	}

	/**
	 * Try to get Smart Connections API using common registration keys.
	 */
	private initializeApi(): void {
		// Try multiple possible API keys
		const possibleKeys = ['smart-connections', 'sc', 'smartconnections'];
		
		for (const key of possibleKeys) {
			try {
				const api = pluginApi.get(key);
				if (api && typeof api === 'object') {
					// Check if it has a similar method (common API pattern)
					if (typeof (api as { similar?: unknown }).similar === 'function') {
						this.scApi = api;
						console.log(`[SmartConnectionsProvider] Found API with key: ${key}`);
						return;
					}
				}
			} catch {
				// Key doesn't exist, try next
				continue;
			}
		}
		
		// API not found - this is fine, provider will return empty results
		console.log('[SmartConnectionsProvider] Smart Connections API not found. Provider will return empty results.');
	}

	async search(query: RetrievalQuery, opts: RetrievalOptions): Promise<ContextItem[]> {
		// If API not available, return empty array (graceful degradation)
		if (!this.scApi) {
			return [];
		}

		const q = (query.text ?? '').trim();
		if (!q) {
			return [];
		}

		try {
			// Call Smart Connections API
			// Common API patterns: scApi.similar(text, limit) or scApi.getSimilar(text, limit)
			const api = this.scApi as { similar?: (text: string, limit: number) => Promise<SmartConnectionsResult[]> | SmartConnectionsResult[] };
			
			if (!api.similar) {
				console.warn('[SmartConnectionsProvider] API found but missing similar() method');
				return [];
			}

			const limit = Math.max(1, Math.min(200, opts.limit * 3));
			const results = await api.similar(q, limit);

			// Convert Smart Connections results to ContextItem[]
			const contextItems: ContextItem[] = [];
			
			for (const result of results) {
				// Extract path from various possible fields
				const path = result.path || result.file || result.filePath || '';
				if (!path || typeof path !== 'string') {
					continue;
				}

				// Skip if path is excluded
				if (!this.isAllowedPath(path)) {
					continue;
				}

				// Get excerpt from result or read file
				let excerpt = result.excerpt || result.content || '';
				if (!excerpt && path) {
					try {
						const file = this.vault.getAbstractFileByPath(path);
						if (file instanceof TFile) {
							const content = await this.vault.read(file);
							// Extract first ~200 characters as excerpt
							excerpt = content.trim().replace(/\s+/g, ' ').slice(0, 200);
							if (content.length > 200) {
								excerpt += '…';
							}
						}
					} catch {
						// File read failed, use empty excerpt
						excerpt = '';
					}
				}

				// Normalize score to 0-1 range
				// Smart Connections might return similarity scores in different ranges
				let score = result.score ?? result.similarity ?? 0.5;
				if (typeof score !== 'number') {
					score = 0.5;
				}
				// Normalize to 0-1 if needed (assuming scores might be 0-1, 0-100, or cosine similarity -1 to 1)
				if (score > 1) {
					score = score / 100; // Assume 0-100 range
				} else if (score < 0) {
					score = (score + 1) / 2; // Assume cosine similarity -1 to 1
				}
				score = Math.max(0, Math.min(1, score));

				contextItems.push({
					key: path,
					path: path,
					title: path.split('/').pop() || path,
					excerpt: excerpt || '[No excerpt available]',
					score: score,
					source: this.id,
					reasonTags: ['smart-connections-api']
				});
			}

			// Sort by score (descending) and limit
			return contextItems
				.sort((a, b) => b.score - a.score)
				.slice(0, opts.limit);

		} catch (error) {
			// Log error but don't throw - graceful degradation
			console.warn('[SmartConnectionsProvider] Error calling Smart Connections API:', error);
			return [];
		}
	}
}

