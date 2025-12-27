import { Plugin, TFile } from 'obsidian';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './ui/DashboardView';
import { SettingsTab } from './ui/SettingsTab';
import { VaultService } from './services/VaultService';
import { ContextAggregator } from './services/ContextAggregator';
import { PromptEngine } from './services/PromptEngine';
import { AIClient } from './services/AIClient';
import { CharacterExtractor } from './services/CharacterExtractor';
import { RetrievalService } from './services/RetrievalService';
import { QueryBuilder } from './services/QueryBuilder';
import { EmbeddingsIndex } from './services/retrieval/EmbeddingsIndex';
import { LocalEmbeddingsProvider } from './services/retrieval/LocalEmbeddingsProvider';
import { CpuReranker } from './services/retrieval/CpuReranker';
import { OllamaEmbeddingProvider } from './services/retrieval/OllamaEmbeddingProvider';
import { HeuristicProvider } from './services/retrieval/HeuristicProvider';
import { GenerationLogService } from './services/GenerationLogService';
import { SetupWizardModal } from './ui/SetupWizard';
import { BookMainSelectorModal } from './ui/BookMainSelectorModal';
import { PublishWizardModal } from './ui/PublishWizardModal';

const DEFAULT_MODE_STATE = {
	chapter: {
		sceneSummary: '',
		rewriteInstructions: '',
		minWords: 2000,
		maxWords: 6000
	},
	microEdit: {
		selectedPassage: '',
		grievances: ''
	},
	characterUpdate: {
		selectedText: '',
		extractionInstructions: '',
		sourcePath: undefined as string | undefined
	},
	continuityCheck: {
		draftText: '',
		focus: {
			knowledge: true,
			timeline: true,
			pov: true,
			naming: true
		}
	}
};

export type DashboardSettings = {
	apiKey: string;
	apiProvider: 'openai' | 'anthropic' | 'gemini' | 'openrouter' | string;
	model: string;
	retrievalEnableSemanticIndex: boolean;
	retrievalEnableBm25: boolean;
	retrievalTopK: number;
	retrievalChunkWords: number;
	retrievalChunkOverlapWords: number;
	retrievalChunkHeadingLevel: 'h1' | 'h2' | 'h3' | 'none';
	book2Path: string;
	storyBiblePath: string;
	characterFolder: string;
	generationLogsEnabled?: boolean;
	generationLogsIncludePrompt?: boolean;
	generationLogsFolder?: string;
	generationMode: 'single' | 'multi';
	multiStrategy: 'draft-revision' | 'consensus-multistage';
	draftModel?: string;
	revisionModel?: string;
	consensusModel1?: string;
	consensusModel2?: string;
	consensusModel3?: string;
	synthesisModel?: string;
	contextTokenLimit?: number;
	modeState: typeof DEFAULT_MODE_STATE;
	externalEmbeddingsEnabled?: boolean;
	externalEmbeddingProvider?: 'openai' | 'cohere' | 'google' | 'custom';
	externalEmbeddingModel?: string;
	externalEmbeddingApiKey?: string;
	externalEmbeddingApiUrl?: string;
	externalEmbeddingUseBatch?: boolean;
	retrievalExcludedFolders?: string[];
	retrievalIndexPaused?: boolean;
	characterExtractionSourcePath?: string;
	guidedDemoDismissed?: boolean;
	guidedDemoShownOnce?: boolean;
	setupCompleted?: boolean;
	vaultPath?: string;
	[key: string]: any;
};

/**
 * Main plugin entrypoint. Slimmed to remove Smart Connections and template dependencies.
 * Settings are typed as `any` to stay resilient while we trim legacy fields.
 */
export default class WritingDashboardPlugin extends Plugin {
	settings: DashboardSettings;
	vaultService: VaultService;
	contextAggregator: ContextAggregator;
	promptEngine: PromptEngine;
	aiClient: AIClient;
	characterExtractor: CharacterExtractor;
	queryBuilder: QueryBuilder;
	retrievalService: RetrievalService;
	embeddingsIndex: EmbeddingsIndex;
	cpuReranker: CpuReranker;
	generationLogService: GenerationLogService;
	ollama: import('./services/retrieval/OllamaEmbeddingProvider').OllamaEmbeddingProvider;
	guidedDemoStartRequested = false;
	lastOpenedMarkdownPath: string | null = null;

