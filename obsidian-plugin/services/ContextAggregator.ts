import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { Context } from './PromptEngine';
import type { ContextItem, RetrievalQuery } from './retrieval/types';
import { VaultService } from './VaultService';
import { TemplateExecutor } from './TemplateExecutor';

export class ContextAggregator {
	private vault: Vault;
	private plugin: WritingDashboardPlugin;
	private vaultService: VaultService;
	public templateExecutor: TemplateExecutor;

	private budgetToChars(tokens: number): number {
		// estimateTokens uses ~4 chars per token; invert that here
		return Math.max(0, Math.floor(tokens * 4));
	}

	private trimHeadToBudget(text: string, maxTokens: number, label: string): string {
		if (!text) return '';
		const maxChars = this.budgetToChars(maxTokens);
		if (text.length <= maxChars) return text;
		const trimmed = text.slice(0, maxChars);
		return (
			`${trimmed}\n\n` +
			`[${label}: truncated to ~${maxTokens.toLocaleString()} tokens]`
		);
	}

	private trimTailToBudget(text: string, maxTokens: number, label: string): string {
		if (!text) return '';
		const maxChars = this.budgetToChars(maxTokens);
		if (text.length <= maxChars) return text;
		const trimmed = text.slice(-maxChars);
		return (
			`[${label}: showing last ~${maxTokens.toLocaleString()} tokens]\n\n` +
			trimmed
		);
	}

	private computeContextBudgetTokens(): { limit: number; reserveForOutput: number; reserveForNonContext: number } {
		const limit = this.plugin.settings.contextTokenLimit ?? 128000;
		// Reserve space for: prompt scaffolding + user inputs + output.
		// Keep output reservation large enough to avoid Gemini "MAX_TOKENS with empty text" cases.
		const reserveForOutput = Math.min(20000, Math.max(6000, Math.floor(limit * 0.02)));
		const reserveForNonContext = Math.min(20000, Math.max(4000, Math.floor(limit * 0.02)));
		return { limit, reserveForOutput, reserveForNonContext };
	}

	constructor(vault: Vault, plugin: WritingDashboardPlugin, vaultService: VaultService) {
		this.vault = vault;
		this.plugin = plugin;
		this.vaultService = vaultService;
		this.templateExecutor = new TemplateExecutor(plugin.app, plugin);
	}

	async getChapterContext(retrievalQuery: RetrievalQuery): Promise<Context> {
		const settings = this.plugin.settings;
		
		// Step 1: Execute Smart Connections template if configured
		let scTemplatePaths: string[] = [];
		if (settings.smartConnectionsTemplatePath) {
			try {
				const activeFile = this.plugin.app.workspace.getActiveFile();
				const templateOutput = await this.templateExecutor.executeTemplate(
					settings.smartConnectionsTemplatePath,
					activeFile
				);
				scTemplatePaths = this.templateExecutor.parseTemplateOutput(templateOutput);
				console.debug(`[ContextAggregator] Smart Connections template returned ${scTemplatePaths.length} paths`);
			} catch (error) {
				console.warn(`[ContextAggregator] Template execution failed:`, error);
				// Continue without SC template results
			}
		}
		
		// Budget context dynamically based on the configured contextTokenLimit.
		const { limit, reserveForOutput, reserveForNonContext } = this.computeContextBudgetTokens();
		const contextBudget = Math.max(1000, limit - reserveForOutput - reserveForNonContext);

		// More available tokens => more retrieved chunks to include.
		const retrievedLimit = Math.min(200, Math.max(24, Math.floor(contextBudget / 12000)));
		const retrievedContext = await this.getRetrievedContext(retrievalQuery, retrievedLimit, scTemplatePaths);
		
		// Read book file only to extract sliding window (last 20k words), not full context
		// Sliding window is automatically extracted from book2Path by the plugin
		const book2Full = await this.readFile(settings.book2Path);
		const slidingWindow = this.extractWordsFromEnd(book2Full, 20000);
		
		const storyBible = await this.readFile(settings.storyBiblePath);
		
		// Allocate context budget by priority. No book2 full context - only sliding window.
		const smartBudget = Math.floor(contextBudget * 0.45);
		const bibleBudget = Math.floor(contextBudget * 0.25);
		const slidingBudget = Math.floor(contextBudget * 0.10);

		const result: Context = {
			smart_connections: this.trimHeadToBudget(retrievedContext, smartBudget, 'Retrieved context'),
			story_bible: this.trimHeadToBudget(storyBible, bibleBudget, 'Story bible'),
			sliding_window: this.trimHeadToBudget(slidingWindow, slidingBudget, 'Sliding window')
		};

		return result;
	}

