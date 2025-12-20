import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { TextChunker } from './TextChunker';

export class VaultService {
	private vault: Vault;
	private plugin: WritingDashboardPlugin;

	constructor(vault: Vault, plugin: WritingDashboardPlugin) {
		this.vault = vault;
		this.plugin = plugin;
	}

	async readFile(path: string): Promise<string> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return await this.vault.read(file);
		}
		throw new Error(`File not found: ${path}`);
	}

	async writeFile(path: string, content: string): Promise<void> {
		await this.vault.adapter.write(path, content);
	}

	async createFileIfNotExists(path: string, content: string): Promise<boolean> {
		const file = this.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return false; // File already exists
		}
		// File doesn't exist, create it
		await this.vault.create(path, content);
		return true; // File was created
	}

	async createFolderIfNotExists(path: string): Promise<boolean> {
		const folder = this.vault.getAbstractFileByPath(path);
		if (folder instanceof TFolder) {
			return false; // Folder already exists
		}
		// Folder doesn't exist, create it
		await this.vault.createFolder(path);
		return true; // Folder was created
	}

	async setupDefaultStructure(items: Array<{type: 'file' | 'folder', path: string, content?: string}>): Promise<{created: string[], skipped: string[]}> {
		const created: string[] = [];
		const skipped: string[] = [];

		for (const item of items) {
			if (item.type === 'file') {
				const wasCreated = await this.createFileIfNotExists(item.path, item.content || '');
				if (wasCreated) {
					created.push(item.path);
				} else {
					skipped.push(item.path);
				}
			} else {
				const wasCreated = await this.createFolderIfNotExists(item.path);
				if (wasCreated) {
					created.push(item.path);
				} else {
					skipped.push(item.path);
				}
			}
		}

		return { created, skipped };
	}

	/**
	 * Chunk a file into 500-word chunks and save them in a chunked folder
	 * @param sourceFilePath Path to the source file (e.g., "Book-Main.md")
	 * @param text Text content to chunk
	 * @param wordsPerChunk Number of words per chunk (default: 500)
	 * @returns Array of created chunk file paths
	 */
	async chunkFile(sourceFilePath: string, text: string, wordsPerChunk: number = 500): Promise<string[]> {
		// Extract base filename without extension
		const baseName = sourceFilePath.replace(/\.md$/, '').replace(/\.\w+$/, '');
		const chunkedFolderName = `${baseName}-Chunked`;
		
		const chunks = TextChunker.chunkText(text, wordsPerChunk);
		
		// Ensure chunked folder exists
		await this.createFolderIfNotExists(chunkedFolderName);
		
		const createdFiles: string[] = [];
		
		// Create chunk files
		for (let i = 0; i < chunks.length; i++) {
			const chunkNumber = String(i + 1).padStart(3, '0');
			const chunkFileName = `${baseName}-CHUNK-${chunkNumber}.md`;
			const chunkFilePath = `${chunkedFolderName}/${chunkFileName}`;
			
			// Create chunk file
			await this.createFileIfNotExists(chunkFilePath, chunks[i]);
			createdFiles.push(chunkFilePath);
		}
		
		return createdFiles;
	}

	async updateCharacterNotes(updates: Array<{ character: string; update: string }>): Promise<void> {
		const characterFolder = this.plugin.settings.characterFolder;
		
		// Ensure folder exists
		await this.createFolderIfNotExists(characterFolder);
		
		for (const { character, update } of updates) {
			const characterPath = `${characterFolder}/${character}.md`;
			let existingContent = '';
			
			try {
				existingContent = await this.readFile(characterPath);
			} catch {
				// File doesn't exist, will create new
			}
			
			// Generate readable timestamp
			const now = new Date();
			const timestamp = now.toLocaleString('en-US', {
				month: 'long',
				day: 'numeric',
				year: 'numeric',
				hour: 'numeric',
				minute: '2-digit',
				hour12: true
			});
			
			const newContent = existingContent 
				? `${existingContent}\n\n## ${timestamp} - Update\n\n${update}\n`
				: `# ${character}\n\n## ${timestamp} - Update\n\n${update}\n`;
			
			await this.writeFile(characterPath, newContent);
		}
	}

	getVaultStructure(): Array<{ name: string; path: string; type: 'file' | 'folder' }> {
		const structure: Array<{ name: string; path: string; type: 'file' | 'folder' }> = [];
		
		const root = this.vault.getRoot();
		this._traverseFolder(root, structure, '');
		
		return structure;
	}

	private _traverseFolder(
		folder: TFolder,
		structure: Array<{ name: string; path: string; type: 'file' | 'folder' }>,
		basePath: string
	): void {
		for (const child of folder.children) {
			const path = basePath ? `${basePath}/${child.name}` : child.name;
			
			if (child instanceof TFolder) {
				structure.push({ name: child.name, path, type: 'folder' });
				this._traverseFolder(child, structure, path);
			} else if (child instanceof TFile) {
				structure.push({ name: child.name, path, type: 'file' });
			}
		}
	}
}

