import { App, TFile } from 'obsidian';

export class TemplateExecutor {
	constructor(private app: App) {}

	/**
	 * Execute an Obsidian template file and return the rendered output.
	 * Uses command palette to trigger template insertion so Smart Connections processes it.
	 * Creates a new leaf at root level that can be saved and evaluated.
	 */
	async executeTemplate(templatePath: string, activeFile: TFile | null): Promise<string> {
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		// Create a visible test note at root level
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		
		// Delete existing test file if it exists
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		
		// Create new empty test file
		const testFile = await this.app.vault.create(testPath, '');
		
		try {
			// Open the test file in a new leaf (required for template command to work)
			const leaf = await this.app.workspace.openLinkText(testPath, '', true);
			
			// Wait a moment for the file to be fully opened and focused
			await new Promise(resolve => setTimeout(resolve, 500));
			
			// Execute the template insertion command via command palette
			// This will trigger Smart Connections to process {{smart-connections:similar:128}}
			// The command will open a template picker - we need to handle that
			const appWithCommands = this.app as any;
			if (appWithCommands.commands && appWithCommands.commands.executeCommandById) {
				await appWithCommands.commands.executeCommandById('templates:insert-template');
			} else {
				throw new Error('Command system not available');
			}
			
			// Wait for user to select template (or if it auto-selects, wait for processing)
			// Then wait longer for Smart Connections to process its syntax
			// Smart Connections may need time to query embeddings and render results
			await new Promise(resolve => setTimeout(resolve, 4000));
			
			// Read the rendered content
			const rendered = await this.app.vault.read(testFile);
			
			// Note: Not closing the leaf - user can see and evaluate the rendered template
			// File will be visible at root: Template-Render-Test.md
			
			return rendered;
		} catch (error) {
			console.error('[TemplateExecutor] Failed to render template:', error);
			// Don't delete test file on error - user can inspect what happened
			throw error;
		}
	}

	/**
	 * Parse template output to extract file paths from Smart Connections results.
	 * Smart Connections typically outputs markdown links like [[Note Name]] or [Note Name](path).
	 */
	parseTemplateOutput(output: string): string[] {
		const paths: string[] = [];
		
		// Extract [[note-name]] links (Obsidian wiki links)
		const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
		let match;
		while ((match = wikiLinkRegex.exec(output)) !== null) {
			const linkText = match[1];
			// Remove heading anchor if present (e.g., "Note Name#Heading" -> "Note Name")
			const cleanLink = linkText.split('#')[0];
			// Convert wiki link to file path (handle aliases, headings, etc.)
			const file = this.app.metadataCache.getFirstLinkpathDest(cleanLink, '');
			if (file) {
				paths.push(file.path);
			}
		}
		
		// Also extract markdown links [text](path)
		const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
		while ((match = markdownLinkRegex.exec(output)) !== null) {
			const linkPath = match[2];
			// Remove #anchor if present
			const cleanPath = linkPath.split('#')[0];
			if (cleanPath && !cleanPath.startsWith('http')) {
				const file = this.app.vault.getAbstractFileByPath(cleanPath);
				if (file instanceof TFile) {
					paths.push(file.path);
				}
			}
		}
		
		// Remove duplicates
		return Array.from(new Set(paths));
	}
}

