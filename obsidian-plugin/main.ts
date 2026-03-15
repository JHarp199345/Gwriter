import { Plugin, TFile } from 'obsidian';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './ui/DashboardView';
import { SettingsTab } from './ui/SettingsTab';
import { VaultService } from './services/VaultService';
import { ContextAggregator } from './services/ContextAggregator';
import { PromptEngine } from './services/PromptEngine';
import { AIClient } from './services/AIClient';
import { CharacterExtractor } from './services/CharacterExtractor';
import { CharacterUpdateService } from './services/CharacterUpdateService';
import { RetrievalService } from './services/RetrievalService';
import { QueryBuilder } from './services/QueryBuilder';
import { EmbeddingsIndex } from './services/retrieval/EmbeddingsIndex';
import { ExternalEmbeddingsProvider } from './services/retrieval/ExternalEmbeddingsProvider';
import { SequentialGenerator } from './services/SequentialGenerator';
import { ContextManager } from './services/ContextManager';
import { AuditService } from './services/AuditService';
import { TrashService } from './services/TrashService';
import { HeuristicProvider } from './services/retrieval/HeuristicProvider';
import { GenerationLogService } from './services/GenerationLogService';
import { DiagnosticsService } from './services/DiagnosticsService';
import { SetupWizardModal } from './ui/SetupWizard';
import { BookMainSelectorModal } from './ui/BookMainSelectorModal';
import { PublishWizardModal } from './ui/PublishWizardModal';

import { HelpDensity } from './ui/HelpRegistry';

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
	characterExtractionChunkSize?: number;
	defaultCharacterExtractionInstructions?: string;
	characterExtractionBackend?: 'cloud';
	worldFolder?: string;
	guidedDemoDismissed?: boolean;
	guidedDemoShownOnce?: boolean;
	setupCompleted?: boolean;
	vaultPath?: string;
	relayCloudModel?: string;
	relayMaxContextWindow?: number;
	relayCostHardBudget?: number; // Max cost per run in dollars
	relayStyleSignature?: string[]; // "Golden Paragraphs" for voice matching
	maxChunkWords: number;
	maxRepairAttempts: number;
	retrievalTokenBudget: number;
	helpDensity?: HelpDensity;
	verifiedModelsCatalog?: string[];
	embeddingStorageMode?: 'isolated' | 'auto' | 'manual';
	manualSharedPath?: string;
	/** Spontaneity/creativity slider value 0–100. Maps to temperature 0.3–1.0. Default 50. */
	spontaneity?: number;
	[key: string]: any;
};

/**
 * Main plugin entrypoint. Slimmed to cloud-only AI (no local Ollama/WASM).
 * Settings are typed as `any` to stay resilient while we trim legacy fields.
 */
export default class WritingDashboardPlugin extends Plugin {
	settings: DashboardSettings;
	// These fields are assigned in onload(), not in the constructor.
	vaultService: VaultService;
	contextAggregator: ContextAggregator;
	promptEngine: PromptEngine;
	aiClient: AIClient;
	characterExtractor: CharacterExtractor;
	characterUpdateService: CharacterUpdateService;
	queryBuilder: QueryBuilder;
	retrievalService: RetrievalService;
	embeddingsIndex: EmbeddingsIndex;
	diagnosticsService: DiagnosticsService;
	generationLogService: GenerationLogService;
	sequentialGenerator: SequentialGenerator;
	auditService: AuditService;
	trashService: TrashService;
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
		this.characterUpdateService = new CharacterUpdateService(
			this,
			this.promptEngine,
			this.characterExtractor,
			this.vaultService
		);
		this.queryBuilder = new QueryBuilder();
		this.auditService = new AuditService();
		this.trashService = new TrashService(this.app.vault, this);
		this.sequentialGenerator = new SequentialGenerator(this.app, this);
		this.embeddingsIndex = new EmbeddingsIndex(this.app.vault, this);
		this.diagnosticsService = new DiagnosticsService(this);
		this.generationLogService = new GenerationLogService(this.app, this);

		// Write handshake for shared brain
		await this.writeHandshake();

