import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { TextChunker } from './TextChunker';
import { CharacterNameResolver } from './CharacterNameResolver';
import { showCharacterNameConflictModal } from '../ui/CharacterNameConflictModal';

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

	/**
	 * Ensure the parent folder of a file path exists. Creates it if missing.
	 * Handles root-level files (no parent folder needed).
	 */
	async ensureParentFolder(filePath: string): Promise<void> {
		const normalized = filePath.replace(/\\/g, '/');
		const lastSlash = normalized.lastIndexOf('/');
		if (lastSlash === -1) {
			// Root-level file, no parent folder needed
			return;
		}
		const parentPath = normalized.substring(0, lastSlash);
		if (parentPath) {
			await this.createFolderIfNotExists(parentPath);
		}
	}

	/**
	 * Find the latest story bible file in a folder matching the pattern "Story bible - *.md"
	 * Returns the path of the latest file by modification time, or null if none found.
	 */
	findLatestStoryBible(folderPath: string): string | null {
		const folder = this.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			return null;
		}

		const storyBibleFiles: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				// Match pattern like "Story bible - YYYY-MM-DD.md" or "Story bible - merged YYYY-MM-DD.md"
				if (child.basename.match(/^Story bible/i)) {
					storyBibleFiles.push(child);
				}
			}
		}

		if (storyBibleFiles.length === 0) {
			return null;
		}

		// Sort by modification time (newest first)
		storyBibleFiles.sort((a, b) => {
			const aTime = a.stat?.mtime || 0;
			const bTime = b.stat?.mtime || 0;
			return bTime - aTime;
		});

		return storyBibleFiles[0].path;
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
		const resolver = new CharacterNameResolver(this.vault, characterFolder);
		const sessionResolutions = new Map<string, string>(); // proposed -> resolved
		
		// Ensure folder exists
		await this.createFolderIfNotExists(characterFolder);
		
		for (const { character, update } of updates) {
			const proposed = (character || '').trim();
			if (!proposed) continue;

			const cached = sessionResolutions.get(proposed);
			let resolvedName = cached;
			if (!resolvedName) {
				const res = resolver.resolve(proposed);
				if (res.resolvedName) {
					resolvedName = res.resolvedName;
				} else if (res.needsConfirmation) {
					const choice = await showCharacterNameConflictModal(this.plugin.app, {
						title: 'Confirm character note',
						message: 'Choose an existing character note to update, or create a new one.',
						proposedName: res.needsConfirmation.proposedName,
						candidates: res.needsConfirmation.candidates
					});
					if (!choice) continue;
					resolvedName = choice.name;
				} else {
					resolvedName = proposed;
				}
				sessionResolutions.set(proposed, resolvedName);
			}

			const characterPath = `${characterFolder}/${resolvedName}.md`;
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
				: `# ${resolvedName}\n\n## ${timestamp} - Update\n\n${update}\n`;
			
			await this.writeFile(characterPath, newContent);
		}
	}

	getVaultStructure(): Array<{ name: string; path: string; type: 'file' | 'folder' }> {
		const structure: Array<{ name: string; path: string; type: 'file' | 'folder' }> = [];
		
		const root = this.vault.getRoot();
		this._traverseFolder(root, structure, '');
		
		return structure;
	}

	/**
	 * List all folder paths in the vault (relative paths). Sorted for stable UI.
	 */
	getAllFolderPaths(): string[] {
		const folders: string[] = [];
		const root = this.vault.getRoot();
		this._collectFolders(root, folders, '');
		return folders.sort((a, b) => a.localeCompare(b));
	}

	/**
	 * `.obsidian/` is always excluded from retrieval/indexing.
	 */
	isExcludedPath(path: string): boolean {
		const normalized = path.replace(/\\/g, '/');
		// Obsidian's config folder is user-configurable; use vault.configDir.
		const configDir = this.vault.configDir.replace(/\\/g, '/');

		// Always exclude Obsidian config + plugin data.
		if (normalized === configDir || normalized.startsWith(`${configDir}/`)) return true;

		// Always exclude generation logs (to prevent retrieval feedback loops).
		const logsFolder = (this.plugin.settings.generationLogsFolder || '').replace(/\\/g, '/').replace(/\/+$/, '');
		if (logsFolder) {
			if (normalized === logsFolder || normalized.startsWith(`${logsFolder}/`)) return true;
		}

		// Retrieval profile include-set: if set, exclude anything not under included folders.
		// If includedFolders is empty, include everything (whole vault).
		const profiles = this.plugin.settings.retrievalProfiles || [];
		const activeId = this.plugin.settings.retrievalActiveProfileId;
		const active = profiles.find((p) => p.id === activeId);
		const includes = (active?.includedFolders || [])
			.map((p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, ''))
			.filter((p) => p.length > 0);
		// Only apply inclusion filter if folders are explicitly specified
		// Empty array means "include whole vault" (skip this check)
		if (includes.length > 0) {
			const allowed = includes.some((inc) => {
				// Match exact folder or files/subfolders within it
				return normalized === inc || normalized.startsWith(`${inc}/`);
			});
			if (!allowed) return true; // Excluded because not in any included folder
		}

		const excluded = this.plugin.settings.retrievalExcludedFolders || [];
		for (const folder of excluded) {
			const f = folder.replace(/\\/g, '/').replace(/\/+$/, '');
			if (!f) continue;
			if (normalized === f || normalized.startsWith(`${f}/`)) return true;
		}
		return false;
	}

	getIncludedMarkdownFiles(): TFile[] {
		return this.vault.getMarkdownFiles().filter((f) => !this.isExcludedPath(f.path));
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

	private _collectFolders(folder: TFolder, folders: string[], basePath: string): void {
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			const path = basePath ? `${basePath}/${child.name}` : child.name;
			folders.push(path);
			this._collectFolders(child, folders, path);
		}
	}
}

