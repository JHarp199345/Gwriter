import { Plugin, TFile, TFolder } from 'obsidian';
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
const DEFAULT_SETTINGS = {
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
    defaultCharacterExtractionInstructions: `[CHARACTER UPDATE INSTRUCTIONS]\n` +
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
    constructor() {
        super(...arguments);
        /**
         * When true, the next time the dashboard UI mounts it will start the guided demo flow.
         * This avoids wiring additional cross-component state management.
         */
        this.guidedDemoStartRequested = false;
        /**
         * Tracks the last markdown file the user opened in Obsidian.
         * Used for actions like "Chunk Selected File" so users don't need to keep updating settings.
         */
        this.lastOpenedMarkdownPath = null;
    }
    notifyUi(eventName) {
        try {
            window.dispatchEvent(new CustomEvent(eventName));
        }
        catch {
            // ignore
        }
    }
    async onload() {
        await this.loadSettings();
        // Track the last opened markdown file (the "current note" the user is working on)
        this.registerEvent(this.app.workspace.on('file-open', (file) => {
            if (file && file.extension === 'md') {
                this.lastOpenedMarkdownPath = file.path;
            }
        }));
        // Track renames so settings don't break if the user renames their manuscript
        this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
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
                if (changed)
                    await this.saveSettings();
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
            if (changed)
                await this.saveSettings();
        }));
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
        const providers = [
            new HeuristicProvider(this.app.vault, this.vaultService),
            new Bm25Provider(this.bm25Index, () => Boolean(this.settings.retrievalEnableBm25), (path) => !this.vaultService.isExcludedPath(path)),
            scProvider
        ];
        // Only add ExternalEmbeddingsProvider if explicitly enabled
        if (this.settings.externalEmbeddingsEnabled &&
            this.settings.externalEmbeddingProvider &&
            this.settings.externalEmbeddingApiKey) {
            providers.push(new ExternalEmbeddingsProvider(this, this.embeddingsIndex, this.bm25Index, () => Boolean(this.settings.externalEmbeddingsEnabled &&
                this.settings.externalEmbeddingProvider &&
                this.settings.externalEmbeddingApiKey), (path) => !this.vaultService.isExcludedPath(path)));
        }
        else {
            // Use local embeddings (hash)
            providers.push(new LocalEmbeddingsProvider(this.embeddingsIndex, () => Boolean(this.settings.retrievalEnableSemanticIndex), (path) => !this.vaultService.isExcludedPath(path)));
        }
        this.retrievalService = new RetrievalService(providers, { getVector: (key) => this.embeddingsIndex.getVectorForKey(key) });
        // Background indexing hooks (best-effort; always safe to fail).
        const maybeQueueIndex = (path) => {
            if (this.settings.retrievalIndexPaused)
                return;
            if (this.vaultService.isExcludedPath(path))
                return;
            if (this.settings.retrievalEnableSemanticIndex)
                this.embeddingsIndex.queueUpdateFile(path);
            if (this.settings.retrievalEnableBm25)
                this.bm25Index.queueUpdateFile(path);
        };
        this.registerEvent(this.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                maybeQueueIndex(file.path);
            }
        }));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                maybeQueueIndex(file.path);
            }
        }));
        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.embeddingsIndex.queueRemoveFile(file.path);
                this.bm25Index.queueRemoveFile(file.path);
            }
        }));
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!(file instanceof TFile) || file.extension !== 'md')
                return;
            this.embeddingsIndex.queueRemoveFile(oldPath);
            this.bm25Index.queueRemoveFile(oldPath);
            maybeQueueIndex(file.path);
        }));
        // Initial best-effort scan.
        if (this.settings.retrievalEnableSemanticIndex && !this.settings.retrievalIndexPaused) {
            this.embeddingsIndex.enqueueFullRescan();
        }
        if (this.settings.retrievalEnableBm25 && !this.settings.retrievalIndexPaused) {
            this.bm25Index.enqueueFullRescan();
        }
        this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(leaf, this));
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
                }
                else {
                    // Show setup wizard automatically on first run
                    this.showSetupWizard();
                }
            }
            else {
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
    recreateRetrievalService() {
        const scProvider = new SmartConnectionsProvider(this.app, this, this.app.vault, (path) => !this.vaultService.isExcludedPath(path));
        this.smartConnectionsProvider = scProvider;
        const providers = [
            new HeuristicProvider(this.app.vault, this.vaultService),
            new Bm25Provider(this.bm25Index, () => Boolean(this.settings.retrievalEnableBm25), (path) => !this.vaultService.isExcludedPath(path)),
            scProvider
        ];
        // Only add ExternalEmbeddingsProvider if explicitly enabled
        if (this.settings.externalEmbeddingsEnabled &&
            this.settings.externalEmbeddingProvider &&
            this.settings.externalEmbeddingApiKey) {
            providers.push(new ExternalEmbeddingsProvider(this, this.embeddingsIndex, this.bm25Index, () => Boolean(this.settings.externalEmbeddingsEnabled &&
                this.settings.externalEmbeddingProvider &&
                this.settings.externalEmbeddingApiKey), (path) => !this.vaultService.isExcludedPath(path)));
        }
        if (this.settings.retrievalSource === 'external-api') {
            // This branch is now handled above - keeping for backward compatibility
        }
        else {
            providers.push(new LocalEmbeddingsProvider(this.embeddingsIndex, () => Boolean(this.settings.retrievalEnableSemanticIndex), (path) => !this.vaultService.isExcludedPath(path)));
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
        const loaded = (await this.loadData());
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
        // Migrations / defaults for new settings
        if (!this.settings.modeState) {
            this.settings.modeState = DEFAULT_SETTINGS.modeState;
        }
        else {
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
            const parentOf = (p) => {
                const norm = (p || '').replace(/\\/g, '/');
                const idx = norm.lastIndexOf('/');
                return idx >= 0 ? norm.slice(0, idx) : '';
            };
            // Build storyIncluded from existing folders, but default to empty array (whole vault)
            const storyFolders = new Set();
            if (this.settings.characterFolder)
                storyFolders.add(this.settings.characterFolder);
            const bookParent = parentOf(this.settings.book2Path);
            if (bookParent)
                storyFolders.add(bookParent);
            const bibleParent = parentOf(this.settings.storyBiblePath);
            if (bibleParent)
                storyFolders.add(bibleParent);
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
        if (!hasActive)
            this.settings.retrievalActiveProfileId = this.settings.retrievalProfiles[0]?.id || 'story';
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
    async ensureSmartConnectionsTemplate() {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1haW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFVLE1BQU0sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQzFELE9BQU8sRUFBRSxhQUFhLEVBQUUsbUJBQW1CLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUN4RSxPQUFPLEVBQUUsV0FBVyxFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDL0MsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBQ2pFLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSx5QkFBeUIsQ0FBQztBQUN2RCxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDL0MsT0FBTyxFQUFFLGtCQUFrQixFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDbkUsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFDL0QsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQ3ZELE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLHdDQUF3QyxDQUFDO0FBQzNFLE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxzQ0FBc0MsQ0FBQztBQUN2RSxPQUFPLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSw4Q0FBOEMsQ0FBQztBQUN2RixPQUFPLEVBQUUsMEJBQTBCLEVBQUUsTUFBTSxpREFBaUQsQ0FBQztBQUM3RixPQUFPLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSwrQ0FBK0MsQ0FBQztBQUN6RixPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sZ0NBQWdDLENBQUM7QUFDM0QsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLG1DQUFtQyxDQUFDO0FBQ2pFLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBTSxrQ0FB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ZXIgfSBmcm9tICdvYnNpZGlhbic7XG5pbXBvcnQgeyBEYXNoYm9hcmRWaWV3LCBWSUVXX1RZUEVfREFTSEJPQVJEIH0gZnJvbSAnLi91aS9EYXNoYm9hcmRWaWV3JztcbmltcG9ydCB7IFNldHRpbmdzVGFiIH0gZnJvbSAnLi91aS9TZXR0aW5nc1RhYic7XG5pbXBvcnQgeyBWYXVsdFNlcnZpY2UgfSBmcm9tICcuL3NlcnZpY2VzL1ZhdWx0U2VydmljZSc7XG5pbXBvcnQgeyBDb250ZXh0QWdncmVnYXRvciB9IGZyb20gJy4vc2VydmljZXMvQ29udGV4dEFnZ3JlZ2F0b3InO1xuaW1wb3J0IHsgUHJvbXB0RW5naW5lIH0gZnJvbSAnLi9zZXJ2aWNlcy9Qcm9tcHRFbmdpbmUnO1xuaW1wb3J0IHsgQUlDbGllbnQgfSBmcm9tICcuL3NlcnZpY2VzL0FJQ2xpZW50JztcbmltcG9ydCB7IENoYXJhY3RlckV4dHJhY3RvciB9IGZyb20gJy4vc2VydmljZXMvQ2hhcmFjdGVyRXh0cmFjdG9yJztcbmltcG9ydCB7IFJldHJpZXZhbFNlcnZpY2UgfSBmcm9tICcuL3NlcnZpY2VzL1JldHJpZXZhbFNlcnZpY2UnO1xuaW1wb3J0IHsgUXVlcnlCdWlsZGVyIH0gZnJvbSAnLi9zZXJ2aWNlcy9RdWVyeUJ1aWxkZXInO1xuaW1wb3J0IHsgSGV1cmlzdGljUHJvdmlkZXIgfSBmcm9tICcuL3NlcnZpY2VzL3JldHJpZXZhbC9IZXVyaXN0aWNQcm92aWRlcic7XG5pbXBvcnQgeyBFbWJlZGRpbmdzSW5kZXggfSBmcm9tICcuL3NlcnZpY2VzL3JldHJpZXZhbC9FbWJlZGRpbmdzSW5kZXgnO1xuaW1wb3J0IHsgTG9jYWxFbWJlZGRpbmdzUHJvdmlkZXIgfSBmcm9tICcuL3NlcnZpY2VzL3JldHJpZXZhbC9Mb2NhbEVtYmVkZGluZ3NQcm92aWRlcic7XG5pbXBvcnQgeyBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlciB9IGZyb20gJy4vc2VydmljZXMvcmV0cmlldmFsL0V4dGVybmFsRW1iZWRkaW5nc1Byb3ZpZGVyJztcbmltcG9ydCB7IFNtYXJ0Q29ubmVjdGlvbnNQcm92aWRlciB9IGZyb20gJy4vc2VydmljZXMvcmV0cmlldmFsL1NtYXJ0Q29ubmVjdGlvbnNQcm92aWRlcic7XG5pbXBvcnQgeyBCbTI1SW5kZXggfSBmcm9tICcuL3NlcnZpY2VzL3JldHJpZXZhbC9CbTI1SW5kZXgnO1xuaW1wb3J0IHsgQm0yNVByb3ZpZGVyIH0gZnJvbSAnLi9zZXJ2aWNlcy9yZXRyaWV2YWwvQm0yNVByb3ZpZGVyJztcbmltcG9ydCB7IENwdVJlcmFua2VyIH0gZnJvbSAnLi9zZXJ2aWNlcy9yZXRyaWV2YWwvQ3B1UmVyYW5rZXInO1xuaW1wb3J0IHsgR2VuZXJhdGlvbkxvZ1NlcnZpY2UgfSBmcm9tICcuL3NlcnZpY2VzL0dlbmVyYXRpb25Mb2dTZXJ2aWNlJztcbmltcG9ydCB7IFNldHVwV2l6YXJkTW9kYWwgfSBmcm9tICcuL3VpL1NldHVwV2l6YXJkJztcbmltcG9ydCB7IEJvb2tNYWluU2VsZWN0b3JNb2RhbCB9IGZyb20gJy4vdWkvQm9va01haW5TZWxlY3Rvck1vZGFsJztcbmltcG9ydCB7IFB1Ymxpc2hXaXphcmRNb2RhbCB9IGZyb20gJy4vdWkvUHVibGlzaFdpemFyZE1vZGFsJztcbmltcG9ydCB7IFRlbXBsYXRlUHJvY2Vzc29yIH0gZnJvbSAnLi9zZXJ2aWNlcy9UZW1wbGF0ZVByb2Nlc3Nvcic7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGFzaGJvYXJkU2V0dGluZ3Mge1xuXHRhcGlLZXk6IHN0cmluZztcblx0YXBpUHJvdmlkZXI6ICdvcGVuYWknIHwgJ2FudGhyb3BpYycgfCAnZ2VtaW5pJyB8ICdvcGVucm91dGVyJztcblx0bW9kZWw6IHN0cmluZztcblx0Z2VuZXJhdGlvbk1vZGU6ICdzaW5nbGUnIHwgJ211bHRpJztcblx0bXVsdGlTdHJhdGVneTogJ2RyYWZ0LXJldmlzaW9uJyB8ICdjb25zZW5zdXMtbXVsdGlzdGFnZSc7XG5cdGRyYWZ0TW9kZWw/OiBzdHJpbmc7XG5cdHJldmlzaW9uTW9kZWw/OiBzdHJpbmc7XG5cdGNvbnNlbnN1c01vZGVsMT86IHN0cmluZztcblx0Y29uc2Vuc3VzTW9kZWwyPzogc3RyaW5nO1xuXHRjb25zZW5zdXNNb2RlbDM/OiBzdHJpbmc7XG5cdHN5bnRoZXNpc01vZGVsPzogc3RyaW5nO1xuXHR2YXVsdFBhdGg6IHN0cmluZztcblx0Y2hhcmFjdGVyRm9sZGVyOiBzdHJpbmc7XG5cdGJvb2syUGF0aDogc3RyaW5nO1xuXHRzdG9yeUJpYmxlUGF0aDogc3RyaW5nO1xuXHQvKipcblx0ICogV29yZCBjb3VudCBwZXIgY2h1bmsgd2hlbiBydW5uaW5nIFwiUHJvY2VzcyBFbnRpcmUgQm9va1wiIGNoYXJhY3RlciBleHRyYWN0aW9uLlxuXHQgKi9cblx0Y2hhcmFjdGVyRXh0cmFjdGlvbkNodW5rU2l6ZTogbnVtYmVyO1xuXHQvKipcblx0ICogT3B0aW9uYWw6IGEgc3BlY2lmaWMgbWFya2Rvd24gZmlsZSB0byBydW4gYnVsayBjaGFyYWN0ZXIgZXh0cmFjdGlvbiBhZ2FpbnN0LlxuXHQgKiBJZiB1bnNldCwgYnVsayBwcm9jZXNzaW5nIHVzZXMgYGJvb2syUGF0aGAuXG5cdCAqL1xuXHRjaGFyYWN0ZXJFeHRyYWN0aW9uU291cmNlUGF0aD86IHN0cmluZztcblx0LyoqXG5cdCAqIFNvZnQgbGltaXQgZm9yIGVzdGltYXRlZCBwcm9tcHQgdG9rZW5zLiBVc2VkIHRvIHdhcm4vY29uZmlybSBiZWZvcmUgc2VuZGluZyByZXF1ZXN0cy5cblx0ICogRGVmYXVsdHMgdG8gMTI4ayAoY29tbW9uIGxhcmdlLWNvbnRleHQgdGllcikuXG5cdCAqL1xuXHRjb250ZXh0VG9rZW5MaW1pdDogbnVtYmVyO1xuXHQvKipcblx0ICogRGVmYXVsdCBpbnN0cnVjdGlvbnMgZm9yIENoYXJhY3RlciBVcGRhdGUgLT4gXCJVcGRhdGUgY2hhcmFjdGVyc1wiIChzZWxlY3RlZCB0ZXh0KSBleHRyYWN0aW9uLlxuXHQgKiBVc2VkIGFzIGEgZmFsbGJhY2sgaWYgdGhlIHBlci1ydW4gaW5zdHJ1Y3Rpb25zIGJveCBpcyBlbXB0eS9pbnZhbGlkLlxuXHQgKi9cblx0ZGVmYXVsdENoYXJhY3RlckV4dHJhY3Rpb25JbnN0cnVjdGlvbnM6IHN0cmluZztcblx0LyoqXG5cdCAqIFdob2xlLXZhdWx0IHJldHJpZXZhbCBleGNsdXNpb25zIChmb2xkZXJzKS4gVGhpcyBpcyBhIGxpdmluZyBsaXN0OiB1c2VycyBjYW4gY2hhbmdlIGl0IGFueSB0aW1lLlxuXHQgKiBgLm9ic2lkaWFuL2AgaXMgYWx3YXlzIGV4Y2x1ZGVkLlxuXHQgKi9cblx0cmV0cmlldmFsRXhjbHVkZWRGb2xkZXJzOiBzdHJpbmdbXTtcblx0LyoqXG5cdCAqIEVuYWJsZSB0aGUgbG9jYWwgc2VtYW50aWMgaW5kZXggdXNlZCBmb3IgcmV0cmlldmFsLiBJZiBkaXNhYmxlZCwgcmV0cmlldmFsIGZhbGxzIGJhY2sgdG8gaGV1cmlzdGljIG9ubHkuXG5cdCAqL1xuXHRyZXRyaWV2YWxFbmFibGVTZW1hbnRpY0luZGV4OiBib29sZWFuO1xuXHQvKipcblx0ICogTWF4aW11bSBudW1iZXIgb2YgcmV0cmlldmVkIGNvbnRleHQgaXRlbXMgaW5qZWN0ZWQgaW50byBwcm9tcHRzLlxuXHQgKi9cblx0cmV0cmlldmFsVG9wSzogbnVtYmVyO1xuXHQvKipcblx0ICogQ2h1bmsgc2l6ZSAod29yZHMpIGZvciBsb2NhbCBzZW1hbnRpYyBpbmRleGluZy5cblx0ICovXG5cdHJldHJpZXZhbENodW5rV29yZHM6IG51bWJlcjtcblx0LyoqXG5cdCAqIENodW5rIG92ZXJsYXAgKHdvcmRzKSBmb3IgbG9jYWwgc2VtYW50aWMgaW5kZXhpbmcuXG5cdCAqL1xuXHRyZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkczogbnVtYmVyO1xuXHQvKipcblx0ICogUHJlZmVycmVkIG1hcmtkb3duIGhlYWRpbmcgbGV2ZWwgdXNlZCB0byBjaHVuayBub3RlcyBmb3IgcmV0cmlldmFsIGluZGV4aW5nLlxuXHQgKiBEZWZhdWx0IGlzIEgxIHRvIG1hdGNoIGNvbW1vbiBjaGFwdGVyLXN0eWxlIG5vdGVzLlxuXHQgKi9cblx0cmV0cmlldmFsQ2h1bmtIZWFkaW5nTGV2ZWw6ICdoMScgfCAnaDInIHwgJ2gzJyB8ICdub25lJztcblx0LyoqXG5cdCAqIElmIHRydWUsIGJhY2tncm91bmQgaW5kZXhpbmcgaXMgcGF1c2VkLlxuXHQgKi9cblx0cmV0cmlldmFsSW5kZXhQYXVzZWQ6IGJvb2xlYW47XG5cdC8qKlxuXHQgKiBJbmNyZW1lbnRhbCBzZW1hbnRpYyBpbmRleCBzdGF0ZSBwZXIgZmlsZS4gVXNlZCB0byBhdm9pZCByZS1pbmRleGluZyB1bmNoYW5nZWQgZmlsZXMuXG5cdCAqL1xuXHRyZXRyaWV2YWxJbmRleFN0YXRlOiBSZWNvcmQ8XG5cdFx0c3RyaW5nLFxuXHRcdHtcblx0XHRcdGhhc2g6IHN0cmluZztcblx0XHRcdGNodW5rQ291bnQ6IG51bWJlcjtcblx0XHRcdHVwZGF0ZWRBdDogc3RyaW5nO1xuXHRcdH1cblx0Pjtcblx0LyoqXG5cdCAqIExvY2FsIGVtYmVkZGluZ3MgYmFja2VuZCBmb3Igc2VtYW50aWMgcmV0cmlldmFsLlxuXHQgKiAtIGhhc2g6IGxpZ2h0d2VpZ2h0IGhhc2hlZCBiYWctb2Ytd29yZHMgKGZhc3QsIHJlbGlhYmxlKVxuXHQgKi9cblx0cmV0cmlldmFsRW1iZWRkaW5nQmFja2VuZDogJ2hhc2gnO1xuXHQvKipcblx0ICogRW5hYmxlIEJNMjUgbGV4aWNhbCByZXRyaWV2YWwgKHJlY29tbWVuZGVkKS5cblx0ICovXG5cdHJldHJpZXZhbEVuYWJsZUJtMjU6IGJvb2xlYW47XG5cdC8qKlxuXHQgKiBFbmFibGUgQ1BVIHJlcmFua2luZyAobG9jYWwpLiBNYXkgYWRkIGxhdGVuY3kgYXQgR2VuZXJhdGUgdGltZS5cblx0ICovXG5cdHJldHJpZXZhbEVuYWJsZVJlcmFua2VyOiBib29sZWFuO1xuXHQvKipcblx0ICogUmV0cmlldmFsIHNvdXJjZTogbG9jYWwgKGhhc2grQk0yNSkgb3IgZXh0ZXJuYWwgZW1iZWRkaW5nIEFQSSAoaHlicmlkKS5cblx0ICovXG5cdHJldHJpZXZhbFNvdXJjZTogJ2xvY2FsJyB8ICdleHRlcm5hbC1hcGknO1xuXHQvKipcblx0ICogRW5hYmxlIGV4dGVybmFsIGVtYmVkZGluZyBBUEkgZm9yIHJldHJpZXZhbCAoZGVmYXVsdDogZmFsc2UpLlxuXHQgKiBXaGVuIGRpc2FibGVkLCBvbmx5IGxvY2FsIGhhc2gvQk0yNSBlbWJlZGRpbmdzIGFyZSB1c2VkLlxuXHQgKi9cblx0ZXh0ZXJuYWxFbWJlZGRpbmdzRW5hYmxlZD86IGJvb2xlYW47XG5cdC8qKlxuXHQgKiBFeHRlcm5hbCBlbWJlZGRpbmcgQVBJIHByb3ZpZGVyIChPcGVuQUksIENvaGVyZSwgR29vZ2xlIEdlbWluaSwgb3IgY3VzdG9tKS5cblx0ICovXG5cdGV4dGVybmFsRW1iZWRkaW5nUHJvdmlkZXI/OiAnb3BlbmFpJyB8ICdjb2hlcmUnIHwgJ2dvb2dsZScgfCAnY3VzdG9tJztcblx0LyoqXG5cdCAqIEFQSSBrZXkgZm9yIGV4dGVybmFsIGVtYmVkZGluZyBwcm92aWRlci5cblx0ICovXG5cdGV4dGVybmFsRW1iZWRkaW5nQXBpS2V5Pzogc3RyaW5nO1xuXHQvKipcblx0ICogTW9kZWwgbmFtZSBmb3IgZXh0ZXJuYWwgZW1iZWRkaW5nIHByb3ZpZGVyIChlLmcuLCB0ZXh0LWVtYmVkZGluZy0zLXNtYWxsLCBnZW1pbmktZW1iZWRkaW5nLTAwMSkuXG5cdCAqL1xuXHRleHRlcm5hbEVtYmVkZGluZ01vZGVsPzogc3RyaW5nO1xuXHQvKipcblx0ICogQ3VzdG9tIEFQSSBVUkwgZm9yIGV4dGVybmFsIGVtYmVkZGluZyBwcm92aWRlciAoaWYgdXNpbmcgY3VzdG9tIHByb3ZpZGVyKS5cblx0ICovXG5cdGV4dGVybmFsRW1iZWRkaW5nQXBpVXJsPzogc3RyaW5nO1xuXHQvKipcblx0ICogVXNlIGJhdGNoIGVtYmVkZGluZ3MgZW5kcG9pbnQgZm9yIEdvb2dsZSBHZW1pbmkgKG1vcmUgZWZmaWNpZW50IGZvciBtdWx0aXBsZSBxdWVyaWVzKS5cblx0ICovXG5cdGV4dGVybmFsRW1iZWRkaW5nVXNlQmF0Y2g/OiBib29sZWFuO1xuXHQvKipcblx0ICogRm9sZGVyIGZvciBwZXItcnVuIGdlbmVyYXRpb24gbG9ncy5cblx0ICovXG5cdGdlbmVyYXRpb25Mb2dzRm9sZGVyOiBzdHJpbmc7XG5cdC8qKlxuXHQgKiBJZiB0cnVlLCB3cml0ZSBwZXItcnVuIGdlbmVyYXRpb24gbG9ncy5cblx0ICovXG5cdGdlbmVyYXRpb25Mb2dzRW5hYmxlZDogYm9vbGVhbjtcblx0LyoqXG5cdCAqIElmIHRydWUsIGluY2x1ZGUgdGhlIGZ1bGwgZmluYWwgcHJvbXB0IHRleHQgaW4gZ2VuZXJhdGlvbiBsb2dzLlxuXHQgKi9cblx0Z2VuZXJhdGlvbkxvZ3NJbmNsdWRlUHJvbXB0OiBib29sZWFuO1xuXHQvKipcblx0ICogUGVyLW1vZGUgcGVyc2lzdGVkIGZvcm0gc3RhdGUgc28gaW5wdXRzIGRvIG5vdCBibGVlZCBiZXR3ZWVuIG1vZGVzLlxuXHQgKi9cblx0bW9kZVN0YXRlOiB7XG5cdFx0Y2hhcHRlcjoge1xuXHRcdFx0c2NlbmVTdW1tYXJ5OiBzdHJpbmc7XG5cdFx0XHRyZXdyaXRlSW5zdHJ1Y3Rpb25zOiBzdHJpbmc7XG5cdFx0XHRtaW5Xb3JkczogbnVtYmVyO1xuXHRcdFx0bWF4V29yZHM6IG51bWJlcjtcblx0XHR9O1xuXHRcdG1pY3JvRWRpdDoge1xuXHRcdFx0c2VsZWN0ZWRQYXNzYWdlOiBzdHJpbmc7XG5cdFx0XHRncmlldmFuY2VzOiBzdHJpbmc7XG5cdFx0fTtcblx0XHRjaGFyYWN0ZXJVcGRhdGU6IHtcblx0XHRcdHNlbGVjdGVkVGV4dDogc3RyaW5nO1xuXHRcdFx0ZXh0cmFjdGlvbkluc3RydWN0aW9uczogc3RyaW5nO1xuXHRcdH07XG5cdFx0Y29udGludWl0eUNoZWNrOiB7XG5cdFx0XHRkcmFmdFRleHQ6IHN0cmluZztcblx0XHRcdGZvY3VzOiB7XG5cdFx0XHRcdGtub3dsZWRnZTogYm9vbGVhbjtcblx0XHRcdFx0dGltZWxpbmU6IGJvb2xlYW47XG5cdFx0XHRcdHBvdjogYm9vbGVhbjtcblx0XHRcdFx0bmFtaW5nOiBib29sZWFuO1xuXHRcdFx0fTtcblx0XHR9O1xuXHR9O1xuXHQvKipcblx0ICogU21hcnQgQ29ubmVjdGlvbnMgY2FjaGUgZm9yIGNhcHR1cmVkIHJlc3VsdHMuXG5cdCAqL1xuXHRzbWFydENvbm5lY3Rpb25zQ2FjaGU/OiB7XG5cdFx0c291cmNlTm90ZVBhdGg/OiBzdHJpbmc7IC8vIE5vdGUgcGF0aCB3aGVuIGNhcHR1cmVkXG5cdFx0dmF1bHRJZD86IHN0cmluZzsgLy8gdmF1bHROYW1lICsgKGFkYXB0ZXIuYmFzZVBhdGggfHwgJycpXG5cdFx0cmVzdWx0czogQXJyYXk8e1xuXHRcdFx0cGF0aDogc3RyaW5nO1xuXHRcdFx0c2NvcmU/OiBudW1iZXI7IC8vIFJhbmstYmFzZWQ6IDEuMCwgMC45OCwgMC45Ni4uLlxuXHRcdFx0Y2FwdHVyZWRTbmlwcGV0Pzogc3RyaW5nOyAvLyBPcHRpb25hbCwgZm9yIHJlZmVyZW5jZSBvbmx5XG5cdFx0XHRjYXB0dXJlZEF0PzogbnVtYmVyOyAvLyBUaW1lc3RhbXAgd2hlbiBjYXB0dXJlZFxuXHRcdH0+O1xuXHRcdGNhcHR1cmVkQXQ6IG51bWJlcjsgLy8gT3ZlcmFsbCBjYWNoZSB0aW1lc3RhbXBcblx0XHRtZXRob2Q6ICdkb20nIHwgJ2NsaXBib2FyZCc7XG5cdFx0c2Vzc2lvbklkOiBzdHJpbmc7IC8vIENhcHR1cmUgc2Vzc2lvbiBJRCBmb3IgbG9nIGdyb3VwaW5nXG5cdH07XG5cdC8qKlxuXHQgKiBFbmFibGUgU21hcnQgQ29ubmVjdGlvbnMgY2FjaGUgZm9yIHJldHJpZXZhbC5cblx0ICovXG5cdHNtYXJ0Q29ubmVjdGlvbnNDYWNoZUVuYWJsZWQ/OiBib29sZWFuO1xuXHQvKipcblx0ICogQ2FjaGUgVFRMIGluIGhvdXJzIChvcHRpb25hbCwgZGVmYXVsdDogbm8gZXhwaXJ5KS5cblx0ICovXG5cdHNtYXJ0Q29ubmVjdGlvbnNDYWNoZVRUTD86IG51bWJlcjtcblx0LyoqXG5cdCAqIEFsbG93ZWQgZm9sZGVycyBmb3IgU21hcnQgQ29ubmVjdGlvbnMgY2FjaGUgKGVtcHR5ID0gYWxsIGFsbG93ZWQpLlxuXHQgKi9cblx0c21hcnRDb25uZWN0aW9uc0FsbG93ZWRGb2xkZXJzPzogc3RyaW5nW107XG5cdC8qKlxuXHQgKiBCbG9ja2VkIGZvbGRlcnMgZm9yIFNtYXJ0IENvbm5lY3Rpb25zIGNhY2hlLlxuXHQgKi9cblx0c21hcnRDb25uZWN0aW9uc0Jsb2NrZWRGb2xkZXJzPzogc3RyaW5nW107XG5cdC8qKlxuXHQgKiBNYXggZmlsZXMgdG8gY2FwdHVyZSBpbiBTbWFydCBDb25uZWN0aW9ucyBjYWNoZSAoZGVmYXVsdDogMjAwKS5cblx0ICovXG5cdHNtYXJ0Q29ubmVjdGlvbnNNYXhDYXB0dXJlRmlsZXM/OiBudW1iZXI7XG5cdC8qKlxuXHQgKiBNYXggZmlsZXMgdG8gc2NvcmUgcGVyIHF1ZXJ5IGluIFNtYXJ0IENvbm5lY3Rpb25zIGNhY2hlIChkZWZhdWx0OiA1MCkuXG5cdCAqL1xuXHRzbWFydENvbm5lY3Rpb25zTWF4U2NvcmVGaWxlcz86IG51bWJlcjtcblx0LyoqXG5cdCAqIE1heCB0b3RhbCBjb250ZXh0IGNoYXJzIGZvciBTbWFydCBDb25uZWN0aW9ucyBleGNlcnB0cyAoZGVmYXVsdDogMzAwMDApLlxuXHQgKi9cblx0c21hcnRDb25uZWN0aW9uc01heENvbnRleHRDaGFycz86IG51bWJlcjtcblx0LyoqXG5cdCAqIEtleWluZyBtb2RlOiBzdHJpY3QgKG9ubHkgdXNlIGNhY2hlIGlmIHNvdXJjZSBub3RlIG1hdGNoZXMpIG9yIHNvZnQgKHByZWZlciBtYXRjaCwgYWxsb3cgb3ZlcnJpZGUpLlxuXHQgKi9cblx0c21hcnRDb25uZWN0aW9uc0tleWluZ01vZGU/OiAnc3RyaWN0JyB8ICdzb2Z0Jztcblx0LyoqXG5cdCAqIFBhdGggdG8gU21hcnQgQ29ubmVjdGlvbnMgdGVtcGxhdGUgZmlsZS5cblx0ICogVGVtcGxhdGUgc2hvdWxkIGNvbnRhaW4ge3tzbWFydC1jb25uZWN0aW9uczpzaW1pbGFyOjEyOH19IHRvIHN1cmZhY2Ugc2VtYW50aWMgbWF0Y2hlcy5cblx0ICogSWYgbm90IHNldCwgU21hcnQgQ29ubmVjdGlvbnMgdGVtcGxhdGUgaW50ZWdyYXRpb24gaXMgZGlzYWJsZWQuXG5cdCAqL1xuXHRzbWFydENvbm5lY3Rpb25zVGVtcGxhdGVQYXRoPzogc3RyaW5nO1xuXHQvKipcblx0ICogRm9sZGVyLWJhc2VkIHJldHJpZXZhbCBwcm9maWxlcyAoc2FmZXR5IHJhaWxzKS5cblx0ICogVGhlIGFjdGl2ZSBwcm9maWxlIGNvbnRyb2xzIHdoaWNoIGZvbGRlcnMgYXJlIGluY2x1ZGVkIGZvciByZXRyaWV2YWwvaW5kZXhpbmcuXG5cdCAqL1xuXHRyZXRyaWV2YWxQcm9maWxlczogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGluY2x1ZGVkRm9sZGVyczogc3RyaW5nW10gfT47XG5cdHJldHJpZXZhbEFjdGl2ZVByb2ZpbGVJZDogc3RyaW5nO1xuXHRzZXR1cENvbXBsZXRlZDogYm9vbGVhbjtcblx0LyoqXG5cdCAqIElmIHRydWUsIGRvIG5vdCBhdXRvLXN0YXJ0IHRoZSBndWlkZWQgZGVtbyBmb3IgZmlyc3QtdGltZSB1c2Vycy5cblx0ICogVXNlcnMgY2FuIHN0aWxsIHJ1biB0aGUgZGVtbyBtYW51YWxseSBmcm9tIHNldHRpbmdzIG9yIHRoZSBjb21tYW5kIHBhbGV0dGUuXG5cdCAqL1xuXHRndWlkZWREZW1vRGlzbWlzc2VkOiBib29sZWFuO1xuXHQvKipcblx0ICogVHJhY2tzIHdoZXRoZXIgdGhlIGd1aWRlZCBkZW1vIGhhcyBiZWVuIHNob3duL3N0YXJ0ZWQgYXQgbGVhc3Qgb25jZSBmb3IgdGhpcyB2YXVsdC5cblx0ICogVXNlZCB0byBhdXRvLXN0YXJ0IHRoZSBkZW1vIGV4YWN0bHkgb25jZSAodW5sZXNzIGRpc21pc3NlZCkuXG5cdCAqL1xuXHRndWlkZWREZW1vU2hvd25PbmNlOiBib29sZWFuO1xuXHRmaWxlU3RhdGU6IFJlY29yZDxcblx0XHRzdHJpbmcsXG5cdFx0e1xuXHRcdFx0bGFzdENodW5rSGFzaD86IHN0cmluZztcblx0XHRcdGxhc3RDaHVua2VkQXQ/OiBzdHJpbmc7XG5cdFx0XHRsYXN0Q2h1bmtDb3VudD86IG51bWJlcjtcblx0XHRcdGxhc3RQcm9jZXNzSGFzaD86IHN0cmluZztcblx0XHRcdGxhc3RQcm9jZXNzZWRBdD86IHN0cmluZztcblx0XHRcdC8qKlxuXHRcdFx0ICogUGVyc2lzdGVkIHN0YXRlIGZvciBidWxrIGNoYXJhY3RlciBleHRyYWN0aW9uIHNvIHdlIGNhbiByZXRyeSBvbmx5IGZhaWxlZCBjaGFwdGVyc1xuXHRcdFx0ICogKHdpdGhvdXQgcmVzdGFydGluZyB0aGUgd2hvbGUgam9iKSBhcyBsb25nIGFzIHRoZSBib29rIGhhc2ggaXMgdW5jaGFuZ2VkLlxuXHRcdFx0ICovXG5cdFx0XHRidWxrUHJvY2Vzc01ldGE/OiB7XG5cdFx0XHRcdGhhc2g6IHN0cmluZztcblx0XHRcdFx0cm9zdGVyVGV4dD86IHN0cmluZztcblx0XHRcdFx0ZmFpbGVkQ2hhcHRlckluZGljZXM/OiBudW1iZXJbXTtcblx0XHRcdH07XG5cdFx0fVxuXHQ+O1xufVxuXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBEYXNoYm9hcmRTZXR0aW5ncyA9IHtcblx0YXBpS2V5OiAnJyxcblx0YXBpUHJvdmlkZXI6ICdvcGVuYWknLFxuXHRtb2RlbDogJ2dwdC00Jyxcblx0Z2VuZXJhdGlvbk1vZGU6ICdzaW5nbGUnLFxuXHRtdWx0aVN0cmF0ZWd5OiAnZHJhZnQtcmV2aXNpb24nLFxuXHRkcmFmdE1vZGVsOiAnZ3B0LTMuNS10dXJibycsXG5cdHJldmlzaW9uTW9kZWw6ICdncHQtNCcsXG5cdGNvbnNlbnN1c01vZGVsMTogJ2dwdC00Jyxcblx0Y29uc2Vuc3VzTW9kZWwyOiAnY2xhdWRlLTMtb3B1cycsXG5cdGNvbnNlbnN1c01vZGVsMzogJ2dlbWluaS1wcm8nLFxuXHRzeW50aGVzaXNNb2RlbDogJ2dwdC00Jyxcblx0dmF1bHRQYXRoOiAnJyxcblx0Y2hhcmFjdGVyRm9sZGVyOiAnJyxcblx0Ym9vazJQYXRoOiAnQm9vay1NYWluLm1kJyxcblx0c3RvcnlCaWJsZVBhdGg6ICdCb29rIC0gU3RvcnkgQmlibGUubWQnLFxuXHRjaGFyYWN0ZXJFeHRyYWN0aW9uQ2h1bmtTaXplOiAyNTAwLFxuXHRjb250ZXh0VG9rZW5MaW1pdDogMTI4MDAwLFxuXHRkZWZhdWx0Q2hhcmFjdGVyRXh0cmFjdGlvbkluc3RydWN0aW9uczpcblx0XHRgW0NIQVJBQ1RFUiBVUERBVEUgSU5TVFJVQ1RJT05TXVxcbmAgK1xuXHRcdGBHb2FsOiBVcGRhdGUgY2hhcmFjdGVyIG5vdGVzIGZyb20gdGhlIHByb3ZpZGVkIHBhc3NhZ2Ugb25seS4gTWFpbnRhaW4gY2Fub24gZnJvbSB0aGUgc3RvcnkgYmlibGUgYW5kIGV4aXN0aW5nIGNoYXJhY3RlciBub3Rlcy4gRG8gbm90IGludmVudCBmYWN0cy5cXG5cXG5gICtcblx0XHRgRm9jdXMgb246XFxuYCArXG5cdFx0YC0gUHN5Y2hvbG9naWNhbC9lbW90aW9uYWwgcmVhY3Rpb25zIGFuZCBkZXZlbG9wbWVudFxcbmAgK1xuXHRcdGAtIE1vdGl2YXRpb25zLCBmZWFycywgZGVzaXJlcywgaW50ZXJuYWwgY29uZmxpY3RzXFxuYCArXG5cdFx0YC0gUmVsYXRpb25zaGlwIGR5bmFtaWNzIGFuZCBzaGlmdHNcXG5gICtcblx0XHRgLSBWb2ljZSBwYXR0ZXJucywgdmVyYmFsIHRlbGxzLCBjb3BpbmcgYmVoYXZpb3JzXFxuYCArXG5cdFx0YC0gQXJjIHByb2dyZXNzaW9uIGFuZCBzdGF0dXMgY2hhbmdlc1xcblxcbmAgK1xuXHRcdGBSdWxlczpcXG5gICtcblx0XHRgLSBFdmlkZW5jZS1iYXNlZCBvbmx5OiBpZiBpdCBpcyBub3Qgc3VwcG9ydGVkIGJ5IHRoZSBwYXNzYWdlLCBvbWl0IGl0XFxuYCArXG5cdFx0YC0gSWYgdW5jZXJ0YWluLCBvbWl0IGl0XFxuYCArXG5cdFx0YC0gUHJlZmVyIGNvbmNyZXRlIG9ic2VydmF0aW9ucyBvdmVyIHN1bW1hcmllc1xcbmAgK1xuXHRcdGAtIElmIG5vIG1lYW5pbmdmdWwgbmV3IGluZm8gZXhpc3RzIGZvciBhIGNoYXJhY3Rlciwgb21pdCB0aGF0IGNoYXJhY3RlclxcblxcbmAgK1xuXHRcdGBPdXRwdXQgZm9ybWF0IChyZXF1aXJlZCk6XFxuYCArXG5cdFx0YCMjIENoYXJhY3RlciBOYW1lXFxuYCArXG5cdFx0YC0gQnVsbGV0IHVwZGF0ZXMgb25seSAobm8gZXh0cmEgaGVhZGluZ3MpXFxuYCxcblx0cmV0cmlldmFsRXhjbHVkZWRGb2xkZXJzOiBbJ1RlbXBsYXRlcyddLFxuXHRyZXRyaWV2YWxFbmFibGVTZW1hbnRpY0luZGV4OiB0cnVlLFxuXHRyZXRyaWV2YWxUb3BLOiAyNCxcblx0cmV0cmlldmFsQ2h1bmtXb3JkczogNTAwLFxuXHRyZXRyaWV2YWxDaHVua092ZXJsYXBXb3JkczogMTAwLFxuXHRyZXRyaWV2YWxDaHVua0hlYWRpbmdMZXZlbDogJ2gxJyxcblx0cmV0cmlldmFsSW5kZXhQYXVzZWQ6IGZhbHNlLFxuXHRyZXRyaWV2YWxJbmRleFN0YXRlOiB7fSxcblx0cmV0cmlldmFsRW1iZWRkaW5nQmFja2VuZDogJ2hhc2gnLFxuXHRyZXRyaWV2YWxFbmFibGVCbTI1OiB0cnVlLFxuXHRyZXRyaWV2YWxFbmFibGVSZXJhbmtlcjogZmFsc2UsXG5cdHJldHJpZXZhbFNvdXJjZTogJ2xvY2FsJyxcblx0ZXh0ZXJuYWxFbWJlZGRpbmdzRW5hYmxlZDogZmFsc2UsIC8vIERlZmF1bHQ6IGRpc2FibGVkIHRvIHByZXZlbnQgYWNjaWRlbnRhbCBBUEkgdXNhZ2Vcblx0ZXh0ZXJuYWxFbWJlZGRpbmdQcm92aWRlcjogdW5kZWZpbmVkLFxuXHRleHRlcm5hbEVtYmVkZGluZ0FwaUtleTogdW5kZWZpbmVkLFxuXHRleHRlcm5hbEVtYmVkZGluZ01vZGVsOiB1bmRlZmluZWQsXG5cdGV4dGVybmFsRW1iZWRkaW5nQXBpVXJsOiB1bmRlZmluZWQsXG5cdGV4dGVybmFsRW1iZWRkaW5nVXNlQmF0Y2g6IGZhbHNlLFxuXHRnZW5lcmF0aW9uTG9nc0ZvbGRlcjogJycsXG5cdGdlbmVyYXRpb25Mb2dzRW5hYmxlZDogZmFsc2UsXG5cdGdlbmVyYXRpb25Mb2dzSW5jbHVkZVByb21wdDogZmFsc2UsXG5cdG1vZGVTdGF0ZToge1xuXHRcdGNoYXB0ZXI6IHtcblx0XHRcdHNjZW5lU3VtbWFyeTogJycsXG5cdFx0XHRyZXdyaXRlSW5zdHJ1Y3Rpb25zOiAnJyxcblx0XHRcdG1pbldvcmRzOiAyMDAwLFxuXHRcdFx0bWF4V29yZHM6IDYwMDBcblx0XHR9LFxuXHRcdG1pY3JvRWRpdDoge1xuXHRcdFx0c2VsZWN0ZWRQYXNzYWdlOiAnJyxcblx0XHRcdGdyaWV2YW5jZXM6ICcnXG5cdFx0fSxcblx0XHRjaGFyYWN0ZXJVcGRhdGU6IHtcblx0XHRcdHNlbGVjdGVkVGV4dDogJycsXG5cdFx0XHRleHRyYWN0aW9uSW5zdHJ1Y3Rpb25zOiAnJ1xuXHRcdH0sXG5cdFx0Y29udGludWl0eUNoZWNrOiB7XG5cdFx0XHRkcmFmdFRleHQ6ICcnLFxuXHRcdFx0Zm9jdXM6IHsga25vd2xlZGdlOiB0cnVlLCB0aW1lbGluZTogdHJ1ZSwgcG92OiB0cnVlLCBuYW1pbmc6IHRydWUgfVxuXHRcdH1cblx0fSxcblx0cmV0cmlldmFsUHJvZmlsZXM6IFtdLFxuXHRyZXRyaWV2YWxBY3RpdmVQcm9maWxlSWQ6ICdzdG9yeScsXG5cdHNldHVwQ29tcGxldGVkOiBmYWxzZSxcblx0Z3VpZGVkRGVtb0Rpc21pc3NlZDogZmFsc2UsXG5cdGd1aWRlZERlbW9TaG93bk9uY2U6IGZhbHNlLFxuXHRmaWxlU3RhdGU6IHt9LFxuXHRzbWFydENvbm5lY3Rpb25zQ2FjaGVFbmFibGVkOiBmYWxzZSxcblx0c21hcnRDb25uZWN0aW9uc0NhY2hlVFRMOiB1bmRlZmluZWQsXG5cdHNtYXJ0Q29ubmVjdGlvbnNBbGxvd2VkRm9sZGVyczogW10sXG5cdHNtYXJ0Q29ubmVjdGlvbnNCbG9ja2VkRm9sZGVyczogW10sXG5cdHNtYXJ0Q29ubmVjdGlvbnNNYXhDYXB0dXJlRmlsZXM6IDIwMCxcblx0c21hcnRDb25uZWN0aW9uc01heFNjb3JlRmlsZXM6IDUwLFxuXHRzbWFydENvbm5lY3Rpb25zTWF4Q29udGV4dENoYXJzOiAzMDAwMCxcblx0c21hcnRDb25uZWN0aW9uc0tleWluZ01vZGU6ICdzb2Z0Jyxcblx0c21hcnRDb25uZWN0aW9uc1RlbXBsYXRlUGF0aDogdW5kZWZpbmVkIC8vIFVzZXIgbXVzdCBjb25maWd1cmUgdGVtcGxhdGVcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIFdyaXRpbmdEYXNoYm9hcmRQbHVnaW4gZXh0ZW5kcyBQbHVnaW4ge1xuXHRzZXR0aW5nczogRGFzaGJvYXJkU2V0dGluZ3M7XG5cdHZhdWx0U2VydmljZTogVmF1bHRTZXJ2aWNlO1xuXHRjb250ZXh0QWdncmVnYXRvcjogQ29udGV4dEFnZ3JlZ2F0b3I7XG5cdHByb21wdEVuZ2luZTogUHJvbXB0RW5naW5lO1xuXHRhaUNsaWVudDogQUlDbGllbnQ7XG5cdGNoYXJhY3RlckV4dHJhY3RvcjogQ2hhcmFjdGVyRXh0cmFjdG9yO1xuXHRxdWVyeUJ1aWxkZXI6IFF1ZXJ5QnVpbGRlcjtcblx0cmV0cmlldmFsU2VydmljZTogUmV0cmlldmFsU2VydmljZTtcblx0c21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyPzogaW1wb3J0KCcuL3NlcnZpY2VzL3JldHJpZXZhbC9TbWFydENvbm5lY3Rpb25zUHJvdmlkZXInKS5TbWFydENvbm5lY3Rpb25zUHJvdmlkZXI7XG5cdGVtYmVkZGluZ3NJbmRleDogRW1iZWRkaW5nc0luZGV4O1xuXHRibTI1SW5kZXg6IEJtMjVJbmRleDtcblx0Y3B1UmVyYW5rZXI6IENwdVJlcmFua2VyO1xuXHRnZW5lcmF0aW9uTG9nU2VydmljZTogR2VuZXJhdGlvbkxvZ1NlcnZpY2U7XG5cdHRlbXBsYXRlUHJvY2Vzc29ySW5zdGFuY2U/OiBUZW1wbGF0ZVByb2Nlc3Nvcjtcblx0LyoqXG5cdCAqIFdoZW4gdHJ1ZSwgdGhlIG5leHQgdGltZSB0aGUgZGFzaGJvYXJkIFVJIG1vdW50cyBpdCB3aWxsIHN0YXJ0IHRoZSBndWlkZWQgZGVtbyBmbG93LlxuXHQgKiBUaGlzIGF2b2lkcyB3aXJpbmcgYWRkaXRpb25hbCBjcm9zcy1jb21wb25lbnQgc3RhdGUgbWFuYWdlbWVudC5cblx0ICovXG5cdGd1aWRlZERlbW9TdGFydFJlcXVlc3RlZCA9IGZhbHNlO1xuXG5cdHByaXZhdGUgbm90aWZ5VWkoZXZlbnROYW1lOiBzdHJpbmcpIHtcblx0XHR0cnkge1xuXHRcdFx0d2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KGV2ZW50TmFtZSkpO1xuXHRcdH0gY2F0Y2gge1xuXHRcdFx0Ly8gaWdub3JlXG5cdFx0fVxuXHR9XG5cdC8qKlxuXHQgKiBUcmFja3MgdGhlIGxhc3QgbWFya2Rvd24gZmlsZSB0aGUgdXNlciBvcGVuZWQgaW4gT2JzaWRpYW4uXG5cdCAqIFVzZWQgZm9yIGFjdGlvbnMgbGlrZSBcIkNodW5rIFNlbGVjdGVkIEZpbGVcIiBzbyB1c2VycyBkb24ndCBuZWVkIHRvIGtlZXAgdXBkYXRpbmcgc2V0dGluZ3MuXG5cdCAqL1xuXHRsYXN0T3BlbmVkTWFya2Rvd25QYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuXHRhc3luYyBvbmxvYWQoKSB7XG5cdFx0YXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuXHRcdC8vIFRyYWNrIHRoZSBsYXN0IG9wZW5lZCBtYXJrZG93biBmaWxlICh0aGUgXCJjdXJyZW50IG5vdGVcIiB0aGUgdXNlciBpcyB3b3JraW5nIG9uKVxuXHRcdHRoaXMucmVnaXN0ZXJFdmVudChcblx0XHRcdHRoaXMuYXBwLndvcmtzcGFjZS5vbignZmlsZS1vcGVuJywgKGZpbGUpID0+IHtcblx0XHRcdFx0aWYgKGZpbGUgJiYgZmlsZS5leHRlbnNpb24gPT09ICdtZCcpIHtcblx0XHRcdFx0XHR0aGlzLmxhc3RPcGVuZWRNYXJrZG93blBhdGggPSBmaWxlLnBhdGg7XG5cdFx0XHRcdH1cblx0XHRcdH0pXG5cdFx0KTtcblxuXHRcdC8vIFRyYWNrIHJlbmFtZXMgc28gc2V0dGluZ3MgZG9uJ3QgYnJlYWsgaWYgdGhlIHVzZXIgcmVuYW1lcyB0aGVpciBtYW51c2NyaXB0XG5cdFx0dGhpcy5yZWdpc3RlckV2ZW50KFxuXHRcdFx0dGhpcy5hcHAudmF1bHQub24oJ3JlbmFtZScsIGFzeW5jIChmaWxlLCBvbGRQYXRoKSA9PiB7XG5cdFx0XHRcdGNvbnN0IG9sZE5vcm0gPSBvbGRQYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcblx0XHRcdFx0Y29uc3QgbmV3Tm9ybSA9IGZpbGUucGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XG5cdFx0XHRcdGxldCBjaGFuZ2VkID0gZmFsc2U7XG5cblx0XHRcdFx0Ly8gVHJhY2sgbWFuYWdlZCBmb2xkZXIgcmVuYW1lcyAoZ2VuZXJhdGlvbiBsb2dzKS5cblx0XHRcdFx0Y29uc3QgbG9nc0ZvbGRlciA9ICh0aGlzLnNldHRpbmdzLmdlbmVyYXRpb25Mb2dzRm9sZGVyIHx8ICcnKS5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXFwvKyQvLCAnJyk7XG5cdFx0XHRcdGlmIChsb2dzRm9sZGVyICYmIGZpbGUgaW5zdGFuY2VvZiBURm9sZGVyICYmIG9sZE5vcm0gPT09IGxvZ3NGb2xkZXIpIHtcblx0XHRcdFx0XHR0aGlzLnNldHRpbmdzLmdlbmVyYXRpb25Mb2dzRm9sZGVyID0gbmV3Tm9ybTtcblx0XHRcdFx0XHRjaGFuZ2VkID0gdHJ1ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkgfHwgZmlsZS5leHRlbnNpb24gIT09ICdtZCcpIHtcblx0XHRcdFx0XHRpZiAoY2hhbmdlZCkgYXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcblx0XHRcdFx0XHRyZXR1cm47XG5cdFx0XHRcdH1cblxuXHRcdFx0XHQvLyBVcGRhdGUgY3VycmVudC1ub3RlIHRyYWNrZXJcblx0XHRcdFx0aWYgKHRoaXMubGFzdE9wZW5lZE1hcmtkb3duUGF0aCA9PT0gb2xkUGF0aCkge1xuXHRcdFx0XHRcdHRoaXMubGFzdE9wZW5lZE1hcmtkb3duUGF0aCA9IGZpbGUucGF0aDtcblx0XHRcdFx0XHRjaGFuZ2VkID0gdHJ1ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIFVwZGF0ZSBCb29rIE1haW4gUGF0aCBpZiBpdCB3YXMgcmVuYW1lZFxuXHRcdFx0XHRpZiAodGhpcy5zZXR0aW5ncy5ib29rMlBhdGggPT09IG9sZFBhdGgpIHtcblx0XHRcdFx0XHR0aGlzLnNldHRpbmdzLmJvb2syUGF0aCA9IGZpbGUucGF0aDtcblx0XHRcdFx0XHRjaGFuZ2VkID0gdHJ1ZTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdC8vIE1pZ3JhdGUgcGVyLWZpbGUgc3RhdGUgKGhhc2hlcy90aW1lc3RhbXBzKSBpZiBwcmVzZW50XG5cdFx0XHRcdGlmICh0aGlzLnNldHRpbmdzLmZpbGVTdGF0ZT8uW29sZFBhdGhdKSB7XG5cdFx0XHRcdFx0dGhpcy5zZXR0aW5ncy5maWxlU3RhdGVbZmlsZS5wYXRoXSA9IHtcblx0XHRcdFx0XHRcdC4uLih0aGlzLnNldHRpbmdzLmZpbGVTdGF0ZVtmaWxlLnBhdGhdIHx8IHt9KSxcblx0XHRcdFx0XHRcdC4uLnRoaXMuc2V0dGluZ3MuZmlsZVN0YXRlW29sZFBhdGhdXG5cdFx0XHRcdFx0fTtcblx0XHRcdFx0XHRkZWxldGUgdGhpcy5zZXR0aW5ncy5maWxlU3RhdGVbb2xkUGF0aF07XG5cdFx0XHRcdFx0Y2hhbmdlZCA9IHRydWU7XG5cdFx0XHRcdH1cblxuXHRcdFx0XHRpZiAoY2hhbmdlZCkgYXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcblx0XHRcdH0pXG5cdFx0KTtcblx0XHRcblx0XHQvLyBTZXQgdmF1bHQgcGF0aCBpZiBub3Qgc2V0XG5cdFx0aWYgKCF0aGlzLnNldHRpbmdzLnZhdWx0UGF0aCkge1xuXHRcdFx0Ly8gQHRzLWV4cGVjdC1lcnJvciBPYnNpZGlhbiBhZGFwdGVyIHR5cGVzIGRvIG5vdCBleHBvc2UgYGJhc2VQYXRoYCwgYnV0IGRlc2t0b3AgYWRhcHRlcnMgcHJvdmlkZSBpdC5cblx0XHRcdHRoaXMuc2V0dGluZ3MudmF1bHRQYXRoID0gdGhpcy5hcHAudmF1bHQuYWRhcHRlci5iYXNlUGF0aCB8fCAnJztcblx0XHRcdGF3YWl0IHRoaXMuc2F2ZVNldHRpbmdzKCk7XG5cdFx0fVxuXHRcdFxuXHRcdHRoaXMudmF1bHRTZXJ2aWNlID0gbmV3IFZhdWx0U2VydmljZSh0aGlzLmFwcC52YXVsdCwgdGhpcyk7XG5cdFx0XG5cdFx0Ly8gRGVsYXkgaG9vayByZWdpc3RyYXRpb24gdW50aWwgYWZ0ZXIgYWxsIHBsdWdpbnMgYXJlIGxvYWRlZFxuXHRcdC8vIFRoaXMgcHJldmVudHMgYnJlYWtpbmcgb3RoZXIgcGx1Z2lucyBkdXJpbmcgaW5pdGlhbGl6YXRpb25cblx0XHR0aGlzLmFwcC53b3Jrc3BhY2Uub25MYXlvdXRSZWFkeSgoKSA9PiB7XG5cdFx0XHQvLyBXYWl0IGFkZGl0aW9uYWwgdGltZSBmb3IgcGx1Z2lucyB0byBmdWxseSBpbml0aWFsaXplXG5cdFx0XHRzZXRUaW1lb3V0KCgpID0+IHtcblx0XHRcdFx0dGhpcy50ZW1wbGF0ZVByb2Nlc3Nvckluc3RhbmNlID0gbmV3IFRlbXBsYXRlUHJvY2Vzc29yKHRoaXMuYXBwLCB0aGlzKTtcblx0XHRcdFx0Y29uc29sZS5sb2coJ1tXcml0aW5nRGFzaGJvYXJkXSDinIUgVGVtcGxhdGVQcm9jZXNzb3IgaW5pdGlhbGl6ZWQgYWZ0ZXIgcGx1Z2luIHN5c3RlbScpO1xuXHRcdFx0fSwgMjAwMCk7IC8vIDIgc2Vjb25kIGRlbGF5IGZvciBwbHVnaW4gaW5pdGlhbGl6YXRpb25cblx0XHR9KTtcblx0XHRcblx0XHR0aGlzLmNvbnRleHRBZ2dyZWdhdG9yID0gbmV3IENvbnRleHRBZ2dyZWdhdG9yKHRoaXMuYXBwLnZhdWx0LCB0aGlzLCB0aGlzLnZhdWx0U2VydmljZSk7XG5cdFx0dGhpcy5wcm9tcHRFbmdpbmUgPSBuZXcgUHJvbXB0RW5naW5lKCk7XG5cdFx0dGhpcy5haUNsaWVudCA9IG5ldyBBSUNsaWVudCgpO1xuXHRcdHRoaXMuY2hhcmFjdGVyRXh0cmFjdG9yID0gbmV3IENoYXJhY3RlckV4dHJhY3RvcigpO1xuXG5cdFx0Ly8gUmV0cmlldmFsIC8gbG9jYWwgaW5kZXhpbmdcblx0XHR0aGlzLnF1ZXJ5QnVpbGRlciA9IG5ldyBRdWVyeUJ1aWxkZXIoKTtcblx0XHR0aGlzLmVtYmVkZGluZ3NJbmRleCA9IG5ldyBFbWJlZGRpbmdzSW5kZXgodGhpcy5hcHAudmF1bHQsIHRoaXMpO1xuXHRcdHRoaXMuYm0yNUluZGV4ID0gbmV3IEJtMjVJbmRleCh0aGlzLmFwcC52YXVsdCwgdGhpcyk7XG5cdFx0dGhpcy5jcHVSZXJhbmtlciA9IG5ldyBDcHVSZXJhbmtlcigpO1xuXHRcdHRoaXMuZ2VuZXJhdGlvbkxvZ1NlcnZpY2UgPSBuZXcgR2VuZXJhdGlvbkxvZ1NlcnZpY2UodGhpcy5hcHAsIHRoaXMpO1xuXHRcdC8vIE5vdGU6IEZvbGRlciB2YWxpZGF0aW9uIGhhcHBlbnMgd2hlbiBsb2dzIGFyZSBlbmFibGVkIHZpYSBzZXR0aW5ncyB0b2dnbGVcblx0XHRjb25zdCBzY1Byb3ZpZGVyID0gbmV3IFNtYXJ0Q29ubmVjdGlvbnNQcm92aWRlcih0aGlzLmFwcCwgdGhpcywgdGhpcy5hcHAudmF1bHQsIChwYXRoKSA9PiAhdGhpcy52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgocGF0aCkpO1xuXHRcdHRoaXMuc21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyID0gc2NQcm92aWRlcjtcblx0XHRcblx0XHRjb25zdCBwcm92aWRlcnM6IEFycmF5PGltcG9ydCgnLi9zZXJ2aWNlcy9yZXRyaWV2YWwvdHlwZXMnKS5SZXRyaWV2YWxQcm92aWRlcj4gPSBbXG5cdFx0XHRuZXcgSGV1cmlzdGljUHJvdmlkZXIodGhpcy5hcHAudmF1bHQsIHRoaXMudmF1bHRTZXJ2aWNlKSxcblx0XHRcdG5ldyBCbTI1UHJvdmlkZXIodGhpcy5ibTI1SW5kZXgsICgpID0+IEJvb2xlYW4odGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVCbTI1KSwgKHBhdGgpID0+ICF0aGlzLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChwYXRoKSksXG5cdFx0XHRzY1Byb3ZpZGVyXG5cdFx0XTtcblx0XHRcblx0XHQvLyBPbmx5IGFkZCBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlciBpZiBleHBsaWNpdGx5IGVuYWJsZWRcblx0XHRpZiAodGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ3NFbmFibGVkICYmIFxuXHRcdFx0dGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ1Byb3ZpZGVyICYmIFxuXHRcdFx0dGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaUtleSkge1xuXHRcdFx0cHJvdmlkZXJzLnB1c2goXG5cdFx0XHRcdG5ldyBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlcihcblx0XHRcdFx0XHR0aGlzLFxuXHRcdFx0XHRcdHRoaXMuZW1iZWRkaW5nc0luZGV4LFxuXHRcdFx0XHRcdHRoaXMuYm0yNUluZGV4LFxuXHRcdFx0XHRcdCgpID0+IEJvb2xlYW4odGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ3NFbmFibGVkICYmIFxuXHRcdFx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdQcm92aWRlciAmJiBcblx0XHRcdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nQXBpS2V5KSxcblx0XHRcdFx0XHQocGF0aCkgPT4gIXRoaXMudmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKHBhdGgpXG5cdFx0XHRcdClcblx0XHRcdCk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdC8vIFVzZSBsb2NhbCBlbWJlZGRpbmdzIChoYXNoKVxuXHRcdFx0cHJvdmlkZXJzLnB1c2goXG5cdFx0XHRcdG5ldyBMb2NhbEVtYmVkZGluZ3NQcm92aWRlcihcblx0XHRcdFx0XHR0aGlzLmVtYmVkZGluZ3NJbmRleCxcblx0XHRcdFx0XHQoKSA9PiBCb29sZWFuKHRoaXMuc2V0dGluZ3MucmV0cmlldmFsRW5hYmxlU2VtYW50aWNJbmRleCksXG5cdFx0XHRcdFx0KHBhdGgpID0+ICF0aGlzLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChwYXRoKVxuXHRcdFx0XHQpXG5cdFx0XHQpO1xuXHRcdH1cblx0XHRcblx0XHR0aGlzLnJldHJpZXZhbFNlcnZpY2UgPSBuZXcgUmV0cmlldmFsU2VydmljZShwcm92aWRlcnMsIHsgZ2V0VmVjdG9yOiAoa2V5KSA9PiB0aGlzLmVtYmVkZGluZ3NJbmRleC5nZXRWZWN0b3JGb3JLZXkoa2V5KSB9KTtcblxuXHRcdC8vIEJhY2tncm91bmQgaW5kZXhpbmcgaG9va3MgKGJlc3QtZWZmb3J0OyBhbHdheXMgc2FmZSB0byBmYWlsKS5cblx0XHRjb25zdCBtYXliZVF1ZXVlSW5kZXggPSAocGF0aDogc3RyaW5nKSA9PiB7XG5cdFx0XHRpZiAodGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxJbmRleFBhdXNlZCkgcmV0dXJuO1xuXHRcdFx0aWYgKHRoaXMudmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKHBhdGgpKSByZXR1cm47XG5cdFx0XHRpZiAodGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVTZW1hbnRpY0luZGV4KSB0aGlzLmVtYmVkZGluZ3NJbmRleC5xdWV1ZVVwZGF0ZUZpbGUocGF0aCk7XG5cdFx0XHRpZiAodGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVCbTI1KSB0aGlzLmJtMjVJbmRleC5xdWV1ZVVwZGF0ZUZpbGUocGF0aCk7XG5cdFx0fTtcblxuXHRcdHRoaXMucmVnaXN0ZXJFdmVudChcblx0XHRcdHRoaXMuYXBwLnZhdWx0Lm9uKCdjcmVhdGUnLCAoZmlsZSkgPT4ge1xuXHRcdFx0XHRpZiAoZmlsZSBpbnN0YW5jZW9mIFRGaWxlICYmIGZpbGUuZXh0ZW5zaW9uID09PSAnbWQnKSB7XG5cdFx0XHRcdFx0bWF5YmVRdWV1ZUluZGV4KGZpbGUucGF0aCk7XG5cdFx0XHRcdH1cblx0XHRcdH0pXG5cdFx0KTtcblx0XHR0aGlzLnJlZ2lzdGVyRXZlbnQoXG5cdFx0XHR0aGlzLmFwcC52YXVsdC5vbignbW9kaWZ5JywgKGZpbGUpID0+IHtcblx0XHRcdFx0aWYgKGZpbGUgaW5zdGFuY2VvZiBURmlsZSAmJiBmaWxlLmV4dGVuc2lvbiA9PT0gJ21kJykge1xuXHRcdFx0XHRcdG1heWJlUXVldWVJbmRleChmaWxlLnBhdGgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9KVxuXHRcdCk7XG5cdFx0dGhpcy5yZWdpc3RlckV2ZW50KFxuXHRcdFx0dGhpcy5hcHAudmF1bHQub24oJ2RlbGV0ZScsIChmaWxlKSA9PiB7XG5cdFx0XHRcdGlmIChmaWxlIGluc3RhbmNlb2YgVEZpbGUgJiYgZmlsZS5leHRlbnNpb24gPT09ICdtZCcpIHtcblx0XHRcdFx0XHR0aGlzLmVtYmVkZGluZ3NJbmRleC5xdWV1ZVJlbW92ZUZpbGUoZmlsZS5wYXRoKTtcblx0XHRcdFx0XHR0aGlzLmJtMjVJbmRleC5xdWV1ZVJlbW92ZUZpbGUoZmlsZS5wYXRoKTtcblx0XHRcdFx0fVxuXHRcdFx0fSlcblx0XHQpO1xuXHRcdHRoaXMucmVnaXN0ZXJFdmVudChcblx0XHRcdHRoaXMuYXBwLnZhdWx0Lm9uKCdyZW5hbWUnLCAoZmlsZSwgb2xkUGF0aCkgPT4ge1xuXHRcdFx0XHRpZiAoIShmaWxlIGluc3RhbmNlb2YgVEZpbGUpIHx8IGZpbGUuZXh0ZW5zaW9uICE9PSAnbWQnKSByZXR1cm47XG5cdFx0XHRcdHRoaXMuZW1iZWRkaW5nc0luZGV4LnF1ZXVlUmVtb3ZlRmlsZShvbGRQYXRoKTtcblx0XHRcdFx0dGhpcy5ibTI1SW5kZXgucXVldWVSZW1vdmVGaWxlKG9sZFBhdGgpO1xuXHRcdFx0XHRtYXliZVF1ZXVlSW5kZXgoZmlsZS5wYXRoKTtcblx0XHRcdH0pXG5cdFx0KTtcblxuXHRcdC8vIEluaXRpYWwgYmVzdC1lZmZvcnQgc2Nhbi5cblx0XHRpZiAodGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVTZW1hbnRpY0luZGV4ICYmICF0aGlzLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSB7XG5cdFx0XHR0aGlzLmVtYmVkZGluZ3NJbmRleC5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdH1cblx0XHRpZiAodGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVCbTI1ICYmICF0aGlzLnNldHRpbmdzLnJldHJpZXZhbEluZGV4UGF1c2VkKSB7XG5cdFx0XHR0aGlzLmJtMjVJbmRleC5lbnF1ZXVlRnVsbFJlc2NhbigpO1xuXHRcdH1cblx0XHRcblx0XHR0aGlzLnJlZ2lzdGVyVmlldyhcblx0XHRcdFZJRVdfVFlQRV9EQVNIQk9BUkQsXG5cdFx0XHQobGVhZikgPT4gbmV3IERhc2hib2FyZFZpZXcobGVhZiwgdGhpcylcblx0XHQpO1xuXHRcdFxuXHRcdHRoaXMuYWRkUmliYm9uSWNvbignYm9vay1vcGVuJywgJ09wZW4gZGFzaGJvYXJkJywgKCkgPT4ge1xuXHRcdFx0Ly8gQXZvaWQgZmxvYXRpbmcgcHJvbWlzZSAoYWN0aXZhdGVWaWV3IGlzIGFzeW5jKVxuXHRcdFx0dm9pZCB0aGlzLmFjdGl2YXRlVmlldygpO1xuXHRcdH0pO1xuXHRcdFxuXHRcdHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgU2V0dGluZ3NUYWIodGhpcy5hcHAsIHRoaXMpKTtcblx0XHRcblx0XHR0aGlzLmFkZENvbW1hbmQoe1xuXHRcdFx0aWQ6ICdvcGVuLWRhc2hib2FyZCcsXG5cdFx0XHRuYW1lOiAnT3BlbiBkYXNoYm9hcmQnLFxuXHRcdFx0Y2FsbGJhY2s6ICgpID0+IHtcblx0XHRcdFx0Ly8gQXZvaWQgZmxvYXRpbmcgcHJvbWlzZSAoYWN0aXZhdGVWaWV3IGlzIGFzeW5jKVxuXHRcdFx0XHR2b2lkIHRoaXMuYWN0aXZhdGVWaWV3KCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHR0aGlzLmFkZENvbW1hbmQoe1xuXHRcdFx0aWQ6ICdydW4tc2V0dXAtd2l6YXJkJyxcblx0XHRcdG5hbWU6ICdSdW4gc2V0dXAgd2l6YXJkJyxcblx0XHRcdGNhbGxiYWNrOiAoKSA9PiB7XG5cdFx0XHRcdHRoaXMuc2hvd1NldHVwV2l6YXJkKCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHR0aGlzLmFkZENvbW1hbmQoe1xuXHRcdFx0aWQ6ICdydW4tZ3VpZGVkLWRlbW8nLFxuXHRcdFx0bmFtZTogJ1J1biBndWlkZWQgZGVtbycsXG5cdFx0XHRjYWxsYmFjazogKCkgPT4ge1xuXHRcdFx0XHR0aGlzLnJlcXVlc3RHdWlkZWREZW1vU3RhcnQoKTtcblx0XHRcdH1cblx0XHR9KTtcblxuXHRcdHRoaXMuYWRkQ29tbWFuZCh7XG5cdFx0XHRpZDogJ2V4cG9ydC10by1lcHViJyxcblx0XHRcdG5hbWU6ICdFeHBvcnQgdG8gZXB1YicsXG5cdFx0XHRjYWxsYmFjazogKCkgPT4ge1xuXHRcdFx0XHR0aGlzLnNob3dQdWJsaXNoV2l6YXJkKCk7XG5cdFx0XHR9XG5cdFx0fSk7XG5cblx0XHQvLyBDaGVjayBmb3IgZmlyc3QtcnVuIHNldHVwXG5cdFx0aWYgKCF0aGlzLnNldHRpbmdzLnNldHVwQ29tcGxldGVkKSB7XG5cdFx0XHQvLyBUcmVhdCBzZXR1cCBhcyBjb21wbGV0ZSBpZiB0aGUgY29uZmlndXJlZCBCb29rIE1haW4gUGF0aCBleGlzdHNcblx0XHRcdGNvbnN0IGJvb2tNYWluRXhpc3RzID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRoaXMuc2V0dGluZ3MuYm9vazJQYXRoKSAhPT0gbnVsbDtcblx0XHRcdGlmICghYm9va01haW5FeGlzdHMpIHtcblx0XHRcdFx0Ly8gSWYgdmF1bHQgYXBwZWFycyBwb3B1bGF0ZWQsIGFzayB1c2VyIHdoaWNoIGZpbGUgaXMgdGhlIG1haW4gYm9vayBmaWxlXG5cdFx0XHRcdGNvbnN0IG1kRmlsZXMgPSB0aGlzLmFwcC52YXVsdC5nZXRNYXJrZG93bkZpbGVzKCk7XG5cdFx0XHRcdGlmIChtZEZpbGVzLmxlbmd0aCA+IDApIHtcblx0XHRcdFx0XHRjb25zdCBtb2RhbCA9IG5ldyBCb29rTWFpblNlbGVjdG9yTW9kYWwodGhpcyk7XG5cdFx0XHRcdFx0bW9kYWwub3BlbigpO1xuXHRcdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBTaG93IHNldHVwIHdpemFyZCBhdXRvbWF0aWNhbGx5IG9uIGZpcnN0IHJ1blxuXHRcdFx0XHR0aGlzLnNob3dTZXR1cFdpemFyZCgpO1xuXHRcdFx0XHR9XG5cdFx0XHR9IGVsc2Uge1xuXHRcdFx0XHQvLyBCb29rIGZpbGUgZXhpc3RzLCBtYXJrIHNldHVwIGFzIGNvbXBsZXRlZFxuXHRcdFx0XHR0aGlzLnNldHRpbmdzLnNldHVwQ29tcGxldGVkID0gdHJ1ZTtcblx0XHRcdFx0YXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcblx0XHRcdH1cblx0XHR9XG5cdH1cblxuXHRzaG93U2V0dXBXaXphcmQoKSB7XG5cdFx0Y29uc3QgbW9kYWwgPSBuZXcgU2V0dXBXaXphcmRNb2RhbCh0aGlzKTtcblx0XHRtb2RhbC5vcGVuKCk7XG5cdH1cblxuXHRzaG93UHVibGlzaFdpemFyZCgpIHtcblx0XHRjb25zdCBtb2RhbCA9IG5ldyBQdWJsaXNoV2l6YXJkTW9kYWwodGhpcyk7XG5cdFx0bW9kYWwub3BlbigpO1xuXHR9XG5cblx0LyoqXG5cdCAqIFJlY3JlYXRlIHRoZSByZXRyaWV2YWwgc2VydmljZSB3aXRoIHRoZSBjdXJyZW50IHNldHRpbmdzLlxuXHQgKiBDYWxsZWQgd2hlbiByZXRyaWV2YWxTb3VyY2Ugb3Igb3RoZXIgcmV0cmlldmFsIHNldHRpbmdzIGNoYW5nZS5cblx0ICovXG5cdHJlY3JlYXRlUmV0cmlldmFsU2VydmljZSgpOiB2b2lkIHtcblx0XHRjb25zdCBzY1Byb3ZpZGVyID0gbmV3IFNtYXJ0Q29ubmVjdGlvbnNQcm92aWRlcih0aGlzLmFwcCwgdGhpcywgdGhpcy5hcHAudmF1bHQsIChwYXRoKSA9PiAhdGhpcy52YXVsdFNlcnZpY2UuaXNFeGNsdWRlZFBhdGgocGF0aCkpO1xuXHRcdHRoaXMuc21hcnRDb25uZWN0aW9uc1Byb3ZpZGVyID0gc2NQcm92aWRlcjtcblx0XHRcblx0XHRjb25zdCBwcm92aWRlcnM6IEFycmF5PGltcG9ydCgnLi9zZXJ2aWNlcy9yZXRyaWV2YWwvdHlwZXMnKS5SZXRyaWV2YWxQcm92aWRlcj4gPSBbXG5cdFx0XHRuZXcgSGV1cmlzdGljUHJvdmlkZXIodGhpcy5hcHAudmF1bHQsIHRoaXMudmF1bHRTZXJ2aWNlKSxcblx0XHRcdG5ldyBCbTI1UHJvdmlkZXIodGhpcy5ibTI1SW5kZXgsICgpID0+IEJvb2xlYW4odGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVCbTI1KSwgKHBhdGgpID0+ICF0aGlzLnZhdWx0U2VydmljZS5pc0V4Y2x1ZGVkUGF0aChwYXRoKSksXG5cdFx0XHRzY1Byb3ZpZGVyXG5cdFx0XTtcblx0XHRcblx0XHQvLyBPbmx5IGFkZCBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlciBpZiBleHBsaWNpdGx5IGVuYWJsZWRcblx0XHRpZiAodGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ3NFbmFibGVkICYmIFxuXHRcdFx0dGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ1Byb3ZpZGVyICYmIFxuXHRcdFx0dGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ0FwaUtleSkge1xuXHRcdFx0cHJvdmlkZXJzLnB1c2goXG5cdFx0XHRcdG5ldyBFeHRlcm5hbEVtYmVkZGluZ3NQcm92aWRlcihcblx0XHRcdFx0XHR0aGlzLFxuXHRcdFx0XHRcdHRoaXMuZW1iZWRkaW5nc0luZGV4LFxuXHRcdFx0XHRcdHRoaXMuYm0yNUluZGV4LFxuXHRcdFx0XHRcdCgpID0+IEJvb2xlYW4odGhpcy5zZXR0aW5ncy5leHRlcm5hbEVtYmVkZGluZ3NFbmFibGVkICYmIFxuXHRcdFx0XHRcdFx0XHRcdHRoaXMuc2V0dGluZ3MuZXh0ZXJuYWxFbWJlZGRpbmdQcm92aWRlciAmJiBcblx0XHRcdFx0XHRcdFx0XHR0aGlzLnNldHRpbmdzLmV4dGVybmFsRW1iZWRkaW5nQXBpS2V5KSxcblx0XHRcdFx0XHQocGF0aCkgPT4gIXRoaXMudmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKHBhdGgpXG5cdFx0XHRcdClcblx0XHRcdCk7XG5cdFx0fVxuXHRcdFxuXHRcdGlmICh0aGlzLnNldHRpbmdzLnJldHJpZXZhbFNvdXJjZSA9PT0gJ2V4dGVybmFsLWFwaScpIHtcblx0XHRcdC8vIFRoaXMgYnJhbmNoIGlzIG5vdyBoYW5kbGVkIGFib3ZlIC0ga2VlcGluZyBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eVxuXHRcdH0gZWxzZSB7XG5cdFx0XHRwcm92aWRlcnMucHVzaChcblx0XHRcdFx0bmV3IExvY2FsRW1iZWRkaW5nc1Byb3ZpZGVyKFxuXHRcdFx0XHRcdHRoaXMuZW1iZWRkaW5nc0luZGV4LFxuXHRcdFx0XHRcdCgpID0+IEJvb2xlYW4odGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxFbmFibGVTZW1hbnRpY0luZGV4KSxcblx0XHRcdFx0XHQocGF0aCkgPT4gIXRoaXMudmF1bHRTZXJ2aWNlLmlzRXhjbHVkZWRQYXRoKHBhdGgpXG5cdFx0XHRcdClcblx0XHRcdCk7XG5cdFx0fVxuXHRcdFxuXHRcdHRoaXMucmV0cmlldmFsU2VydmljZSA9IG5ldyBSZXRyaWV2YWxTZXJ2aWNlKHByb3ZpZGVycywgeyBnZXRWZWN0b3I6IChrZXkpID0+IHRoaXMuZW1iZWRkaW5nc0luZGV4LmdldFZlY3RvckZvcktleShrZXkpIH0pO1xuXHR9XG5cblxuXHRyZXF1ZXN0R3VpZGVkRGVtb1N0YXJ0KCkge1xuXHRcdHRoaXMuZ3VpZGVkRGVtb1N0YXJ0UmVxdWVzdGVkID0gdHJ1ZTtcblx0XHR0aGlzLm5vdGlmeVVpKCd3cml0aW5nLWRhc2hib2FyZDpndWlkZWQtZGVtby1zdGFydCcpO1xuXHRcdHZvaWQgdGhpcy5hY3RpdmF0ZVZpZXcoKTtcblx0fVxuXG5cdGFzeW5jIG9udW5sb2FkKCkge1xuXHRcdC8vIENsZWFudXAgaWYgbmVlZGVkXG5cdH1cblxuXHRhc3luYyBsb2FkU2V0dGluZ3MoKSB7XG5cdFx0Y29uc3QgbG9hZGVkID0gKGF3YWl0IHRoaXMubG9hZERhdGEoKSkgYXMgUGFydGlhbDxEYXNoYm9hcmRTZXR0aW5ncz4gfCBudWxsO1xuXHRcdHRoaXMuc2V0dGluZ3MgPSBPYmplY3QuYXNzaWduKHt9LCBERUZBVUxUX1NFVFRJTkdTLCBsb2FkZWQgfHwge30pO1xuXG5cdFx0Ly8gTWlncmF0aW9ucyAvIGRlZmF1bHRzIGZvciBuZXcgc2V0dGluZ3Ncblx0XHRpZiAoIXRoaXMuc2V0dGluZ3MubW9kZVN0YXRlKSB7XG5cdFx0XHR0aGlzLnNldHRpbmdzLm1vZGVTdGF0ZSA9IERFRkFVTFRfU0VUVElOR1MubW9kZVN0YXRlO1xuXHRcdH0gZWxzZSB7XG5cdFx0XHQvLyBGaWxsIG1pc3Npbmcgc3Via2V5cyAobm9uLWRlc3RydWN0aXZlKVxuXHRcdFx0dGhpcy5zZXR0aW5ncy5tb2RlU3RhdGUgPSB7XG5cdFx0XHRcdC4uLkRFRkFVTFRfU0VUVElOR1MubW9kZVN0YXRlLFxuXHRcdFx0XHQuLi50aGlzLnNldHRpbmdzLm1vZGVTdGF0ZSxcblx0XHRcdFx0Y2hhcHRlcjogeyAuLi5ERUZBVUxUX1NFVFRJTkdTLm1vZGVTdGF0ZS5jaGFwdGVyLCAuLi4odGhpcy5zZXR0aW5ncy5tb2RlU3RhdGUuY2hhcHRlciB8fCB7fSkgfSxcblx0XHRcdFx0bWljcm9FZGl0OiB7IC4uLkRFRkFVTFRfU0VUVElOR1MubW9kZVN0YXRlLm1pY3JvRWRpdCwgLi4uKHRoaXMuc2V0dGluZ3MubW9kZVN0YXRlLm1pY3JvRWRpdCB8fCB7fSkgfSxcblx0XHRcdFx0Y2hhcmFjdGVyVXBkYXRlOiB7IC4uLkRFRkFVTFRfU0VUVElOR1MubW9kZVN0YXRlLmNoYXJhY3RlclVwZGF0ZSwgLi4uKHRoaXMuc2V0dGluZ3MubW9kZVN0YXRlLmNoYXJhY3RlclVwZGF0ZSB8fCB7fSkgfSxcblx0XHRcdFx0Y29udGludWl0eUNoZWNrOiB7XG5cdFx0XHRcdFx0Li4uREVGQVVMVF9TRVRUSU5HUy5tb2RlU3RhdGUuY29udGludWl0eUNoZWNrLFxuXHRcdFx0XHRcdC4uLih0aGlzLnNldHRpbmdzLm1vZGVTdGF0ZS5jb250aW51aXR5Q2hlY2sgfHwge30pLFxuXHRcdFx0XHRcdGZvY3VzOiB7XG5cdFx0XHRcdFx0XHQuLi5ERUZBVUxUX1NFVFRJTkdTLm1vZGVTdGF0ZS5jb250aW51aXR5Q2hlY2suZm9jdXMsXG5cdFx0XHRcdFx0XHQuLi4oKHRoaXMuc2V0dGluZ3MubW9kZVN0YXRlLmNvbnRpbnVpdHlDaGVjayB8fCB7fSkuZm9jdXMgfHwge30pXG5cdFx0XHRcdFx0fVxuXHRcdFx0XHR9XG5cdFx0XHR9O1xuXHRcdH1cblxuXHRcdC8vIFJldHJpZXZhbCBwcm9maWxlczogZW5zdXJlIHByZWJ1aWx0IHByb2ZpbGVzIGV4aXN0LlxuXHRcdGlmICghQXJyYXkuaXNBcnJheSh0aGlzLnNldHRpbmdzLnJldHJpZXZhbFByb2ZpbGVzKSB8fCB0aGlzLnNldHRpbmdzLnJldHJpZXZhbFByb2ZpbGVzLmxlbmd0aCA9PT0gMCkge1xuXHRcdFx0Y29uc3QgcGFyZW50T2YgPSAocDogc3RyaW5nKSA9PiB7XG5cdFx0XHRcdGNvbnN0IG5vcm0gPSAocCB8fCAnJykucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xuXHRcdFx0XHRjb25zdCBpZHggPSBub3JtLmxhc3RJbmRleE9mKCcvJyk7XG5cdFx0XHRcdHJldHVybiBpZHggPj0gMCA/IG5vcm0uc2xpY2UoMCwgaWR4KSA6ICcnO1xuXHRcdFx0fTtcblx0XHRcdFxuXHRcdFx0Ly8gQnVpbGQgc3RvcnlJbmNsdWRlZCBmcm9tIGV4aXN0aW5nIGZvbGRlcnMsIGJ1dCBkZWZhdWx0IHRvIGVtcHR5IGFycmF5ICh3aG9sZSB2YXVsdClcblx0XHRcdGNvbnN0IHN0b3J5Rm9sZGVycyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXHRcdFx0aWYgKHRoaXMuc2V0dGluZ3MuY2hhcmFjdGVyRm9sZGVyKSBzdG9yeUZvbGRlcnMuYWRkKHRoaXMuc2V0dGluZ3MuY2hhcmFjdGVyRm9sZGVyKTtcblx0XHRcdGNvbnN0IGJvb2tQYXJlbnQgPSBwYXJlbnRPZih0aGlzLnNldHRpbmdzLmJvb2syUGF0aCk7XG5cdFx0XHRpZiAoYm9va1BhcmVudCkgc3RvcnlGb2xkZXJzLmFkZChib29rUGFyZW50KTtcblx0XHRcdGNvbnN0IGJpYmxlUGFyZW50ID0gcGFyZW50T2YodGhpcy5zZXR0aW5ncy5zdG9yeUJpYmxlUGF0aCk7XG5cdFx0XHRpZiAoYmlibGVQYXJlbnQpIHN0b3J5Rm9sZGVycy5hZGQoYmlibGVQYXJlbnQpO1xuXHRcdFx0Ly8gUmVtb3ZlIGVtcHR5IGVudHJpZXNcblx0XHRcdGNvbnN0IHN0b3J5SW5jbHVkZWQgPSBBcnJheS5mcm9tKHN0b3J5Rm9sZGVycykubWFwKChzKSA9PiAocyB8fCAnJykucmVwbGFjZSgvXFwvKyQvLCAnJykpLmZpbHRlcigocykgPT4gcy5sZW5ndGggPiAwKTtcblxuXHRcdFx0Ly8gRGVmYXVsdCBcIlN0b3J5XCIgcHJvZmlsZTogZW1wdHkgYXJyYXkgbWVhbnMgXCJpbmNsdWRlIHdob2xlIHZhdWx0XCJcblx0XHRcdC8vIFVzZXJzIGNhbiBzZWxlY3RpdmVseSBpbmNsdWRlIGZvbGRlcnMgaWYgdGhleSB3YW50IHRvIGxpbWl0IHNjb3BlXG5cdFx0XHR0aGlzLnNldHRpbmdzLnJldHJpZXZhbFByb2ZpbGVzID0gW1xuXHRcdFx0XHR7IGlkOiAnc3RvcnknLCBuYW1lOiAnU3RvcnknLCBpbmNsdWRlZEZvbGRlcnM6IHN0b3J5SW5jbHVkZWQubGVuZ3RoID4gMCA/IHN0b3J5SW5jbHVkZWQgOiBbXSB9LFxuXHRcdFx0XHR7IGlkOiAncmVzZWFyY2gnLCBuYW1lOiAnUmVzZWFyY2gnLCBpbmNsdWRlZEZvbGRlcnM6IFsnUmVzZWFyY2gnLCAnV29ybGRidWlsZGluZyddIH0sXG5cdFx0XHRcdHsgaWQ6ICdtYW51c2NyaXB0JywgbmFtZTogJ01hbnVzY3JpcHQgb25seScsIGluY2x1ZGVkRm9sZGVyczogYm9va1BhcmVudCA/IFtib29rUGFyZW50XSA6IFtdIH1cblx0XHRcdF07XG5cdFx0XHR0aGlzLnNldHRpbmdzLnJldHJpZXZhbEFjdGl2ZVByb2ZpbGVJZCA9ICdzdG9yeSc7XG5cdFx0fVxuXG5cdFx0Y29uc3QgaGFzQWN0aXZlID0gdGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxQcm9maWxlcy5zb21lKChwKSA9PiBwLmlkID09PSB0aGlzLnNldHRpbmdzLnJldHJpZXZhbEFjdGl2ZVByb2ZpbGVJZCk7XG5cdFx0aWYgKCFoYXNBY3RpdmUpIHRoaXMuc2V0dGluZ3MucmV0cmlldmFsQWN0aXZlUHJvZmlsZUlkID0gdGhpcy5zZXR0aW5ncy5yZXRyaWV2YWxQcm9maWxlc1swXT8uaWQgfHwgJ3N0b3J5Jztcblx0fVxuXG5cdGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcblx0XHRhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuXHRcdHRoaXMubm90aWZ5VWkoJ3dyaXRpbmctZGFzaGJvYXJkOnNldHRpbmdzLWNoYW5nZWQnKTtcblx0fVxuXG5cdC8qKlxuXHQgKiBBdXRvLWdlbmVyYXRlIFNtYXJ0IENvbm5lY3Rpb25zIHRlbXBsYXRlIGZpbGUgaWYgaXQgZG9lc24ndCBleGlzdC5cblx0ICogQ3JlYXRlcyB0aGUgdGVtcGxhdGUgaW4gYSB2aXNpYmxlIHJvb3QtbGV2ZWwgZm9sZGVyLlxuXHQgKiBSZXR1cm5zIHRoZSBwYXRoIHRvIHRoZSB0ZW1wbGF0ZSBmaWxlLlxuXHQgKi9cblx0YXN5bmMgZW5zdXJlU21hcnRDb25uZWN0aW9uc1RlbXBsYXRlKCk6IFByb21pc2U8c3RyaW5nPiB7XG5cdFx0Ly8gVXNlIGEgdmlzaWJsZSBmb2xkZXIgYXQgcm9vdCBsZXZlbCAtIG5vIGRvdCBwcmVmaXgsIG9idmlvdXNseSBhcHBhcmVudFxuXHRcdGNvbnN0IHRlbXBsYXRlc0ZvbGRlciA9ICdXcml0aW5nIERhc2hib2FyZCBUZW1wbGF0ZXMnO1xuXHRcdFxuXHRcdC8vIENyZWF0ZSBmb2xkZXIgaWYgaXQgZG9lc24ndCBleGlzdFxuXHRcdGF3YWl0IHRoaXMudmF1bHRTZXJ2aWNlLmNyZWF0ZUZvbGRlcklmTm90RXhpc3RzKHRlbXBsYXRlc0ZvbGRlcik7XG5cdFx0XG5cdFx0Ly8gVGVtcGxhdGUgZmlsZSBwYXRoXG5cdFx0Y29uc3QgdGVtcGxhdGVQYXRoID0gYCR7dGVtcGxhdGVzRm9sZGVyfS9TQy1UZW1wbGF0ZS5tZGA7XG5cdFx0Y29uc3QgdGVtcGxhdGVGaWxlID0gdGhpcy5hcHAudmF1bHQuZ2V0QWJzdHJhY3RGaWxlQnlQYXRoKHRlbXBsYXRlUGF0aCk7XG5cdFx0XG5cdFx0aWYgKCEodGVtcGxhdGVGaWxlIGluc3RhbmNlb2YgVEZpbGUpKSB7XG5cdFx0XHQvLyBDcmVhdGUgdGVtcGxhdGUgZmlsZSB3aXRoIFNtYXJ0IENvbm5lY3Rpb25zIHN5bnRheFxuXHRcdFx0Y29uc3QgdGVtcGxhdGVDb250ZW50ID0gJ3t7c21hcnQtY29ubmVjdGlvbnM6c2ltaWxhcjoxMjh9fSc7XG5cdFx0XHRhd2FpdCB0aGlzLnZhdWx0U2VydmljZS53cml0ZUZpbGUodGVtcGxhdGVQYXRoLCB0ZW1wbGF0ZUNvbnRlbnQpO1xuXHRcdFx0XG5cdFx0XHQvLyBBdXRvLWNvbmZpZ3VyZSB0aGUgcGF0aCBpbiBzZXR0aW5nc1xuXHRcdFx0dGhpcy5zZXR0aW5ncy5zbWFydENvbm5lY3Rpb25zVGVtcGxhdGVQYXRoID0gdGVtcGxhdGVQYXRoO1xuXHRcdFx0YXdhaXQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcblx0XHR9XG5cdFx0XG5cdFx0cmV0dXJuIHRlbXBsYXRlUGF0aDtcblx0fVxuXG5cdGFzeW5jIGFjdGl2YXRlVmlldygpIHtcblx0XHRjb25zdCB7IHdvcmtzcGFjZSB9ID0gdGhpcy5hcHA7XG5cdFx0bGV0IGxlYWYgPSB3b3Jrc3BhY2UuZ2V0TGVhdmVzT2ZUeXBlKFZJRVdfVFlQRV9EQVNIQk9BUkQpWzBdO1xuXHRcdFxuXHRcdGlmICghbGVhZikge1xuXHRcdFx0bGVhZiA9IHdvcmtzcGFjZS5nZXRSaWdodExlYWYoZmFsc2UpO1xuXHRcdFx0YXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoeyB0eXBlOiBWSUVXX1RZUEVfREFTSEJPQVJELCBhY3RpdmU6IHRydWUgfSk7XG5cdFx0fVxuXHRcdFxuXHRcdHdvcmtzcGFjZS5yZXZlYWxMZWFmKGxlYWYpO1xuXHR9XG59XG5cbiJdfQ==