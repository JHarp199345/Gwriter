import { App, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { TemplateProcessor } from './TemplateProcessor';

export class TemplateExecutor {
	private templateProcessor: TemplateProcessor;
	
	constructor(private app: App, private plugin: WritingDashboardPlugin) {
		// TemplateProcessor will be initialized in main.ts
		// We'll get it from the plugin instance
	}

	/**
	 * Execute a template file and return the rendered output.
	 * Uses our TemplateProcessor which registers hooks for Smart Connections.
	 */
	async executeTemplate(templatePath: string, activeFile: TFile | null): Promise<string> {
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		// Get the template processor from the plugin
		const processor = (this.plugin as any).templateProcessorInstance;
		if (!processor) {
			throw new Error('TemplateProcessor not initialized. Please ensure the plugin has loaded.');
		}

		// Read template content
		const templateContent = await this.app.vault.read(templateFile);
		
		console.debug(`[TemplateExecutor] Executing template: ${templatePath}`);
		console.debug(`[TemplateExecutor] Template content: ${templateContent.substring(0, 200)}...`);
		
		// Process template using our processor (which Smart Connections can hook into)
		const rendered = await processor.processTemplate(templateContent, { file: activeFile });
		
		// Log hook status for debugging
		const hookStatus = processor.getHookStatus();
		console.debug('[TemplateExecutor] Hook registration status:', hookStatus);
		
		// Create a visible test note at root level to see the rendered output
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		
		// Delete existing test file if it exists
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		
		// Create new test file with rendered content
		const testFile = await this.app.vault.create(testPath, rendered);
		
		// Open in a new leaf so user can see it
		await this.app.workspace.openLinkText(testPath, '', true);
		
		console.debug(`[TemplateExecutor] Template rendered: ${rendered.length} chars`);
		console.debug(`[TemplateExecutor] Rendered content preview: ${rendered.substring(0, 500)}...`);
		
		return rendered;
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

