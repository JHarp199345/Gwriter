import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { Context } from './PromptEngine';
import type { ContextItem, RetrievalQuery } from './retrieval/types';

export class ContextAggregator {
	private vault: Vault;
	private plugin: WritingDashboardPlugin;

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

	constructor(vault: Vault, plugin: WritingDashboardPlugin) {
		this.vault = vault;
		this.plugin = plugin;
	}

	async getChapterContext(retrievalQuery: RetrievalQuery): Promise<Context> {
		const settings = this.plugin.settings;
		
		// Handle extractionsPath gracefully - it's optional
		let extractions = '';
		if (settings.extractionsPath) {
			try {
				extractions = await this.readFile(settings.extractionsPath);
			} catch {
				// File doesn't exist, use empty string
				extractions = '';
			}
		}
		
		// Budget context dynamically based on the configured contextTokenLimit.
		const { limit, reserveForOutput, reserveForNonContext } = this.computeContextBudgetTokens();
		const contextBudget = Math.max(1000, limit - reserveForOutput - reserveForNonContext);

		// More available tokens => more retrieved chunks to include.
		const retrievedLimit = Math.min(200, Math.max(24, Math.floor(contextBudget / 12000)));
		const retrievedContext = await this.getRetrievedContext(retrievalQuery, retrievedLimit);
		const book2Full = await this.readFile(settings.book2Path);
		const storyBible = await this.readFile(settings.storyBiblePath);
		const slidingWindow = await this.readFile(settings.slidingWindowPath);

		// Allocate context budget by priority. Book 2 gets the remainder (tail).
		const smartBudget = Math.floor(contextBudget * 0.30);
		const bibleBudget = Math.floor(contextBudget * 0.18);
		const extractionsBudget = Math.floor(contextBudget * 0.08);
		const slidingBudget = Math.floor(contextBudget * 0.04);
		const used =
			smartBudget + bibleBudget + extractionsBudget + slidingBudget;
		const book2Budget = Math.max(1000, contextBudget - used);

		return {
			smart_connections: this.trimHeadToBudget(retrievedContext, smartBudget, 'Retrieved context'),
			// For continuation, the most recent manuscript tail matters most.
			book2: this.trimTailToBudget(book2Full, book2Budget, 'Book 2'),
			story_bible: this.trimHeadToBudget(storyBible, bibleBudget, 'Story bible'),
			extractions: this.trimHeadToBudget(extractions, extractionsBudget, 'Extractions'),
			sliding_window: this.trimHeadToBudget(slidingWindow, slidingBudget, 'Sliding window')
		};
	}

	async getMicroEditContext(selectedText: string, retrievalQuery: RetrievalQuery): Promise<Context> {
		const settings = this.plugin.settings;
		const surrounding = await this.getSurroundingContext(selectedText, 500, 500);
		
		// Handle extractionsPath gracefully - it's optional
		let extractions = '';
		if (settings.extractionsPath) {
			try {
				extractions = await this.readFile(settings.extractionsPath);
			} catch {
				// File doesn't exist, use empty string
				extractions = '';
			}
		}
		
		// Budget context dynamically based on the configured contextTokenLimit.
		const { limit, reserveForOutput, reserveForNonContext } = this.computeContextBudgetTokens();
		const contextBudget = Math.max(1000, limit - reserveForOutput - reserveForNonContext);

		const storyBible = await this.readFile(settings.storyBiblePath);
		const slidingWindow = await this.readFile(settings.slidingWindowPath);
		const characterNotes = this.formatCharacterNotes(await this.getAllCharacterNotes());

		// Retrieved context in micro-edit is a style/continuity echo; keep it smaller.
		const retrievedLimit = Math.min(80, Math.max(12, Math.floor(contextBudget / 20000)));
		const retrievedContext = await this.getRetrievedContext(retrievalQuery, retrievedLimit);

		// Allocate budget by priority for micro edits.
		const slidingBudget = Math.floor(contextBudget * 0.03);
		const bibleBudget = Math.floor(contextBudget * 0.20);
		const extractionsBudget = Math.floor(contextBudget * 0.10);
		const characterBudget = Math.floor(contextBudget * 0.32);
		const smartBudget = Math.floor(contextBudget * 0.15);

		return {
			sliding_window: this.trimHeadToBudget(slidingWindow, slidingBudget, 'Sliding window'),
			story_bible: this.trimHeadToBudget(storyBible, bibleBudget, 'Story bible'),
			extractions: this.trimHeadToBudget(extractions, extractionsBudget, 'Extractions'),
			character_notes: this.trimHeadToBudget(characterNotes, characterBudget, 'Character notes'),
			smart_connections: this.trimHeadToBudget(retrievedContext, smartBudget, 'Retrieved context'),
			surrounding_before: surrounding.before,
			surrounding_after: surrounding.after
		};
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

	private async getRetrievedContext(query: RetrievalQuery, limit: number): Promise<string> {
		try {
			const results = await this.plugin.retrievalService.search(query, {
				limit: Math.max(1, Math.min(200, limit))
			});
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
		
		// Try to get context from sliding window first, then book2
		let sourceText = '';
		try {
			sourceText = await this.readFile(settings.slidingWindowPath);
		} catch {
			try {
				sourceText = await this.readFile(settings.book2Path);
			} catch {
				return { before: '', after: '' };
			}
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

