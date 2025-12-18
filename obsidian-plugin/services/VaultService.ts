import { Vault, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';

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

	async updateCharacterNotes(updates: Array<{ character: string; update: string }>): Promise<void> {
		const characterFolder = this.plugin.settings.characterFolder;
		
		for (const { character, update } of updates) {
			const characterPath = `${characterFolder}/${character}.md`;
			let existingContent = '';
			
			try {
				existingContent = await this.readFile(characterPath);
			} catch {
				// File doesn't exist, create new
				// Ensure folder exists
				const folder = this.vault.getAbstractFileByPath(characterFolder);
				if (!folder) {
					await this.vault.createFolder(characterFolder);
				}
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

