import { Plugin, TFile, TFolder, Setting, App } from 'obsidian';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './ui/DashboardView';
import { SettingsTab } from './ui/SettingsTab';
import { VaultService } from './services/VaultService';
import { ContextAggregator } from './services/ContextAggregator';
import { PromptEngine } from './services/PromptEngine';
import { AIClient } from './services/AIClient';
import { CharacterExtractor } from './services/CharacterExtractor';
import { SetupWizardModal } from './ui/SetupWizard';

export interface DashboardSettings {
	apiKey: string;
	apiProvider: 'openai' | 'anthropic' | 'gemini' | 'openrouter';
	model: string;
	generationMode: 'single' | 'multi';
	multiStrategy: 'draft-revision' | 'consensus-multistage';
	draftModel?: string;
	revisionModel?: string;
	consensusModel1?: string;
	consensusModel2?: string;
	consensusModel3?: string;
	synthesisModel?: string;
	vaultPath: string;
	characterFolder: string;
	book2Path: string;
	storyBiblePath: string;
	extractionsPath: string;
	slidingWindowPath: string;
	setupCompleted: boolean;
}

const DEFAULT_SETTINGS: DashboardSettings = {
	apiKey: '',
	apiProvider: 'openai',
	model: 'gpt-4',
	generationMode: 'single',
	multiStrategy: 'draft-revision',
	draftModel: 'gpt-3.5-turbo',
	revisionModel: 'gpt-4',
	consensusModel1: 'gpt-4',
	consensusModel2: 'claude-3-opus',
	consensusModel3: 'gemini-pro',
	synthesisModel: 'gpt-4',
	vaultPath: '',
	characterFolder: 'Characters',
	book2Path: 'Book-Main.md',
	storyBiblePath: 'Book - Story Bible.md',
	extractionsPath: 'Extractions.md',
	slidingWindowPath: 'Memory - Sliding Window.md',
	setupCompleted: false
};

export default class WritingDashboardPlugin extends Plugin {
	settings: DashboardSettings;
	vaultService: VaultService;
	contextAggregator: ContextAggregator;
	promptEngine: PromptEngine;
	aiClient: AIClient;
	characterExtractor: CharacterExtractor;
	/**
	 * Tracks the last markdown file the user opened in Obsidian.
	 * Used for actions like "Chunk Selected File" so users don't need to keep updating settings.
	 */
	lastOpenedMarkdownPath: string | null = null;

	async onload() {
		await this.loadSettings();

		// Track the last opened markdown file (the "current note" the user is working on)
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && file.extension === 'md') {
					this.lastOpenedMarkdownPath = file.path;
				}
			})
		);
		
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

		this.addCommand({
			id: 'run-setup-wizard',
			name: 'Run Setup Wizard',
			callback: () => {
				this.showSetupWizard();
			}
		});

		// Check for first-run setup
		if (!this.settings.setupCompleted) {
			const bookMainExists = this.app.vault.getAbstractFileByPath('Book-Main.md') !== null;
			if (!bookMainExists) {
				// Show setup wizard automatically on first run
				this.showSetupWizard();
			} else {
				// Book-Main.md exists, mark setup as completed
				this.settings.setupCompleted = true;
				await this.saveSettings();
			}
		}
	}

	async showSetupWizard() {
		const modal = new SetupWizardModal(this);
		modal.open();
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

