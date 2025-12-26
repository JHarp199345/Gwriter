import { Notice, Plugin, TFile, TFolder } from 'obsidian';
import { DashboardView, VIEW_TYPE_DASHBOARD } from './ui/DashboardView';
import { SettingsTab } from './ui/SettingsTab';
import { VaultService } from './services/VaultService';
import { ContextAggregator } from './services/ContextAggregator';
import { PromptEngine } from './services/PromptEngine';
import { AIClient } from './services/AIClient';
import { CharacterExtractor } from './services/CharacterExtractor';
import { RetrievalService } from './services/RetrievalService';
import { QueryBuilder } from './services/QueryBuilder';
import { HeuristicProvider } from './services/retrieval/HeuristicProvider';
import { EmbeddingsIndex } from './services/retrieval/EmbeddingsIndex';
import { LocalEmbeddingsProvider } from './services/retrieval/LocalEmbeddingsProvider';
import { ExternalEmbeddingsProvider } from './services/retrieval/ExternalEmbeddingsProvider';
import { SmartConnectionsProvider } from './services/retrieval/SmartConnectionsProvider';
import { Bm25Index } from './services/retrieval/Bm25Index';
import { Bm25Provider } from './services/retrieval/Bm25Provider';
import { CpuReranker } from './services/retrieval/CpuReranker';
import { GenerationLogService } from './services/GenerationLogService';
import { SetupWizardModal } from './ui/SetupWizard';
import { BookMainSelectorModal } from './ui/BookMainSelectorModal';
import { PublishWizardModal } from './ui/PublishWizardModal';
import { TemplateProcessor } from './services/TemplateProcessor';

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
	/**
	 * Word count per chunk when running "Process Entire Book" character extraction.
	 */
	characterExtractionChunkSize: number;
	/**
	 * Optional: a specific markdown file to run bulk character extraction against.
	 * If unset, bulk processing uses `book2Path`.
	 */
	characterExtractionSourcePath?: string;
	/**
	 * Soft limit for estimated prompt tokens. Used to warn/confirm before sending requests.
	 * Defaults to 128k (common large-context tier).
	 */
	contextTokenLimit: number;
	/**
	 * Default instructions for Character Update -> "Update characters" (selected text) extraction.
	 * Used as a fallback if the per-run instructions box is empty/invalid.
	 */
	defaultCharacterExtractionInstructions: string;
	/**
	 * Whole-vault retrieval exclusions (folders). This is a living list: users can change it any time.
	 * `.obsidian/` is always excluded.
	 */
	retrievalExcludedFolders: string[];
	/**
	 * Enable the local semantic index used for retrieval. If disabled, retrieval falls back to heuristic only.
	 */
	retrievalEnableSemanticIndex: boolean;
	/**
	 * Maximum number of retrieved context items injected into prompts.
	 */
	retrievalTopK: number;
	/**
	 * Chunk size (words) for local semantic indexing.
	 */
	retrievalChunkWords: number;
	/**
	 * Chunk overlap (words) for local semantic indexing.
	 */
	retrievalChunkOverlapWords: number;
	/**
	 * Preferred markdown heading level used to chunk notes for retrieval indexing.
	 * Default is H1 to match common chapter-style notes.
	 */
	retrievalChunkHeadingLevel: 'h1' | 'h2' | 'h3' | 'none';
	/**
	 * If true, background indexing is paused.
	 */
	retrievalIndexPaused: boolean;
	/**
	 * Incremental semantic index state per file. Used to avoid re-indexing unchanged files.
	 */
	retrievalIndexState: Record<
		string,
		{
			hash: string;
			chunkCount: number;
			updatedAt: string;
		}
	>;
	/**
	 * Local embeddings backend for semantic retrieval.
	 * - hash: lightweight hashed bag-of-words (fast, reliable)
	 */
	retrievalEmbeddingBackend: 'hash';
	/**
	 * Enable BM25 lexical retrieval (recommended).
	 */
	retrievalEnableBm25: boolean;
	/**
	 * Enable CPU reranking (local). May add latency at Generate time.
	 */
	retrievalEnableReranker: boolean;
	/**
	 * Retrieval source: local (hash+BM25) or external embedding API (hybrid).
	 */
	retrievalSource: 'local' | 'external-api';
	/**
	 * Enable external embedding API for retrieval (default: false).
	 * When disabled, only local hash/BM25 embeddings are used.
	 */
	externalEmbeddingsEnabled?: boolean;
	/**
	 * External embedding API provider (OpenAI, Cohere, Google Gemini, or custom).
	 */
	externalEmbeddingProvider?: 'openai' | 'cohere' | 'google' | 'custom';
	/**
	 * API key for external embedding provider.
	 */
	externalEmbeddingApiKey?: string;
	/**
	 * Model name for external embedding provider (e.g., text-embedding-3-small, gemini-embedding-001).
	 */
	externalEmbeddingModel?: string;
	/**
	 * Custom API URL for external embedding provider (if using custom provider).
	 */
	externalEmbeddingApiUrl?: string;
	/**
	 * Use batch embeddings endpoint for Google Gemini (more efficient for multiple queries).
	 */
	externalEmbeddingUseBatch?: boolean;
	/**
	 * Folder for per-run generation logs.
	 */
	generationLogsFolder: string;
	/**
	 * If true, write per-run generation logs.
	 */
	generationLogsEnabled: boolean;
	/**
	 * If true, include the full final prompt text in generation logs.
	 */
	generationLogsIncludePrompt: boolean;
	/**
	 * Per-mode persisted form state so inputs do not bleed between modes.
	 */
	modeState: {
		chapter: {
			sceneSummary: string;
			rewriteInstructions: string;
			minWords: number;
			maxWords: number;
		};
		microEdit: {
			selectedPassage: string;
			grievances: string;
		};
		characterUpdate: {
			selectedText: string;
			extractionInstructions: string;
		};
		continuityCheck: {
			draftText: string;
			focus: {
				knowledge: boolean;
				timeline: boolean;
				pov: boolean;
				naming: boolean;
			};
		};
	};
	/**
	 * Smart Connections cache for captured results.
	 */
	smartConnectionsCache?: {
		sourceNotePath?: string; // Note path when captured
		vaultId?: string; // vaultName + (adapter.basePath || '')
		results: Array<{
			path: string;
			score?: number; // Rank-based: 1.0, 0.98, 0.96...
			capturedSnippet?: string; // Optional, for reference only
			capturedAt?: number; // Timestamp when captured
		}>;
		capturedAt: number; // Overall cache timestamp
		method: 'dom' | 'clipboard';
		sessionId: string; // Capture session ID for log grouping
	};
	/**
	 * Enable Smart Connections cache for retrieval.
	 */
	smartConnectionsCacheEnabled?: boolean;
	/**
	 * Cache TTL in hours (optional, default: no expiry).
	 */
	smartConnectionsCacheTTL?: number;
	/**
	 * Allowed folders for Smart Connections cache (empty = all allowed).
	 */
	smartConnectionsAllowedFolders?: string[];
	/**
	 * Blocked folders for Smart Connections cache.
	 */
	smartConnectionsBlockedFolders?: string[];
	/**
	 * Max files to capture in Smart Connections cache (default: 200).
	 */
	smartConnectionsMaxCaptureFiles?: number;
	/**
	 * Max files to score per query in Smart Connections cache (default: 50).
	 */
	smartConnectionsMaxScoreFiles?: number;
	/**
	 * Max total context chars for Smart Connections excerpts (default: 30000).
	 */
	smartConnectionsMaxContextChars?: number;
	/**
	 * Keying mode: strict (only use cache if source note matches) or soft (prefer match, allow override).
	 */
	smartConnectionsKeyingMode?: 'strict' | 'soft';
	/**
	 * Path to Smart Connections template file.
	 * Template should contain {{smart-connections:similar:128}} to surface semantic matches.
	 * If not set, Smart Connections template integration is disabled.
	 */
	smartConnectionsTemplatePath?: string;
	/**
	 * Folder-based retrieval profiles (safety rails).
	 * The active profile controls which folders are included for retrieval/indexing.
	 */
	retrievalProfiles: Array<{ id: string; name: string; includedFolders: string[] }>;
	retrievalActiveProfileId: string;
	setupCompleted: boolean;
	/**
	 * If true, do not auto-start the guided demo for first-time users.
	 * Users can still run the demo manually from settings or the command palette.
	 */
	guidedDemoDismissed: boolean;
	/**
	 * Tracks whether the guided demo has been shown/started at least once for this vault.
	 * Used to auto-start the demo exactly once (unless dismissed).
	 */
	guidedDemoShownOnce: boolean;
	fileState: Record<
		string,
		{
			lastChunkHash?: string;
			lastChunkedAt?: string;
			lastChunkCount?: number;
			lastProcessHash?: string;
			lastProcessedAt?: string;
			/**
			 * Persisted state for bulk character extraction so we can retry only failed chapters
			 * (without restarting the whole job) as long as the book hash is unchanged.
			 */
			bulkProcessMeta?: {
				hash: string;
				rosterText?: string;
				failedChapterIndices?: number[];
			};
		}
	>;
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
	characterFolder: '',
	book2Path: 'Book-Main.md',
	storyBiblePath: 'Book - Story Bible.md',
	characterExtractionChunkSize: 2500,
	contextTokenLimit: 128000,
	defaultCharacterExtractionInstructions:
		`[CHARACTER UPDATE INSTRUCTIONS]\n` +
		`Goal: Update character notes from the provided passage only. Maintain canon from the story bible and existing character notes. Do not invent facts.\n\n` +
		`Focus on:\n` +
		`- Psychological/emotional reactions and development\n` +
		`- Motivations, fears, desires, internal conflicts\n` +
		`- Relationship dynamics and shifts\n` +
		`- Voice patterns, verbal tells, coping behaviors\n` +
		`- Arc progression and status changes\n\n` +
		`Rules:\n` +
		`- Evidence-based only: if it is not supported by the passage, omit it\n` +
		`- If uncertain, omit it\n` +
		`- Prefer concrete observations over summaries\n` +
		`- If no meaningful new info exists for a character, omit that character\n\n` +
		`Output format (required):\n` +
		`## Character Name\n` +
		`- Bullet updates only (no extra headings)\n`,
	retrievalExcludedFolders: ['Templates'],
	retrievalEnableSemanticIndex: true,
	retrievalTopK: 24,
	retrievalChunkWords: 500,
	retrievalChunkOverlapWords: 100,
	retrievalChunkHeadingLevel: 'h1',
	retrievalIndexPaused: false,
	retrievalIndexState: {},
	retrievalEmbeddingBackend: 'hash',
	retrievalEnableBm25: true,
	retrievalEnableReranker: false,
	retrievalSource: 'local',
	externalEmbeddingsEnabled: false, // Default: disabled to prevent accidental API usage
	externalEmbeddingProvider: undefined,
	externalEmbeddingApiKey: undefined,
	externalEmbeddingModel: undefined,
	externalEmbeddingApiUrl: undefined,
	externalEmbeddingUseBatch: false,
	generationLogsFolder: '',
	generationLogsEnabled: false,
	generationLogsIncludePrompt: false,
	modeState: {
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
			extractionInstructions: ''
		},
		continuityCheck: {
			draftText: '',
			focus: { knowledge: true, timeline: true, pov: true, naming: true }
		}
	},
	retrievalProfiles: [],
	retrievalActiveProfileId: 'story',
	setupCompleted: false,
	guidedDemoDismissed: false,
	guidedDemoShownOnce: false,
	fileState: {},
	smartConnectionsCacheEnabled: false,
	smartConnectionsCacheTTL: undefined,
	smartConnectionsAllowedFolders: [],
	smartConnectionsBlockedFolders: [],
	smartConnectionsMaxCaptureFiles: 200,
	smartConnectionsMaxScoreFiles: 50,
	smartConnectionsMaxContextChars: 30000,
	smartConnectionsKeyingMode: 'soft',
	smartConnectionsTemplatePath: undefined // User must configure template
};

