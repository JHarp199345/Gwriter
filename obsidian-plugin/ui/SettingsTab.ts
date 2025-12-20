import { App, PluginSettingTab, Setting } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { SetupWizardModal } from './SetupWizard';

// Model lists for each provider
const OPENAI_MODELS = [
	{ value: 'gpt-5.2-pro', label: 'GPT-5.2 Pro' },
	{ value: 'gpt-5.2-thinking', label: 'GPT-5.2 Thinking' },
	{ value: 'gpt-5.2-instant', label: 'GPT-5.2 Instant' },
	{ value: 'gpt-4o', label: 'GPT-4o' },
	{ value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
	{ value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
	{ value: 'gpt-4', label: 'GPT-4' },
	{ value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' }
];

const ANTHROPIC_MODELS = [
	{ value: 'claude-4-5-opus', label: 'Claude 4.5 Opus' },
	{ value: 'claude-4-5-sonnet', label: 'Claude 4.5 Sonnet' },
	{ value: 'claude-4-5-haiku', label: 'Claude 4.5 Haiku' },
	{ value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
	{ value: 'claude-3-opus', label: 'Claude 3 Opus' },
	{ value: 'claude-3-sonnet', label: 'Claude 3 Sonnet' },
	{ value: 'claude-3-haiku', label: 'Claude 3 Haiku' }
];

const GEMINI_MODELS = [
	{ value: 'gemini-3-pro-preview', label: 'Gemini 3.0 Pro (Preview)' },
	{ value: 'gemini-3-flash-preview', label: 'Gemini 3.0 Flash (Preview)' },
	{ value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
	{ value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
	{ value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
	{ value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash Experimental' },
	{ value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
	{ value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
	{ value: 'gemini-pro', label: 'Gemini Pro' }
];

const OPENROUTER_MODELS = [
	{ value: 'openai/gpt-5.2-pro', label: 'OpenAI GPT-5.2 Pro' },
	{ value: 'openai/gpt-5.2-thinking', label: 'OpenAI GPT-5.2 Thinking' },
	{ value: 'openai/gpt-5.2-instant', label: 'OpenAI GPT-5.2 Instant' },
	{ value: 'openai/gpt-4o', label: 'OpenAI GPT-4o' },
	{ value: 'openai/gpt-4o-mini', label: 'OpenAI GPT-4o Mini' },
	{ value: 'openai/gpt-4-turbo', label: 'OpenAI GPT-4 Turbo' },
	{ value: 'openai/gpt-4', label: 'OpenAI GPT-4' },
	{ value: 'openai/gpt-3.5-turbo', label: 'OpenAI GPT-3.5 Turbo' },
	{ value: 'anthropic/claude-4-5-opus', label: 'Anthropic Claude 4.5 Opus' },
	{ value: 'anthropic/claude-4-5-sonnet', label: 'Anthropic Claude 4.5 Sonnet' },
	{ value: 'anthropic/claude-4-5-haiku', label: 'Anthropic Claude 4.5 Haiku' },
	{ value: 'anthropic/claude-3-5-sonnet', label: 'Anthropic Claude 3.5 Sonnet' },
	{ value: 'anthropic/claude-3-opus', label: 'Anthropic Claude 3 Opus' },
	{ value: 'anthropic/claude-3-sonnet', label: 'Anthropic Claude 3 Sonnet' },
	{ value: 'anthropic/claude-3-haiku', label: 'Anthropic Claude 3 Haiku' },
	{ value: 'google/gemini-3-pro-preview', label: 'Google Gemini 3.0 Pro (Preview)' },
	{ value: 'google/gemini-3-flash-preview', label: 'Google Gemini 3.0 Flash (Preview)' },
	{ value: 'google/gemini-2.5-pro', label: 'Google Gemini 2.5 Pro' },
	{ value: 'google/gemini-2.5-flash', label: 'Google Gemini 2.5 Flash' },
	{ value: 'google/gemini-2.5-flash-lite', label: 'Google Gemini 2.5 Flash Lite' },
	{ value: 'google/gemini-2.0-flash-exp', label: 'Google Gemini 2.0 Flash Experimental' },
	{ value: 'google/gemini-1.5-pro', label: 'Google Gemini 1.5 Pro' },
	{ value: 'google/gemini-1.5-flash', label: 'Google Gemini 1.5 Flash' },
	{ value: 'google/gemini-pro', label: 'Google Gemini Pro' }
];

function getModelsForProvider(provider: string): Array<{ value: string; label: string }> {
	switch (provider) {
		case 'openai':
			return OPENAI_MODELS;
		case 'anthropic':
			return ANTHROPIC_MODELS;
		case 'gemini':
			return GEMINI_MODELS;
		case 'openrouter':
			return OPENROUTER_MODELS;
		default:
			return [];
	}
}

export class SettingsTab extends PluginSettingTab {
	plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Keep heading generic per Obsidian review-bot rules (avoid plugin name and "settings")
		new Setting(containerEl).setName('Configuration').setHeading();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Your AI API key (stored securely)')
			.addText(text => text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Generation mode')
			.setDesc('Single mode: fast, single model. Multi mode: higher quality with multiple models.')
			.addDropdown(dropdown => dropdown
				.addOption('single', 'Single mode')
				.addOption('multi', 'Multi mode')
				.setValue(this.plugin.settings.generationMode)
				.onChange(async (value: 'single' | 'multi') => {
					this.plugin.settings.generationMode = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide multi-mode settings
				}));

		new Setting(containerEl)
			.setName('API provider')
			.setDesc('Choose your AI provider. Openrouter is recommended for multi mode.')
			.addDropdown(dropdown => dropdown
				.addOption('openrouter', 'Openrouter (recommended)')
				.addOption('openai', 'Openai')
				.addOption('anthropic', 'Anthropic')
				.addOption('gemini', 'Gemini')
				.setValue(this.plugin.settings.apiProvider)
				.onChange(async (value: 'openai' | 'anthropic' | 'gemini' | 'openrouter') => {
					this.plugin.settings.apiProvider = value;
					// Reset model to first available model for new provider if current model doesn't exist
					const models = getModelsForProvider(value);
					const currentModel = this.plugin.settings.model;
					if (!models.some(m => m.value === currentModel)) {
						this.plugin.settings.model = models[0].value;
					}
					await this.plugin.saveSettings();
					this.display(); // Refresh to update model dropdown
				}));

		new Setting(containerEl)
			.setName('Model')
			.setDesc('AI model to use')
			.addDropdown(dropdown => {
				const models = getModelsForProvider(this.plugin.settings.apiProvider);
				models.forEach(model => {
					dropdown.addOption(model.value, model.label);
				});
				dropdown.setValue(this.plugin.settings.model || models[0].value);
				dropdown.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				});
			});

		// Multi-mode settings (only shown when MultiMode is selected)
		if (this.plugin.settings.generationMode === 'multi') {
			new Setting(containerEl)
				.setName('Multi-mode strategy')
				.setDesc('Draft + revision: fast draft + quality revision. Consensus + multi-stage: maximum quality (slower, more expensive).')
				.addDropdown(dropdown => dropdown
					.addOption('draft-revision', 'Draft + revision')
					.addOption('consensus-multistage', 'Consensus + multi-stage (maximum quality)')
					.setValue(this.plugin.settings.multiStrategy)
					.onChange(async (value: 'draft-revision' | 'consensus-multistage') => {
						this.plugin.settings.multiStrategy = value;
						await this.plugin.saveSettings();
						this.display(); // Refresh to show relevant settings
					}));

			if (this.plugin.settings.multiStrategy === 'draft-revision') {
				// Draft Model dropdown
				new Setting(containerEl)
					.setName('Draft model')
					.setDesc('Fast model for initial draft')
					.addDropdown(dropdown => {
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.draftModel || models[0].value);
						dropdown.onChange(async (value) => {
							this.plugin.settings.draftModel = value;
							await this.plugin.saveSettings();
						});
					});

				// Revision Model dropdown
				new Setting(containerEl)
					.setName('Revision model')
					.setDesc('Quality model for refinement')
					.addDropdown(dropdown => {
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.revisionModel || models[0].value);
						dropdown.onChange(async (value) => {
							this.plugin.settings.revisionModel = value;
							await this.plugin.saveSettings();
						});
					});
			} else {
				// Consensus + Multi-Stage settings
				new Setting(containerEl)
					.setName('Consensus model 1')
					.setDesc('Primary model for consensus generation')
					.addDropdown(dropdown => {
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.consensusModel1 || models[0].value);
						dropdown.onChange(async (value) => {
							this.plugin.settings.consensusModel1 = value;
							await this.plugin.saveSettings();
						});
					});

				new Setting(containerEl)
					.setName('Consensus model 2')
					.setDesc('Second model for consensus generation')
					.addDropdown(dropdown => {
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.consensusModel2 || (models.length > 1 ? models[1].value : models[0].value));
						dropdown.onChange(async (value) => {
							this.plugin.settings.consensusModel2 = value;
							await this.plugin.saveSettings();
						});
					});

				new Setting(containerEl)
					.setName('Consensus model 3 (optional)')
					.setDesc('Third model for stronger consensus (optional)')
					.addDropdown(dropdown => {
						dropdown.addOption('', 'None');
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.consensusModel3 || '');
						dropdown.onChange(async (value) => {
							this.plugin.settings.consensusModel3 = value || undefined;
							await this.plugin.saveSettings();
						});
					});

				new Setting(containerEl)
					.setName('Synthesis model')
					.setDesc('Model to synthesize final output from consensus')
					.addDropdown(dropdown => {
						const models = getModelsForProvider(this.plugin.settings.apiProvider);
						models.forEach(model => {
							dropdown.addOption(model.value, model.label);
						});
						dropdown.setValue(this.plugin.settings.synthesisModel || models[0].value);
						dropdown.onChange(async (value) => {
							this.plugin.settings.synthesisModel = value;
							await this.plugin.saveSettings();
						});
					});
			}
		}


		new Setting(containerEl)
			.setName('Vault path')
			.setDesc('Path to your Obsidian vault (auto-detected)')
			.addText(text => text
				.setPlaceholder('Vault path')
				.setValue(this.plugin.settings.vaultPath)
				.onChange(async (value) => {
					this.plugin.settings.vaultPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Setup wizard')
			.setDesc('Create default files and folders for your writing workspace')
			.addButton(button => button
				.setButtonText('Run setup wizard')
				.onClick(() => {
					const modal = new SetupWizardModal(this.plugin);
					modal.open();
				}));

		new Setting(containerEl)
			.setName('Character folder')
			.setDesc('Folder name for character notes (default: characters)')
			.addText(text => text
				.setPlaceholder('Characters')
				.setValue(this.plugin.settings.characterFolder)
				.onChange(async (value) => {
					this.plugin.settings.characterFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Book main path')
			.setDesc('Path to your active manuscript')
			.addText(text => text
				.setPlaceholder('book-main.md')
				.setValue(this.plugin.settings.book2Path)
				.onChange(async (value) => {
					this.plugin.settings.book2Path = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Story bible path')
			.setDesc('Path to your story bible')
			.addText(text => text
				.setPlaceholder('book - story bible.md')
				.setValue(this.plugin.settings.storyBiblePath)
				.onChange(async (value) => {
					this.plugin.settings.storyBiblePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Extractions path (optional)')
			.setDesc('Path to your extractions file. Optional - only needed if you use extractions instead of chunked folders.')
			.addText(text => text
				.setPlaceholder('Extractions.md')
				.setValue(this.plugin.settings.extractionsPath)
				.onChange(async (value) => {
					this.plugin.settings.extractionsPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sliding window path')
			.setDesc('Path to your sliding window memory file')
			.addText(text => text
				.setPlaceholder('memory - sliding window.md')
				.setValue(this.plugin.settings.slidingWindowPath)
				.onChange(async (value) => {
					this.plugin.settings.slidingWindowPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Character extraction chunk size (words)')
			.setDesc('Used by "Process entire book" to batch character extraction. Larger chunks (e.g., 2000–3000) tend to improve character context.')
			.addText(text => text
				.setPlaceholder('2500')
				.setValue(String(this.plugin.settings.characterExtractionChunkSize ?? 2500))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					// Clamp to a sane range to prevent accidental extreme values
					const clamped = Number.isFinite(parsed) ? Math.min(10000, Math.max(250, parsed)) : 2500;
					this.plugin.settings.characterExtractionChunkSize = clamped;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default character extraction instructions')
			.setDesc('Used by character update (selected text). If the extraction instructions box is empty/invalid, this default is used instead.')
			.addTextArea(text => text
				.setPlaceholder('[Character update instructions] ...')
				.setValue(this.plugin.settings.defaultCharacterExtractionInstructions || '')
				.onChange(async (value) => {
					this.plugin.settings.defaultCharacterExtractionInstructions = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Context token limit (warning)')
			.setDesc('Shows a warning before generating if the estimated prompt tokens exceed this limit. Default: 128000.')
			.addText(text => text
				.setPlaceholder('128000')
				.setValue(String(this.plugin.settings.contextTokenLimit ?? 128000))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					const clamped = Number.isFinite(parsed) ? Math.min(2000000, Math.max(1000, parsed)) : 128000;
					this.plugin.settings.contextTokenLimit = clamped;
					await this.plugin.saveSettings();
				}));
	}
}

