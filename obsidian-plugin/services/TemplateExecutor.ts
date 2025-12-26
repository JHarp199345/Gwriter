import { App, TFile } from 'obsidian';

export class TemplateExecutor {
	constructor(private app: App) {}

	/**
	 * Execute an Obsidian template file and return the rendered output.
	 * The template is rendered with the active file as context.
	 * For testing: creates a visible note at root level to see rendered output.
	 */
	async executeTemplate(templatePath: string, activeFile: TFile | null): Promise<string> {
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		const appWithPlugins = this.app as any;
		const templatesPlugin = appWithPlugins.internalPlugins?.plugins?.templates?.instance;
		
		if (!templatesPlugin) {
			throw new Error('Templates plugin not available. Please enable it in Settings > Core plugins.');
		}

		// Create a visible test note at root level (not temporary, for testing)
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		
		// Delete existing test file if it exists
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		
		// Create new test file
		const testFile = await this.app.vault.create(testPath, '');
		
		try {
			// Use Templates plugin's insertTemplate method to render the template
			// This will process Smart Connections syntax automatically
			if (templatesPlugin.insertTemplate && typeof templatesPlugin.insertTemplate === 'function') {
				// Try different method signatures
				try {
					await templatesPlugin.insertTemplate(testFile, templateFile.path);
				} catch (e) {
					// Try alternative signature
					await templatesPlugin.insertTemplate(templateFile.path);
				}
			} else {
				throw new Error('Templates plugin insertTemplate method not found');
			}
			
			// Wait for Smart Connections to process its syntax
			await new Promise(resolve => setTimeout(resolve, 2000));
			
			// Read the rendered content
			const rendered = await this.app.vault.read(testFile);
			
			// Note: Not deleting the test file so user can inspect it
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

