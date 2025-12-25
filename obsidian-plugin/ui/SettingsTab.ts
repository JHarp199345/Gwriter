import { App, PluginSettingTab, Setting, TFolder, Notice, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { SetupWizardModal } from './SetupWizard';
import { FileTreePickerModal } from './FileTreePickerModal';
import { FolderTreePickerModal } from './FolderTreePickerModal';
import { StressTestService } from '../services/StressTestService';

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

		// Keep folder exclusion list "live" while this tab is open.
		const refreshIfVisible = () => {
			try {
				if (this.containerEl?.isConnected) this.display();
			} catch {
				// ignore
			}
		};
		this.plugin.registerEvent(this.app.vault.on('create', refreshIfVisible));
		this.plugin.registerEvent(this.app.vault.on('delete', refreshIfVisible));
		this.plugin.registerEvent(
			this.app.vault.on('rename', () => {
				refreshIfVisible();
			})
		);
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

		// Retrieval / indexing settings
		new Setting(containerEl).setName('Retrieval').setHeading();

		// Retrieval profile (folder include-set)
		const profiles = Array.isArray(this.plugin.settings.retrievalProfiles) ? this.plugin.settings.retrievalProfiles : [];
		const activeProfileId = this.plugin.settings.retrievalActiveProfileId;

		new Setting(containerEl)
			.setName('Retrieval profile')
			.setDesc('Controls which folders are included for retrieval and indexing. Use this to avoid pulling irrelevant vault content.')
			.addDropdown((dropdown) => {
				for (const p of profiles) dropdown.addOption(p.id, p.name);
				dropdown.setValue(activeProfileId || (profiles[0]?.id ?? 'story'));
				dropdown.onChange(async (value) => {
					this.plugin.settings.retrievalActiveProfileId = value;
					await this.plugin.saveSettings();
					this.plugin.embeddingsIndex.queueRecheckAllIndexed();
					this.plugin.bm25Index.queueRecheckAllIndexed();
					this.plugin.embeddingsIndex.enqueueFullRescan();
					this.plugin.bm25Index.enqueueFullRescan();
					this.display();
				});
			});

		const activeProfile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0];
		if (activeProfile) {
			new Setting(containerEl)
				.setName('Profile name')
				.setDesc('Rename the active profile.')
				.addText((text) =>
					text.setValue(activeProfile.name).onChange(async (value) => {
						const nextName = value.trim() || activeProfile.name;
						activeProfile.name = nextName;
						this.plugin.settings.retrievalProfiles = profiles;
						await this.plugin.saveSettings();
					})
				);

			// Create/delete profiles
			let newProfileName = '';
			new Setting(containerEl)
				.setName('Create profile')
				.setDesc('Create a new retrieval profile.')
				.addText((text) =>
					text.setPlaceholder('New profile name').onChange((value) => {
						newProfileName = value;
					})
				)
				.addButton((btn) =>
					btn.setButtonText('Create').setCta().onClick(async () => {
						const name = (newProfileName || '').trim();
						if (!name) return;
						const id = `custom-${Date.now()}`;
						this.plugin.settings.retrievalProfiles = [...profiles, { id, name, includedFolders: [] }];
						this.plugin.settings.retrievalActiveProfileId = id;
						await this.plugin.saveSettings();
						this.display();
					})
				);

			if (!['story', 'research', 'manuscript'].includes(activeProfile.id)) {
				new Setting(containerEl)
					.setName('Delete profile')
					.setDesc('Deletes the active profile.')
					.addButton((btn) =>
						btn.setButtonText('Delete').onClick(async () => {
							this.plugin.settings.retrievalProfiles = profiles.filter((p) => p.id !== activeProfile.id);
							this.plugin.settings.retrievalActiveProfileId = this.plugin.settings.retrievalProfiles[0]?.id || 'story';
							await this.plugin.saveSettings();
							this.plugin.embeddingsIndex.enqueueFullRescan();
							this.plugin.bm25Index.enqueueFullRescan();
							this.display();
						})
					);
			}

			// Live folder roster for includes
			const folderRoster = this.plugin.vaultService.getAllFolderPaths();
			const configDir = this.plugin.app.vault.configDir.replace(/\\/g, '/').replace(/\/+$/, '');
			const logsFolder = (this.plugin.settings.generationLogsFolder || '').replace(/\\/g, '/').replace(/\/+$/, '');
			const includes = new Set<string>((activeProfile.includedFolders || []).map((p) => p.replace(/\\/g, '/')));
			const profileContainer = containerEl.createDiv({ cls: 'writing-dashboard-exclusions' });
			new Setting(profileContainer)
				.setName('Included folders')
				.setDesc('Only these folders are searched and indexed. Leave empty to include the whole vault (minus exclusions).');

			for (const folder of folderRoster) {
				const normalized = folder.replace(/\\/g, '/');
				const isProtected =
					(normalized === configDir || normalized.startsWith(`${configDir}/`)) ||
					(logsFolder && (normalized === logsFolder || normalized.startsWith(`${logsFolder}/`)));
				const isChecked = includes.has(normalized);
				new Setting(profileContainer)
					.setName(normalized)
					.addToggle((toggle) =>
						toggle.setValue(isChecked).setDisabled(isProtected).onChange(async (value) => {
							const next = new Set<string>((activeProfile.includedFolders || []).map((p) => p.replace(/\\/g, '/')));
							if (value) next.add(normalized);
							else next.delete(normalized);
							activeProfile.includedFolders = Array.from(next).sort((a, b) => a.localeCompare(b));
							this.plugin.settings.retrievalProfiles = profiles;
							await this.plugin.saveSettings();
							this.plugin.embeddingsIndex.queueRecheckAllIndexed();
							this.plugin.bm25Index.queueRecheckAllIndexed();
							this.plugin.embeddingsIndex.enqueueFullRescan();
							this.plugin.bm25Index.enqueueFullRescan();
						})
					);
			}
		}

		new Setting(containerEl)
			.setName('Enable bm25 retrieval')
			.setDesc('Use a search-engine style relevance ranking (BM25). Recommended for names, places, and exact terms.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.retrievalEnableBm25)).onChange(async (value) => {
					this.plugin.settings.retrievalEnableBm25 = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Enable semantic retrieval')
			.setDesc('Build a local index to retrieve relevant notes from the vault. If disabled, retrieval uses heuristic matching only.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.retrievalEnableSemanticIndex)).onChange(async (value) => {
					this.plugin.settings.retrievalEnableSemanticIndex = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Semantic backend')
			.setDesc('Choose which local semantic retrieval method to use. Hash is fast and reliable.')
			.addDropdown((dropdown) => {
				dropdown.addOption('hash', 'Hash (fast, reliable - recommended)');
				dropdown.setValue(this.plugin.settings.retrievalEmbeddingBackend ?? 'hash');
				dropdown.onChange(async (value) => {
					this.plugin.settings.retrievalEmbeddingBackend = value as 'hash';
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Enable reranking (experimental)')
			.setDesc('Use a local CPU reranker to improve the ordering of retrieved snippets. Experimental feature - may fail if model files cannot be downloaded. If disabled, retrieval will work without reranking.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.retrievalEnableReranker)).onChange(async (value) => {
					this.plugin.settings.retrievalEnableReranker = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Retrieved items (limit)')
			.setDesc('Maximum number of retrieved snippets to include in prompts.')
			.addText((text) =>
				text
					.setPlaceholder('24')
					.setValue(String(this.plugin.settings.retrievalTopK ?? 24))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.retrievalTopK = Math.max(1, Math.min(100, parsed));
							await this.plugin.saveSettings();
						}
					})
			);

		// External embedding API settings (always shown - automatically used if configured)
		new Setting(containerEl)
			.setName('External embedding provider')
			.setDesc('Choose which external embedding API to use. If configured, external embeddings will be used automatically instead of local hash embeddings.')
				.addDropdown((dropdown) => {
					dropdown.addOption('openai', 'OpenAI');
					dropdown.addOption('cohere', 'Cohere');
					dropdown.addOption('google', 'Google (Gemini)');
					dropdown.addOption('custom', 'Custom');
					dropdown.setValue(this.plugin.settings.externalEmbeddingProvider ?? 'openai');
					dropdown.onChange(async (value) => {
						this.plugin.settings.externalEmbeddingProvider = value as 'openai' | 'cohere' | 'google' | 'custom';
						// Set default model for provider
						if (value === 'openai') {
							this.plugin.settings.externalEmbeddingModel = 'text-embedding-3-small';
						} else if (value === 'cohere') {
							this.plugin.settings.externalEmbeddingModel = 'embed-english-v3.0';
						} else if (value === 'google') {
							this.plugin.settings.externalEmbeddingModel = 'gemini-embedding-001';
						} else {
							this.plugin.settings.externalEmbeddingModel = '';
						}
						await this.plugin.saveSettings();
						await this.plugin.recreateRetrievalService(); // Recreate to use new provider
						this.display(); // Refresh to show provider-specific settings
					});
				});

			new Setting(containerEl)
				.setName('External embedding API key')
				.setDesc('Your API key for the external embedding provider.')
				.addText((text) => {
					text.setPlaceholder('Enter API key')
						.setValue(this.plugin.settings.externalEmbeddingApiKey ?? '');
					text.inputEl.type = 'password';
					text.onChange(async (value) => {
						this.plugin.settings.externalEmbeddingApiKey = value;
						await this.plugin.saveSettings();
						await this.plugin.recreateRetrievalService(); // Recreate to use new API key
					});
				});

			const provider = this.plugin.settings.externalEmbeddingProvider ?? 'openai';
			const defaultModel = provider === 'openai' ? 'text-embedding-3-small' : provider === 'cohere' ? 'embed-english-v3.0' : provider === 'google' ? 'gemini-embedding-001' : '';

			new Setting(containerEl)
				.setName('External embedding model')
				.setDesc(`Model name for ${provider} (e.g., ${defaultModel}).`)
				.addText((text) =>
					text
						.setPlaceholder(defaultModel)
						.setValue(this.plugin.settings.externalEmbeddingModel ?? defaultModel)
						.onChange(async (value) => {
							this.plugin.settings.externalEmbeddingModel = value;
							await this.plugin.saveSettings();
						})
				);

			if (provider === 'google') {
				new Setting(containerEl)
					.setName('Use batch embeddings (Google Gemini)')
					.setDesc('Use batch endpoint for more efficient embedding of multiple queries.')
					.addToggle((toggle) =>
						toggle.setValue(Boolean(this.plugin.settings.externalEmbeddingUseBatch)).onChange(async (value) => {
							this.plugin.settings.externalEmbeddingUseBatch = value;
							await this.plugin.saveSettings();
						})
					);
			}

			if (provider === 'custom') {
				new Setting(containerEl)
					.setName('Custom API URL')
					.setDesc('Endpoint URL for your custom embedding API.')
					.addText((text) =>
						text
							.setPlaceholder('https://api.example.com/embeddings')
							.setValue(this.plugin.settings.externalEmbeddingApiUrl ?? '')
							.onChange(async (value) => {
								this.plugin.settings.externalEmbeddingApiUrl = value;
								await this.plugin.saveSettings();
							})
					);
			}

			new Setting(containerEl)
				.setName('Test connection')
				.setDesc('Test the external embedding API connection.')
				.addButton((btn) =>
					btn.setButtonText('Test').onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');
						try {
							// Simple test: try to get an embedding for a test query
							const testQuery = 'test';
							const response = await fetch(
								provider === 'openai'
									? 'https://api.openai.com/v1/embeddings'
									: provider === 'cohere'
									? 'https://api.cohere.ai/v1/embed'
									: provider === 'google'
									? `https://generativelanguage.googleapis.com/v1beta/models/${this.plugin.settings.externalEmbeddingModel || 'gemini-embedding-001'}:embedContent?key=${this.plugin.settings.externalEmbeddingApiKey}`
									: this.plugin.settings.externalEmbeddingApiUrl || '',
								{
									method: 'POST',
									headers: {
										'Content-Type': 'application/json',
										...(provider !== 'google' && provider !== 'custom' ? { Authorization: `Bearer ${this.plugin.settings.externalEmbeddingApiKey}` } : {})
									},
									body: JSON.stringify(
										provider === 'openai'
											? { model: this.plugin.settings.externalEmbeddingModel || 'text-embedding-3-small', input: testQuery }
											: provider === 'cohere'
											? { model: this.plugin.settings.externalEmbeddingModel || 'embed-english-v3.0', texts: [testQuery] }
											: provider === 'google'
											? { content: { parts: [{ text: testQuery }] } }
											: { text: testQuery }
									)
								}
							);
							if (response.ok) {
								new Notice('External embedding API connection successful!', 3000);
							} else {
								const error = await response.text();
								new Notice(`External embedding API test failed: ${response.status} ${error}`, 5000);
							}
						} catch (error) {
							new Notice(`External embedding API test failed: ${error instanceof Error ? error.message : String(error)}`, 5000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('Test');
						}
					})
				);

		new Setting(containerEl)
			.setName('Index chunk size (words)')
			.setDesc('Controls how your notes are chunked for semantic retrieval. Larger chunks add more context but may reduce precision.')
			.addText((text) =>
				text
					.setPlaceholder('500')
					.setValue(String(this.plugin.settings.retrievalChunkWords ?? 500))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.retrievalChunkWords = Math.max(200, Math.min(2000, parsed));
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Index chunk overlap (words)')
			.setDesc('Overlap helps preserve continuity between chunks.')
			.addText((text) =>
				text
					.setPlaceholder('100')
					.setValue(String(this.plugin.settings.retrievalChunkOverlapWords ?? 100))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.retrievalChunkOverlapWords = Math.max(0, Math.min(500, parsed));
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Indexing heading level')
			.setDesc('Preferred heading level used to split notes into coherent chunks for retrieval indexing. Falls back to word-window chunking if headings are missing.')
			.addDropdown((dropdown) => {
				dropdown.addOption('h1', 'H1 (#)');
				dropdown.addOption('h2', 'H2 (##)');
				dropdown.addOption('h3', 'H3 (###)');
				dropdown.addOption('none', 'None (word chunks only)');
				dropdown.setValue(this.plugin.settings.retrievalChunkHeadingLevel ?? 'h1');
				dropdown.onChange(async (value) => {
					this.plugin.settings.retrievalChunkHeadingLevel = value as 'h1' | 'h2' | 'h3' | 'none';
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Pause indexing')
			.setDesc('Pauses background indexing for semantic retrieval.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.retrievalIndexPaused)).onChange(async (value) => {
					this.plugin.settings.retrievalIndexPaused = value;
					await this.plugin.saveSettings();
				})
			);

		// Folder exclusions (dynamic checkbox list)
		const excluded = new Set<string>((this.plugin.settings.retrievalExcludedFolders || []).map((p) => p.replace(/\\/g, '/')));
		const folders = this.plugin.vaultService.getAllFolderPaths();

		const exclusionsContainer = containerEl.createDiv({ cls: 'writing-dashboard-exclusions' });
		new Setting(exclusionsContainer)
			.setName('Exclude from retrieval')
			.setDesc('Choose folders to exclude from retrieval and indexing. Obsidian configuration is always excluded.');

		// Always-excluded config folder row (locked)
		const configDir = this.app.vault.configDir.replace(/\\/g, '/');
		new Setting(exclusionsContainer)
			.setName(configDir)
			.setDesc('Always excluded.')
			.addToggle((toggle) => toggle.setValue(true).setDisabled(true));

		for (const folder of folders) {
			const normalized = folder.replace(/\\/g, '/');
			const isChecked = excluded.has(normalized);
			new Setting(exclusionsContainer)
				.setName(normalized)
				.addToggle((toggle) =>
					toggle.setValue(isChecked).onChange(async (value) => {
						const next = new Set<string>(
							(this.plugin.settings.retrievalExcludedFolders || []).map((p) => p.replace(/\\/g, '/'))
						);
						if (value) next.add(normalized);
						else next.delete(normalized);
						this.plugin.settings.retrievalExcludedFolders = Array.from(next).sort((a, b) => a.localeCompare(b));
						await this.plugin.saveSettings();
					})
				);
		}

		// Show excluded folders that no longer exist (e.g., renamed/deleted) so users can clean them up.
		const existingSet = new Set<string>(folders.map((f) => f.replace(/\\/g, '/')));
		const missing = Array.from(excluded).filter((p) => p && !existingSet.has(p));
		if (missing.length > 0) {
			new Setting(exclusionsContainer).setName('Missing excluded folders').setHeading();
			for (const missingPath of missing.sort((a, b) => a.localeCompare(b))) {
				new Setting(exclusionsContainer)
					.setName(missingPath)
					.setDesc('This folder does not exist in the vault.')
					.addButton((btn) =>
						btn.setButtonText('Remove').onClick(async () => {
							const next = new Set<string>(
								(this.plugin.settings.retrievalExcludedFolders || []).map((p) => p.replace(/\\/g, '/'))
							);
							next.delete(missingPath);
							this.plugin.settings.retrievalExcludedFolders = Array.from(next).sort((a, b) => a.localeCompare(b));
							await this.plugin.saveSettings();
							this.display();
						})
					);
			}
		}

		// Smart Connections cache settings
		new Setting(containerEl).setName('Smart Connections cache').setHeading();

		new Setting(containerEl)
			.setName('Use Smart Connections cache')
			.setDesc('Enable retrieval from cached Smart Connections results. Cache captures Smart Connections results **at the time you capture**.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.smartConnectionsCacheEnabled)).onChange(async (value) => {
					this.plugin.settings.smartConnectionsCacheEnabled = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide Smart Connections options
				})
			);

		if (this.plugin.settings.smartConnectionsCacheEnabled) {
			// Cache status display
			const scProvider = this.plugin.smartConnectionsProvider;
			const cacheStatus = scProvider?.getCacheStatus() || { exists: false, enabled: false, count: 0, fresh: false };
			
			const statusDesc = cacheStatus.exists
				? `Cached: ${cacheStatus.count} notes • ${cacheStatus.age || 'unknown'} ago • method: ${cacheStatus.method || 'unknown'}${cacheStatus.sourceNote ? ` • from: ${cacheStatus.sourceNote}` : ''}`
				: 'No cache available. Capture results to enable Smart Connections retrieval.';

			new Setting(containerEl)
				.setName('Cache status')
				.setDesc(statusDesc)
				.setDisabled(true);

			// Capture buttons
			const captureContainer = containerEl.createDiv();
			new Setting(captureContainer)
				.setName('Capture from Smart Connections (DOM)')
				.setDesc('Capture results from Smart Connections view if open. Only enabled if SC view is detected with results.')
				.addButton((btn) => {
					if (scProvider) {
						const viewCheck = scProvider.checkViewAvailable();
						btn.setButtonText('Capture')
							.setDisabled(!viewCheck.available)
							.setTooltip(viewCheck.available ? 'Click to capture Smart Connections results' : viewCheck.message || 'Smart Connections view not available')
							.onClick(async () => {
								btn.setButtonText('Capturing...').setDisabled(true);
								try {
									const activeFile = this.app.workspace.getActiveFile();
									const sourceNotePath = activeFile?.path;
									const result = await scProvider.captureAndSaveFromDom(sourceNotePath);
									
									if (result.success) {
										new Notice(`Captured ${result.count} notes from Smart Connections`, 3000);
										this.display(); // Refresh to show updated status
									} else {
										new Notice(result.message || 'Capture failed', 5000);
									}
								} catch (error) {
									new Notice(`Capture failed: ${error instanceof Error ? error.message : String(error)}`, 5000);
								} finally {
									btn.setButtonText('Capture').setDisabled(false);
								}
							});
					} else {
						btn.setButtonText('Capture').setDisabled(true);
					}
				});

			new Setting(captureContainer)
				.setName('Capture from Clipboard')
				.setDesc('Capture results from clipboard. Ensure clipboard contains Smart Connections results with markdown links.')
				.addButton((btn) => {
					if (scProvider) {
						btn.setButtonText('Capture')
							.onClick(async () => {
								btn.setButtonText('Capturing...').setDisabled(true);
								try {
									const activeFile = this.app.workspace.getActiveFile();
									const sourceNotePath = activeFile?.path;
									const result = await scProvider.captureAndSaveFromClipboard(sourceNotePath);
									
									if (result.success) {
										new Notice(`Captured ${result.count} notes from clipboard`, 3000);
										this.display(); // Refresh to show updated status
									} else {
										new Notice(result.message || 'Capture failed', 5000);
									}
								} catch (error) {
									new Notice(`Capture failed: ${error instanceof Error ? error.message : String(error)}`, 5000);
								} finally {
									btn.setButtonText('Capture').setDisabled(false);
								}
							});
					} else {
						btn.setButtonText('Capture').setDisabled(true);
					}
				});

			// Clear cache button
			new Setting(containerEl)
				.setName('Clear cache')
				.setDesc('Remove all cached Smart Connections results.')
				.addButton((btn) => {
					if (scProvider) {
						btn.setButtonText('Clear')
							.setWarning()
							.onClick(async () => {
								await scProvider.clearCache();
								new Notice('Smart Connections cache cleared', 3000);
								this.display(); // Refresh to show updated status
							});
					} else {
						btn.setButtonText('Clear').setDisabled(true);
					}
				});

			// View cached items expander
			if (cacheStatus.exists && cacheStatus.count > 0) {
				const cache = this.plugin.settings.smartConnectionsCache;
				if (cache) {
					const expanderContainer = containerEl.createDiv();
					new Setting(expanderContainer)
						.setName('View cached items')
						.setDesc(`Showing ${cache.results.length} cached items.`)
						.addToggle((toggle) => {
							toggle.setValue(false);
							const itemsContainer = expanderContainer.createDiv({ cls: 'writing-dashboard-cached-items' });
							itemsContainer.style.display = 'none';
							
							toggle.onChange((value) => {
								itemsContainer.style.display = value ? 'block' : 'none';
								
								if (value && itemsContainer.children.length === 0) {
									// Populate items list
									for (const item of cache.results) {
										const itemSetting = new Setting(itemsContainer)
											.setName(item.path)
											.setDesc(`Score: ${(item.score || 0.5).toFixed(2)} • Captured: ${item.capturedAt ? new Date(item.capturedAt).toLocaleString() : 'unknown'}`)
											.addButton((btn) => {
												btn.setButtonText('Remove')
													.setWarning()
													.onClick(async () => {
														cache.results = cache.results.filter(r => r.path !== item.path);
														this.plugin.settings.smartConnectionsCache = cache;
														await this.plugin.saveSettings();
														this.display(); // Refresh to update list
													});
											});
									}
								}
							});
						});
				}
			}

			// Settings for filters and limits
			new Setting(containerEl)
				.setName('Max capture files')
				.setDesc('Maximum number of files to capture (default: 200).')
				.addText((text) => {
					text.setPlaceholder('200')
						.setValue(String(this.plugin.settings.smartConnectionsMaxCaptureFiles ?? 200))
						.inputEl.type = 'number';
					text.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.smartConnectionsMaxCaptureFiles = num;
							await this.plugin.saveSettings();
						}
					});
				});

			new Setting(containerEl)
				.setName('Max score files')
				.setDesc('Maximum number of files to score per query (default: 50).')
				.addText((text) => {
					text.setPlaceholder('50')
						.setValue(String(this.plugin.settings.smartConnectionsMaxScoreFiles ?? 50))
						.inputEl.type = 'number';
					text.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.smartConnectionsMaxScoreFiles = num;
							await this.plugin.saveSettings();
						}
					});
				});

			new Setting(containerEl)
				.setName('Max context chars')
				.setDesc('Maximum total context characters for excerpts (default: 30000).')
				.addText((text) => {
					text.setPlaceholder('30000')
						.setValue(String(this.plugin.settings.smartConnectionsMaxContextChars ?? 30000))
						.inputEl.type = 'number';
					text.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num > 0) {
							this.plugin.settings.smartConnectionsMaxContextChars = num;
							await this.plugin.saveSettings();
						}
					});
				});

			new Setting(containerEl)
				.setName('Keying mode')
				.setDesc('Strict: only use cache if source note matches. Soft: prefer match, allow manual override (default).')
				.addDropdown((dropdown) => {
					dropdown.addOption('soft', 'Soft (prefer match, allow override)');
					dropdown.addOption('strict', 'Strict (only use if source matches)');
					dropdown.setValue(this.plugin.settings.smartConnectionsKeyingMode ?? 'soft');
					dropdown.onChange(async (value) => {
						this.plugin.settings.smartConnectionsKeyingMode = value as 'strict' | 'soft';
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.setName('Cache TTL (hours)')
				.setDesc('Cache expiration time in hours. Leave empty for no expiration.')
				.addText((text) => {
					text.setPlaceholder('24 (or empty for no expiration)')
						.setValue(this.plugin.settings.smartConnectionsCacheTTL ? String(this.plugin.settings.smartConnectionsCacheTTL) : '');
					text.inputEl.type = 'number';
					text.onChange(async (value) => {
						if (value.trim() === '') {
							this.plugin.settings.smartConnectionsCacheTTL = undefined;
						} else {
							const num = parseFloat(value);
							if (!isNaN(num) && num > 0) {
								this.plugin.settings.smartConnectionsCacheTTL = num;
							}
						}
						await this.plugin.saveSettings();
					});
				});

			// Folder filters (simplified - could be enhanced with multi-select)
			new Setting(containerEl)
				.setName('Allowed folders (comma-separated)')
				.setDesc('Folders to include. Leave empty to allow all folders (except blocked).')
				.addText((text) => {
					text.setPlaceholder('Characters, Notes')
						.setValue((this.plugin.settings.smartConnectionsAllowedFolders || []).join(', '))
						.onChange(async (value) => {
							const folders = value.split(',').map(f => f.trim()).filter(f => f.length > 0);
							this.plugin.settings.smartConnectionsAllowedFolders = folders;
							await this.plugin.saveSettings();
						});
				});

			new Setting(containerEl)
				.setName('Blocked folders (comma-separated)')
				.setDesc('Folders to exclude from Smart Connections cache.')
				.addText((text) => {
					text.setPlaceholder('Private, Journal')
						.setValue((this.plugin.settings.smartConnectionsBlockedFolders || []).join(', '))
						.onChange(async (value) => {
							const folders = value.split(',').map(f => f.trim()).filter(f => f.length > 0);
							this.plugin.settings.smartConnectionsBlockedFolders = folders;
							await this.plugin.saveSettings();
						});
				});

			// UX wording
			containerEl.createDiv({ cls: 'writing-dashboard-info-box' })
				.createEl('p', { text: 'Review/remove cached notes before generation.' });
		}

		// Generation logs
		new Setting(containerEl).setName('Generation logs').setHeading();

		new Setting(containerEl)
			.setName('Save generation logs')
			.setDesc('Writes a log note per generation run with inputs, retrieved context, and output. Logs are excluded from retrieval.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.generationLogsEnabled)).onChange(async (value) => {
					this.plugin.settings.generationLogsEnabled = value;
					await this.plugin.saveSettings();
					
					// If enabling logs, check if folder is set and exists
					if (value) {
						const folderPath = this.plugin.settings.generationLogsFolder || '';
						const folder = this.app.vault.getAbstractFileByPath(folderPath);
						if (!folderPath || !(folder instanceof TFolder)) {
							// Prompt user to select/create folder
							const modal = new FolderTreePickerModal(this.plugin, {
								currentPath: folderPath || undefined,
								title: 'Select or create generation logs folder',
								onPick: async (selectedPath) => {
									this.plugin.settings.generationLogsFolder = selectedPath;
									await this.plugin.saveSettings();
									// Refresh the setting to update the button text
									this.display();
								}
							});
							modal.open();
						}
					}
				})
			);

		const generationLogsFolderSetting = new Setting(containerEl)
			.setName('Generation logs folder')
			.setDesc(`Current: ${this.plugin.settings.generationLogsFolder || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.generationLogsFolder ? this.plugin.settings.generationLogsFolder.split('/').pop() || 'Select folder' : 'Select folder')
				.onClick(() => {
					const modal = new FolderTreePickerModal(this.plugin, {
						currentPath: this.plugin.settings.generationLogsFolder || undefined,
						title: 'Select or create generation logs folder',
						onPick: async (folderPath) => {
							this.plugin.settings.generationLogsFolder = folderPath;
							await this.plugin.saveSettings();
							// Refresh the setting to update the button text and desc
							this.display();
						}
					});
					modal.open();
				}));

		new Setting(containerEl)
			.setName('Include full prompt in logs')
			.setDesc('If enabled, logs include the full prompt text that was sent to the model.')
			.addToggle((toggle) =>
				toggle.setValue(Boolean(this.plugin.settings.generationLogsIncludePrompt)).onChange(async (value) => {
					this.plugin.settings.generationLogsIncludePrompt = value;
					await this.plugin.saveSettings();
				})
			);

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
			.setName('Guided demo')
			.setDesc('Generate demo-only text to learn the workflow (chapter → micro edit → character update).')
			.addButton((button) =>
				button.setButtonText('Run guided demo').onClick(() => {
					this.plugin.requestGuidedDemoStart();
				})
			);

		const characterFolderSetting = new Setting(containerEl)
			.setName('Character folder')
			.setDesc(`Current: ${this.plugin.settings.characterFolder || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.characterFolder ? this.plugin.settings.characterFolder.split('/').pop() || 'Select folder' : 'Select folder')
				.onClick(() => {
					const modal = new FolderTreePickerModal(this.plugin, {
						currentPath: this.plugin.settings.characterFolder || undefined,
						title: 'Select or create character folder',
						onPick: async (folderPath) => {
							this.plugin.settings.characterFolder = folderPath;
							await this.plugin.saveSettings();
							// Refresh the setting to update the button text and desc
							this.display();
						}
					});
					modal.open();
				}));

		new Setting(containerEl)
			.setName('Book main file')
			.setDesc(`Current: ${this.plugin.settings.book2Path || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.book2Path ? this.plugin.settings.book2Path.split('/').pop() || 'Select book file' : 'Select book file')
				.onClick(() => {
					const modal = new FileTreePickerModal(this.plugin, {
						currentPath: this.plugin.settings.book2Path,
						onPick: async (filePath) => {
							this.plugin.settings.book2Path = filePath;
							await this.plugin.saveSettings();
							// Refresh the setting to update the button text and desc
							this.display();
						}
					});
					modal.open();
				}));

		const storyBibleSetting = new Setting(containerEl)
			.setName('Story bible path')
			.setDesc(`Current: ${this.plugin.settings.storyBiblePath || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.storyBiblePath ? this.plugin.settings.storyBiblePath.split('/').pop() || 'Select story bible' : 'Select story bible')
				.onClick(() => {
					const modal = new FileTreePickerModal(this.plugin, {
						currentPath: this.plugin.settings.storyBiblePath,
						onPick: async (filePath) => {
							this.plugin.settings.storyBiblePath = filePath;
							await this.plugin.saveSettings();
							// Refresh the setting to update the button text and desc
							this.display();
						}
					});
					modal.open();
				}));


		new Setting(containerEl)
			.setName('Character extraction chunk size (words)')
			.setDesc('Used by "process entire book" to batch character extraction. Larger chunks (e.g., 2000–3000) tend to improve character context.')
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
				.setPlaceholder('Character update instructions...')
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

		// Stress Test Section
		containerEl.createEl('h2', { text: 'Developer Tools' });

		new Setting(containerEl)
			.setName('Run Stress Test')
			.setDesc('Comprehensive test of all plugin features. Creates temporary test files, runs all operations, then cleans up automatically. Log is saved as a note in your vault.')
			.addButton(button => button
				.setButtonText('Start Stress Test')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Running...');
					
					try {
						const stressTest = new StressTestService(this.plugin);
						const logContent = await stressTest.runFullStressTest();
						
						// Save log as a note in the vault
						const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
						const logFileName = `Stress Test Log - ${timestamp}.md`;
						const logPath = logFileName;
						
						await this.plugin.app.vault.create(logPath, logContent);
						
						new Notice(`Stress test completed! Log saved to: ${logFileName}`);
						
						// Open the log file
						const logFile = this.plugin.app.vault.getAbstractFileByPath(logPath);
						if (logFile instanceof TFile) {
							await this.app.workspace.openLinkText(logPath, '', true);
						}
						
					} catch (error) {
						new Notice(`Stress test failed: ${error instanceof Error ? error.message : String(error)}`);
						console.error('Stress test error:', error);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Start Stress Test');
					}
				}));
	}
}

