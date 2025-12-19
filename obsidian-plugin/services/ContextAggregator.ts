import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { Context } from './PromptEngine';

export class ContextAggregator {
	private vault: Vault;
	private plugin: WritingDashboardPlugin;

	constructor(vault: Vault, plugin: WritingDashboardPlugin) {
		this.vault = vault;
		this.plugin = plugin;
	}

	async getChapterContext(): Promise<Context> {
		const settings = this.plugin.settings;
		
		return {
			smart_connections: await this.getSmartConnections(),
			book2: await this.readFile(settings.book2Path),
			story_bible: await this.readFile(settings.storyBiblePath),
			extractions: await this.readFile(settings.extractionsPath),
			sliding_window: await this.readFile(settings.slidingWindowPath)
		};
	}

	async getMicroEditContext(selectedText: string): Promise<Context> {
		const settings = this.plugin.settings;
		const surrounding = await this.getSurroundingContext(selectedText, 500, 500);
		
		return {
			sliding_window: await this.readFile(settings.slidingWindowPath),
			story_bible: await this.readFile(settings.storyBiblePath),
			extractions: await this.readFile(settings.extractionsPath),
			character_notes: await this.formatCharacterNotes(await this.getAllCharacterNotes()),
			smart_connections: await this.getSmartConnections(32),
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
		} catch (error) {
			return `[Error reading file ${path}: ${error}]`;
		}
	}

	private async getSmartConnections(limit: number = 64): Promise<string> {
		// Try to read Smart Connections data
		const scDataPath = '.obsidian/plugins/smart-connections/data.json';
		try {
			const file = this.vault.getAbstractFileByPath(scDataPath);
			if (file instanceof TFile) {
				const data = JSON.parse(await this.vault.read(file));
				// For now, return a placeholder - full implementation would
				// query embeddings and return actual similar note content
				return '[Smart Connections data loaded - similarity search available]';
			}
		} catch (error) {
			return `[Smart Connections: Error loading data - ${error}]`;
		}
		return '[Smart Connections: No data found - ensure plugin is installed and has indexed your vault]';
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
		} catch (error) {
			// Folder doesn't exist yet, that's okay
		}
		
		return notes;
	}

	private async formatCharacterNotes(characterNotes: Record<string, string>): Promise<string> {
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

