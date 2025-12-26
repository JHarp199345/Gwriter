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
		
		console.log('[TemplateProcessor] 🔧 Starting hook registration...');
		const scPlugin = appWithPlugins.plugins?.plugins?.['smart-connections'];
		console.log(
			`[TemplateProcessor] Plugin system state: ` +
			`app.plugins=${!!appWithPlugins.plugins} | ` +
			`app.plugins.plugins=${!!appWithPlugins.plugins?.plugins} | ` +
			`SC installed=${!!scPlugin} | ` +
			`SC loaded=${!!scPlugin?.instance} | ` +
			`SC enabled=${scPlugin?.enabled === true}`
		);
		
		// FIRST: Check if Text Generator is installed and see how it registers
		const textGeneratorPlugin = appWithPlugins.plugins?.plugins?.['text-generator'];
		if (textGeneratorPlugin) {
			console.log('[TemplateProcessor] 📦 Text Generator plugin found!');
			console.log('[TemplateProcessor] 🔍 Inspecting Text Generator template processor...');
			
			// Check how Text Generator exposes its template processor
			const tgInstance = textGeneratorPlugin.instance || textGeneratorPlugin;
			const tgProcessor = tgInstance?.templateProcessor || 
			                   tgInstance?.processTemplate ||
			                   textGeneratorPlugin.templateProcessor ||
			                   textGeneratorPlugin.processTemplate;
			
			if (tgProcessor) {
				console.log('[TemplateProcessor] ✅ Found Text Generator template processor:', typeof tgProcessor);
				if (typeof tgProcessor === 'object') {
					console.log('[TemplateProcessor] 📋 Text Generator processor keys:', Object.keys(tgProcessor || {}));
				}
				// Check where Text Generator registered itself
				if (appWithPlugins.templateProcessors) {
					const tgInArray = appWithPlugins.templateProcessors.find((p: any) => 
						p.id === 'text-generator' || p.name === 'Text Generator' || p.plugin === textGeneratorPlugin
					);
					if (tgInArray) {
						console.log('[TemplateProcessor] 📍 Text Generator found in app.templateProcessors array');
						console.log('[TemplateProcessor] 📋 Text Generator registration:', Object.keys(tgInArray));
					}
				}
			} else {
				console.log('[TemplateProcessor] ⚠️ Text Generator found but no template processor detected');
				console.log('[TemplateProcessor] 🔍 Text Generator plugin structure:', Object.keys(textGeneratorPlugin));
			}
		} else {
			console.log('[TemplateProcessor] ℹ️ Text Generator plugin not found');
		}
		
		// Hook Method 1: Register in app.templateProcessors array
		// SAFE: Only add if it already exists - never create it
		if (appWithPlugins.templateProcessors && Array.isArray(appWithPlugins.templateProcessors)) {
			appWithPlugins.templateProcessors.push({
				id: 'writing-dashboard',
				name: 'Writing Dashboard',
				process: this.processTemplate.bind(this),
				processTemplate: this.processTemplate.bind(this),
				renderTemplate: this.processTemplate.bind(this),
				plugin: this.plugin
			});
			this.logHookAttempt('app.templateProcessors array');
		} else {
			console.warn('[TemplateProcessor] ⚠️ app.templateProcessors not available or not an array - skipping');
		}
		
		// REMOVED: Hook Method 2 - app.plugins.templateProcessors
		// DANGEROUS: Modifying app.plugins structures breaks the plugin system
		
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
		// SAFE: Only add if it already exists - never create it
		if (appWithPlugins.templates && appWithPlugins.templates.processors && Array.isArray(appWithPlugins.templates.processors)) {
			appWithPlugins.templates.processors.push({
				id: 'writing-dashboard',
				name: 'Writing Dashboard',
				process: this.processTemplate.bind(this),
				processTemplate: this.processTemplate.bind(this)
			});
			this.logHookAttempt('app.templates.processors');
		} else {
			console.warn('[TemplateProcessor] ⚠️ app.templates.processors not available or not an array - skipping');
		}
		
		// REMOVED: Hook Method 8 - app.plugins.plugins['writing-dashboard']
		// DANGEROUS: Modifying plugin instances breaks the plugin system
		
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
		
		// REMOVED: Hook Method 10 - app.plugins.enabledPlugins.templateProcessors
		// DANGEROUS: Modifying enabledPlugins breaks the plugin system
		
		// Hook Method 11: Register as global function
		(window as any).writingDashboardProcessTemplate = this.processTemplate.bind(this);
		this.logHookAttempt('window.writingDashboardProcessTemplate function');
		
		// REMOVED: Hook Method 12 - app.plugins.plugins['writing-dashboard-template']
		// DANGEROUS: Creating new plugin entries breaks the plugin system
		} catch (error) {
			console.warn('[TemplateProcessor] Error during hook registration:', error);
			// Don't throw - allow plugin to continue loading even if some hooks fail
		}
	}

	private logHookAttempt(method: string): void {
		this.hookAttempts.set(method, false); // Will be set to true if used
		console.debug(`[TemplateProcessor] Registered hook via: ${method}`);
		console.log(`[TemplateProcessor] ✓ Registered hook via: ${method}`);
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
		console.log('[TemplateProcessor] 🚀 processTemplate called!');
		console.debug('[TemplateProcessor] processTemplate called!');
		console.log('[TemplateProcessor] 📄 Template content length:', templateContent.length);
		console.debug('[TemplateProcessor] Template content length:', templateContent.length);
		console.log('[TemplateProcessor] 📁 Active file:', context.file?.path || 'None');
		console.debug('[TemplateProcessor] Active file:', context.file?.path);
		
		// Track that our processor is being used
		// Log call stack to see which registration method worked
		try {
			const stack = new Error().stack;
			console.log('[TemplateProcessor] 📚 Call stack (first 10 lines):');
			const stackLines = stack?.split('\n').slice(0, 10) || [];
			stackLines.forEach((line, i) => {
				console.log(`[TemplateProcessor]   ${i + 1}. ${line.trim()}`);
			});
			console.debug('[TemplateProcessor] Call stack:', stack?.split('\n').slice(0, 10).join('\n'));
		} catch (e) {
			console.warn('[TemplateProcessor] ⚠️ Stack trace not available:', e);
		}
		
		let processed = templateContent;
		
		// Step 1: Process {{read "path"}} syntax
		console.log('[TemplateProcessor] 🔍 Processing {{read}} placeholders...');
		processed = await this.processReadPlaceholders(processed);
		
		// Step 2: Process {{clipboard}} syntax
		console.log('[TemplateProcessor] 📋 Processing {{clipboard}} placeholder...');
		processed = await this.processClipboardPlaceholder(processed);
		
		// Step 3: Process {{cursor}} syntax
		console.log('[TemplateProcessor] 📍 Processing {{cursor}} placeholder...');
		processed = this.processCursorPlaceholder(processed, context.file);
		
		// Step 4: Emit template processing event for Smart Connections to hook into
		// This is the critical moment - Smart Connections should detect this and process {{smart-connections:similar:N}}
		console.log('[TemplateProcessor] 📡 Emitting template-processing event for Smart Connections...');
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
		console.log('[TemplateProcessor] 📡 Emitting template-process event...');
		window.dispatchEvent(new CustomEvent('template-process', {
			detail: { 
				content: processed, 
				context,
				processor: 'writing-dashboard'
			}
		}));
		
		// Step 5: Wait for Smart Connections to process {{smart-connections:similar:N}}
		// Smart Connections should have hooked into the event and processed the syntax
		console.log('[TemplateProcessor] ⏳ Waiting 2 seconds for Smart Connections to process syntax...');
		console.debug('[TemplateProcessor] Waiting for Smart Connections to process syntax...');
		await new Promise(resolve => setTimeout(resolve, 2000));
		
		// Step 6: Check if Smart Connections processed the content
		// Smart Connections should have replaced {{smart-connections:similar:N}} with actual links
		const scRegex = /\{\{smart-connections:similar:(\d+)\}\}/g;
		const hasUnprocessedSC = scRegex.test(processed);
		
		if (hasUnprocessedSC) {
			const matches = processed.match(scRegex);
			console.warn('[TemplateProcessor] ❌ Smart Connections syntax not processed - hooks may not be working');
			console.warn(`[TemplateProcessor] ⚠️ Unprocessed syntax found: ${matches?.length || 0} placeholders still present`);
			if (matches) {
				console.warn('[TemplateProcessor] Unprocessed placeholders:', matches);
			}
			
			// Diagnose why Smart Connections didn't process
			const diagnosis = this.diagnoseSmartConnectionsFailure();
			console.warn(`[TemplateProcessor] 🔍 Diagnostic: ${diagnosis}`);
		} else {
			console.log('[TemplateProcessor] ✅ Smart Connections syntax appears to have been processed');
			console.debug('[TemplateProcessor] Smart Connections syntax appears to have been processed');
		}
		
		// Step 7: Re-read the processed content in case Smart Connections modified it
		// (Smart Connections might modify the content directly via the event)
		const finalContent = processed;
		
		console.log('[TemplateProcessor] ✅ Final processed content length:', finalContent.length);
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
	 * Diagnose why Smart Connections didn't process the template
	 * Returns a detailed explanation of what happened and why
	 */
	private diagnoseSmartConnectionsFailure(): string {
		const appWithPlugins = this.app as any;
		const diagnostics: string[] = [];
		
		// Check if Smart Connections plugin exists (read-only access)
		const scPlugin = appWithPlugins.plugins?.plugins?.['smart-connections'];
		if (!scPlugin) {
			diagnostics.push('ROOT CAUSE: Smart Connections plugin not installed or not found in app.plugins.plugins');
			diagnostics.push('WHY THIS FAILED: Smart Connections cannot process templates if the plugin is not installed');
			diagnostics.push('SOLUTION: Install Smart Connections plugin from Community Plugins');
		} else {
			// Check if plugin is actually LOADED, not just installed
			const isLoaded = scPlugin.instance !== undefined && scPlugin.instance !== null;
			const isEnabled = scPlugin.enabled === true;
			
			if (!isLoaded) {
				diagnostics.push('ROOT CAUSE: Smart Connections plugin found but instance not loaded yet');
				diagnostics.push('WHY THIS FAILED: Plugin may still be initializing - our hook registration ran too early');
				diagnostics.push('SOLUTION: Plugin needs time to fully load. Try again after a few seconds, or delay our hook registration');
			} else if (!isEnabled) {
				diagnostics.push('ROOT CAUSE: Smart Connections plugin found but not enabled');
				diagnostics.push('WHY THIS FAILED: Disabled plugins do not process templates or respond to events');
				diagnostics.push('SOLUTION: Enable Smart Connections in Settings > Community Plugins');
			} else {
				// Plugin is loaded AND enabled - proceed with checks
				diagnostics.push('✓ Smart Connections plugin is installed, loaded, and enabled');
				
				// Check if our hooks were registered
				const hookStatus = this.getHookStatus();
				const registeredCount = Object.values(hookStatus).length;
				diagnostics.push(`✓ ${registeredCount} hook registration methods attempted`);
				
				// Check if processTemplate was called (indicates a hook worked)
				diagnostics.push('✓ Our template processor WAS called (hook registration succeeded)');
				diagnostics.push('✓ Template processing events were emitted (template-processing, template-process)');
				
				// Check if Smart Connections has template processing capabilities (read-only access)
				const scInstance = scPlugin.instance;
				if (scInstance) {
					const scMethods = Object.keys(scInstance).filter(k => 
						k.toLowerCase().includes('template') || 
						k.toLowerCase().includes('process') ||
						k.toLowerCase().includes('similar')
					);
					if (scMethods.length > 0) {
						diagnostics.push(`✓ Smart Connections has methods: ${scMethods.join(', ')}`);
					} else {
						diagnostics.push('⚠️ Smart Connections template processing methods not detected');
					}
				}
				
				// The real issue: Smart Connections may not be listening to our events
				diagnostics.push('ROOT CAUSE: Smart Connections is not listening to our template-processing events');
				diagnostics.push('WHY THIS FAILED: Smart Connections likely hooks into Text Generator\'s template system, not generic events');
				diagnostics.push('WHAT HAPPENED: We emitted events but Smart Connections did not respond because it uses a different hook mechanism');
				diagnostics.push('SOLUTION: Smart Connections may need to be called via Obsidian\'s native template insertion (which we tried) or Text Generator\'s API');
			}
		}
		
		return diagnostics.join(' | ');
	}

	/**
	 * Get status of which hooks were registered (for debugging)
	 */
	getHookStatus(): Record<string, boolean> {
		return Object.fromEntries(this.hookAttempts);
	}
}

