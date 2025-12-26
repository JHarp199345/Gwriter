import { App, TFile } from 'obsidian';

export class TemplateExecutor {
	constructor(private app: App) {}

	/**
	 * Execute an Obsidian template file and return the rendered output.
	 * The template is rendered with the active file as context.
	 */
	async executeTemplate(templatePath: string, activeFile: TFile | null): Promise<string> {
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		const templateContent = await this.app.vault.read(templateFile);
		
		// Use Obsidian's built-in template rendering
		// Note: Obsidian's template system may require the file to be in a specific location
		// We'll use app.templates.renderTemplate() if available, or manual rendering
		try {
			// Try Obsidian's native template rendering
			if (this.app.templates && typeof this.app.templates.renderTemplate === 'function') {
				return await this.app.templates.renderTemplate(templateContent, activeFile);
			}
			
			// Fallback: Manual template processing (if native API not available)
			// This would require parsing {{smart-connections:similar:128}} ourselves
			// For now, we'll assume Obsidian's template system handles it
			throw new Error('Template rendering API not available');
		} catch (error) {
			console.error('[TemplateExecutor] Failed to render template:', error);
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

