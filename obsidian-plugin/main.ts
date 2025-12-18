import { Plugin, TFile, TFolder, Setting, App } from 'obsidian';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './ui/DashboardView';
import { SettingsTab } from './ui/SettingsTab';
import { VaultService } from './services/VaultService';
import { ContextAggregator } from './services/ContextAggregator';
import { PromptEngine } from './services/PromptEngine';
import { AIClient } from './services/AIClient';
import { CharacterExtractor } from './services/CharacterExtractor';

export interface DashboardSettings {
	apiKey: string;
	apiProvider: 'openai' | 'anthropic' | 'gemini';
	model: string;
	vaultPath: string;
	characterFolder: string;
	book2Path: string;
	storyBiblePath: string;
	extractionsPath: string;
	slidingWindowPath: string;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	apiKey: '',
	apiProvider: 'openai',
	model: 'gpt-4',
	vaultPath: '',
	characterFolder: 'Characters',
	book2Path: 'Book - MAIN 2.md',
	storyBiblePath: 'Book - Story Bible.md',
	extractionsPath: 'Extractions.md',
	slidingWindowPath: 'Memory - Sliding Window.md'
};

export default class WritingDashboardPlugin extends Plugin {
	settings: DashboardSettings;
	vaultService: VaultService;
	contextAggregator: ContextAggregator;
	promptEngine: PromptEngine;
	aiClient: AIClient;
	characterExtractor: CharacterExtractor;

	async onload() {
		await this.loadSettings();
		
		// Set vault path if not set
		if (!this.settings.vaultPath) {
			// @ts-ignore - basePath exists but not in types
			this.settings.vaultPath = this.app.vault.adapter.basePath || '';
			await this.saveSettings();
		}
		
		this.vaultService = new VaultService(this.app.vault, this);
		this.contextAggregator = new ContextAggregator(this.app.vault, this);
		this.promptEngine = new PromptEngine();
		this.aiClient = new AIClient();
		this.characterExtractor = new CharacterExtractor();
		
		this.registerView(
			VIEW_TYPE_DASHBOARD,
			(leaf) => new DashboardView(leaf, this)
		);
		
		this.addRibbonIcon('book-open', 'Open Writing Dashboard', () => {
			this.activateView();
		});
		
		this.addSettingTab(new SettingsTab(this.app, this));
		
		this.addCommand({
			id: 'open-dashboard',
			name: 'Open Writing Dashboard',
			callback: () => {
				this.activateView();
			}
		});
	}

	async onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];
		
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
		}
		
		workspace.revealLeaf(leaf);
	}
}