	async getMicroEditContext(selectedText: string, retrievalQuery: RetrievalQuery): Promise<Context> {
		const settings = this.plugin.settings;
		const surrounding = await this.getSurroundingContext(selectedText, 500, 500);
		
		// Step 1: Execute Smart Connections template if configured
		let scTemplatePaths: string[] = [];
		if (settings.smartConnectionsTemplatePath) {
			try {
				const activeFile = this.plugin.app.workspace.getActiveFile();
				const templateOutput = await this.templateExecutor.executeTemplate(
					settings.smartConnectionsTemplatePath,
					activeFile
				);
				scTemplatePaths = this.templateExecutor.parseTemplateOutput(templateOutput);
				console.debug(`[ContextAggregator] Smart Connections template returned ${scTemplatePaths.length} paths`);
			} catch (error) {
				console.warn(`[ContextAggregator] Template execution failed:`, error);
				// Continue without SC template results
			}
		}
		
		// Budget context dynamically based on the configured contextTokenLimit.
		const { limit, reserveForOutput, reserveForNonContext } = this.computeContextBudgetTokens();
		const contextBudget = Math.max(1000, limit - reserveForOutput - reserveForNonContext);

		// Read book file only to extract sliding window (last 20k words), not full context
		// Sliding window is automatically extracted from book2Path by the plugin
		const book2Full = await this.readFile(settings.book2Path);
		const slidingWindow = this.extractWordsFromEnd(book2Full, 20000);
		
		const storyBible = await this.readFile(settings.storyBiblePath);
		const characterNotes = this.formatCharacterNotes(await this.getAllCharacterNotes());

		// Retrieved context in micro-edit is a style/continuity echo; keep it smaller.
		const retrievedLimit = Math.min(80, Math.max(12, Math.floor(contextBudget / 20000)));
		const retrievedContext = await this.getRetrievedContext(retrievalQuery, retrievedLimit, scTemplatePaths);
		
		// Allocate budget by priority for micro edits.
		const slidingBudget = Math.floor(contextBudget * 0.03);
		const bibleBudget = Math.floor(contextBudget * 0.25);
		const characterBudget = Math.floor(contextBudget * 0.37);
		const smartBudget = Math.floor(contextBudget * 0.20);

		const result: Context = {
			sliding_window: this.trimHeadToBudget(slidingWindow, slidingBudget, 'Sliding window'),
			story_bible: this.trimHeadToBudget(storyBible, bibleBudget, 'Story bible'),
			character_notes: this.trimHeadToBudget(characterNotes, characterBudget, 'Character notes'),
			smart_connections: this.trimHeadToBudget(retrievedContext, smartBudget, 'Retrieved context'),
			surrounding_before: surrounding.before,
			surrounding_after: surrounding.after
		};

		return result;
	}

	async getCharacterNotes(): Promise<Record<string, string>> {
		return await this.getAllCharacterNotes();
	}

	async readFile(path: string): Promise<string> {
		try {
			const file = this.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				return await this.vault.read(file);
			}
			return `[File not found: ${path}]`;
		} catch (error: unknown) {
			const message =
				error instanceof Error
					? error.message
					: (() => {
							try {
								return JSON.stringify(error);
							} catch {
								return '[unserializable error]';
							}
						})();
			return `[Error reading file ${path}: ${message}]`;
		}
	}

	private formatRetrievedItems(items: ContextItem[]): string {
		if (!items.length) return '[No retrieved context]';
		const lines: string[] = [];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			lines.push(
				`[${i + 1}] ${item.path}\n` +
					`Score: ${item.score.toFixed(3)} (${item.source})\n` +
					`${item.excerpt}`.trim()
			);
		}
		return lines.join('\n\n---\n\n');
	}

	private async getRetrievedContext(query: RetrievalQuery, limit: number, _scTemplatePaths?: string[]): Promise<string> {
		try {
			let results = await this.plugin.retrievalService.search(query, {
				limit: Math.max(1, Math.min(200, limit))
			});
			if (this.plugin.settings.retrievalEnableReranker) {
				try {
					results = await this.plugin.cpuReranker.rerank(query.text || '', results, { limit: Math.max(1, Math.min(200, limit)) });
				} catch {
					// If reranker fails, keep pre-rerank results.
				}
			}
			return this.formatRetrievedItems(results);
		} catch {
			return '[Retrieved context unavailable]';
		}
	}

	private async getAllCharacterNotes(): Promise<Record<string, string>> {
		const notes: Record<string, string> = {};
		const characterFolder = this.plugin.settings.characterFolder;
		
		try {
			const folder = this.vault.getAbstractFileByPath(characterFolder);
			if (folder instanceof TFolder) {
				for (const child of folder.children) {
					if (child instanceof TFile && child.extension === 'md') {
						const characterName = child.basename;
						notes[characterName] = await this.vault.read(child);
					}
				}
			}
		} catch {
			// Folder doesn't exist yet, that's okay
		}
		
		return notes;
	}

	private formatCharacterNotes(characterNotes: Record<string, string>): string {
		if (Object.keys(characterNotes).length === 0) {
			return '[No character notes found]';
		}
		
		const formatted: string[] = [];
		for (const [name, content] of Object.entries(characterNotes)) {
			formatted.push(`## ${name}\n${content}\n`);
		}
		
		return formatted.join('\n---\n\n');
	}

	// Helper method to extract words from text
	private extractWords(text: string, count: number): string {
		const words = text.trim().split(/\s+/);
		if (words.length <= count) return text;
		return words.slice(0, count).join(' ');
	}

	// Helper method to extract words from the end of text
	private extractWordsFromEnd(text: string, count: number): string {
		const words = text.trim().split(/\s+/);
		if (words.length <= count) return text;
		return words.slice(-count).join(' ');
	}

	// Get surrounding context (words before and after selected text)
	async getSurroundingContext(selectedText: string, wordsBefore: number = 500, wordsAfter: number = 500): Promise<{ before: string; after: string }> {
		const settings = this.plugin.settings;
		
		// Get context from book main file (sliding window is automatically extracted from here)
		let sourceText = '';
		try {
			sourceText = await this.readFile(settings.book2Path);
		} catch {
			return { before: '', after: '' };
		}
		
		// Find the selected text in the source
		const selectedIndex = sourceText.indexOf(selectedText);
		
		if (selectedIndex === -1) {
			// Selected text not found, return empty
			return { before: '', after: '' };
		}
		
		// Extract text before
		const textBefore = sourceText.substring(0, selectedIndex);
		const beforeWords = this.extractWordsFromEnd(textBefore, wordsBefore);
		
		// Extract text after
		const textAfter = sourceText.substring(selectedIndex + selectedText.length);
		const afterWords = this.extractWords(textAfter, wordsAfter);
		
		return { before: beforeWords, after: afterWords };
	}
}

