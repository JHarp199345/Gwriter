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
		
		return {
			sliding_window: await this.readFile(settings.slidingWindowPath),
			story_bible: await this.readFile(settings.storyBiblePath),
			extractions: await this.readFile(settings.extractionsPath),
			character_notes: await this.formatCharacterNotes(await this.getAllCharacterNotes()),
			smart_connections: await this.getSmartConnections(32)
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
}

