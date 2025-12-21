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
import { HeuristicProvider } from './services/retrieval/HeuristicProvider';
import { EmbeddingsIndex } from './services/retrieval/EmbeddingsIndex';
import { LocalEmbeddingsProvider } from './services/retrieval/LocalEmbeddingsProvider';
import { SetupWizardModal } from './ui/SetupWizard';
import { BookMainSelectorModal } from './ui/BookMainSelectorModal';
import { PublishWizardModal } from './ui/PublishWizardModal';

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
	/**
	 * Word count per chunk when running "Process Entire Book" character extraction.
	 * (Chunking for Smart Connections/reference folders is separate.)
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
	 * - hash: lightweight hashed bag-of-words (fast, lower quality)
	 * - minilm: true local embeddings (higher quality; may be slower)
	 */
	retrievalEmbeddingBackend: 'hash' | 'minilm';
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
	characterFolder: 'Characters',
	book2Path: 'Book-Main.md',
	storyBiblePath: 'Book - Story Bible.md',
	extractionsPath: 'Extractions.md',
	slidingWindowPath: 'Memory - Sliding Window.md',
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
	retrievalIndexPaused: false,
	retrievalIndexState: {},
	retrievalEmbeddingBackend: 'minilm',
	setupCompleted: false,
	guidedDemoDismissed: false,
	guidedDemoShownOnce: false,
	fileState: {}
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
	embeddingsIndex: EmbeddingsIndex;
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
				if (!(file instanceof TFile) || file.extension !== 'md') return;

				// Update current-note tracker
				if (this.lastOpenedMarkdownPath === oldPath) {
					this.lastOpenedMarkdownPath = file.path;
				}

				// Update Book Main Path if it was renamed
				if (this.settings.book2Path === oldPath) {
					this.settings.book2Path = file.path;
				}

				// Migrate per-file state (hashes/timestamps) if present
				if (this.settings.fileState?.[oldPath]) {
					this.settings.fileState[file.path] = {
						...(this.settings.fileState[file.path] || {}),
						...this.settings.fileState[oldPath]
					};
					delete this.settings.fileState[oldPath];
				}

				await this.saveSettings();
			})
		);
		
		// Set vault path if not set
		if (!this.settings.vaultPath) {
			// @ts-expect-error Obsidian adapter types do not expose `basePath`, but desktop adapters provide it.
			this.settings.vaultPath = this.app.vault.adapter.basePath || '';
			await this.saveSettings();
		}
		
		this.vaultService = new VaultService(this.app.vault, this);
		this.contextAggregator = new ContextAggregator(this.app.vault, this);
		this.promptEngine = new PromptEngine();
		this.aiClient = new AIClient();
		this.characterExtractor = new CharacterExtractor();

		// Retrieval / local indexing
		this.queryBuilder = new QueryBuilder();
		this.embeddingsIndex = new EmbeddingsIndex(this.app.vault, this);
		const providers = [
			new HeuristicProvider(this.app.vault, this.vaultService),
			new LocalEmbeddingsProvider(
				this.embeddingsIndex,
				() => Boolean(this.settings.retrievalEnableSemanticIndex),
				(path) => !this.vaultService.isExcludedPath(path)
			)
		];
		this.retrievalService = new RetrievalService(providers);

		// Background indexing hooks (best-effort; always safe to fail).
		const maybeQueueIndex = (path: string) => {
			if (!this.settings.retrievalEnableSemanticIndex) return;
			if (this.settings.retrievalIndexPaused) return;
			if (this.vaultService.isExcludedPath(path)) return;
			this.embeddingsIndex.queueUpdateFile(path);
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
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (!(file instanceof TFile) || file.extension !== 'md') return;
				this.embeddingsIndex.queueRemoveFile(oldPath);
				maybeQueueIndex(file.path);
			})
		);

		// Initial best-effort scan.
		if (this.settings.retrievalEnableSemanticIndex && !this.settings.retrievalIndexPaused) {
			this.embeddingsIndex.enqueueFullRescan();
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
					const modal = new BookMainSelectorModal(this, mdFiles);
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

	requestGuidedDemoStart() {
		this.guidedDemoStartRequested = true;
		this.notifyUi('writing-dashboard:guided-demo-start');
		void this.activateView();
	}

	async onunload() {
		// Cleanup if needed
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.notifyUi('writing-dashboard:settings-changed');
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