export default class WritingDashboardPlugin extends Plugin {
	settings: DashboardSettings;
	vaultService: VaultService;
	contextAggregator: ContextAggregator;
	promptEngine: PromptEngine;
	aiClient: AIClient;
	characterExtractor: CharacterExtractor;
	queryBuilder: QueryBuilder;
	retrievalService: RetrievalService;
	smartConnectionsProvider?: import('./services/retrieval/SmartConnectionsProvider').SmartConnectionsProvider;
	embeddingsIndex: EmbeddingsIndex;
	bm25Index: Bm25Index;
	cpuReranker: CpuReranker;
	generationLogService: GenerationLogService;
	templateProcessorInstance?: TemplateProcessor;
	/**
	 * When true, the next time the dashboard UI mounts it will start the guided demo flow.
	 * This avoids wiring additional cross-component state management.
	 */
	guidedDemoStartRequested = false;

	private notifyUi(eventName: string) {
		try {
			window.dispatchEvent(new CustomEvent(eventName));
		} catch {
			// ignore
		}
	}
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

		// Track renames so settings don't break if the user renames their manuscript
		this.registerEvent(
			this.app.vault.on('rename', async (file, oldPath) => {
				const oldNorm = oldPath.replace(/\\/g, '/');
				const newNorm = file.path.replace(/\\/g, '/');
				let changed = false;

				// Track managed folder renames (generation logs).
				const logsFolder = (this.settings.generationLogsFolder || '').replace(/\\/g, '/').replace(/\/+$/, '');
				if (logsFolder && file instanceof TFolder && oldNorm === logsFolder) {
					this.settings.generationLogsFolder = newNorm;
					changed = true;
				}

				if (!(file instanceof TFile) || file.extension !== 'md') {
					if (changed) await this.saveSettings();
					return;
				}

				// Update current-note tracker
				if (this.lastOpenedMarkdownPath === oldPath) {
					this.lastOpenedMarkdownPath = file.path;
					changed = true;
				}

				// Update Book Main Path if it was renamed
				if (this.settings.book2Path === oldPath) {
					this.settings.book2Path = file.path;
					changed = true;
				}

				// Migrate per-file state (hashes/timestamps) if present
				if (this.settings.fileState?.[oldPath]) {
					this.settings.fileState[file.path] = {
						...(this.settings.fileState[file.path] || {}),
						...this.settings.fileState[oldPath]
					};
					delete this.settings.fileState[oldPath];
					changed = true;
				}

				if (changed) await this.saveSettings();
			})
		);
		
