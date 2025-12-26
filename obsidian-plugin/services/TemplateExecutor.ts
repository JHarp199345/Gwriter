import { App, TFile, Modal, Setting } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { TemplateProcessor } from './TemplateProcessor';

class TemplateInsertPrompt extends Modal {
	private onRun: () => Promise<void>;

	constructor(app: App, onRun: () => Promise<void>) {
		super(app);
		this.onRun = onRun;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Run Smart Connections template' });
		contentEl.createEl('p', {
			text: 'Click below to run Templates: Insert Template so Smart Connections can process {{smart-connections:similar:#}}.'
		});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Run Templates: Insert Template')
				.setCta()
				.onClick(async () => {
					try {
						await this.onRun();
					} finally {
						this.close();
					}
				}))
			.addExtraButton(btn => btn
				.setIcon('cross')
				.setTooltip('Cancel')
				.onClick(() => this.close()));
	}
}

export class TemplateExecutor {
	private templateProcessor: TemplateProcessor;
	
	constructor(private app: App, private plugin: WritingDashboardPlugin) {
		// TemplateProcessor will be initialized in main.ts
		// We'll get it from the plugin instance
	}

	/**
	 * Execute a template file and return the rendered output.
	 * Tries multiple approaches:
	 * 1. Native Obsidian template insertion (for Smart Connections compatibility)
	 * 2. Custom TemplateProcessor (fallback)
	 */
	async executeTemplate(templatePath: string, activeFile: TFile | null): Promise<string> {
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template file not found: ${templatePath}`);
		}

		console.log(`[TemplateExecutor] 🚀 Executing template: ${templatePath}`);
		
		// APPROACH 1: User-driven Templates command (Smart Connections friendly)
		console.log('[TemplateExecutor] 📝 Prompting user to run Templates: Insert Template...');
		try {
			const userResult = await this.executeNativeTemplateWithPrompt(templateFile);
			if (userResult) {
				const hasUnprocessedSC = /\{\{smart-connections:similar:(\d+)\}\}/g.test(userResult);
				if (!hasUnprocessedSC) {
					console.log('[TemplateExecutor] ✅ User-driven template insertion succeeded and Smart Connections processed it!');
					return userResult;
				} else {
					const scMatches = userResult.match(/\{\{smart-connections:similar:(\d+)\}\}/g);
					console.log('[TemplateExecutor] ⚠️ User-driven insertion succeeded but Smart Connections syntax still present');
					console.log(`[TemplateExecutor] 🔍 Diagnostic: Found ${scMatches?.length || 0} unprocessed Smart Connections placeholders`);
					console.log('[TemplateExecutor] 🔄 Trying automated native insertion next...');
				}
			} else {
				console.log('[TemplateExecutor] ⚠️ User-driven insertion returned empty result');
				console.log('[TemplateExecutor] 🔄 Trying automated native insertion next...');
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.warn(`[TemplateExecutor] ⚠️ User-driven insertion failed: ${errorMsg}`);
			console.log('[TemplateExecutor] 🔄 Trying automated native insertion next...');
		}

		// APPROACH 2: Automated native insertion (no user interaction)
		console.log('[TemplateExecutor] 📝 Attempting automated native template insertion...');
		try {
			const nativeResult = await this.executeNativeTemplate(templateFile, activeFile);
			if (nativeResult) {
				const hasUnprocessedSC = /\{\{smart-connections:similar:(\d+)\}\}/g.test(nativeResult);
				if (!hasUnprocessedSC) {
					console.log('[TemplateExecutor] ✅ Automated native insertion succeeded and Smart Connections processed it!');
					return nativeResult;
				} else {
					const scMatches = nativeResult.match(/\{\{smart-connections:similar:(\d+)\}\}/g);
					console.log('[TemplateExecutor] ⚠️ Automated native insertion succeeded but Smart Connections syntax still present');
					console.log(`[TemplateExecutor] 🔍 Diagnostic: Found ${scMatches?.length || 0} unprocessed Smart Connections placeholders`);
					console.log('[TemplateExecutor] 🔄 Falling back to custom processor...');
				}
			} else {
				console.log('[TemplateExecutor] ⚠️ Automated native insertion returned empty result');
				console.log('[TemplateExecutor] 🔍 Diagnostic: Template may not have been inserted or file was empty');
				console.log('[TemplateExecutor] 🔄 Falling back to custom processor...');
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.warn(`[TemplateExecutor] ⚠️ Automated native insertion failed: ${errorMsg}`);
			console.log(`[TemplateExecutor] 🔍 Diagnostic: ${this.diagnoseNativeTemplateFailure(error)}`);
			console.log('[TemplateExecutor] 🔄 Falling back to custom processor...');
		}
		
		// APPROACH 2: Fallback to custom TemplateProcessor
		console.log('[TemplateExecutor] 🔄 Using custom TemplateProcessor...');
		const processor = (this.plugin as any).templateProcessorInstance;
		if (!processor) {
			throw new Error('TemplateProcessor not initialized. Please ensure the plugin has loaded.');
		}

		const templateContent = await this.app.vault.read(templateFile);
		console.log(`[TemplateExecutor] 📄 Template content: ${templateContent.substring(0, 200)}...`);
		console.debug(`[TemplateExecutor] Template content: ${templateContent.substring(0, 200)}...`);
		
		const rendered = await processor.processTemplate(templateContent, { file: activeFile });
		
		const hookStatus = processor.getHookStatus();
		console.log('[TemplateExecutor] 📊 Hook registration status:', hookStatus);
		console.debug('[TemplateExecutor] Hook registration status:', hookStatus);
		
		// Create test file
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		const testFile = await this.app.vault.create(testPath, rendered);
		await this.app.workspace.openLinkText(testPath, '', true);
		
		console.log(`[TemplateExecutor] ✅ Template rendered: ${rendered.length} chars`);
		console.log(`[TemplateExecutor] 📄 Rendered preview: ${rendered.substring(0, 500)}...`);
		console.debug(`[TemplateExecutor] Template rendered: ${rendered.length} chars`);
		console.debug(`[TemplateExecutor] Rendered content preview: ${rendered.substring(0, 500)}...`);
		
		return rendered;
	}

	/**
	 * Diagnose why native template insertion failed
	 * Returns detailed explanation of what happened and why
	 */
	private diagnoseNativeTemplateFailure(error: unknown): string {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const appWithPlugins = this.app as any;
		
		const diagnostics: string[] = [];
		diagnostics.push(`EVENT: Native template insertion failed with error: "${errorMsg}"`);
		
		// Check Templates plugin
		const templatesPlugin = appWithPlugins.internalPlugins?.plugins?.templates;
		if (!templatesPlugin) {
			diagnostics.push('ROOT CAUSE: Templates plugin not found in internalPlugins');
			diagnostics.push('WHY THIS FAILED: Cannot insert templates without the Templates core plugin');
			diagnostics.push('SOLUTION: Templates is a core plugin - if missing, this may be an Obsidian installation issue');
		} else if (!templatesPlugin.enabled) {
			diagnostics.push('ROOT CAUSE: Templates plugin exists but is not enabled');
			diagnostics.push('WHY THIS FAILED: Disabled core plugins do not provide their functionality');
			diagnostics.push('SOLUTION: Enable Templates plugin in Settings > Core plugins');
		} else if (!templatesPlugin.instance) {
			diagnostics.push('ROOT CAUSE: Templates plugin enabled but instance not available');
			diagnostics.push('WHY THIS FAILED: Plugin instance is required to call insertTemplate method');
			diagnostics.push('SOLUTION: This may be a timing issue - plugin may not be fully initialized yet');
		} else if (!templatesPlugin.instance.insertTemplate) {
			diagnostics.push('ROOT CAUSE: Templates plugin instance exists but insertTemplate method not found');
			diagnostics.push('WHY THIS FAILED: The method we need to call does not exist on the plugin instance');
			diagnostics.push('SOLUTION: Obsidian version may be incompatible or plugin API changed');
		} else {
			diagnostics.push('✓ Templates plugin is available and has insertTemplate method');
		}
		
		// Check commands
		if (!appWithPlugins.commands) {
			diagnostics.push('⚠️ App commands API not available (fallback method unavailable)');
		} else if (!appWithPlugins.commands.executeCommandById) {
			diagnostics.push('⚠️ Command execution method not available (fallback method unavailable)');
		}
		
		// Check Smart Connections
		const scPlugin = appWithPlugins.plugins?.plugins?.['smart-connections'];
		if (!scPlugin) {
			diagnostics.push('⚠️ Smart Connections plugin not detected (may not be installed)');
		} else if (!scPlugin.enabled) {
			diagnostics.push('⚠️ Smart Connections plugin found but not enabled');
		} else {
			diagnostics.push('✓ Smart Connections plugin is installed and enabled');
		}
		
		// Error-specific diagnostics
		if (errorMsg.includes('not available')) {
			diagnostics.push('WHY THIS FAILED: Required API or method is not available in current Obsidian version');
		} else if (errorMsg.includes('not enabled')) {
			diagnostics.push('WHY THIS FAILED: Required plugin is not enabled in settings');
		} else if (errorMsg.includes('not found')) {
			diagnostics.push('WHY THIS FAILED: Required plugin or component not found');
		}
		
		return diagnostics.length > 0 
			? diagnostics.join(' | ')
			: `Unknown error: ${errorMsg}`;
	}

	/**
	 * Diagnose why template insertion method failed
	 * Returns detailed explanation of what happened and why
	 */
	private diagnoseTemplateInsertionFailure(error: unknown, templatesPlugin: any): string {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const diagnostics: string[] = [];
		diagnostics.push(`EVENT: Template insertion method failed with error: "${errorMsg}"`);
		
		if (!templatesPlugin.instance) {
			diagnostics.push('ROOT CAUSE: Templates plugin instance is null or undefined');
			diagnostics.push('WHY THIS FAILED: Cannot call methods on a null/undefined instance');
			diagnostics.push('SOLUTION: Plugin may not be fully initialized - try again or check plugin status');
		} else {
			const instanceMethods = Object.keys(templatesPlugin.instance).filter(k => 
				typeof templatesPlugin.instance[k] === 'function'
			);
			diagnostics.push(`✓ Available instance methods: ${instanceMethods.join(', ') || 'none'}`);
			
			if (!templatesPlugin.instance.insertTemplate) {
				diagnostics.push('ROOT CAUSE: insertTemplate method not found on instance');
				diagnostics.push('WHY THIS FAILED: The method we need does not exist on the plugin instance');
				diagnostics.push('SOLUTION: Obsidian version may be incompatible or plugin API changed');
			} else {
				diagnostics.push('✓ insertTemplate method exists but call failed');
				diagnostics.push('WHY THIS FAILED: Method exists but threw an error when called');
				diagnostics.push('POSSIBLE REASONS: Invalid parameters, file permissions, or internal plugin error');
			}
		}
		
		if (errorMsg.includes('user interaction')) {
			diagnostics.push('ROOT CAUSE: Command requires manual user selection of template');
			diagnostics.push('WHY THIS FAILED: Templates command opens a modal that requires user input');
			diagnostics.push('SOLUTION: This approach cannot be automated - use direct insertTemplate method instead');
		}
		
		return diagnostics.length > 0 
			? diagnostics.join(' | ')
			: `Error: ${errorMsg}`;
	}

	/**
	 * User-driven native template insertion: prompts user to run the Templates command,
	 * then reads the rendered file.
	 */
	private async executeNativeTemplateWithPrompt(templateFile: TFile): Promise<string> {
		// Create / reset the test file
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		const testFile = await this.app.vault.create(testPath, '');

		// Open file in a new leaf
		await this.app.workspace.openLinkText(testPath, '', true);
		await new Promise(resolve => setTimeout(resolve, 300));

		// Prompt user to run Templates: Insert Template
		const runTemplatesCommand = async () => {
			const appWithCommands = this.app as any;
			if (appWithCommands.commands?.executeCommandById) {
				await appWithCommands.commands.executeCommandById('templates:insert-template');
			} else {
				throw new Error('Commands API not available');
			}
		};

		await new Promise<void>((resolve, reject) => {
			const modal = new TemplateInsertPrompt(this.app, async () => {
				try {
					await runTemplatesCommand();
					resolve();
				} catch (e) {
					reject(e);
				}
			});
			modal.open();
		});

		// Wait for Smart Connections to process
		console.log('[TemplateExecutor] ⏳ Waiting 5 seconds for Smart Connections to process (user-driven)...');
		await new Promise(resolve => setTimeout(resolve, 5000));

		const rendered = await this.app.vault.read(testFile);
		console.log('[TemplateExecutor] 📄 User-driven native template rendered:', rendered.length, 'chars');
		if (rendered.length > 0) {
			console.log('[TemplateExecutor] 📄 Preview:', rendered.substring(0, 300));
		}

		return rendered;
	}

	/**
	 * Execute template using Obsidian's native template insertion command.
	 * This is how Text Generator likely does it, and Smart Connections hooks into this.
	 */
	private async executeNativeTemplate(templateFile: TFile, activeFile: TFile | null): Promise<string> {
		// Create a temporary file to insert template into
		const testPath = `Template-Render-Test.md`;
		const existingFile = this.app.vault.getAbstractFileByPath(testPath);
		if (existingFile instanceof TFile) {
			await this.app.vault.delete(existingFile);
		}
		
		// Create empty file
		const testFile = await this.app.vault.create(testPath, '');
		
		// Open file in a new leaf
		const leaf = await this.app.workspace.openLinkText(testPath, '', true);
		await new Promise(resolve => setTimeout(resolve, 500));
		
		// Get the Templates plugin
		const templatesPlugin = (this.app as any).internalPlugins?.plugins?.templates;
		if (!templatesPlugin) {
			throw new Error('Templates plugin not found in internalPlugins');
		}
		if (!templatesPlugin.enabled) {
			throw new Error('Templates plugin is not enabled (enable it in Settings > Core plugins)');
		}
		if (!templatesPlugin.instance) {
			throw new Error('Templates plugin instance not available');
		}
		
		console.log('[TemplateExecutor] 📝 Inserting template via Templates plugin...');
		console.log(`[TemplateExecutor] 🔍 Diagnostic: Template file: ${templateFile.path}`);
		console.log(`[TemplateExecutor] 🔍 Diagnostic: Target file: ${testFile.path}`);
		
		// Try to insert template - Smart Connections should hook into this
		try {
			// Method 1: Direct insertTemplate call (if available)
			if (templatesPlugin.instance.insertTemplate) {
				console.log('[TemplateExecutor] 🔧 Using insertTemplate method...');
				console.log(`[TemplateExecutor] 🔍 Diagnostic: insertTemplate method signature: ${typeof templatesPlugin.instance.insertTemplate}`);
				await templatesPlugin.instance.insertTemplate(testFile, templateFile.path);
				console.log('[TemplateExecutor] ✅ Template inserted via insertTemplate method');
			} 
			// Method 2: Try via command (but this requires user interaction, so may not work)
			else if ((this.app as any).commands?.executeCommandById) {
				console.log('[TemplateExecutor] 🔧 Attempting via command palette...');
				console.log('[TemplateExecutor] 🔍 Diagnostic: insertTemplate method not found, trying command approach');
				// This is tricky - the command expects user to select template
				// We'll try to programmatically trigger it
				await (this.app as any).commands.executeCommandById('templates:insert-template');
				// Wait a bit for the modal to appear and process
				await new Promise(resolve => setTimeout(resolve, 1000));
				console.log('[TemplateExecutor] ⚠️ Command executed (may require user interaction)');
				console.log('[TemplateExecutor] 🔍 Diagnostic: Command-based insertion requires user to select template manually');
			} else {
				const availableMethods = Object.keys(templatesPlugin.instance || {}).filter(k => 
					k.toLowerCase().includes('template') || k.toLowerCase().includes('insert')
				);
				throw new Error(`No template insertion method available. Available methods: ${availableMethods.join(', ') || 'none found'}`);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.warn(`[TemplateExecutor] ⚠️ Template insertion method failed: ${errorMsg}`);
			console.log(`[TemplateExecutor] 🔍 Diagnostic: ${this.diagnoseTemplateInsertionFailure(error, templatesPlugin)}`);
			throw error;
		}
		
		// Wait for Smart Connections to process (it hooks into template insertion)
		console.log('[TemplateExecutor] ⏳ Waiting 5 seconds for Smart Connections to process...');
		await new Promise(resolve => setTimeout(resolve, 5000));
		
		// Read the rendered content
		const rendered = await this.app.vault.read(testFile);
		
		// Keep file open for user inspection
		console.log('[TemplateExecutor] 📄 Native template rendered:', rendered.length, 'chars');
		if (rendered.length > 0) {
			console.log('[TemplateExecutor] 📄 Preview:', rendered.substring(0, 300));
		}
		
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

