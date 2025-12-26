import { App, TFile, MarkdownView } from 'obsidian';
import WritingDashboardPlugin from '../main';

export class TemplateProcessor {
	private hookAttempts: Map<string, boolean> = new Map();
	private app: App;
	private plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		this.app = app;
		this.plugin = plugin;
		this.registerAllPossibleHooks();
	}

	/**
	 * Register hooks in every possible way Smart Connections might look for template processors.
	 * We'll track which one actually gets used.
	 */
	private registerAllPossibleHooks(): void {
		try {
			const appWithPlugins = this.app as any;
		
		// Hook Method 1: Register in app.templateProcessors array
		if (!appWithPlugins.templateProcessors) {
			appWithPlugins.templateProcessors = [];
		}
		appWithPlugins.templateProcessors.push({
			id: 'writing-dashboard',
			name: 'Writing Dashboard',
			process: this.processTemplate.bind(this),
			processTemplate: this.processTemplate.bind(this),
			renderTemplate: this.processTemplate.bind(this),
			plugin: this.plugin
		});
		this.logHookAttempt('app.templateProcessors array');
		
		// Hook Method 2: Register in app.plugins.templateProcessors object
		if (!appWithPlugins.plugins) {
			appWithPlugins.plugins = {};
		}
		if (!appWithPlugins.plugins.templateProcessors) {
			appWithPlugins.plugins.templateProcessors = {};
		}
		appWithPlugins.plugins.templateProcessors['writing-dashboard'] = {
			id: 'writing-dashboard',
			name: 'Writing Dashboard',
			process: this.processTemplate.bind(this),
			processTemplate: this.processTemplate.bind(this),
			renderTemplate: this.processTemplate.bind(this)
		};
		this.logHookAttempt('app.plugins.templateProcessors object');
		
		// Hook Method 3: Register in window.templateProcessors array
		if (!(window as any).templateProcessors) {
			(window as any).templateProcessors = [];
		}
		(window as any).templateProcessors.push({
			id: 'writing-dashboard',
			name: 'Writing Dashboard',
			process: this.processTemplate.bind(this),
			processTemplate: this.processTemplate.bind(this)
		});
		this.logHookAttempt('window.templateProcessors array');
		
		// Hook Method 4: Register as window.templateProcessor (singular object)
		if (!(window as any).templateProcessor) {
			(window as any).templateProcessor = {};
		}
		(window as any).templateProcessor['writing-dashboard'] = this.processTemplate.bind(this);
		this.logHookAttempt('window.templateProcessor object');
		
		// Hook Method 5: Expose on plugin instance
		(this.plugin as any).templateProcessor = this.processTemplate.bind(this);
		(this.plugin as any).processTemplate = this.processTemplate.bind(this);
		(this.plugin as any).renderTemplate = this.processTemplate.bind(this);
		this.logHookAttempt('plugin instance methods');
		
		// Hook Method 6: Custom event listener registration
		window.addEventListener('template-process', this.handleTemplateProcess.bind(this));
		window.addEventListener('template-processing', this.handleTemplateProcessing.bind(this));
		this.logHookAttempt('window template-process event listeners');
		
		// Hook Method 7: Expose via app.templates (if exists)
		if (appWithPlugins.templates) {
			if (!appWithPlugins.templates.processors) {
				appWithPlugins.templates.processors = [];
			}
			appWithPlugins.templates.processors.push({
				id: 'writing-dashboard',
				name: 'Writing Dashboard',
				process: this.processTemplate.bind(this),
				processTemplate: this.processTemplate.bind(this)
			});
			this.logHookAttempt('app.templates.processors');
		}
		
		// Hook Method 8: Register in app.plugins.plugins['writing-dashboard']
		const ourPlugin = appWithPlugins.plugins?.plugins?.['writing-dashboard'];
		if (ourPlugin) {
			ourPlugin.templateProcessor = this.processTemplate.bind(this);
			ourPlugin.processTemplate = this.processTemplate.bind(this);
			ourPlugin.renderTemplate = this.processTemplate.bind(this);
		}
		this.logHookAttempt('app.plugins.plugins[writing-dashboard]');
		
		// Hook Method 9: Emit registration event
		window.dispatchEvent(new CustomEvent('template-processor-registered', {
			detail: {
				id: 'writing-dashboard',
				process: this.processTemplate.bind(this),
				processTemplate: this.processTemplate.bind(this),
				plugin: this.plugin
			}
		}));
		this.logHookAttempt('template-processor-registered event');
		
		// Hook Method 10: Register in app.plugins.enabledPlugins template processors
		if (appWithPlugins.plugins?.enabledPlugins) {
			if (!appWithPlugins.plugins.enabledPlugins.templateProcessors) {
				appWithPlugins.plugins.enabledPlugins.templateProcessors = [];
			}
			appWithPlugins.plugins.enabledPlugins.templateProcessors.push({
				id: 'writing-dashboard',
				name: 'Writing Dashboard',
				process: this.processTemplate.bind(this)
			});
			this.logHookAttempt('app.plugins.enabledPlugins.templateProcessors');
		}
		
		// Hook Method 11: Register as global function
		(window as any).writingDashboardProcessTemplate = this.processTemplate.bind(this);
		this.logHookAttempt('window.writingDashboardProcessTemplate function');
		
		// Hook Method 12: Register in app.plugins.plugins namespace with different key
		if (appWithPlugins.plugins?.plugins) {
			appWithPlugins.plugins.plugins['writing-dashboard-template'] = {
				id: 'writing-dashboard',
				name: 'Writing Dashboard',
				process: this.processTemplate.bind(this),
				processTemplate: this.processTemplate.bind(this)
			};
		}
		this.logHookAttempt('app.plugins.plugins[writing-dashboard-template]');
		} catch (error) {
			console.warn('[TemplateProcessor] Error during hook registration:', error);
			// Don't throw - allow plugin to continue loading even if some hooks fail
		}
	}

	private logHookAttempt(method: string): void {
		this.hookAttempts.set(method, false); // Will be set to true if used
		console.debug(`[TemplateProcessor] Registered hook via: ${method}`);
	}

	private handleTemplateProcess(event: CustomEvent): void {
		console.debug(`[TemplateProcessor] Template process event received:`, event.type, event.detail);
		// Track which event type was used
	}

	private handleTemplateProcessing(event: CustomEvent): void {
		console.debug(`[TemplateProcessor] Template processing event received:`, event.type, event.detail);
	}

	/**
	 * Main template processing method that Smart Connections should hook into.
	 * This processes our template placeholders and emits events for Smart Connections.
	 */
	async processTemplate(templateContent: string, context: { file?: TFile }): Promise<string> {
		// Log that our processor was called
		console.debug('[TemplateProcessor] processTemplate called!');
		console.debug('[TemplateProcessor] Template content length:', templateContent.length);
		console.debug('[TemplateProcessor] Active file:', context.file?.path);
		
		// Track that our processor is being used
		// Log call stack to see which registration method worked
		try {
			const stack = new Error().stack;
			console.debug('[TemplateProcessor] Call stack:', stack?.split('\n').slice(0, 10).join('\n'));
		} catch (e) {
			// Stack trace not available
		}
		
		let processed = templateContent;
		
		// Step 1: Process {{read "path"}} syntax
		processed = await this.processReadPlaceholders(processed);
		
		// Step 2: Process {{clipboard}} syntax
		processed = await this.processClipboardPlaceholder(processed);
		
		// Step 3: Process {{cursor}} syntax
		processed = this.processCursorPlaceholder(processed, context.file);
		
		// Step 4: Emit template processing event for Smart Connections to hook into
		// This is the critical moment - Smart Connections should detect this and process {{smart-connections:similar:N}}
		console.debug('[TemplateProcessor] Emitting template-processing event for Smart Connections');
		window.dispatchEvent(new CustomEvent('template-processing', {
			detail: { 
				content: processed, 
				context,
				processor: 'writing-dashboard',
				originalContent: templateContent
			}
		}));
		
		// Also emit other possible event names
		window.dispatchEvent(new CustomEvent('template-process', {
			detail: { 
				content: processed, 
				context,
				processor: 'writing-dashboard'
			}
		}));
		
		// Step 5: Wait for Smart Connections to process {{smart-connections:similar:N}}
		// Smart Connections should have hooked into the event and processed the syntax
		console.debug('[TemplateProcessor] Waiting for Smart Connections to process syntax...');
		await new Promise(resolve => setTimeout(resolve, 2000));
		
		// Step 6: Check if Smart Connections processed the content
		// Smart Connections should have replaced {{smart-connections:similar:N}} with actual links
		const scRegex = /\{\{smart-connections:similar:(\d+)\}\}/g;
		const hasUnprocessedSC = scRegex.test(processed);
		
		if (hasUnprocessedSC) {
			console.warn('[TemplateProcessor] Smart Connections syntax not processed - hooks may not be working');
			console.warn('[TemplateProcessor] Unprocessed syntax found in content');
		} else {
			console.debug('[TemplateProcessor] Smart Connections syntax appears to have been processed');
		}
		
		// Step 7: Re-read the processed content in case Smart Connections modified it
		// (Smart Connections might modify the content directly via the event)
		const finalContent = processed;
		
		console.debug('[TemplateProcessor] Final processed content length:', finalContent.length);
		
		return finalContent;
	}

	/**
	 * Process {{read "file.md"}} placeholders
	 */
	private async processReadPlaceholders(content: string): Promise<string> {
		const readRegex = /\{\{read\s+"([^"]+)"\}\}/g;
		let match;
		const replacements: Array<{ placeholder: string; content: string }> = [];
		
		while ((match = readRegex.exec(content)) !== null) {
			const filePath = match[1];
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				try {
					const fileContent = await this.app.vault.read(file);
					replacements.push({ placeholder: match[0], content: fileContent });
					console.debug(`[TemplateProcessor] Processed {{read "${filePath}"}} - ${fileContent.length} chars`);
				} catch (error) {
					console.warn(`[TemplateProcessor] Failed to read file: ${filePath}`, error);
					replacements.push({ placeholder: match[0], content: `[Error reading file: ${filePath}]` });
				}
			} else {
				console.warn(`[TemplateProcessor] File not found: ${filePath}`);
				replacements.push({ placeholder: match[0], content: `[File not found: ${filePath}]` });
			}
		}
		
		for (const { placeholder, content: fileContent } of replacements) {
			content = content.replace(placeholder, fileContent);
		}
		
		return content;
	}

	/**
	 * Process {{clipboard}} placeholder
	 */
	private async processClipboardPlaceholder(content: string): Promise<string> {
		if (content.includes('{{clipboard}}')) {
			try {
				const clipboardText = await navigator.clipboard.readText();
				content = content.replace(/\{\{clipboard\}\}/g, clipboardText);
				console.debug(`[TemplateProcessor] Processed {{clipboard}} - ${clipboardText.length} chars`);
			} catch (error) {
				console.warn('[TemplateProcessor] Failed to read clipboard:', error);
				content = content.replace(/\{\{clipboard\}\}/g, '');
			}
		}
		return content;
	}

	/**
	 * Process {{cursor}} placeholder
	 */
	private processCursorPlaceholder(content: string, activeFile: TFile | null): string {
		if (content.includes('{{cursor}}')) {
			try {
				const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeLeaf) {
					const editor = activeLeaf.editor;
					const selection = editor.getSelection();
					const cursorContent = selection || `[Cursor in ${activeFile?.basename || 'active file'}]`;
					content = content.replace(/\{\{cursor\}\}/g, cursorContent);
					console.debug(`[TemplateProcessor] Processed {{cursor}} - ${cursorContent.length} chars`);
				} else {
					content = content.replace(/\{\{cursor\}\}/g, '');
				}
			} catch (error) {
				console.warn('[TemplateProcessor] Failed to process {{cursor}}:', error);
				content = content.replace(/\{\{cursor\}\}/g, '');
			}
		}
		return content;
	}

	/**
	 * Get status of which hooks were registered (for debugging)
	 */
	getHookStatus(): Record<string, boolean> {
		return Object.fromEntries(this.hookAttempts);
	}
}