		// Set vault path if not set
		if (!this.settings.vaultPath) {
			// @ts-expect-error Obsidian adapter types do not expose `basePath`, but desktop adapters provide it.
			this.settings.vaultPath = this.app.vault.adapter.basePath || '';
			await this.saveSettings();
		}
		
		this.vaultService = new VaultService(this.app.vault, this);
		
		// Delay hook registration until after all plugins are loaded
		// This prevents breaking other plugins during initialization
		this.app.workspace.onLayoutReady(() => {
			// Wait additional time for plugins to fully initialize
			setTimeout(() => {
				this.templateProcessorInstance = new TemplateProcessor(this.app, this);
				console.log('[WritingDashboard] ✅ TemplateProcessor initialized after plugin system');
			}, 2000); // 2 second delay for plugin initialization
		});
		
		this.contextAggregator = new ContextAggregator(this.app.vault, this, this.vaultService);
		this.promptEngine = new PromptEngine();
		this.aiClient = new AIClient();
		this.characterExtractor = new CharacterExtractor();

		// Retrieval / local indexing
		this.queryBuilder = new QueryBuilder();
		this.embeddingsIndex = new EmbeddingsIndex(this.app.vault, this);
		this.bm25Index = new Bm25Index(this.app.vault, this);
		this.cpuReranker = new CpuReranker();
		this.generationLogService = new GenerationLogService(this.app, this);
		// Note: Folder validation happens when logs are enabled via settings toggle
		const scProvider = new SmartConnectionsProvider(this.app, this, this.app.vault, (path) => !this.vaultService.isExcludedPath(path));
		this.smartConnectionsProvider = scProvider;
		