	async onload() {
		await this.loadSettings();

		// Core services
		this.vaultService = new VaultService(this.app.vault, this);
		this.contextAggregator = new ContextAggregator(this.app.vault, this, this.vaultService);
		this.promptEngine = new PromptEngine();
		this.aiClient = new AIClient();
		this.characterExtractor = new CharacterExtractor();
		this.queryBuilder = new QueryBuilder();
		this.ollama = new OllamaEmbeddingProvider(this.app);
		this.embeddingsIndex = new EmbeddingsIndex(this.app.vault, this, this.ollama);
		this.cpuReranker = new CpuReranker();
		this.generationLogService = new GenerationLogService(this.app, this);

		// Retrieval providers (hash/BM25 + optional local embeddings)
		const providers: Array<import('./services/retrieval/types').RetrievalProvider> = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new LocalEmbeddingsProvider(
				this.embeddingsIndex,
				() => Boolean(this.settings?.retrievalEnableSemanticIndex ?? true),
				(path) => !this.vaultService.isExcludedPath(path)
			)
		];
		this.retrievalService = new RetrievalService(providers, {
			getVector: (key) => this.embeddingsIndex.getVectorForKey(key)
		});

		// UI entry points
		this.addRibbonIcon('book', 'Open Writing Dashboard', () => this.activateView());
		this.addCommand({
			id: 'open-writing-dashboard',
			name: 'Open dashboard',
			callback: () => this.activateView()
		});
		this.addCommand({
			id: 'run-setup-wizard',
			name: 'Run setup wizard',
			callback: () => new SetupWizardModal(this).open()
		});
		this.addCommand({
			id: 'select-book-main-file',
			name: 'Select Book main file',
			callback: () => new BookMainSelectorModal(this).open()
		});
		this.addCommand({
			id: 'publish',
			name: 'Publish (epub/docx/rtf)',
			callback: () => this.showPublishWizard()
		});

		this.addSettingTab(new SettingsTab(this.app, this));
		this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));

		// Start dashboard after layout
		this.app.workspace.onLayoutReady(() => this.activateView());
	}

	onunload() {
		this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD).forEach((leaf) => leaf.detach());
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

	async loadSettings() {
		const loaded = (await this.loadData()) || {};
		this.settings = Object.assign(
			{
				apiKey: '',
				apiProvider: 'openai',
				model: 'gpt-4o',
				retrievalEnableSemanticIndex: true,
				retrievalEnableBm25: true,
				retrievalTopK: 24,
				retrievalChunkWords: 500,
				retrievalChunkOverlapWords: 100,
				retrievalChunkHeadingLevel: 'h1',
				book2Path: 'Book-Main.md',
				storyBiblePath: 'Book - Story Bible.md',
				characterFolder: 'Characters',
				generationLogsEnabled: false,
				generationLogsIncludePrompt: false,
				generationLogsFolder: '',
				generationMode: 'single',
				multiStrategy: 'draft-revision',
				contextTokenLimit: 128000,
				modeState: DEFAULT_MODE_STATE,
				externalEmbeddingsEnabled: false,
				externalEmbeddingProvider: 'openai',
				externalEmbeddingModel: 'text-embedding-3-small',
				externalEmbeddingApiKey: '',
				externalEmbeddingApiUrl: '',
				externalEmbeddingUseBatch: false,
				retrievalExcludedFolders: [],
				retrievalIndexPaused: false,
				characterExtractionSourcePath: undefined,
				guidedDemoDismissed: false,
				guidedDemoShownOnce: false,
				setupCompleted: false,
				// Retrieval profiles: seed a default "story" profile that scopes to plugin-created folders.
				retrievalProfiles: [
					{
						id: 'story',
						name: 'Story',
						includedFolders: ['Characters', 'Story bibles', 'Generation logs', 'Exports']
					}
				],
				retrievalActiveProfileId: 'story'
			},
			loaded
		);

		// Ensure an active retrieval profile is set; fall back to the first profile if missing.
		if (!this.settings.retrievalActiveProfileId) {
			const firstProfile = this.settings.retrievalProfiles?.[0];
			if (firstProfile?.id) {
				this.settings.retrievalActiveProfileId = firstProfile.id;
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.notifyUi('writing-dashboard:settings-changed');
	}

	private notifyUi(eventName: string) {
		try {
			window.dispatchEvent(new CustomEvent(eventName));
		} catch {
			// ignore
		}
	}

	showPublishWizard() {
		new PublishWizardModal(this).open();
	}

	requestGuidedDemoStart() {
		this.guidedDemoStartRequested = true;
		this.notifyUi('writing-dashboard:guided-demo-start');
	}

	recreateRetrievalService() {
		const providers: Array<import('./services/retrieval/types').RetrievalProvider> = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new LocalEmbeddingsProvider(
				this.embeddingsIndex,
				() => Boolean(this.settings?.retrievalEnableSemanticIndex ?? true),
				(path) => !this.vaultService.isExcludedPath(path)
			)
		];

		this.retrievalService = new RetrievalService(providers, {
			getVector: (key) => this.embeddingsIndex.getVectorForKey(key)
		});
	}
}


