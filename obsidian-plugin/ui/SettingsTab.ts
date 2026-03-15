import { App, PluginSettingTab, Setting, TFolder, Notice, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { SetupWizardModal } from './SetupWizard';
import { TreePickerModal } from './TreePickerModal';
import { HelpDensity } from './HelpRegistry';
import { relayEventBus } from '../services/EventBus';

// Model lists for each provider
// IDs verified against live API docs — March 2026
// Sources: docs.anthropic.com, platform.openai.com, ai.google.dev, openrouter.ai/models

const OPENAI_MODELS = [
	// Current generation (2025–2026)
	{ value: 'gpt-5', label: 'GPT-5' },
	{ value: 'gpt-4.1', label: 'GPT-4.1' },
	{ value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
	{ value: 'gpt-4o', label: 'GPT-4o' },
	{ value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
	// Reasoning models
	{ value: 'o3', label: 'o3 (Reasoning)' },
	{ value: 'o4-mini', label: 'o4-mini (Reasoning, Fast)' }
];

const ANTHROPIC_MODELS = [
	// Current generation — Claude 4.x (2025–2026)
	{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6 ⭐ Most capable' },
	{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 ⭐ Recommended' },
	{ value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Fast & cheap)' },
	// Previous generation — still active
	{ value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Legacy)' },
	{ value: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Pinned, Legacy)' }
];

const GEMINI_MODELS = [
	// ── Gemini 2.5 — stable production (widely available) ────────
	{ value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash ⭐ Recommended — fast & affordable' },
	{ value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — highest quality, 2M ctx' },
	{ value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite — cheapest option' },
	// ── Gemini 3.x — active previews (may require waitlist access) ─
	{ value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview ⚠ may require waitlist' },
	{ value: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview ⚠ may require waitlist' },
	// ── Older / deprecated ────────────────────────────────────────
	{ value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Deprecated by Google)' },
	{ value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
];

const OPENROUTER_MODELS = [
	// ── Anthropic via OpenRouter ──────────────────────────────────
	{ value: 'anthropic/claude-sonnet-4-6', label: '★ Anthropic — Claude Sonnet 4.6' },
	{ value: 'anthropic/claude-opus-4-6', label: 'Anthropic — Claude Opus 4.6' },
	{ value: 'anthropic/claude-haiku-4-5', label: 'Anthropic — Claude Haiku 4.5 (Fast)' },
	// ── OpenAI via OpenRouter ─────────────────────────────────────
	{ value: 'openai/gpt-5', label: 'OpenAI — GPT-5' },
	{ value: 'openai/gpt-4.1', label: 'OpenAI — GPT-4.1' },
	{ value: 'openai/gpt-4.1-mini', label: 'OpenAI — GPT-4.1 Mini' },
	{ value: 'openai/gpt-4o', label: 'OpenAI — GPT-4o' },
	{ value: 'openai/o3', label: 'OpenAI — o3 (Reasoning)' },
	{ value: 'openai/o4-mini', label: 'OpenAI — o4-mini (Reasoning, Fast)' },
	// ── Google via OpenRouter ─────────────────────────────────────
	{ value: 'google/gemini-2.5-flash', label: '★ Google — Gemini 2.5 Flash (Recommended)' },
	{ value: 'google/gemini-2.5-pro', label: 'Google — Gemini 2.5 Pro' },
	{ value: 'google/gemini-3-flash-preview-20251217', label: 'Google — Gemini 3 Flash Preview ⚠ waitlist' },
	{ value: 'google/gemini-3.1-pro-preview', label: 'Google — Gemini 3.1 Pro Preview' },
	// ── Meta Llama via OpenRouter ─────────────────────────────────
	{ value: 'meta-llama/llama-4-maverick', label: 'Meta — Llama 4 Maverick (Best quality)' },
	{ value: 'meta-llama/llama-4-scout', label: 'Meta — Llama 4 Scout (10M ctx)' },
	{ value: 'meta-llama/llama-4-maverick:free', label: 'Meta — Llama 4 Maverick (Free tier)' },
	{ value: 'meta-llama/llama-4-scout:free', label: 'Meta — Llama 4 Scout (Free tier)' },
	// ── Other top models via OpenRouter ──────────────────────────
	{ value: 'mistralai/mistral-large-2512', label: 'Mistral — Mistral Large 3 (Dec 2025)' },
	{ value: 'deepseek/deepseek-v3.2-20251201', label: 'DeepSeek — V3.2 (Top OSS)' },
	{ value: 'minimax/minimax-m2.5', label: 'MiniMax — M2.5 (Most used on OR)' }
];

/** Model IDs that have been confirmed shut down by Google and will never work. */
const SHUTDOWN_MODELS = new Set<string>([
	// none currently — remove entries here if a model is confirmed back online
]);

/** Model IDs that exist but may require special waitlist/preview access from Google. */
const RESTRICTED_PREVIEW_MODELS = new Set([
	'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview',
]);

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
	readonly plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		super(app, plugin);
		this.plugin = plugin;

		// Keep folder exclusion list "live" while this tab is open.
		const refreshIfVisible = () => {
			try {
				if (this.containerEl?.isConnected) this.display();
			} catch (err) {
				console.debug('[SettingsTab] Failed to refresh settings display:', err);
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

		const addSection = (title: string, desc?: string) => {
			new Setting(containerEl).setName(title).setHeading();
			if (desc) {
				const p = containerEl.createEl('p', { text: desc });
				p.style.marginTop = '-8px';
			}
		};

		addSection('API & Model', 'Provider, key, and model selection');

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
					this.display(); // Refresh to update/clear the preview warning banner
				});
			});

		// ── Model health banner ──────────────────────────────────────────────
		if (this.plugin.settings.apiProvider === 'gemini') {
			const model = this.plugin.settings.model;
			const isShutdown = SHUTDOWN_MODELS.has(model);
			const isRestricted = RESTRICTED_PREVIEW_MODELS.has(model);

			if (isShutdown || isRestricted) {
				const banner = containerEl.createEl('div');
				banner.style.cssText = [
					`background: var(${isShutdown ? '--background-modifier-error' : '--background-modifier-message'})`,
					`color: var(${isShutdown ? '--text-error' : '--text-warning'})`,
					`border: 1px solid var(${isShutdown ? '--background-modifier-error-hover' : '--background-modifier-message'})`,
					'border-radius: 6px',
					'padding: 10px 14px',
					'margin: 4px 0 12px',
					'font-size: 0.88em',
					'line-height: 1.5',
				].join(';');

				if (isShutdown) {
					banner.innerHTML =
						`<strong>✗ This model was shut down by Google on March 9, 2026</strong><br>` +
						`<b>${model}</b> no longer exists in the Gemini API. ` +
						`Every request will fail with a 429 or 404 error.<br>` +
						`<b>Fix:</b> change Model above to <b>Gemini 2.5 Flash</b> — it is the current recommended model.`;
				} else {
					banner.innerHTML =
						`<strong>⚠ Preview model — waitlist may be required</strong><br>` +
						`<b>${model}</b> is an active Gemini preview. Without Google's explicit access approval ` +
						`you will receive a <code>429 Resource Exhausted</code> error.<br>` +
						`If generation fails, switch to <b>Gemini 2.5 Flash</b> in the Model dropdown above.`;
				}
			}
		}

		new Setting(containerEl)
			.setName('Words per chunk')
			.setDesc('Target word count for each generation pass. Default 2500. Cloud AI handles 3000–8000 well — enter any value, there is no upper limit.')
			.addText(text => text
				.setPlaceholder('2500')
				.setValue(String(this.plugin.settings.maxChunkWords))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed >= 100) {
						this.plugin.settings.maxChunkWords = parsed;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Test Now (Diagnostics)')
			.setDesc('Run a comprehensive check of all systems based on your current settings.')
			.addButton((btn) =>
				btn
					.setButtonText('Run Diagnostics')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Testing...');

						try {
							const report = await this.plugin.diagnosticsService.runDiagnostics();

							if (report.overallStatus === 'PASS') {
								new Notice('All systems PASS! Your configuration is healthy.');
							} else if (report.overallStatus === 'WARN') {
								const warnings = report.results.filter(r => r.status === 'WARN');
								new Notice(`Systems healthy with ${warnings.length} warnings. Check console/artifacts for details.`);
							} else {
								const fails = report.results.filter(r => r.status === 'FAIL');
								new Notice(`${fails.length} systems FAILED. Generation is blocked. Check console/artifacts.`);
							}

							console.debug('[Diagnostics] Full Report:', report);
						} catch (err) {
							new Notice(`Diagnostics failed: ${err instanceof Error ? err.message : String(err)}`);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText('Run Diagnostics');
						}
					})
			);

		// Retrieval / indexing settings
		addSection('Retrieval scope', 'Choose included folders for this project.');

		new Setting(containerEl)
			.setName('Profile')
			.setDesc('Select which folders to include for retrieval/indexing (applies to all features).')
			.addButton((btn) =>
				btn.setButtonText('Open profile picker').onClick(() => {
					const { ProfilePickerModal } = require('./ProfilePickerModal');
					new ProfilePickerModal(this.plugin).open();
				})
			);

		addSection('Retrieval engines', 'Semantic/BM25 knobs and result limits.');

		// Add status line first
		const status = this.plugin.embeddingsIndex.getStatus();
		const statusEl = containerEl.createEl('div', {
			cls: 'setting-item-description',
			text: `Index Status: ${status.indexedChunks} chunks across ${status.indexedFiles} files${status.queued > 0 ? ` | Queued: ${status.queued}` : ''}`
		});
		statusEl.style.marginBottom = '10px';
		statusEl.style.padding = '8px';
		statusEl.style.backgroundColor = 'var(--background-secondary)';
		statusEl.style.borderRadius = '4px';

		new Setting(containerEl)
			.setName('Semantic Index Management')
			.setDesc('Manually trigger a full rescan of your vault or clear the local index.')
			.addButton(btn => {
				const reindexBtn = btn;
				reindexBtn.setButtonText('Re-index Vault');

				// Subscribe to indexing events for dynamic button updates
				const onStart = (data: { totalFiles: number }) => {
					reindexBtn.setDisabled(true);
					reindexBtn.setButtonText(`Indexing (0/${data.totalFiles})...`);
				};
				const onProgress = (data: { processed: number; total: number }) => {
					reindexBtn.setButtonText(`Indexing (${data.processed}/${data.total})...`);
				};
				const onComplete = () => {
					reindexBtn.setDisabled(false);
					reindexBtn.setButtonText('Re-index Vault');
					// Refresh status display
					const newStatus = this.plugin.embeddingsIndex.getStatus();
					statusEl.textContent = `Index Status: ${newStatus.indexedChunks} chunks across ${newStatus.indexedFiles} files`;
				};

				relayEventBus.on('index:start', onStart);
				relayEventBus.on('index:progress', onProgress);
				relayEventBus.on('index:complete', onComplete);

				reindexBtn.onClick(async () => {
					reindexBtn.setDisabled(true);
					reindexBtn.setButtonText('Starting...');
					this.plugin.embeddingsIndex.enqueueFullRescan();
				});
			})
			.addButton(btn => btn
				.setButtonText('Clear Index')
				.setWarning()
				.onClick(async () => {
					if (globalThis.confirm('Are you sure? This will delete your entire local semantic index and require a full rebuild.')) {
						await this.plugin.embeddingsIndex.clearIndex();
						new Notice('Index cleared successfully.');
						this.display();
					}
				}));

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
			.setName('Embedding Storage Mode')
			.setDesc('Isolated: Private index. Auto: Share with StoryBoard. Manual: Use custom path.')
			.addDropdown(dropdown => dropdown
				.addOption('isolated', 'Isolated (Private)')
				.addOption('auto', 'Auto (Shared Brain)')
				.addOption('manual', 'Manual')
				.setValue(this.plugin.settings.embeddingStorageMode || 'isolated')
				.onChange(async (value: 'isolated' | 'auto' | 'manual') => {
					this.plugin.settings.embeddingStorageMode = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.embeddingStorageMode === 'manual') {
			new Setting(containerEl)
				.setName('Manual Shared Path')
				.setDesc('Vault-relative path to the shared index directory.')
				.addText(text => text
					.setPlaceholder('Embeddings/shared-index')
					.setValue(this.plugin.settings.manualSharedPath || '')
					.onChange(async (value) => {
						this.plugin.settings.manualSharedPath = value;
						await this.plugin.saveSettings();
					}));
		}

		new Setting(containerEl)
			.setName('Retrieved items (limit)')
			.setDesc('Maximum number of retrieved snippets to include in prompts.')
			.addText((text) =>
				text
					.setPlaceholder('24')
					.setValue(String(this.plugin.settings.retrievalTopK ?? 24))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.retrievalTopK = Math.max(1, Math.min(100, parsed));
							await this.plugin.saveSettings();
						}
					})
			);

		// External embedding API settings
		addSection('External embeddings (optional)', 'Use a remote embedding API instead of local hash/BM25.');
		new Setting(containerEl)
			.setName('Enable external embeddings')
			.setDesc('WARNING: Enabling this will make API calls during retrieval. Keep disabled to use only local hash/BM25 search (recommended).')
			.addToggle((toggle) => {
				toggle.setValue(Boolean(this.plugin.settings.externalEmbeddingsEnabled ?? false));
				toggle.onChange(async (value) => {
					this.plugin.settings.externalEmbeddingsEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.recreateRetrievalService();
					this.display(); // Refresh to show/hide settings
				});
			});

		// Only show other external embedding settings if enabled
		if (this.plugin.settings.externalEmbeddingsEnabled) {
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
						this.plugin.recreateRetrievalService(); // Recreate to use new provider
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
						this.plugin.recreateRetrievalService(); // Recreate to use new API key
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
		}

		addSection('Indexing & chunking', 'Chunk size, overlap, heading split, and indexing pause.');
		new Setting(containerEl)
			.setName('Index chunk size (words)')
			.setDesc('Controls how your notes are chunked for semantic retrieval. Larger chunks add more context but may reduce precision.')
			.addText((text) =>
				text
					.setPlaceholder('500')
					.setValue(String(this.plugin.settings.retrievalChunkWords ?? 500))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
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
						const parsed = Number.parseInt(value, 10);
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

		// Generation logs
		addSection('Generation logs', 'Optional logging of prompts/outputs (excluded from retrieval).');

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
							new TreePickerModal(this.plugin, {
								title: 'Select or create generation logs folder',
								mode: 'single',
								initialSelection: folderPath || undefined,
								filter: (node) => node.type === 'folder',
								onSubmit: async (picked) => {
									const path = Array.isArray(picked) ? picked[0] : picked;
									this.plugin.settings.generationLogsFolder = path;
									await this.plugin.saveSettings();
									this.display();
								}
							}).open();
						}
					}
				})
			);

		new Setting(containerEl)
			.setName('Generation logs folder')
			.setDesc(`Current: ${this.plugin.settings.generationLogsFolder || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.generationLogsFolder ? this.plugin.settings.generationLogsFolder.split('/').pop() || 'Select folder' : 'Select folder')
				.onClick(() => {
					new TreePickerModal(this.plugin, {
						title: 'Select or create generation logs folder',
						mode: 'single',
						initialSelection: this.plugin.settings.generationLogsFolder || undefined,
						filter: (node) => node.type === 'folder',
						onSubmit: async (folderPath) => {
							const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
							this.plugin.settings.generationLogsFolder = path;
							await this.plugin.saveSettings();
							this.display();
						}
					}).open();
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

		addSection('Paths & setup', 'Setup wizard and guided demo.');

		new Setting(containerEl)
			.setName('Help Density')
			.setDesc('Control how many tooltips and guidance elements are shown throughout the plugin.')
			.addDropdown(dropdown => dropdown
				.addOption('NONE', 'None (Clean UI)')
				.addOption('LITE', 'Lite (Standard tooltips)')
				.addOption('FULL', 'Full (Detailed guidance)')
				.setValue(this.plugin.settings.helpDensity || 'LITE')
				.onChange(async (value: HelpDensity) => {
					this.plugin.settings.helpDensity = value;
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

		addSection('Manuscript & characters', 'Core paths for manuscript, story bible, and character notes.');

		new Setting(containerEl)
			.setName('Character folder')
			.setDesc(`Current: ${this.plugin.settings.characterFolder || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.characterFolder ? this.plugin.settings.characterFolder.split('/').pop() || 'Select path' : 'Select path')
				.onClick(() => {
					new TreePickerModal(this.plugin, {
						title: 'Select character folder',
						mode: 'single',
						initialSelection: this.plugin.settings.characterFolder,
						filter: (node) => node.type === 'folder',
						onSubmit: async (path) => {
							const picked = Array.isArray(path) ? path[0] : path;
							this.plugin.settings.characterFolder = picked;
							await this.plugin.saveSettings();
							this.display();
						}
					}).open();
				}));

		new Setting(containerEl)
			.setName('Book main file')
			.setDesc(`Current: ${this.plugin.settings.book2Path || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.book2Path ? this.plugin.settings.book2Path.split('/').pop() || 'Select book file' : 'Select book file')
				.onClick(() => {
					new TreePickerModal(this.plugin, {
						title: 'Select book main file',
						mode: 'single',
						initialSelection: this.plugin.settings.book2Path,
						onSubmit: async (filePath) => {
							const picked = Array.isArray(filePath) ? filePath[0] : filePath;
							this.plugin.settings.book2Path = picked;
							await this.plugin.saveSettings();
							this.display();
						}
					}).open();
				}));

		new Setting(containerEl)
			.setName('Story bible path')
			.setDesc(`Current: ${this.plugin.settings.storyBiblePath || '(none selected)'}`)
			.addButton(button => button
				.setButtonText(this.plugin.settings.storyBiblePath ? this.plugin.settings.storyBiblePath.split('/').pop() || 'Select story bible' : 'Select story bible')
				.onClick(() => {
					new TreePickerModal(this.plugin, {
						title: 'Select story bible',
						mode: 'single',
						initialSelection: this.plugin.settings.storyBiblePath,
						onSubmit: async (filePath) => {
							const picked = Array.isArray(filePath) ? filePath[0] : filePath;
							this.plugin.settings.storyBiblePath = picked;
							await this.plugin.saveSettings();
							this.display();
						}
					}).open();
				}));

		addSection('Writing Commandments', 'Literary rules injected into every generation phase. The AI treats these as non-negotiable when no specific direction is given.');

		new Setting(containerEl)
			.setName('Writing Commandments')
			.setDesc(
				'These rules govern every generation phase — especially Phase 2 when no midpoint direction is given. ' +
				'Based on Orson Scott Card\'s story architecture principles. Edit, remove, or add commandments freely. ' +
				'Each commandment should be numbered and self-contained.'
			)
			.addTextArea(text => {
				const defaultCommandments = `1. THE LAW OF CAUSATION
No event occurs in isolation. Every action must have a reaction and a preceding cause. Ask "Why did this happen?" then ask it again, up to 4 levels deep. The causation must always lead to a state change. Reject the first, most obvious reason — it is rarely the right one.

2. THE MICE QUOTIENT ANCHOR
Every scene has a primary driver: Milieu (The World), Idea (The Mystery), Character (The Transformation), or Event (The Conflict). The scene is not complete until that driver has progressed. If it is a Character scene, the character's internal state MUST be different by the final paragraph.

3. THE INEVITABLE END
Every causal chain must trend toward the narrative climax. Every choice a character makes must narrow their future options, making the eventual ending feel inevitable but unexpected. Never add complications that do not serve the ultimate direction of the story.

4. DEEP POV
Do not report on events — experience them. Filter every description through the POV character's specific biases, sensory experience, and emotional state. Do not default to omniscient narration or generic AI prose patterns.

5. NO FLOATING DIALOGUE
Dialogue is action. Characters speak to get something or to hide something. Every line of dialogue must have a subtext cause rooted in that character's motivations. No line of dialogue exists purely for exposition.

6. THE ADDITIVE WRITER RULE
You are an additive writer. Your only job is to concatenate, not recreate. Every paragraph must be a direct consequence of the one before it. If a character has left a room, they cannot be in that room in the next paragraph unless they physically walk back in. Never restart the narrative or regenerate the beginning of anything.`;
				text
					.setPlaceholder(defaultCommandments)
					.setValue(this.plugin.settings.writingCommandments || defaultCommandments)
					.onChange(async (value) => {
						this.plugin.settings.writingCommandments = value.trim() || undefined;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 22;
				text.inputEl.style.width = '100%';
				text.inputEl.style.fontFamily = 'var(--font-text)';
				text.inputEl.style.fontSize = '0.88em';
				text.inputEl.style.lineHeight = '1.6';
				return text;
			});

		addSection('Character extraction & safeguards', 'Defaults for character processing and prompt-size warnings.');

		new Setting(containerEl)
			.setName('Character extraction chunk size (words)')
			.setDesc('Used by "process entire book" to batch character extraction. Larger chunks (e.g., 2000–3000) tend to improve character context.')
			.addText(text => text
				.setPlaceholder('2500')
				.setValue(String(this.plugin.settings.characterExtractionChunkSize ?? 2500))
				.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
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
					const parsed = Number.parseInt(value, 10);
					const clamped = Number.isFinite(parsed) ? Math.min(2000000, Math.max(1000, parsed)) : 128000;
					this.plugin.settings.contextTokenLimit = clamped;
					await this.plugin.saveSettings();
				}));
	}
}