		const providers: Array<import('./services/retrieval/types').RetrievalProvider> = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new Bm25Provider(this.bm25Index, () => Boolean(this.settings.retrievalEnableBm25), (path) => !this.vaultService.isExcludedPath(path)),
			scProvider
		];
		
		// Only add ExternalEmbeddingsProvider if explicitly enabled
		if (this.settings.externalEmbeddingsEnabled && 
			this.settings.externalEmbeddingProvider && 
			this.settings.externalEmbeddingApiKey) {
			providers.push(
				new ExternalEmbeddingsProvider(
					this,
					this.embeddingsIndex,
					this.bm25Index,
					() => Boolean(this.settings.externalEmbeddingsEnabled && 
								this.settings.externalEmbeddingProvider && 
								this.settings.externalEmbeddingApiKey),
					(path) => !this.vaultService.isExcludedPath(path)
				)
			);
		} else {
			// Use local embeddings (hash)
			providers.push(
				new LocalEmbeddingsProvider(
					this.embeddingsIndex,
					() => Boolean(this.settings.retrievalEnableSemanticIndex),
					(path) => !this.vaultService.isExcludedPath(path)
				)
			);
		}
		
		this.retrievalService = new RetrievalService(providers, { getVector: (key) => this.embeddingsIndex.getVectorForKey(key) });

		// Background indexing hooks (best-effort; always safe to fail).
		const maybeQueueIndex = (path: string) => {
			if (this.settings.retrievalIndexPaused) return;
			if (this.vaultService.isExcludedPath(path)) return;
			if (this.settings.retrievalEnableSemanticIndex) this.embeddingsIndex.queueUpdateFile(path);
			if (this.settings.retrievalEnableBm25) this.bm25Index.queueUpdateFile(path);
		};

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					maybeQueueIndex(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					maybeQueueIndex(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.embeddingsIndex.queueRemoveFile(file.path);
					this.bm25Index.queueRemoveFile(file.path);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				this.embeddingsIndex.queueRemoveFile(oldPath);
				this.bm25Index.queueRemoveFile(oldPath);
				maybeQueueIndex(file.path);
			})
		);

		// Initial best-effort scan.
		if (this.settings.retrievalEnableSemanticIndex && !this.settings.retrievalIndexPaused) {
			this.embeddingsIndex.enqueueFullRescan();
		}
		if (this.settings.retrievalEnableBm25 && !this.settings.retrievalIndexPaused) {
			this.bm25Index.enqueueFullRescan();
		}
		
		this.registerView(
			VIEW_TYPE_DASHBOARD,
			(leaf) => new DashboardView(leaf, this)
		);
		
		this.addRibbonIcon('book-open', 'Open dashboard', () => {
			// Avoid floating promise (activateView is async)
			void this.activateView();
		});
		
		this.addSettingTab(new SettingsTab(this.app, this));
		
		this.addCommand({
			id: 'open-dashboard',
			name: 'Open dashboard',
			callback: () => {
				// Avoid floating promise (activateView is async)
				void this.activateView();
			}
		});

		this.addCommand({
			id: 'run-setup-wizard',
			name: 'Run setup wizard',
			callback: () => {
				this.showSetupWizard();
			}
		});

		this.addCommand({
			id: 'run-guided-demo',
			name: 'Run guided demo',
			callback: () => {
				this.requestGuidedDemoStart();
			}
		});

		this.addCommand({
			id: 'export-to-epub',
			name: 'Export to epub',
			callback: () => {
				this.showPublishWizard();
			}
		});

		// Check for first-run setup
		if (!this.settings.setupCompleted) {
			// Treat setup as complete if the configured Book Main Path exists
			const bookMainExists = this.app.vault.getAbstractFileByPath(this.settings.book2Path) !== null;
			if (!bookMainExists) {
				// If vault appears populated, ask user which file is the main book file
				const mdFiles = this.app.vault.getMarkdownFiles();
				if (mdFiles.length > 0) {
					const modal = new BookMainSelectorModal(this);
					modal.open();
				} else {
				// Show setup wizard automatically on first run
				this.showSetupWizard();
				}
			} else {
				// Book file exists, mark setup as completed
				this.settings.setupCompleted = true;
				await this.saveSettings();
			}
		}
	}

	showSetupWizard() {
		const modal = new SetupWizardModal(this);
		modal.open();
	}

	showPublishWizard() {
		const modal = new PublishWizardModal(this);
		modal.open();
	}

	/**
	 * Recreate the retrieval service with the current settings.
	 * Called when retrievalSource or other retrieval settings change.
	 */
	recreateRetrievalService(): void {
		const scProvider = new SmartConnectionsProvider(this.app, this, this.app.vault, (path) => !this.vaultService.isExcludedPath(path));
		this.smartConnectionsProvider = scProvider;
		
		const providers: Array<import('./services/retrieval/types').RetrievalProvider> = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new Bm25Provider(this.bm25Index, () => Boolean(this.settings.retrievalEnableBm25), (path) => !this.vaultService.isExcludedPath(path)),
			scProvider
		];
		
		// Only add ExternalEmbeddingsProvider if explicitly enabled
		if (this.settings.externalEmbeddingsEnabled && 
			this.settings.externalEmbeddingProvider && 
			this.settings.externalEmbeddingApiKey) {
			providers.push(
				new ExternalEmbeddingsProvider(
					this,
					this.embeddingsIndex,
					this.bm25Index,
					() => Boolean(this.settings.externalEmbeddingsEnabled && 
								this.settings.externalEmbeddingProvider && 
								this.settings.externalEmbeddingApiKey),
					(path) => !this.vaultService.isExcludedPath(path)
				)
			);
		}
		
		if (this.settings.retrievalSource === 'external-api') {
			// This branch is now handled above - keeping for backward compatibility
		} else {
			providers.push(
				new LocalEmbeddingsProvider(
					this.embeddingsIndex,
					() => Boolean(this.settings.retrievalEnableSemanticIndex),
					(path) => !this.vaultService.isExcludedPath(path)
				)
			);
		}
		
		this.retrievalService = new RetrievalService(providers, { getVector: (key) => this.embeddingsIndex.getVectorForKey(key) });
	}


	requestGuidedDemoStart() {
		this.guidedDemoStartRequested = true;
		this.notifyUi('writing-dashboard:guided-demo-start');
		void this.activateView();
	}

	async onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<DashboardSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});

		// Migrations / defaults for new settings
		if (!this.settings.modeState) {
			this.settings.modeState = DEFAULT_SETTINGS.modeState;
		} else {
			// Fill missing subkeys (non-destructive)
			this.settings.modeState = {
				...DEFAULT_SETTINGS.modeState,
				...this.settings.modeState,
				chapter: { ...DEFAULT_SETTINGS.modeState.chapter, ...(this.settings.modeState.chapter || {}) },
				microEdit: { ...DEFAULT_SETTINGS.modeState.microEdit, ...(this.settings.modeState.microEdit || {}) },
				characterUpdate: { ...DEFAULT_SETTINGS.modeState.characterUpdate, ...(this.settings.modeState.characterUpdate || {}) },
				continuityCheck: {
					...DEFAULT_SETTINGS.modeState.continuityCheck,
					...(this.settings.modeState.continuityCheck || {}),
					focus: {
						...DEFAULT_SETTINGS.modeState.continuityCheck.focus,
						...((this.settings.modeState.continuityCheck || {}).focus || {})
					}
				}
			};
		}

		// Retrieval profiles: ensure prebuilt profiles exist.
		if (!Array.isArray(this.settings.retrievalProfiles) || this.settings.retrievalProfiles.length === 0) {
			const parentOf = (p: string) => {
				const norm = (p || '').replace(/\\/g, '/');
				const idx = norm.lastIndexOf('/');
				return idx >= 0 ? norm.slice(0, idx) : '';
			};
			
			// Build storyIncluded from existing folders, but default to empty array (whole vault)
			const storyFolders = new Set<string>();
			if (this.settings.characterFolder) storyFolders.add(this.settings.characterFolder);
			const bookParent = parentOf(this.settings.book2Path);
			if (bookParent) storyFolders.add(bookParent);
			const bibleParent = parentOf(this.settings.storyBiblePath);
			if (bibleParent) storyFolders.add(bibleParent);
			// Remove empty entries
			const storyIncluded = Array.from(storyFolders).map((s) => (s || '').replace(/\/+$/, '')).filter((s) => s.length > 0);

			// Default "Story" profile: empty array means "include whole vault"
			// Users can selectively include folders if they want to limit scope
			this.settings.retrievalProfiles = [
				{ id: 'story', name: 'Story', includedFolders: storyIncluded.length > 0 ? storyIncluded : [] },
				{ id: 'research', name: 'Research', includedFolders: ['Research', 'Worldbuilding'] },
				{ id: 'manuscript', name: 'Manuscript only', includedFolders: bookParent ? [bookParent] : [] }
			];
			this.settings.retrievalActiveProfileId = 'story';
		}

		const hasActive = this.settings.retrievalProfiles.some((p) => p.id === this.settings.retrievalActiveProfileId);
		if (!hasActive) this.settings.retrievalActiveProfileId = this.settings.retrievalProfiles[0]?.id || 'story';
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.notifyUi('writing-dashboard:settings-changed');
	}

	/**
	 * Auto-generate Smart Connections template file if it doesn't exist.
	 * Creates the template in a visible root-level folder.
	 * Returns the path to the template file.
	 */
	async ensureSmartConnectionsTemplate(): Promise<string> {
		// Use a visible folder at root level - no dot prefix, obviously apparent
		const templatesFolder = 'Writing Dashboard Templates';
		
		// Create folder if it doesn't exist
		await this.vaultService.createFolderIfNotExists(templatesFolder);
		
		// Template file path
		const templatePath = `${templatesFolder}/SC-Template.md`;
		const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
		
		if (!(templateFile instanceof TFile)) {
			// Create template file with Smart Connections syntax
			const templateContent = '{{smart-connections:similar:128}}';
			await this.vaultService.writeFile(templatePath, templateContent);
			
			// Auto-configure the path in settings
			this.settings.smartConnectionsTemplatePath = templatePath;
			await this.saveSettings();
		}
		
		return templatePath;
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

