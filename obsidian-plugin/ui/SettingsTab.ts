import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import WritingDashboardPlugin, { DashboardSettings } from '../main';

export class SettingsTab extends PluginSettingTab {
	plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Writing Dashboard Settings' });

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your AI API key (stored securely)')
			.addText(text => text
				.setPlaceholder('Enter API key')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Provider')
			.setDesc('Choose your AI provider')
			.addDropdown(dropdown => dropdown
				.addOption('openai', 'OpenAI')
				.addOption('anthropic', 'Anthropic')
				.addOption('gemini', 'Gemini')
				.setValue(this.plugin.settings.apiProvider)
				.onChange(async (value: 'openai' | 'anthropic' | 'gemini') => {
					this.plugin.settings.apiProvider = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Model')
			.setDesc('AI model to use (e.g., gpt-4, claude-3-opus, gemini-pro)')
			.addText(text => text
				.setPlaceholder('gpt-4')
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Vault Path')
			.setDesc('Path to your Obsidian vault (auto-detected)')
			.addText(text => text
				.setPlaceholder('Vault path')
				.setValue(this.plugin.settings.vaultPath)
				.onChange(async (value) => {
					this.plugin.settings.vaultPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Character Folder')
			.setDesc('Folder name for character notes (default: Characters)')
			.addText(text => text
				.setPlaceholder('Characters')
				.setValue(this.plugin.settings.characterFolder)
				.onChange(async (value) => {
					this.plugin.settings.characterFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Book 2 Path')
			.setDesc('Path to your active manuscript')
			.addText(text => text
				.setPlaceholder('Book - MAIN 2.md')
				.setValue(this.plugin.settings.book2Path)
				.onChange(async (value) => {
					this.plugin.settings.book2Path = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Story Bible Path')
			.setDesc('Path to your story bible')
			.addText(text => text
				.setPlaceholder('Book - Story Bible.md')
				.setValue(this.plugin.settings.storyBiblePath)
				.onChange(async (value) => {
					this.plugin.settings.storyBiblePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Extractions Path')
			.setDesc('Path to your extractions file')
			.addText(text => text
				.setPlaceholder('Extractions.md')
				.setValue(this.plugin.settings.extractionsPath)
				.onChange(async (value) => {
					this.plugin.settings.extractionsPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sliding Window Path')
			.setDesc('Path to your sliding window memory file')
			.addText(text => text
				.setPlaceholder('Memory - Sliding Window.md')
				.setValue(this.plugin.settings.slidingWindowPath)
				.onChange(async (value) => {
					this.plugin.settings.slidingWindowPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Python Backend URL')
			.setDesc('URL of the Python backend server')
			.addText(text => text
				.setPlaceholder('http://localhost:8000')
				.setValue(this.plugin.settings.pythonBackendUrl)
				.onChange(async (value) => {
					this.plugin.settings.pythonBackendUrl = value;
					const { PythonBridge } = await import('../services/PythonBridge');
					this.plugin.pythonBridge = new PythonBridge(value);
					await this.plugin.saveSettings();
				}));
	}
}