		// Retrieval providers: heuristic (BM25/hash) + optional external cloud embeddings
		const providers: Array<import('./services/retrieval/types').RetrievalProvider> = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new ExternalEmbeddingsProvider(
				this,
				this.embeddingsIndex,
				() => Boolean(this.settings?.externalEmbeddingsEnabled ?? false),
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

	async writeHandshake() {
		if (!this.embeddingsIndex) return;
		const profile = this.embeddingsIndex.getEmbeddingProfile();
		const handshakeDir = `${this.app.vault.configDir}/embeddings/handshake`;
		const handshakePath = `${handshakeDir}/writing-dashboard.json`;

		try {
			if (!(await this.app.vault.adapter.exists(handshakeDir))) {
				// Recursive mkdir is not supported by adapter.mkdir, but we can try
				const parts = handshakeDir.split('/');
				let current = '';
				for (const part of parts) {
					current += (current ? '/' : '') + part;
					if (!(await this.app.vault.adapter.exists(current))) {
						await this.app.vault.adapter.mkdir(current);
					}
				}
			}
			const payload = {
				pluginId: 'writing-dashboard',
				updatedAt: Date.now(),
				embeddingProfile: profile,
				preferredSharedIndexPath: 'Embeddings/shared-index/',
				// Source folders for StoryBoard discovery
				sources: {
					characterFolder: this.settings.characterFolder || 'Characters',
					worldFolder: this.settings.worldFolder || 'World',
					storyBiblePath: this.settings.storyBiblePath || 'Book - Story Bible.md',
					bookMainPath: this.settings.book2Path || 'Book-Main.md'
				}
			};
			await this.app.vault.adapter.write(handshakePath, JSON.stringify(payload, null, 2));
		} catch (err) {
			console.error('[WritingDashboard] Failed to write handshake:', err);
		}
	}

	onunload() {
		if (this.embeddingsIndex) {
			this.embeddingsIndex.onunload();
		}
		this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD).forEach((leaf) => leaf.detach());
	}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		const loaded = (await this.loadData()) || {};

		// Migration: Remove legacy relayFastModel
		if (loaded.relayFastModel) {
			console.debug('[WritingDashboard] Migrating to single-model mode: removing legacy relayFastModel setting.');
			delete loaded.relayFastModel;
			await this.saveData(loaded);
		}

		// Migration: Remove legacy local AI fields from saved data
		const legacyFields = ['ollamaBaseUrl', 'ramTier', 'riskProfile', 'contextSliderValue',
			'verifiedModelContextLimit', 'relaySmartModel', 'relayEmbeddingModel', 'relayMode'];
		let needsSave = false;
		for (const field of legacyFields) {
			if (field in loaded) {
				delete loaded[field];
				needsSave = true;
			}
		}
		if (needsSave) {
			await this.saveData(loaded);
		}

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
				characterExtractionChunkSize: 2500,
				defaultCharacterExtractionInstructions: '',
				characterExtractionBackend: 'cloud',
				worldFolder: 'World',
				guidedDemoDismissed: false,
				guidedDemoShownOnce: false,
				setupCompleted: false,
				retrievalProfiles: [],
				retrievalActiveProfileId: undefined,
				retrievalIncludedFolders: [],
				relayCloudModel: 'gpt-4o',
				relayMaxContextWindow: 128000,
				relayCostHardBudget: 1.0, // $1 max per run
				maxChunkWords: 2500,
				maxRepairAttempts: 1,
				retrievalTokenBudget: 3000,
				helpDensity: 'LITE',
				verifiedModelsCatalog: [],
				embeddingStorageMode: 'isolated',
				manualSharedPath: '',
			},
			loaded
		);

	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.notifyUi('writing-dashboard:settings-changed');
	}

	private notifyUi(eventName: string) {
		try {
			window.dispatchEvent(new CustomEvent(eventName));
		} catch (err) {
			console.debug('[WritingDashboard] UI event dispatch failed:', err);
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
			new ExternalEmbeddingsProvider(
				this,
				this.embeddingsIndex,
				() => Boolean(this.settings?.externalEmbeddingsEnabled ?? false),
				(path) => !this.vaultService.isExcludedPath(path)
			)
		];

		this.retrievalService = new RetrievalService(providers, {
			getVector: (key) => this.embeddingsIndex.getVectorForKey(key)
		});
	}
}
