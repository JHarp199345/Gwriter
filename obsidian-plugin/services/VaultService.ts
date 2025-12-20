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
	 * @param overwrite If true, overwrites existing chunk files and deletes extra old chunks
	 * @returns Stats about what was written/skipped/deleted
	 */
	async chunkFile(
		sourceFilePath: string,
		text: string,
		wordsPerChunk: number = 500,
		overwrite: boolean = false
	): Promise<{
		folder: string;
		totalChunks: number;
		created: number;
		overwritten: number;
		skipped: number;
		deletedExtra: number;
		filePaths: string[];
	}> {
		// Extract base filename without extension
		const baseName = sourceFilePath.replace(/\.md$/, '').replace(/\.\w+$/, '');
		const chunkedFolderName = `${baseName}-Chunked`;
		
		const chunks = TextChunker.chunkText(text, wordsPerChunk);
		
		// Ensure chunked folder exists
		await this.createFolderIfNotExists(chunkedFolderName);
		
		const filePaths: string[] = [];
		let created = 0;
		let overwrittenCount = 0;
		let skipped = 0;
		
		// Create chunk files
		for (let i = 0; i < chunks.length; i++) {
			const chunkNumber = String(i + 1).padStart(3, '0');
			const chunkFileName = `${baseName}-CHUNK-${chunkNumber}.md`;
			const chunkFilePath = `${chunkedFolderName}/${chunkFileName}`;
			
			const existing = this.vault.getAbstractFileByPath(chunkFilePath);
			if (overwrite) {
				// Overwrite if exists, otherwise create
				if (existing instanceof TFile) {
					await this.vault.modify(existing, chunks[i]);
					overwrittenCount++;
				} else {
					const wasCreated = await this.createFileIfNotExists(chunkFilePath, chunks[i]);
					if (wasCreated) created++;
				}
			} else {
				// Create chunk file only if it doesn't already exist
				if (existing instanceof TFile) {
					skipped++;
				} else {
					const wasCreated = await this.createFileIfNotExists(chunkFilePath, chunks[i]);
					if (wasCreated) created++;
				}
			}
			filePaths.push(chunkFilePath);
		}

		// If overwriting, delete any extra old chunk files beyond the new chunk count
		let deletedExtra = 0;
		if (overwrite) {
			const folder = this.vault.getAbstractFileByPath(chunkedFolderName);
			if (folder instanceof TFolder) {
				const maxIndex = chunks.length;
				const regex = new RegExp(`^${this._escapeRegExp(baseName)}-CHUNK-(\\d{3})\\.md$`);
				for (const child of folder.children) {
					if (!(child instanceof TFile) || child.extension !== 'md') continue;
					const match = child.name.match(regex);
					if (!match) continue;
					const idx = parseInt(match[1], 10);
					if (Number.isFinite(idx) && idx > maxIndex) {
						await this.vault.delete(child);
						deletedExtra++;
					}
				}
			}
		}
		
		return {
			folder: chunkedFolderName,
			totalChunks: chunks.length,
			created,
			overwritten: overwrittenCount,
			skipped,
			deletedExtra,
			filePaths
		};
	}

	private _escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	async updateCharacterNotes(
		updates: Array<{ character: string; update: string }>,
		folderOverride?: string
	): Promise<void> {
		const characterFolder = folderOverride || this.plugin.settings.characterFolder;
		
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

