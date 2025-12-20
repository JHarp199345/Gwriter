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
		
		return {
			smart_connections: await this.getSmartConnections(),
			book2: await this.readFile(settings.book2Path),
			story_bible: await this.readFile(settings.storyBiblePath),
			extractions: extractions,
			sliding_window: await this.readFile(settings.slidingWindowPath)
		};
	}

	async getMicroEditContext(selectedText: string): Promise<Context> {
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
		
		return {
			sliding_window: await this.readFile(settings.slidingWindowPath),
			story_bible: await this.readFile(settings.storyBiblePath),
			extractions: extractions,
			character_notes: this.formatCharacterNotes(await this.getAllCharacterNotes()),
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
		// Obsidian's config folder is user-configurable; use vault.configDir
		const scDataPath = `${this.vault.configDir}/plugins/smart-connections/data.json`;
		let smartConnectionsAvailable = false;
		
		try {
			const file = this.vault.getAbstractFileByPath(scDataPath);
			if (file instanceof TFile) {
				const data = JSON.parse(await this.vault.read(file));
				smartConnectionsAvailable = true;
				// Smart Connections data exists - now extract Book 1 content
			}
		} catch (error) {
			// Smart Connections not available, will use fallback
		}
		
		// Extract Book 1 canon content from vault
		const book1Content = await this.extractBook1Content(limit);
		
		if (book1Content.length > 0) {
			const scStatus = smartConnectionsAvailable 
				? '[Smart Connections: Active - Book 1 canon loaded]' 
				: '[Smart Connections: Not installed - Using Book 1 files directly]';
			return `${scStatus}\n\n${book1Content}`;
		}
		
		if (smartConnectionsAvailable) {
			return '[Smart Connections: Data found but no Book 1 content detected. Ensure Book 1 files exist in your vault.]';
		}
		
		return '[Smart Connections: Not available. To use Book 1 canon context, either install Smart Connections plugin or ensure Book 1 files are accessible in your vault.]';
	}

	/**
	 * Extract Book 1 canon content from vault
	 * Looks for common Book 1 patterns: chunked folders, Book 1 files, etc.
	 */
	private async extractBook1Content(maxChunks: number = 64): Promise<string> {
		const content: string[] = [];
		const processedFiles = new Set<string>();
		
		// Common Book 1 folder/file patterns
		const book1Patterns = [
			'Book 1 - Chunked',
			'Book-1-Chunked',
			'Book1-Chunked',
			'Book 1',
			'Book-1',
			'Book1'
		];
		
		// Search for Book 1 chunked folders first (most common)
		for (const pattern of book1Patterns) {
			try {
				const folder = this.vault.getAbstractFileByPath(pattern);
				if (folder instanceof TFolder) {
					const chunks = await this.readChunkedFolder(folder, maxChunks);
					content.push(...chunks);
					if (content.length >= maxChunks) break;
				}
			} catch {
				// Folder doesn't exist, continue
			}
		}
		
		// If no chunked folder found, look for Book 1 files directly
		if (content.length === 0) {
			for (const pattern of book1Patterns) {
				try {
					const file = this.vault.getAbstractFileByPath(`${pattern}.md`);
					if (file instanceof TFile && !processedFiles.has(file.path)) {
						const fileContent = await this.vault.read(file);
						// Extract sample chunks from the file
						const chunks = this.chunkText(fileContent, Math.min(maxChunks, 10));
						content.push(...chunks);
						processedFiles.add(file.path);
					}
				} catch {
					// File doesn't exist, continue
				}
			}
		}
		
		// Also search for any files with "Book 1" in the name
		if (content.length < maxChunks) {
			const allFiles = this.vault.getMarkdownFiles();
			for (const file of allFiles) {
				if (processedFiles.has(file.path)) continue;
				
				const fileName = file.basename.toLowerCase();
				if (fileName.includes('book 1') || fileName.includes('book-1') || fileName.includes('book1')) {
					try {
						const fileContent = await this.vault.read(file);
						const chunks = this.chunkText(fileContent, Math.min(maxChunks - content.length, 5));
						content.push(...chunks);
						processedFiles.add(file.path);
						if (content.length >= maxChunks) break;
					} catch {
						// Error reading file, skip
					}
				}
			}
		}
		
		// Format content with file references
		if (content.length === 0) {
			return '';
		}
		
		return content.slice(0, maxChunks).join('\n\n---\n\n');
	}

	/**
	 * Read all chunk files from a chunked folder
	 */
	private async readChunkedFolder(folder: TFolder, maxChunks: number): Promise<string[]> {
		const chunks: string[] = [];
		const chunkFiles: TFile[] = [];
		
		// Collect all markdown files
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				chunkFiles.push(child);
			}
		}
		
		// Sort by name to maintain order
		chunkFiles.sort((a, b) => a.name.localeCompare(b.name));
		
		// Read up to maxChunks files
		for (let i = 0; i < Math.min(chunkFiles.length, maxChunks); i++) {
			try {
				const content = await this.vault.read(chunkFiles[i]);
				if (content.trim()) {
					chunks.push(`[From: ${chunkFiles[i].name}]\n${content}`);
				}
			} catch {
				// Error reading file, skip
			}
		}
		
		return chunks;
	}

	/**
	 * Chunk text into smaller pieces (for large files)
	 */
	private chunkText(text: string, maxChunks: number): string[] {
		const words = text.trim().split(/\s+/);
		if (words.length === 0) return [];
		
		const wordsPerChunk = Math.max(500, Math.ceil(words.length / maxChunks));
		const chunks: string[] = [];
		
		for (let i = 0; i < words.length && chunks.length < maxChunks; i += wordsPerChunk) {
			const chunk = words.slice(i, i + wordsPerChunk).join(' ');
			if (chunk.trim()) {
				chunks.push(chunk);
			}
		}
		
		return chunks;
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

