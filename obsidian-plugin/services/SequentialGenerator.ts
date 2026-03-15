import {
    ChapterState,
    AuditResult,
    PatchOp,
    RunManifest,
    StageResult,
    ContextBundleManifest,
    Violation,
    CanonFact,
    ParagraphMetadata,
    MismatchReport,
    AttributeRegistry,
    RunState,
    InterventionEvent,
    InterventionTriggerReason,
    InterventionGuidance,
    RunContinuation,
    PlotMemory,
    ProtectionReason,
    ProtectionEdge,
    ProtectionEdgeType,
    BranchStatus,
    InterventionRollbackEvent,
    PolicySnapshot,
    RunIndex,
    RunHealthCode,
    ArtifactManifest,
    ArtifactSchemaVersions,
    RequiredArtifactsByStage,
    healthSeverity
} from './Schemas';
import {
    PatchOp as StitchPatchOp,
    sortPatchOps
} from '../contracts/StitchContract';
import {
    ReplayPrereqs,
    determineReplayTier
} from '../contracts/ReplayContract';
import { ContextManager } from './ContextManager';
import { AuditService } from './AuditService';
import { ProseStitcher } from './ProseStitcher';
import { ParagraphIdentityService } from './ParagraphIdentityService';
import { CO_AUTHORING_POLICY } from './policy';
import { App, Notice, TFile, TFolder } from 'obsidian';
import { relayEventBus } from './EventBus';
import WritingDashboardPlugin from '../main';
import { sha256, contentHash, canonicalJsonStringify, normalizeWhitespace, fnv1a32 } from './ContentHash';
import { showInterventionModal } from '../ui/InterventionModal';
import { LoreHarvestService } from './LoreHarvestService';
import { showHarvestChecklistModal } from '../ui/HarvestChecklistModal';
import { RunPaths } from './RunPaths';
import { CloudRelay, WriteChapterInput, EditChapterInput } from './CloudRelay';
import { ContextPacker } from './ContextPacker';
import { estimateTokens } from './TokenEstimate';
import { getContextLimit } from './ContextSafety';
import { gwlog, gwwarn, gwerr, gwlogRunStart, gwSnip, gwWords } from './GWLogger';

/**
 * SequentialGenerator is the "Brain" of the relay drafting race.
 * It manages the Plan-Retrieve-Write-Verify-Repair loop as a version-pinned state machine.
 */
export class SequentialGenerator {
    private readonly plugin: WritingDashboardPlugin;
    private readonly proseStitcher: ProseStitcher;
    private readonly identityService: ParagraphIdentityService;
    private readonly loreHarvestService: LoreHarvestService;
    private readonly auditService: AuditService;
    private abortController: AbortController | null = null;

    private state: RunState = 'idle';
    private currentRunId: string | null = null; // UUID (logical identity)
    private currentRunKey: string | null = null; // Folder name (e.g., "run-1735689600")
    private manifest: RunManifest | null = null;
    private commitLock: boolean = false;
    private dryRun: boolean = false;
    private interventionCount: number = 0;
    private readonly interventionCountPerChunk: Map<string, number> = new Map();
    private contextManager: ContextManager | null = null;
    private readonly entitiesMentionedHistory: Map<string, string[]> = new Map(); // chunkId -> entityIds
    private rollingWindow: { id: string, text: string, hash: string, status: 'STREAMING' | 'FINALIZED' | 'USER_DIRTY' }[][] = []; // Last 3 chunks
    private currentSceneSummary: string = ''; // Author's directions for the current run

    // ── Two-phase generation state ──────────────────────────────────────────
    private currentPhase: 1 | 2 = 1;        // Active generation phase
    private phase2Direction: string | null = null; // Optional midpoint steering (from author)
    private phase2DirectionResolver: ((direction: string | null) => void) | null = null;
    private chapterPlan: string = '';        // Single OSC plan governing both phases
    private readonly lastAppliedSeqNo: Map<string, number> = new Map(); // seamId -> seqNo
    private readonly seamTaskCounters: Map<string, number> = new Map(); // seamId -> counter
    private readonly sessionId: string = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private readonly cloudRelay: CloudRelay | null = null;
    private readonly contextPacker: ContextPacker | null = null;

    constructor(app: App, plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
        this.proseStitcher = new ProseStitcher(plugin);
        this.identityService = new ParagraphIdentityService();
        this.loreHarvestService = new LoreHarvestService(plugin);
        this.auditService = new AuditService();
        this.cloudRelay = new CloudRelay(plugin);
        this.contextPacker = new ContextPacker();
    }

    getCurrentRunId(): string | null {
        return this.currentRunId;
    }

    getCurrentSessionId(): string {
        return this.sessionId;
    }

    /**
     * Returns the appropriate generation profile for a given stage.
     * Consolidates creative vs mechanical tasks for single-model efficiency.
     */
    private getTaskProfile(stageType: string) {
        const isMechanical = ['PLAN', 'RETRIEVE', 'AUDIT', 'UPDATE', 'REPAIR', 'STITCH', 'HARVEST'].includes(stageType);

        return {
            model: this.plugin.settings.model,
            temperature: isMechanical ? 0.1 : 0.7,
            max_tokens: isMechanical ? 1024 : 4096,
            format: isMechanical ? 'json' as const : undefined
        };
    }

    // ---------------------------------------------------------------------------
    // generateChapter helpers
    // ---------------------------------------------------------------------------

    private _isGenerationRunning(): boolean {
        return this.state === 'RUNNING' || this.state === 'PAUSED_FOR_INTERVENTION' || this.state === 'RESUMING';
    }

    private _isRamBlocked(_smartModel: string): boolean {
        // RAM tier checking removed (local AI removed). Always returns false for cloud mode.
        return false;
    }

    private _buildInitialChapterState(): ChapterState {
        return {
            chapterId: `chapter-${Date.now()}`,
            canonVersion: 1,
            entities: [],
            canonFacts: [],
            mutationHistory: [],
            timeline: [],
            openLoops: [],
            constraints: {
                pov: this.plugin.settings.defaultPOV || 'third-person-limited',
                tense: this.plugin.settings.defaultTense || 'past',
                tone: ['noir'],
                forbidden: []
            }
        } as ChapterState;
    }

    private async _buildEnvironmentMeta(smartModel: string, policyHash: string, corpusHash: string): Promise<RunManifest['environment']> {
        const pluginVersion = this.plugin.manifest.version || '1.0.3';
        const indexStatus = this.plugin.embeddingsIndex.getStatus();
        return {
            pluginVersion,
            policyHash,
            promptTemplateHash: await sha256(JSON.stringify(this.plugin.promptEngine)),
            scoringProfileHash: policyHash,
            modelBackend: 'cloud',
            modelId: smartModel,
            vaultSnapshotHash: corpusHash,
            indexVersion: indexStatus.indexedChunks,
            timestamp: Date.now()
        };
    }

    private async _initManifest(
        smartModel: string,
        smartModelDigest: string | null,
        policyHash: string,
        corpusHash: string,
        initialState: ChapterState,
        storyBibleHash: string,
        environment: RunManifest['environment']
    ): Promise<void> {
        const pluginVersion = this.plugin.manifest.version || '1.0.3';
        this.manifest = {
            runId: this.currentRunId!,
            runKey: this.currentRunKey!,
            chapterId: initialState.chapterId,
            startTime: Date.now(),
            storyBibleHash,
            initialStateHash: await sha256(JSON.stringify(initialState)),
            stages: [],
            config: {
                smartModel,
                smartModelDigest,
                maxChunkWords: this.plugin.settings.maxChunkWords || 2500,
                temperature: 0.7,
                policyHash,
                corpusHash,
                pluginVersion
            },
            environment,
            replayable: false,
            interventions: [],
            continuations: [],
            plotMemorySnapshots: []
        };
    }

    private _getSpontaneityAndRisk(iteration: number, contextManager: ContextManager) {
        const sliderValue = (this.plugin.settings as any).spontaneitySlider || 50;
        const rawParams = this.getSpontaneityParams(sliderValue);
        const risk = iteration > 1 ? this.calculateContinuityRisk(iteration - 1, contextManager) : 0;
        const effectiveNovelty = this.applySmoothClamp(rawParams.novelty, risk);
        return { sliderValue, rawParams, effectiveNovelty };
    }

    private _updateSpontaneityProfile(sliderValue: number, rawParams: { temp: number; novelty: number; stickyMin: number }, effectiveNovelty: number): void {
        this.manifest!.config.spontaneityProfile = {
            sliderValue,
            temp: rawParams.temp,
            novelty: effectiveNovelty,
            stickyMin: rawParams.stickyMin
        };
    }

    private async _runPlanStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        mechanicalProfile: ReturnType<typeof this.getTaskProfile>,
        initialState: ChapterState,
        iteration: number
    ): Promise<StageResult | null> {
        const sceneSummaryBlock = this.currentSceneSummary
            ? `\n\nAUTHOR'S SCENE DIRECTIONS — the prose must realise exactly this:\n"""\n${this.currentSceneSummary}\n"""`
            : '';
        const prompt = `Plan the next ${this.manifest!.config.maxChunkWords} words of narrative prose.${sceneSummaryBlock}\n\nProduce a brief beat-by-beat plan that will be handed to the writer.`;
        return this.runStage('PLAN', smartProfile.model, async () => {
            return await this.plugin.aiClient.generate(prompt, { ...this.plugin.settings, generationMode: 'single' as const });
        }, undefined, await sha256(prompt));
    }

    /**
     * Generates ONE OSC-structured chapter plan that governs BOTH phases.
     * Called once before any prose is written. The plan (MICE driver, emotional
     * arc, causation chain, phase obligations, forbidden territory) is the
     * contract between Phase 1 and Phase 2 — neither phase re-plans independently.
     */
    private async _runChapterPlanStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        contextManager: ContextManager
    ): Promise<StageResult | null> {
        const { previousChapter, currentChapter } = await this._getChapterContext();
        const plotMemory = contextManager.getState().plotMemory?.denseSummary || '';

        const prompt = this.plugin.promptEngine.buildChapterPlanPrompt({
            sceneSummary: this.currentSceneSummary,
            previousChapter: previousChapter || '',
            currentChapter: currentChapter || '',
            plotMemory,
            commandments: this.plugin.settings.writingCommandments || '',
        });

        return this.runStage('PLAN', smartProfile.model, async () => {
            return await this.plugin.aiClient.generate(
                prompt,
                { ...this.plugin.settings, generationMode: 'single' as const }
            );
        }, undefined, await sha256(prompt));
    }

    private async _runRetrieveStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        planResult: StageResult,
        contextManager: ContextManager,
        effectiveNovelty: number,
        rawParams: { temp: number; novelty: number; stickyMin: number },
        iteration: number
    ): Promise<StageResult | null> {
        return this.runStage('RETRIEVE', smartProfile.model, async () => {
            const query = {
                text: planResult.data.summary || this.currentSceneSummary || 'next scene',
                mode: 'chapter' as const,
                hints: planResult.data.hints,
                intents: planResult.data.retrievalIntents
            };
            const searchResult = await this.plugin.retrievalService.search(query, {
                limit: 8,
                strictMode: true,
                noveltyBias: effectiveNovelty,
                stickyMin: rawParams.stickyMin,
                fallbackSet: contextManager.getStickyFallbackSet(contextManager.getState().lastChunkId),
                scoringVersion: 1
            });

            const intents = (query as any).intents || [];
            this._emitHardIntentMisses(intents, searchResult);

            return searchResult;
        }, undefined, await sha256(JSON.stringify(planResult.data)));
    }

    private _emitHardIntentMisses(intents: any[], searchResult: any[]): void {
        intents.forEach((intent: any) => {
            if (intent.hardness !== 'HARD') return;
            const fulfilled = searchResult.some(hit =>
                hit.intentType === intent.type &&
                hit.relevance && hit.relevance.finalScore >= hit.relevance.threshold
            );
            if (!fulfilled) {
                console.warn(`[SequentialGenerator] HARD intent miss: ${intent.type}`);
                relayEventBus.emit('pilot:miss', { type: intent.type, runId: this.currentRunId });
            }
        });
    }

    private _computeDegradedDomains(planResult: StageResult, retrieveResult: StageResult): { missedHardIntents: any[]; restrictedDomains: string[]; isDegraded: boolean } {
        const missedHardIntents = ((planResult.data.retrievalIntents || []) as any[])
            .filter(intent => intent.hardness === 'HARD' && !retrieveResult.data.some((hit: any) => hit.intentType === intent.type));
        const restrictedDomains = missedHardIntents.map(i => i.domain || i.type);
        return { missedHardIntents, restrictedDomains, isDegraded: restrictedDomains.length > 0 };
    }

    private async _runWriteStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        planResult: StageResult,
        retrieveResult: StageResult,
        contextManager: ContextManager,
        iteration: number,
        rawParams: { temp: number; novelty: number; stickyMin: number },
        isDegraded: boolean,
        restrictedDomains: string[],
        phaseTargetWords: number = 1500
    ): Promise<StageResult | null> {
        const stateCard = contextManager.renderStateCard();
        const retrieved = retrieveResult.data.map((r: any) => r.excerpt).join('\n\n');
        const plotMemory = contextManager.getState().plotMemory?.denseSummary || '';
        const plotMemoryBlock = plotMemory
            ? `\nPLOT MEMORY: ${plotMemory}\n(Use this for plot trajectory and high-level continuity.)`
            : '';
        const constraintBlock = isDegraded
            ? `\n[DEGRADED MODE] Restricted Domains: ${restrictedDomains.join(', ')}\nConstraint: Do not assert new canonical facts about these domains.`
            : '';

        // ── Word-First Context Strategy ────────────────────────────────────────────
        // Pull the full previous chapter + entire current chapter from the vault.
        // This gives the AI real narrative momentum instead of a 2-paragraph stub.
        const { previousChapter, currentChapter } = await this._getChapterContext();
        const prevChapterBlock = previousChapter
            ? `\n\nPREVIOUS CHAPTER (full — read this to absorb tone, pacing, and where we just were):\n"""\n${previousChapter}\n"""\n`
            : '';
        const currentChapterBlock = currentChapter
            ? `\n\nCURRENT CHAPTER — EVERYTHING WRITTEN SO FAR (continue from this; do NOT repeat any of it):\n"""\n${currentChapter}\n"""\n`
            : '';

        // Within-run continuity: pin to the exact last paragraph so chunks stitch seamlessly.
        // Skip when Phase 2 has the full Phase 1 prose block — the anchor is already inside
        // that block and repeating it causes the AI to re-write the last paragraph verbatim.
        const runAnchor = this._getLastChunkTail();
        const phase1ProseWillProvide = this.currentPhase === 2 && this.rollingWindow.length > 0;
        const runAnchorBlock = runAnchor && !phase1ProseWillProvide
            ? `\nCONTINUATION ANCHOR — your first sentence must flow directly from:\n"""${runAnchor}"""\n`
            : '';

        // ── Character lore targeted to this scene ──────────────────────────────
        const characterLoreText = await this._getCharacterLore(planResult.data, currentChapter);
        const characterLoreBlock = characterLoreText
            ? `\n\nCHARACTER LORE (only characters present in this scene):\n${characterLoreText}\n`
            : '';

        // ── Writing Commandments — literary rules that govern every phase ──────
        const commandmentsText = this.plugin.settings.writingCommandments;
        const commandmentsBlock = commandmentsText
            ? `\n\nWRITING COMMANDMENTS — these rules are non-negotiable and govern every paragraph:\n${commandmentsText}\n`
            : '';

        // ── Phase 1 prose — injected as context for Phase 2 ───────────────────
        const phase1ProseBlock = (() => {
            if (this.currentPhase !== 2 || this.rollingWindow.length === 0) return '';
            // The most recent committed chunk is Phase 1's output
            const lastChunk = this.rollingWindow[this.rollingWindow.length - 1];
            const phase1Text = lastChunk.map(p => p.text).join('\n\n');
            return phase1Text
                ? `\n\nPHASE 1 PROSE — what you just wrote (continue seamlessly from the end of this; do NOT repeat it):\n"""\n${phase1Text}\n"""\n`
                : '';
        })();

        // ── Phase-aware generation directive ───────────────────────────────────
        const phaseDirective = this.currentPhase === 1
            ? `\n\n[GENERATION PHASE 1 — OPENING MOVEMENT]\nYou are writing the first half of this chapter. Establish the situation, develop tension, build forward momentum. DO NOT resolve the scene arc or wrap anything up. End at a point of tension, decision, or revelation — somewhere the story wants to continue from.\n`
            : `\n\n[GENERATION PHASE 2 — FORWARD MOVEMENT]\nThe story is already in motion. You are deepening and advancing it — not ending it.\n\nFORBIDDEN:\n- Do NOT wrap up the chapter as if writing the final page of a short story.\n- Do NOT summarize why a character is somewhere or how they got there.\n- Do NOT use the word "terminus" or any synonym meaning "end point" or "conclusion".\n- Do NOT re-establish the opening situation or recap Phase 1.\n\nREQUIRED:\n- The character must encounter something NEW — a discovery, intrusion, voice, object, or revelation they did not anticipate and did not put there.\n- This new thing must force them out of their own head and into an external EVENT.\n- End the chapter at the edge of that new thing — not after it, not summarizing it. Leave the reader in the moment it begins.${this.phase2Direction ? `\n\nAUTHOR'S MIDPOINT DIRECTION: ${this.phase2Direction}` : ''}\n`;

        // Scene summary — the author's directions for this specific scene
        const sceneSummaryBlock = this.currentSceneSummary
            ? `\n\nAUTHOR'S SCENE DIRECTIONS — realise this in your prose:\n"""\n${this.currentSceneSummary}\n"""\n`
            : '';

        const chapterPlanBlock = this.chapterPlan
            ? `CHAPTER PLAN (governs both phases — follow the obligations for Phase ${this.currentPhase}):\n${this.chapterPlan}\n\n⚠ NARRATIVE WALL: Every term above is craft vocabulary for you as author — MICE, causation chain, phase obligations, forbidden territory, terminus — NONE of these phrases belong in the prose. They are invisible to the reader. Writing any structural label into the story text is a critical failure.`
            : `PLAN: ${JSON.stringify(planResult.data)}`;

        const prompt = `
                        ${stateCard}${plotMemoryBlock}
                        ${chapterPlanBlock}
                        RETRIEVED FACTS: ${retrieved}${constraintBlock}${sceneSummaryBlock}${prevChapterBlock}${currentChapterBlock}${phase1ProseBlock}${runAnchorBlock}${characterLoreBlock}${commandmentsBlock}${phaseDirective}

                        INSTRUCTION: Write approximately ${phaseTargetWords} words of clean, continuous prose. This is Phase ${this.currentPhase} of 2 — do not loop back, do not restart, do not produce more than one self-contained movement.
                        Separate paragraphs with a blank line. Output the prose and nothing else — no JSON, no HTML tags, no paragraph IDs, no annotations, no metadata.
                        ${isDegraded ? '[Constraint: Do not introduce canonical facts about restricted domains.]' : ''}
                    `;

        const stageManifest = await (async () => {
            const manifest = contextManager.generateManifest(retrieveResult.data, [], prompt);
            manifest.promptHash = await sha256(prompt);
            return manifest;
        })();

        return this.runStage('WRITE', smartProfile.model, async () => {
            return await this.plugin.aiClient.generateStream(
                prompt,
                { ...this.plugin.settings, generationMode: 'single' as const },
                (accumulated) => {
                    relayEventBus.emit('chunk:buffer:update', { content: accumulated });
                },
                this.abortController?.signal
            );
        }, stageManifest);
    }

    /**
     * Pauses Phase 2 from starting until the author provides a midpoint direction
     * (or skips). Resolved by providePhase2Direction() from the UI.
     */
    private _waitForPhase2Direction(): Promise<string | null> {
        return new Promise(resolve => {
            this.phase2DirectionResolver = resolve;
        });
    }

    /**
     * Called by the UI when the author submits a midpoint direction or skips.
     * Passing null means "use commandments only" — no extra steering.
     */
    public providePhase2Direction(direction: string | null): void {
        if (this.phase2DirectionResolver) {
            this.phase2DirectionResolver(direction);
            this.phase2DirectionResolver = null;
        }
    }

    /**
     * Returns the last `n` non-empty paragraphs from the active manuscript file.
     * Used as a continuation anchor for the first generated chunk so that it
     * flows seamlessly from wherever the existing text ends.
     */
    private async _getExistingManuscriptTail(n: number): Promise<string> {
        try {
            const content = await this.plugin.vaultService.readFile(this.plugin.settings.book2Path);
            if (!content) return '';
            const paragraphs = content.split(/\n{2,}/).map(p => p.trim()).filter(p => p.length > 20);
            return paragraphs.slice(-n).join('\n\n');
        } catch {
            return '';
        }
    }

    /**
     * Returns the last paragraph of the most recently committed chunk from the rolling window.
     * Used as a continuation anchor for all chunks after the first so each one picks up
     * exactly where the previous left off.
     */
    private _getLastChunkTail(): string {
        if (this.rollingWindow.length === 0) return '';
        const lastChunk = this.rollingWindow[this.rollingWindow.length - 1];
        if (!lastChunk || lastChunk.length === 0) return '';
        // Return the last paragraph of the last committed chunk
        return lastChunk[lastChunk.length - 1]?.text ?? '';
    }

    /**
     * Word-First Context Strategy: reads the manuscript and returns the previous
     * complete chapter and the current chapter (everything written so far).
     *
     * Splits on H1 headings (the convention used throughout the book).
     * Previous chapter is capped at PREV_CHAPTER_WORD_CAP words so very long
     * chapters don't crowd the context; current chapter is returned in full
     * because the AI must know everything already written to avoid repetition.
     */
    private async _getChapterContext(): Promise<{ previousChapter: string; currentChapter: string }> {
        const PREV_CHAPTER_WORD_CAP = 8000;
        try {
            const content = await this.plugin.vaultService.readFile(this.plugin.settings.book2Path);
            if (!content) return { previousChapter: '', currentChapter: '' };

            // Split on H1 boundaries; keep the heading attached to its body
            const parts = content.split(/^(?=#\s)/m).filter(p => p.trim().length > 100);

            if (parts.length === 0) {
                return { previousChapter: '', currentChapter: content };
            }

            const currentChapter = parts[parts.length - 1] ?? '';
            const prevChapterFull = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : '';

            // Cap previous chapter by word count (take the tail so tone is freshest)
            const prevWords = prevChapterFull.split(/\s+/);
            const previousChapter = prevWords.length > PREV_CHAPTER_WORD_CAP
                ? prevWords.slice(-PREV_CHAPTER_WORD_CAP).join(' ')
                : prevChapterFull;

            return { previousChapter, currentChapter };
        } catch {
            return { previousChapter: '', currentChapter: '' };
        }
    }

    /**
     * Character Lore injection: reads character notes from the character folder
     * and returns only those characters whose names appear in the plan data or
     * current chapter text — so the AI gets targeted facts about the people
     * actually in the scene, not a dump of every character in the book.
     *
     * Each note is capped at CHARS_PER_NOTE_CAP characters to stay token-sane.
     */
    private async _getCharacterLore(planData: any, currentChapter: string): Promise<string> {
        const CHARS_PER_NOTE_CAP = 2000;
        const MAX_CHARACTERS = 8;

        const folder = this.plugin.settings.characterFolder || 'Characters';
        // Build a searchable haystack from the plan output and current chapter
        const haystack = `${JSON.stringify(planData)} ${currentChapter}`.toLowerCase();

        try {
            const files = this.plugin.app.vault.getMarkdownFiles()
                .filter(f => f.path.startsWith(`${folder}/`));

            const relevant: Array<{ name: string; content: string }> = [];
            for (const file of files) {
                if (haystack.includes(file.basename.toLowerCase())) {
                    const content = await this.plugin.app.vault.cachedRead(file);
                    relevant.push({ name: file.basename, content: content.slice(0, CHARS_PER_NOTE_CAP) });
                    if (relevant.length >= MAX_CHARACTERS) break;
                }
            }

            if (relevant.length === 0) return '';
            return relevant.map(c => `### ${c.name}\n${c.content}`).join('\n\n');
        } catch {
            return '';
        }
    }

    private _quarantineDegradedFacts(writeResult: StageResult, restrictedDomains: string[]): void {
        if (!writeResult.metadata) return;
        writeResult.metadata.forEach((m: any) => {
            if (!m.newFactsProposed) return;
            m.newFactsProposed.forEach((f: any) => {
                if (restrictedDomains.some(d => f.type === d || f.attribute === d)) {
                    f.lifecycleState = 'QUARANTINED';
                    console.log(`[SequentialGenerator] Auto-quarantined fact in restricted domain: ${f.attribute}`);
                }
            });
        });
    }

    private async _runAuditStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        mechanicalProfile: ReturnType<typeof this.getTaskProfile>,
        contextManager: ContextManager,
        chunkText: string,
        iteration: number
    ): Promise<StageResult | null> {
        return this.runStage('AUDIT', smartProfile.model, async () => {
            const prompt = this.plugin.promptEngine.buildAuditPrompt(contextManager.getState(), chunkText, contextManager.getState());
            const res = await this.plugin.aiClient.generate(prompt, { ...this.plugin.settings, generationMode: 'single' as const });
            return JSON.parse(res) as AuditResult;
        }, undefined, await sha256(chunkText));
    }

    private async _runRepairStageIfNeeded(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        auditData: AuditResult,
        chunkText: string,
        writeResult: StageResult,
        interventionGuidance: InterventionGuidance | null,
        iteration: number,
        chunkId: string,
        contextManager: ContextManager
    ): Promise<{ interventionGuidance: InterventionGuidance | null; cancelled: boolean }> {
        if (auditData.overallSeverity < 4) {
            return { interventionGuidance, cancelled: false };
        }

        const repairCapCheck = this.checkRepairCap();
        if (repairCapCheck.trigger) {
            const updated = await this.handleIntervention(
                repairCapCheck.trigger,
                repairCapCheck.violationSummary,
                chunkId,
                auditData.overallSeverity,
                contextManager
            );
            if (!updated) {
                return { interventionGuidance: null, cancelled: true };
            }
            interventionGuidance = updated;
        }

        const repairResult = await this._runRepairStage(
            smartProfile,
            auditData,
            chunkText,
            interventionGuidance,
            iteration
        );

        if (repairResult) {
            const patches: PatchOp[] = repairResult.data;
            writeResult.data = this.applyPatches(writeResult.data, patches);
        }

        return { interventionGuidance, cancelled: false };
    }

    private async _runRepairStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        auditData: AuditResult,
        chunkText: string,
        interventionGuidance: InterventionGuidance | null,
        iteration: number
    ): Promise<StageResult | null> {
        return this.runStage('REPAIR', smartProfile.model, async () => {
            const prompt = interventionGuidance
                ? this._buildRepairPromptWithGuidance(interventionGuidance)
                : `Repair the following prose chunk to resolve these violations: ${JSON.stringify(auditData.violations)}\n\nChunk: ${chunkText}`;

            return await this.plugin.aiClient.generate(prompt, { ...this.plugin.settings, generationMode: 'single' as const });
        }, undefined, await sha256(chunkText + JSON.stringify(auditData)));
    }

    private _buildRepairPromptWithGuidance(interventionGuidance: InterventionGuidance): string {
        return `
USER_INTERVENTION_GUIDANCE:
Goal: ${interventionGuidance.goal}
Must Preserve: ${interventionGuidance.mustPreserve.join(', ')}
Must Avoid: ${interventionGuidance.mustAvoid.join(', ')}

[USER INSTRUCTIONS]
${interventionGuidance.userPrompt}
[/USER INSTRUCTIONS]

Constraints:
- Must not change canon unless explicitly instructed
- Must resolve violation safely
- Must respect truth matrix and anchors
`;
    }

    private async _runUpdateStage(
        smartProfile: ReturnType<typeof this.getTaskProfile>,
        contextManager: ContextManager,
        writeResult: StageResult,
        iteration: number
    ): Promise<StageResult | null> {
        return this.runStage('UPDATE', smartProfile.model, async () => {
            const newFacts: CanonFact[] = [];
            contextManager.updateState(newFacts, {
                chunkId: `chunk-${iteration}`,
                summary: `Generated chunk ${iteration}`
            });

            const citedFactIds = writeResult.metadata?.flatMap(m => m.factIds) || [];
            contextManager.refreshPins(citedFactIds);

            const state = contextManager.getState();
            const mentionedEntities = new Set<string>();
            citedFactIds.forEach(id => {
                const fact = state.canonFacts.find(f => f.id === id);
                if (fact) mentionedEntities.add(fact.entityId);
            });
            this.entitiesMentionedHistory.set(`chunk-${iteration}`, Array.from(mentionedEntities));

            return { status: 'success', version: contextManager.getState().canonVersion };
        }, undefined, await sha256(`Generated chunk ${iteration}`));
    }

    private async _finalizeSuccessfulRun(totalWords: number, contextManager: ContextManager): Promise<void> {
        this.state = 'COMPLETED';
        this.manifest!.endTime = Date.now();

        const health = this.calculateHealth();
        relayEventBus.emit('run:end', {
            runId: this.currentRunId!,
            totalWords,
            health
        } as any);

        await this.performPostRunHarvest(contextManager);

        this.manifest!.replayPrereqs = await this.computeReplayPrereqs();

        await this.saveManifest();
        await this.cleanupOldRuns();
    }

    /**
     * Main entry point to generate a chapter in stages.
     */
    async generateChapter(targetWordCount: number, opts?: { dryRun?: boolean; sceneSummary?: string }) {
        if (this._isGenerationRunning()) {
            new Notice('Generation is already running.');
            return;
        }

        // ── Start the diagnostic log for this run ──────────────────────────────
        gwlogRunStart();
        gwlog('RUN', `generateChapter | targetWords=${targetWordCount} | dryRun=${!!opts?.dryRun}`);
        gwlog('RUN', `sceneSummary="${gwSnip(opts?.sceneSummary, 100)}"`);
        gwlog('CFG', `provider=${this.plugin.settings.apiProvider} | model=${this.plugin.settings.model} | key=${this.plugin.settings.apiKey ? this.plugin.settings.apiKey.slice(0,8)+'…(len='+this.plugin.settings.apiKey.length+')' : '(EMPTY!)'}`);
        gwlog('CFG', `book2Path="${this.plugin.settings.book2Path}" | storyBible="${this.plugin.settings.storyBiblePath}" | charFolder="${this.plugin.settings.characterFolder}"`);
        gwlog('CFG', `maxChunkWords=${this.plugin.settings.maxChunkWords} | contextTokenLimit=${this.plugin.settings.contextTokenLimit ?? 128000}`);

        this.currentSceneSummary = opts?.sceneSummary?.trim() || '';
        this.dryRun = !!opts?.dryRun;
        if (this.dryRun) {
            new Notice('Running in DRY-RUN mode. No changes will be saved.');
        }

        this.currentRunKey = `run-${Date.now()}`;
        this.currentRunId = (globalThis.crypto?.randomUUID?.() || `uuid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
        this.state = 'RUNNING';
        this.abortController = new AbortController();
        this.interventionCount = 0;
        this.interventionCountPerChunk.clear();
        this.currentPhase = 1;
        this.phase2Direction = null;
        this.phase2DirectionResolver = null;
        this.chapterPlan = '';

        // ── Emit run:start IMMEDIATELY so the modal opens before any async setup.
        // All setup errors are now caught by the try/catch below and surfaced via run:error.
        const initialState = this._buildInitialChapterState();
        gwlog('RUN', `run:start emitting | runId=${this.currentRunId} | chapterId=${initialState.chapterId}`);
        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });
        gwlog('RUN', 'run:start emitted → modal should now be visible');

        let totalWords = 0;
        let contextManager: ContextManager | null = null;

        // Each phase targets half the requested word count. The target is a
        // guideline passed to the AI — not a loop termination condition.
        // Generation is exactly 2 API calls: Phase 1 then Phase 2. Full stop.
        const phaseTargetWords = Math.round(targetWordCount / 2);

        try {
            gwlog('SETUP', 'acquireRunLock...');
            await this.acquireRunLock(this.currentRunKey!);
            gwlog('SETUP', 'acquireRunLock OK');

            const smartModel = this.plugin.settings.model;
            const smartProfile = this.getTaskProfile('WRITE');
            const mechanicalProfile = this.getTaskProfile('MECHANICAL');

            gwlog('SETUP', 'computing policyHash + corpusHash...');
            const policyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
            const corpusHash = await this.plugin.embeddingsIndex.getCorpusHash();
            gwlog('SETUP', `policyHash=${policyHash.slice(0,8)}… corpusHash=${corpusHash.slice(0,8)}…`);

            contextManager = new ContextManager(this.plugin.app.vault, initialState);
            this.contextManager = contextManager;

            this.verifySchemaDrift(initialState);

            gwlog('SETUP', `seedFromStoryBible | path="${this.plugin.settings.storyBiblePath}"`);
            const seedResult = await contextManager.seedFromStoryBible(this.plugin.settings.storyBiblePath);
            gwlog('SETUP', `seedFromStoryBible OK | hash=${seedResult.hash?.slice(0,8) ?? '(none)'}`);

            const environment = await this._buildEnvironmentMeta(smartModel, policyHash, corpusHash);
            await this._initManifest(smartModel, null, policyHash, corpusHash, initialState, seedResult.hash, environment);
            gwlog('SETUP', 'manifest initialised — starting 2-phase generation (one plan, two writes)');

            // ── ONE plan for the whole chapter ────────────────────────────────────
            gwlog('PLAN', 'Generating OSC chapter plan (governs both phases)...');
            const planResult = await this._runChapterPlanStage(smartProfile, contextManager);
            if (!planResult || this.checkControlFlow()) {
                gwwarn('PLAN', 'Chapter plan stage failed or aborted');
            } else {
                this.chapterPlan = String(planResult.data);
                gwlog('PLAN', `Chapter plan ready | ${this.chapterPlan.length} chars`);

                // ── ONE retrieval for both phases ─────────────────────────────────
                const { sliderValue, rawParams, effectiveNovelty } = this._getSpontaneityAndRisk(1, contextManager);
                this._updateSpontaneityProfile(sliderValue, rawParams, effectiveNovelty);

                gwlog('RETRIEVE', 'Running retrieval (shared for both phases)...');
                const retrieveResult = await this._runRetrieveStage(smartProfile, planResult, contextManager, effectiveNovelty, rawParams, 1);
                if (!retrieveResult || this.checkControlFlow()) {
                    gwwarn('RETRIEVE', 'Retrieval failed or aborted');
                } else {
                    const { restrictedDomains, isDegraded } = this._computeDegradedDomains(planResult, retrieveResult);
                    if (isDegraded) gwwarn('SETUP', `degraded mode | restrictedDomains=${restrictedDomains.join(',')}`);

                    // ── Phase 1: first half of the plan ──────────────────────────
                    this.currentPhase = 1;
                    gwlog('PHASE', `━━━ Phase 1 of 2 | targetWords=${phaseTargetWords} ━━━`);

                    const phase1Result = await this._runWriteStage(smartProfile, planResult, retrieveResult, contextManager, 1, rawParams, isDegraded, restrictedDomains, phaseTargetWords);

                    if (phase1Result && !this.checkControlFlow()) {
                        if (isDegraded) this._quarantineDegradedFacts(phase1Result, restrictedDomains);

                        const { text: chunk1, metadata: meta1 } = this.segmentAndRecover(phase1Result.data, []);
                        phase1Result.data = chunk1;
                        phase1Result.metadata = meta1;

                        gwlog('COMMIT', `Phase 1 commit | words=${gwWords(chunk1)}`);
                        await this.commitChunk(1, phase1Result.data, phase1Result.metadata);

                        await this._runUpdateStage(smartProfile, contextManager, phase1Result, 1);
                        totalWords += phase1Result.data.split(/\s+/).length;
                        gwlog('PHASE', `Phase 1 complete | words=${gwWords(phase1Result.data)} | total=${totalWords}`);

                        // ── Phase transition: optional author direction ────────────
                        relayEventBus.emit('phase:transition', { phase1Words: totalWords, targetWords: targetWordCount });
                        const direction = await this._waitForPhase2Direction();
                        this.phase2Direction = direction;
                        gwlog('PHASE', `Phase 2 direction: "${direction ?? 'none — commandments govern'}"`);

                        if (!this.checkControlFlow()) {
                            // ── Phase 2: second half of the plan ─────────────────
                            this.currentPhase = 2;
                            gwlog('PHASE', `━━━ Phase 2 of 2 | targetWords=${phaseTargetWords} ━━━`);

                            const { sliderValue: sv2, rawParams: rp2, effectiveNovelty: en2 } = this._getSpontaneityAndRisk(2, contextManager);
                            this._updateSpontaneityProfile(sv2, rp2, en2);

                            const phase2Result = await this._runWriteStage(smartProfile, planResult, retrieveResult, contextManager, 2, rp2, isDegraded, restrictedDomains, phaseTargetWords);

                            if (phase2Result && !this.checkControlFlow()) {
                                if (isDegraded) this._quarantineDegradedFacts(phase2Result, restrictedDomains);

                                const { text: chunk2, metadata: meta2 } = this.segmentAndRecover(phase2Result.data, []);
                                phase2Result.data = chunk2;
                                phase2Result.metadata = meta2;

                                gwlog('COMMIT', `Phase 2 commit | words=${gwWords(chunk2)}`);
                                await this.commitChunk(2, phase2Result.data, phase2Result.metadata);

                                await this._runUpdateStage(smartProfile, contextManager, phase2Result, 2);
                                totalWords += phase2Result.data.split(/\s+/).length;
                                gwlog('PHASE', `Phase 2 complete | words=${gwWords(phase2Result.data)} | total=${totalWords}`);

                                if (this.shouldTriggerTelescoping(2, contextManager)) {
                                    await this.performTelescoping(2, contextManager);
                                }
                            } else {
                                gwwarn('PHASE', 'Phase 2 write failed or aborted');
                            }
                        }
                    } else {
                        gwwarn('PHASE', 'Phase 1 write failed or aborted');
                    }

                    await this.saveManifest();
                }
            }

            gwlog('RUN', `2-phase generation complete | totalWords=${totalWords} | state=${this.state}`);

            if (contextManager && (this.state === 'RUNNING' || this.state === 'RESUMING')) {
                gwlog('RUN', '_finalizeSuccessfulRun...');
                await this._finalizeSuccessfulRun(totalWords, contextManager);
                gwlog('RUN', '✓ run COMPLETED successfully');
            } else {
                gwwarn('RUN', `run ended without finalize | state=${this.state} | contextManager=${contextManager ? 'ok' : 'null'}`);
            }

        } catch (err) {
            const msg = (err as Error).message || String(err);
            gwerr('RUN', `UNCAUGHT ERROR in generateChapter: ${msg}`, err);
            this.state = 'error';
            relayEventBus.emit('run:error', { runId: this.currentRunId!, error: msg });
        } finally {
            gwlog('RUN', `finally | releasing lock | runKey=${this.currentRunKey}`);
            if (this.currentRunKey) {
                await this.releaseRunLock(this.currentRunKey);
            }
            this.abortController = null;
            gwlog('RUN', '══════════════════ RUN FINISHED ══════════════════\n');
        }
    }

    /**
     * Edit an existing chapter using cloud monolithic path
     */
    async editChapter(opts: { chapterText: string; editInstructions: string }): Promise<void> {
        if (this.state === 'RUNNING') return;

        const relayMode = this.plugin.settings.relayMode || 'local';
        if (relayMode !== 'cloud') {
            new Notice('Edit mode is currently only supported in Cloud Relay mode.');
            return;
        }

        this.currentRunKey = `edit-${Date.now()}`;
        this.currentRunId = crypto.randomUUID();
        this.state = 'RUNNING';
        this.abortController = new AbortController();

        await this.acquireRunLock(this.currentRunKey);

        try {
            relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: 'editing' });
            relayEventBus.emit('stage:progress', { runId: this.currentRunId, stageId: 'edit', message: 'Preparing edit context...' });

            const contextPack = await this.contextPacker!.buildContextPack(
                this.contextManager!.getState(),
                [],
                this.plugin.settings.relayStyleSignature,
                opts.editInstructions
            );

            const editInput: EditChapterInput = {
                chapterText: opts.chapterText,
                editInstructions: opts.editInstructions,
                context: contextPack,
                lockMap: contextPack.lockMap,
                outputContract: {
                    allowedScope: 'CHAPTER',
                    allowedOperations: ['STYLE_ONLY', 'CONTENT_EDIT']
                }
            };

            relayEventBus.emit('stage:progress', { runId: this.currentRunId, stageId: 'edit', message: 'Cloud editing...' });

            const output = await this.cloudRelay!.editChapter(editInput, this.abortController.signal);

            const fullEditedProse = output.resultParagraphs.map(p => p.text).join('\n\n');
            const auditResult = await this.auditService.auditFullChapter(fullEditedProse, this.contextManager!.getState());

            if (auditResult.overallSeverity >= 4) {
                new Notice(`Edit completed with ${auditResult.violations.length} violations.`);
            }

            relayEventBus.emit('chunk:committed', {
                runId: this.currentRunId,
                chunkId: 'edited-chapter',
                content: fullEditedProse,
                metadata: output.resultParagraphs.map(p => p.sidecar),
                path: this.plugin.settings.book2Path
            });

            this.state = 'COMPLETED';
            relayEventBus.emit('run:end', { runId: this.currentRunId, totalWords: fullEditedProse.split(/\s+/).length });

        } catch (err: any) {
            this.state = 'error';
            relayEventBus.emit('run:error', { runId: this.currentRunId!, error: err.message });
        } finally {
            await this.releaseRunLock(this.currentRunKey);
            this.state = 'idle';
            this.abortController = null;
        }
    }

    private async runStage(
        type: StageResult['stageType'],
        model: string,
        execution: () => Promise<any>,
        stageManifest?: ContextBundleManifest,
        inputHash?: string
    ): Promise<StageResult | null> {
        if (this.checkControlFlow()) return null;

        const stageId = `stage-${Date.now()}`;
        relayEventBus.emit('stage:start', { runId: this.currentRunId!, stageId, type });

        const startTime = Date.now();
        let retryCount = 0;
        const maxRetries = 1;

        while (retryCount <= maxRetries) {
            try {
                const data = await execution();
                const endTime = Date.now();

                const result: StageResult = {
                    stageId,
                    stageType: type,
                    startTime,
                    endTime,
                    inputHash: inputHash || 'pending',
                    outputHash: await sha256(JSON.stringify(data)),
                    data,
                    manifest: stageManifest
                };

                this.manifest!.stages.push(result);
                relayEventBus.emit('stage:end', { runId: this.currentRunId!, stageId, result });
                return result;
            } catch (err) {
                retryCount++;
                if (retryCount > maxRetries) {
                    relayEventBus.emit('run:error', { runId: this.currentRunId!, error: `Stage ${type} failed after ${maxRetries} retries: ${err.message}` });
                    throw err;
                }
                console.warn(`[SequentialGenerator] Retrying stage ${type} due to error: ${err.message}`);
            }
        }
        return null;
    }

    private async commitChunk(iteration: number, content: string, metadata?: ParagraphMetadata[]) {
        if (this.commitLock) return;
        this.commitLock = true;
        try {
            const paras = content.split('\n\n').filter(p => p.trim()).map((p, i) => {
                const text = p.trim();
                const id = metadata?.[i]?.p_id || `chunk-${iteration}-p${i}`;
                const hash = fnv1a32(normalizeWhitespace(text));
                return { id, text, hash, status: 'FINALIZED' as const };
            });

            this.rollingWindow.push(paras);
            if (this.rollingWindow.length > 3) {
                this.rollingWindow.shift();
            }

            if (!this.dryRun) {
                relayEventBus.emit('chunk:committed', {
                    runId: this.currentRunId!,
                    chunkId: `chunk-${iteration}`,
                    content,
                    path: this.plugin.settings.book2Path
                });
                // Clear the live streaming preview now that the chunk is committed
                relayEventBus.emit('chunk:buffer:update', { content: '' });
            }

            if (iteration > 1) {
                await this.enqueueStitchTask(iteration - 1, iteration);
            }

            this.manifest!.stages.push({
                stageId: `commit-${iteration}`,
                stageType: 'UPDATE',
                startTime: Date.now(),
                endTime: Date.now(),
                inputHash: await sha256(content),
                outputHash: await sha256(content),
                data: { committed: true }
            });
        } finally {
            this.commitLock = false;
        }
    }

    private async enqueueStitchTask(leftIdx: number, rightIdx: number) {
        const seamId = `chunk-${leftIdx}__chunk-${rightIdx}`;
        const seqNo = (this.seamTaskCounters.get(seamId) || 0) + 1;
        this.seamTaskCounters.set(seamId, seqNo);

        const taskKey = `${this.currentRunId}__${this.sessionId}__${seamId}`;

        const leftParas = this.rollingWindow.find(chunk => chunk[0]?.id.startsWith(`chunk-${leftIdx}`));
        const rightParas = this.rollingWindow.find(chunk => chunk[0]?.id.startsWith(`chunk-${rightIdx}`));

        if (!leftParas || !rightParas) {
            console.warn(`[SequentialGenerator] Stitch skipped: Chunks ${leftIdx} or ${rightIdx} not in rolling window.`);
            return;
        }

        const cleanLeft = leftParas.filter(p => p.status === 'FINALIZED');
        const cleanRight = rightParas.filter(p => p.status === 'FINALIZED');

        if (cleanLeft.length === 0 || cleanRight.length === 0) return;

        (async () => {
            try {
                const state = this.contextManager!.getState();
                const context = await this.contextPacker!.packContext(this.plugin, state);
                const stablePrefix = this.plugin.promptEngine.buildStablePrefix(context);

                const response = await this.proseStitcher.stitch(
                    cleanLeft,
                    cleanRight,
                    state,
                    { runId: this.currentRunId!, sessionId: this.sessionId, seamId, seqNo },
                    stablePrefix
                );

                if (response && response.patchOps.length > 0) {
                    if (this.currentRunId !== response.runId || this.sessionId !== response.sessionId) return;
                    relayEventBus.emit('chunk:patch', response);
                    console.debug(`[SequentialGenerator] Stitch success: ${seamId} (seq ${seqNo})`);
                }
            } catch (err) {
                console.error(`[SequentialGenerator] Stitch task failed for ${seamId}:`, err);
            }
        })();
    }

    /**
     * Handles intervention: pauses run, shows modal, resumes with user guidance.
     */
    private async handleIntervention(
        triggerReason: InterventionTriggerReason,
        violationSummary: string,
        chunkId: string,
        severity: number,
        contextManager: ContextManager
    ): Promise<InterventionGuidance | null> {
        this._enforceInterventionCaps(chunkId);

        this.state = 'PAUSED_FOR_INTERVENTION';
        await this.saveManifest();

        const result = await showInterventionModal(this.plugin.app, {
            triggerReason,
            violationSummary,
            chunkId,
            severity
        });

        if (!result?.proceed) {
            this.state = 'STOPPED_FATAL';
            return null;
        }

        const continuation = await this._buildContinuation(contextManager);
        this._recordIntervention(chunkId, triggerReason, severity, violationSummary, result, continuation);

        const chunkCount = this.interventionCountPerChunk.get(chunkId) || 0;
        this.interventionCount++;
        this.interventionCountPerChunk.set(chunkId, chunkCount + 1);

        this.state = 'RESUMING';
        relayEventBus.emit('control:resumed', { runId: this.currentRunId! });
        this.state = 'RUNNING';

        return result.guidance;
    }

    private _enforceInterventionCaps(chunkId: string): void {
        const policy = CO_AUTHORING_POLICY.INTERVENTION;
        if (this.interventionCount >= policy.MAX_INTERVENTIONS_PER_RUN) {
            this.state = 'STOPPED_FATAL';
            throw new Error(`FAIL_INTERVENTION_CAP: Maximum interventions per run (${policy.MAX_INTERVENTIONS_PER_RUN}) exceeded.`);
        }
        const chunkCount = this.interventionCountPerChunk.get(chunkId) || 0;
        if (chunkCount >= policy.MAX_INTERVENTIONS_PER_CHUNK) {
            this.state = 'STOPPED_FATAL';
            throw new Error(`FAIL_INTERVENTION_CAP: Maximum interventions per chunk (${policy.MAX_INTERVENTIONS_PER_CHUNK}) exceeded for chunk ${chunkId}.`);
        }
    }

    private async _buildContinuation(contextManager: ContextManager): Promise<RunContinuation> {
        const continuationId = `cont-${String((this.manifest!.continuations?.length || 0) + 1).padStart(3, '0')}`;
        const snapshotHash = await sha256(JSON.stringify(contextManager.getState()));
        const parentContId = this.manifest!.continuations?.length
            ? this.manifest!.continuations[this.manifest!.continuations.length - 1].continuationId
            : undefined;

        const continuation: RunContinuation = {
            continuationId,
            parentRunId: this.currentRunId!,
            parentContId,
            pauseEventId: `intervention-${Date.now()}`,
            resumedAt: Date.now(),
            snapshotHash,
            status: 'ACTIVE',
            resumePlan: {
                rerunRetrieval: false,
                reuseHits: true,
                reusePlotMemory: true,
                reuseAnchors: true,
                reusePromptBodies: true,
                reusePromptTemplates: true,
                resumeStage: 'WRITE'
            }
        };

        if (!this.manifest!.continuations) {
            this.manifest!.continuations = [];
        }
        this.manifest!.continuations.push(continuation);
        return continuation;
    }

    private _recordIntervention(
        chunkId: string,
        triggerReason: InterventionTriggerReason,
        severity: number,
        violationSummary: string,
        result: { guidance: InterventionGuidance; proceed: boolean },
        continuation: RunContinuation
    ): void {
        const interventionEvent: InterventionEvent = {
            eventId: continuation.pauseEventId,
            runId: this.currentRunId!,
            chunkId,
            triggerReason,
            severity,
            violationSummary,
            guidance: result.guidance,
            policyMode: this.dryRun ? 'DRY_RUN' : 'LIVE',
            appliedAtStage: 'WRITE',
            timestamp: Date.now(),
            blockedActions: [],
            appliedConstraints: [],
            retrievalReused: continuation.resumePlan.reuseHits
        };

        if (!this.manifest!.interventions) {
            this.manifest!.interventions = [];
        }
        this.manifest!.interventions.push(interventionEvent);
    }

    /**
     * Determines if telescoping should be triggered based on adaptive criteria.
     */
    private shouldTriggerTelescoping(iteration: number, contextManager: ContextManager): boolean {
        const policy = CO_AUTHORING_POLICY.TELESCOPING;

        if (this._isTelescopingTriggeredByChunkCadence(iteration, policy)) return true;
        if (this._isTelescopingTriggeredByContextPressure(policy)) return true;
        if (this._isTelescopingTriggeredByEntityDensity(policy)) return true;

        return false;
    }

    private _isTelescopingTriggeredByChunkCadence(iteration: number, policy: any): boolean {
        return iteration % policy.CHUNK_CADENCE === 0;
    }

    private _isTelescopingTriggeredByContextPressure(policy: any): boolean {
        let lastWriteStage: StageResult | undefined;
        for (let i = (this.manifest?.stages.length || 0) - 1; i >= 0; i--) {
            if (this.manifest!.stages[i].stageType === 'WRITE') {
                lastWriteStage = this.manifest!.stages[i];
                break;
            }
        }
        if (!lastWriteStage?.manifest) return false;
        const contextLimit = getContextLimit(this.plugin.settings);
        const usage = lastWriteStage.manifest.tokenEstimate / contextLimit;
        if (usage > policy.CONTEXT_PRESSURE_THRESHOLD) {
            console.debug(`[SequentialGenerator] Telescoping triggered by context pressure: ${Math.round(usage * 100)}%`);
            return true;
        }
        return false;
    }

    private _isTelescopingTriggeredByEntityDensity(policy: any): boolean {
        const windowSize = policy.ENTITY_DENSITY_WINDOW;
        const recentChunks = Array.from(this.entitiesMentionedHistory.keys()).slice(-windowSize);
        if (recentChunks.length < windowSize) return false;
        const uniqueEntities = new Set<string>();
        recentChunks.forEach(id => {
            this.entitiesMentionedHistory.get(id)?.forEach(e => uniqueEntities.add(e));
        });
        if (uniqueEntities.size > policy.HIGH_ENTITY_DENSITY_THRESHOLD) {
            console.debug(`[SequentialGenerator] Telescoping triggered by high entity density: ${uniqueEntities.size} entities in last ${windowSize} chunks`);
            return true;
        }
        return false;
    }

    /**
     * Performs structured telescoping: extracts plot memory from recent chunks.
     */
    private async performTelescoping(iteration: number, contextManager: ContextManager) {
        const policy = CO_AUTHORING_POLICY.TELESCOPING;
        const state = contextManager.getState();

        const recentChunks = state.timeline.slice(-policy.CHUNK_CADENCE).map(t => {
            const writeStage = this.manifest!.stages.find(s =>
                s.stageType === 'WRITE' && s.data && s.data.includes && s.data.includes(t.chunkId)
            );
            return {
                chunkId: t.chunkId,
                summary: t.summary,
                text: writeStage?.data || ''
            };
        });

        const prompt = this.plugin.promptEngine.buildTelescopingPrompt({
            recentChunks,
            currentPlotMemory: state.plotMemory?.denseSummary
        });

        const telescopeResult = await this.runStage('TELESCOPE', this.plugin.settings.model, async () => {
            return await this.plugin.aiClient.generate(prompt, { ...this.plugin.settings, generationMode: 'single' as const });
        });

        if (!telescopeResult) return;

        const structured = telescopeResult.data;
        const currentVersion = state.plotMemory?.version || 0;
        const sourceChunkIds = recentChunks.map(c => c.chunkId);
        const plotMemory: PlotMemory = {
            version: currentVersion + 1,
            sourceChunkIds,
            hash: await sha256(structured.denseSummary),
            denseSummary: structured.denseSummary,
            structured: {
                events: structured.events || [],
                openThreads: structured.openThreads || [],
                resolvedThreads: structured.resolvedThreads || [],
                anchorState: structured.anchorState || { cast: [] },
                newEntityStrings: structured.newEntityStrings || [],
                uncertainEvents: structured.uncertainEvents || []
            },
            timestamp: Date.now()
        };

        contextManager.getState().plotMemory = plotMemory;

        if (!this.manifest!.plotMemorySnapshots) {
            this.manifest!.plotMemorySnapshots = [];
        }
        this.manifest!.plotMemorySnapshots.push({
            version: plotMemory.version,
            hash: plotMemory.hash,
            sourceChunkIds,
            timestamp: plotMemory.timestamp
        });

        console.debug(`[SequentialGenerator] Telescoped plot memory v${plotMemory.version} from chunks ${sourceChunkIds.join(', ')}`);
    }

    // ---------------------------------------------------------------------------
    // performPostRunHarvest helpers
    // ---------------------------------------------------------------------------

    private _getProseChunksFromManifest(): Array<{ chunkId: string; text: string; metadata: any }> {
        if (!this.manifest) return [];
        return this.manifest.stages
            .filter(s => s.stageType === 'WRITE' && typeof s.data === 'string')
            .map(s => ({
                chunkId: s.stageId,
                text: s.data as string,
                metadata: s.metadata
            }));
    }

    private _buildHarvestSummary(candidates: any[]): any {
        return {
            totalCandidates: candidates.length,
            clusteredCount: candidates.length,
            approvedIds: [],
            rejectedIds: [],
            autoAcceptedSceneOnly: [],
            conflicts: candidates.filter(c => c.conflictCheckResult.hasConflict).map(c => ({
                harvestId: c.harvestId,
                conflictReason: 'Lore conflict detected',
                conflictingFactIds: c.conflictCheckResult.conflictingFactIds || []
            }))
        };
    }

    private _applySceneOnlyAutoAccepts(candidates: any[], contextManager: ContextManager): void {
        const sceneOnlyItems = candidates.filter(c => c.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY');
        sceneOnlyItems.forEach(item => {
            const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const };
            contextManager.updateState([fact]);
            this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
            console.debug(`[SequentialGenerator] Auto-accepted run-local lore: ${item.proposedFact.attribute} of ${item.proposedFact.entityId}`);
        });
    }

    private _applyRunLocalItems(runLocalIds: string[], resolutionActions: Record<string, string>, candidates: any[], contextManager: ContextManager): void {
        if (runLocalIds.length === 0) return;
        const runLocalItems = candidates.filter(c => runLocalIds.includes(c.harvestId));
        runLocalItems.forEach(item => {
            item.resolutionAction = resolutionActions[item.harvestId] || 'SCOPE_TO_SCENE';
            const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const, scope: 'SCENE' as const };
            contextManager.updateState([fact]);
            this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
            console.debug(`[SequentialGenerator] Accepted run-local lore: ${item.proposedFact.attribute} of ${item.proposedFact.entityId}`);
        });
    }

    private async _mergeApprovedIntoStoryBible(
        approvedIds: string[],
        resolutionActions: Record<string, string>,
        candidates: any[],
        contextManager: ContextManager
    ): Promise<void> {
        if (approvedIds.length === 0) return;

        approvedIds.forEach(id => {
            const item = candidates.find(c => c.harvestId === id);
            if (item && resolutionActions[id]) {
                item.resolutionAction = resolutionActions[id];
            }
        });

        const approvedItems = candidates.filter(c => approvedIds.includes(c.harvestId));
        const mergeResult = await this.plugin.vaultService.mergeHarvestIntoStoryBible(
            this.plugin.settings.storyBiblePath,
            approvedItems,
            contextManager.getState().canonVersion
        );

        if (!mergeResult.success) return;

        this.manifest!.harvestSummary!.canonVersionAfterMerge = mergeResult.canonVersionAfterMerge;

        const promotedFacts = approvedItems.map(item => ({
            ...item.proposedFact,
            lifecycleState: 'CANON' as const,
            origin: 'BIBLE' as const
        }));
        contextManager.updateState(promotedFacts);

        await this.writeProtectionIndex({
            code: 'PROMOTION_TO_BIBLE',
            createdAt: Date.now(),
            sourceEventId: `harvest-${this.currentRunId}`,
            canonVersion: mergeResult.canonVersionAfterMerge,
            factIds: approvedIds
        });

        relayEventBus.emit('state:updated', {
            runId: this.currentRunId!,
            chapterId: this.manifest!.chapterId,
            diffSummary: `Canon version updated to ${mergeResult.canonVersionAfterMerge}`
        });

        new Notice(`Successfully merged ${approvedIds.length} items into Story Bible.`);
    }

    /**
     * Post-run lore harvesting workflow.
     */
    private async performPostRunHarvest(contextManager: ContextManager) {
        if (!this.manifest) return;

        const proseChunks = this._getProseChunksFromManifest();
        if (proseChunks.length === 0) return;

        const candidates = await this.loreHarvestService.extractCandidates(
            proseChunks,
            contextManager.getState(),
            this.currentRunId!
        );

        if (candidates.length === 0) {
            console.debug('[SequentialGenerator] No lore candidates found for harvesting.');
            return;
        }

        this.manifest.harvestSummary = this._buildHarvestSummary(candidates);
        this._applySceneOnlyAutoAccepts(candidates, contextManager);

        const reviewItems = candidates.filter(c => c.recommendedAction === 'REVIEW' || c.recommendedAction === 'QUARANTINE');
        if (reviewItems.length > 0) {
            const result = await showHarvestChecklistModal(this.plugin.app, { items: reviewItems });
            if (result) {
                this.manifest.harvestSummary.approvedIds = result.approvedIds;
                this.manifest.harvestSummary.rejectedIds = result.rejectedIds;

                this._applyRunLocalItems(result.runLocalIds, result.resolutionActions, candidates, contextManager);
                await this._mergeApprovedIntoStoryBible(result.approvedIds, result.resolutionActions, candidates, contextManager);
            }
        }

        await this.saveManifest();
    }

    private checkControlFlow(): boolean {
        if (this.abortController?.signal.aborted || this.state === 'aborted' || this.state === 'STOPPED_FATAL') return true;
        if (this.state === 'PAUSED_FOR_INTERVENTION') {
            relayEventBus.emit('control:paused', { runId: this.currentRunId! });
            return true;
        }
        return false;
    }

    /**
     * Triggers a lightweight re-evaluation of grounding after a mutation is accepted.
     */
    private async reGround(contextManager: ContextManager) {
        console.debug('[SequentialGenerator] Post-mutation re-grounding triggered.');
        // In a real run, this would trigger a partial RETRIEVE or update the PLAN
        // to ensure new canon is used in the next iteration.
    }

    /**
     * Verifies the current environment against a manifest for strict replay.
     * Generates a MismatchReport if discrepancies are found.
     */
    async verifyManifest(manifest: RunManifest): Promise<MismatchReport[]> {
        const reports: MismatchReport[] = [];

        const currentPolicyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
        if (manifest.config.policyHash !== currentPolicyHash) {
            reports.push({
                field: 'policyHash',
                expected: manifest.config.policyHash,
                actual: currentPolicyHash,
                canProceed: false,
                severity: 'error'
            });
        }

        const currentCorpusHash = await this.plugin.embeddingsIndex.getCorpusHash();
        if (manifest.config.corpusHash !== currentCorpusHash) {
            reports.push({
                field: 'corpusHash',
                expected: manifest.config.corpusHash,
                actual: currentCorpusHash,
                canProceed: true,
                severity: 'warn'
            });
        }

        if (manifest.config.pluginVersion !== this.plugin.manifest.version) {
            reports.push({
                field: 'pluginVersion',
                expected: manifest.config.pluginVersion,
                actual: this.plugin.manifest.version,
                canProceed: true,
                severity: 'warn'
            });
        }

        return reports;
    }

    getContextManager(): ContextManager | null {
        return this.contextManager;
    }

    private async computeReplayPrereqs(): Promise<ReplayPrereqs> {
        const runKey = this.currentRunKey!;
        const adapter = this.plugin.app.vault.adapter;
        const base = RunPaths.baseDir(runKey);

        const hasPromptBodies = await adapter.exists(`${base}/context/prompt.chunk-1.json`);
        const hasHitsBodies = await adapter.exists(`${base}/context/hits.chunk-1.json`);
        const hasTemplateSnapshot = !!this.manifest?.environment?.snapshots?.templateSnapshot;
        const hasScoringSnapshot = !!this.manifest?.environment?.snapshots?.scoringSnapshot;
        const hasModelIdentity = !!this.manifest?.config?.smartModelDigest;

        return {
            hasPromptBodies,
            hasHitsBodies,
            hasTemplateSnapshot,
            hasScoringSnapshot,
            hasModelIdentity
        };
    }

    private consecutiveViolations = 0;

    /**
     * Checks for schema version mismatch between plugin and chapter state.
     */
    private verifySchemaDrift(state: ChapterState) {
        const LATEST_SUPPORTED_SCHEMA = 1;
        if (state.schemaVersion && state.schemaVersion > LATEST_SUPPORTED_SCHEMA) {
            throw new Error(`FAIL_SCHEMA_DRIFT: State schema version (${state.schemaVersion}) is newer than plugin version. Please update Gwriter.`);
        }
    }

    /**
     * Matrix Severity Check: Returns intervention trigger if needed.
     */
    private shouldTriggerIntervention(audit: AuditResult, chunkId: string): { trigger: 'FAIL_MATRIX_SEVERITY' | null; violationSummary: string } {
        if (audit.overallSeverity >= 5) {
            const coreViolation = audit.violations.find(v => v.severity >= 5);
            const msg = coreViolation?.message || 'Inconsistent lore detected';
            return { trigger: 'FAIL_MATRIX_SEVERITY', violationSummary: `CORE truth violation: ${msg}` };
        }
        return { trigger: null, violationSummary: '' };
    }

    /**
     * Repair Cap Check: Returns intervention trigger if needed.
     */
    private checkRepairCap(): { trigger: 'FAIL_REPAIR_CAP' | null; violationSummary: string } {
        const policy = CO_AUTHORING_POLICY.CONTINUITY_RISK;
        const recentStages = this.manifest!.stages.slice(-policy.WINDOWS.REPAIR_RATE_CHUNKS * 5);
        const repairs = recentStages.filter(s => s.stageType === 'REPAIR').length;

        if (repairs > 3) {
            return { trigger: 'FAIL_REPAIR_CAP', violationSummary: `Excessive repair debt (${repairs} repairs). Stopping to prevent hallucination spiral.` };
        }
        return { trigger: null, violationSummary: '' };
    }

    // ---------------------------------------------------------------------------
    // calculateContinuityRisk helpers
    // ---------------------------------------------------------------------------

    private _calcDormancyRisk(iteration: number, state: ChapterState, windows: any): number {
        const keyFacts = state.canonFacts.filter(f => AttributeRegistry.includes(f.attribute));
        if (keyFacts.length === 0) return 0;
        const dormantCount = keyFacts.filter(f => {
            const lastUsed = f.chunkId ? Number.parseInt(f.chunkId.replace('chunk-', '')) : 0;
            return (iteration - lastUsed) >= windows.DORMANCY_CHUNKS;
        }).length;
        return dormantCount / keyFacts.length;
    }

    private _calcDensityDropRisk(): number {
        const writeStages = this.manifest!.stages.filter(s => s.stageType === 'WRITE');
        if (writeStages.length < 2) return 0;
        const last2 = writeStages.slice(-2);
        const scores = last2.map(s => {
            const metadata = s.metadata || [];
            const grounded = metadata.filter(m => !m.isSpeculative).length;
            return metadata.length > 0 ? grounded / metadata.length : 0;
        });
        return Math.max(0, scores[0] - scores[1]);
    }

    private _calcRepairRisk(windows: any): number {
        const recentStages = this.manifest!.stages.slice(-windows.REPAIR_RATE_CHUNKS * 5);
        const auditStages = recentStages.filter(s => s.stageType === 'AUDIT');
        if (auditStages.length === 0) return 0;
        const repairs = recentStages.filter(s => s.stageType === 'REPAIR').length;
        return Math.min(1, repairs / auditStages.length);
    }

    private _calcRelianceRisk(): number {
        const writeStages = this.manifest!.stages.filter(s => s.stageType === 'WRITE');
        const lastWrite = writeStages[writeStages.length - 1];
        if (!lastWrite?.metadata) return 0;
        const factCounts: Record<string, number> = {};
        lastWrite.metadata.forEach(m => {
            m.factIds.forEach(id => {
                factCounts[id] = (factCounts[id] || 0) + 1;
            });
        });
        const totalParas = lastWrite.metadata.length;
        const maxFactCount = Math.max(0, ...Object.values(factCounts));
        return totalParas > 0 ? maxFactCount / totalParas : 0;
    }

    /**
     * Calculates the continuity risk score for the current iteration.
     * weighted sum: dormancy (35%) + drop (25%) + repairs (25%) + reliance (15%)
     */
    private calculateContinuityRisk(iteration: number, contextManager: ContextManager): number {
        const policy = CO_AUTHORING_POLICY.CONTINUITY_RISK;
        const weights = policy.WEIGHTS;
        const windows = policy.WINDOWS;

        const dormancyRisk = this._calcDormancyRisk(iteration, contextManager.getState(), windows);
        const densityDropRisk = this._calcDensityDropRisk();
        const repairRisk = this._calcRepairRisk(windows);
        const relianceRisk = this._calcRelianceRisk();

        const totalRisk = (dormancyRisk * weights.DORMANCY) +
                          (densityDropRisk * weights.DENSITY_DROP) +
                          (repairRisk * weights.REPAIR_RATE) +
                          (relianceRisk * weights.OVER_RELIANCE);

        if (!this.manifest!.continuityRisks) this.manifest!.continuityRisks = {};
        this.manifest!.continuityRisks[iteration.toString()] = totalRisk;

        return totalRisk;
    }

    /**
     * Maps the 0-100 slider value to LLM parameters using the lookup table.
     */
    private getSpontaneityParams(sliderValue: number) {
        const table = CO_AUTHORING_POLICY.SPONTANEITY.LOOKUP;
        const entry = table.find(e => sliderValue >= e.min && sliderValue <= e.max) || table[0];

        const rangeWidth = entry.max - entry.min;
        const progress = rangeWidth === 0 ? 0 : (sliderValue - entry.min) / rangeWidth;

        const temp = entry.temp[0] + (entry.temp[1] - entry.temp[0]) * progress;
        const novelty = entry.novelty[0] + (entry.novelty[1] - entry.novelty[0]) * progress;

        return {
            temp,
            novelty,
            stickyMin: entry.sticky_min
        };
    }

    /**
     * Applies a smooth continuous clamping function to novelty bias based on risk.
     * novelty_effective = novelty_raw * (1 - clamp01((risk - r0)/(r1 - r0)))
     */
    private applySmoothClamp(novelty: number, risk: number): number {
        const { R0_START_CLAMPING, R1_FULL_CLAMP } = CO_AUTHORING_POLICY.CONTINUITY_RISK.THRESHOLDS;

        if (risk <= R0_START_CLAMPING) return novelty;
        if (risk >= R1_FULL_CLAMP) return 0;

        const clampFactor = (risk - R0_START_CLAMPING) / (R1_FULL_CLAMP - R0_START_CLAMPING);
        return novelty * (1 - clampFactor);
    }

    private checkQualityFloors(iteration: number) {
        const policy = CO_AUTHORING_POLICY.QUALITY_FLOORS;
        const stages = this.manifest!.stages;
        const writeStages = stages.filter(s => s.stageType === 'WRITE');

        const totalGrounded = writeStages.reduce((acc, s) => acc + (s.metadata?.length || 0), 0);
        const speculativeCount = writeStages.reduce((acc, s) => acc + (s.metadata?.filter(m => m.isSpeculative).length || 0), 0);
        const speculativeRatio = totalGrounded > 0 ? speculativeCount / totalGrounded : 0;

        let hasViolation = false;
        if (speculativeRatio > policy.MAX_SPECULATIVE_RATIO) {
            hasViolation = true;
            console.warn(`[SequentialGenerator] Quality Floor Violation: Speculative Ratio too high.`);
        }

        let consecutiveLite = 0;
        for (let i = writeStages.length - 1; i >= 0; i--) {
            const isLite = writeStages[i].data?.recovered || writeStages[i].metadata?.every(m => m.isSpeculative);
            if (isLite) consecutiveLite++;
            else break;
        }

        if (consecutiveLite > policy.MAX_CONSECUTIVE_LITE_CHUNKS) {
            hasViolation = true;
        }

        if (hasViolation) {
            this.consecutiveViolations++;
            if (this.consecutiveViolations === 1) {
                new Notice('Quality Warning: grounding density low. Auto-refreshing context next chunk.');
            } else if (this.consecutiveViolations >= 2) {
                this.state = 'PAUSED_FOR_INTERVENTION';
                relayEventBus.emit('control:paused', { runId: this.currentRunId! });
                new Notice('Generation paused: multiple quality violations. Review lore/context.');
            }
        } else {
            this.consecutiveViolations = 0;
        }
    }

    private segmentAndRecover(text: string, oldMetadata: ParagraphMetadata[]): { text: string, metadata: ParagraphMetadata[] } {
        const policy = CO_AUTHORING_POLICY.SEGMENTATION;
        let paragraphs = text.split('\n\n').filter(p => p.trim());

        if (paragraphs.length <= 1 && text.length > policy.HARD_MAX_CHARS_PER_PARA) {
            console.debug('[SequentialGenerator] Segmentation drift detected. Recovering...');
            paragraphs = this.fallbackSegment(text);
        }

        const oldParas = oldMetadata.map(m => ({ p_id: m.p_id, text: '' }));
        const recovered = this.identityService.recoverIdentities(paragraphs, oldParas);

        return {
            text: paragraphs.join('\n\n'),
            metadata: recovered.map(r => ({
                p_id: r.p_id,
                goalIds: [],
                factIds: [],
                sourceChunkIds: [],
                isSpeculative: true
            }))
        };
    }

    private fallbackSegment(text: string): string[] {
        const policy = CO_AUTHORING_POLICY.SEGMENTATION;
        const sentences = text.match(/[^.!?]+[.!?]+(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || [text];
        const paragraphs: string[] = [];
        let current: string[] = [];

        for (const s of sentences) {
            current.push(s);
            const currentLen = current.join(' ').length;
            if ((current.length >= policy.TARGET_SENTENCES_PER_PARA.max || currentLen > policy.HARD_MAX_CHARS_PER_PARA) &&
                !this.isInQuotesOrParens(s)) {
                paragraphs.push(current.join(' ').trim());
                current = [];
            }
        }
        if (current.length > 0) paragraphs.push(current.join(' ').trim());
        return paragraphs;
    }

    private isInQuotesOrParens(text: string): boolean {
        const quotes = (text.match(/"/g) || []).length;
        const parens = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
        return quotes % 2 !== 0 || parens !== 0;
    }

    private calculateHealth() {
        const stages = this.manifest!.stages;
        const writeStages = stages.filter(s => s.stageType === 'WRITE');

        let tierAParagraphs = 0;
        let totalParagraphs = 0;

        writeStages.forEach(s => {
            if (s.data?.runMode === 'CLOUD_MONOLITHIC') {
                totalParagraphs += 1;
                tierAParagraphs += 1;
            } else {
                tierAParagraphs += (s.metadata?.filter(m => !m.isSpeculative).length || 0);
                totalParagraphs += (s.metadata?.length || 0);
            }
        });

        return {
            tierARatio: totalParagraphs > 0 ? tierAParagraphs / totalParagraphs : 0,
            recoveryEvents: stages.filter(s => s.data?.recovered).length,
            mutationsProposed: this.manifest!.stages.filter(s => s.stageType === 'UPDATE' && s.data?.mutations).length
        };
    }

    private async applyPatches(text: string, patches: PatchOp[]): Promise<string> {
        let result = text;
        const sorted = [...patches].sort((a, b) => b.range.start - a.range.start);
        for (const patch of sorted) {
            if (patch.op === 'replace') {
                result = result.slice(0, patch.range.start) + patch.newValue + result.slice(patch.range.end);
            }
        }
        return result;
    }

    private applyStitchPatches(text: string, ops: StitchPatchOp[], metadata: ParagraphMetadata[]): string {
        const paragraphs = text.split('\n\n').filter(p => p.trim());
        const paraMap = new Map(paragraphs.map((p, i) => [metadata[i]?.p_id || `temp-${i}`, p]));

        const sortedOps = sortPatchOps(ops);

        for (const op of sortedOps) {
            const currentText = paraMap.get(op.paragraphId);
            if (currentText) {
                const updated = currentText.substring(0, op.start) + op.replacementText + currentText.substring(op.end);
                paraMap.set(op.paragraphId, updated);
            }
        }

        return paragraphs.map((_, i) => paraMap.get(metadata[i]?.p_id || `temp-${i}`)).join('\n\n');
    }

    private failRun(error: string) {
        this.state = 'error';
        relayEventBus.emit('run:error', { runId: this.currentRunId || 'unknown', error });
        new Notice(`Generation failed: ${error}`);
    }

    private async saveManifest() {
        if (!this.manifest || !this.currentRunKey) return;

        const manifestPath = `${RunPaths.baseDir(this.currentRunKey)}/run.json`;

        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.logsDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.contextDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.harvestDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.snapshotsDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.replaysDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.branchesDir(this.currentRunKey)}/dummy.txt`);

        const manifestWithMetadata = {
            ...this.manifest,
            _metadata: {
                runId: this.manifest.runId,
                runKey: this.manifest.runKey,
                contentHash: await contentHash(this.manifest),
                schemaVersion: ArtifactSchemaVersions.RUN_MANIFEST,
                generatorVersion: `${this.manifest.config.pluginVersion}+policy-${this.manifest.config.policyHash.slice(0, 8)}`,
                timestamp: Date.now()
            }
        };

        await this.plugin.vaultService.ensureParentFolder(manifestPath);
        await this.plugin.vaultService.writeFile(manifestPath, JSON.stringify(manifestWithMetadata, null, 2));

        if (this.manifest.continuations && this.manifest.continuations.length > 0) {
            for (const cont of this.manifest.continuations) {
                if (cont.status === 'ACTIVE') {
                    await this.saveContinuationManifest(cont.continuationId);
                }
            }
        }

        await this.writePolicySnapshot(this.currentRunKey);
        await this.writeRunIndex(this.currentRunKey);
    }

    /**
     * Saves a continuation delta manifest to branches/cont-XXX/cont.json
     */
    private async saveContinuationManifest(contId: string): Promise<void> {
        if (!this.manifest || !this.currentRunKey) return;

        const contManifest = {
            continuationId: contId,
            parentRunId: this.manifest.runId,
            runKey: this.currentRunKey,
            stages: this.manifest.stages.filter(_s => {
                return true;
            }),
            interventions: this.manifest.interventions?.filter(_i => {
                return true;
            }) || [],
            timestamp: Date.now()
        };

        const contPath = RunPaths.continuationManifestPath(this.currentRunKey, contId);
        await this.plugin.vaultService.ensureParentFolder(contPath);

        const contWithMetadata = {
            ...contManifest,
            _metadata: {
                runId: this.manifest.runId,
                runKey: this.currentRunKey,
                contentHash: await contentHash(contManifest),
                schemaVersion: ArtifactSchemaVersions.RUN_MANIFEST,
                generatorVersion: `${this.manifest.config.pluginVersion}+policy-${this.manifest.config.policyHash.slice(0, 8)}`,
                timestamp: Date.now()
            }
        };

        await this.plugin.vaultService.writeFile(contPath, JSON.stringify(contWithMetadata, null, 2));

        if (!this.manifest.continuations) {
            this.manifest.continuations = [];
        }
    }

    /**
     * Writes a policy snapshot for the run.
     */
    private async writePolicySnapshot(runKey: string): Promise<void> {
        const policy = CO_AUTHORING_POLICY;
        const policyHash = await sha256(canonicalJsonStringify(policy));

        let pluginVersion = this.plugin.manifest.version;
        if (!pluginVersion) {
            try {
                const packageJson = require('../../package.json');
                pluginVersion = packageJson.version || 'unknown';
            } catch {
                pluginVersion = 'unknown';
            }
        }

        const snapshot: PolicySnapshot = {
            policyHash,
            policyVersion: pluginVersion,
            thresholds: {
                GROUNDING: policy.GROUNDING,
                RETRIEVAL: policy.RETRIEVAL,
                INTERVENTION: policy.INTERVENTION,
                TELESCOPING: policy.TELESCOPING,
                HARVEST: policy.HARVEST
            },
            timestamp: Date.now()
        };

        const snapshotWithMetadata = {
            ...snapshot,
            _metadata: {
                runId: this.manifest?.runId || '',
                runKey,
                contentHash: await contentHash(snapshot),
                schemaVersion: ArtifactSchemaVersions.DECISIONS,
                generatorVersion: `${pluginVersion}+policy-${policyHash.slice(0, 8)}`,
                timestamp: Date.now()
            }
        };

        const snapshotPath = `${RunPaths.baseDir(runKey)}/policy.json`;
        await this.plugin.vaultService.writeFile(snapshotPath, JSON.stringify(snapshotWithMetadata, null, 2));
    }

    /**
     * Writes the RunIndex (TOC) for the run with comprehensive health checking.
     */
    private async writeRunIndex(runKey: string): Promise<void> {
        if (!this.manifest) return;

        const healthResult = this.calculateHealthCode();

        const auditViolations = this.manifest.stages.filter(s => s.stageType === 'AUDIT').reduce((acc, s) => acc + (s.data?.violations?.length || 0), 0);

        const index: RunIndex = {
            indexSchemaVersion: ArtifactSchemaVersions.RUN_INDEX,
            runId: this.manifest.runId,
            health: healthResult.health,
            healthCodes: healthResult.codes,
            stagesCompleted: this.manifest.stages.map(s => s.stageType),
            artifacts: {},
            requiredArtifactsByStage: RequiredArtifactsByStage as unknown as Record<string, string[]>,
            metrics: {
                repairs: this.manifest.stages.filter(s => s.stageType === 'REPAIR').length,
                misses: auditViolations,
                interventions: this.manifest.interventions?.length || 0,
                harvestCandidates: this.manifest.harvestSummary?.totalCandidates || 0
            },
            latestContinuationId: this.manifest.continuations?.[this.manifest.continuations.length - 1]?.continuationId,
            computedAt: Date.now()
        };

        const indexWithMetadata = {
            ...index,
            _metadata: {
                runId: this.manifest.runId,
                runKey,
                contentHash: await contentHash(index),
                schemaVersion: ArtifactSchemaVersions.RUN_INDEX,
                generatorVersion: `${this.manifest.config.pluginVersion}+policy-${this.manifest.config.policyHash.slice(0, 8)}`,
                timestamp: Date.now()
            }
        };

        const indexPath = `${RunPaths.baseDir(runKey)}/index.json`;
        await this.plugin.vaultService.writeFile(indexPath, JSON.stringify(indexWithMetadata, null, 2));
    }

    /**
     * Calculates health code for the run with comprehensive checks.
     * Returns worst severity and array of all issues found.
     */
    private calculateHealthCode(): { health: RunHealthCode; codes: RunHealthCode[] } {
        if (!this.manifest) return { health: 'OK', codes: [] };

        const codes: RunHealthCode[] = [];

        if (this.manifest.stages.some(s => !s.data)) {
            codes.push('MISSING_PROMPT_BODY');
        }

        if (this.manifest.continuations) {
            const contIds = new Set(this.manifest.continuations.map(c => c.continuationId));
            for (const cont of this.manifest.continuations) {
                if (cont.parentContId && !contIds.has(cont.parentContId)) {
                    codes.push('BRANCH_ORPHANED');
                    break;
                }
            }
        }

        if (codes.length === 0) {
            return { health: 'OK', codes: [] };
        }

        codes.sort((a, b) => healthSeverity(b) - healthSeverity(a));
        return { health: codes[0], codes };
    }

    /**
     * Acquires a heartbeat lock for the run.
     */
    private async acquireRunLock(runKey: string): Promise<void> {
        const lockPath = `.gwriter/locks/${runKey}.lock`;
        const lockContent = {
            runId: this.currentRunId!,
            runKey,
            sessionId: this.sessionId,
            startedAt: Date.now(),
            lastHeartbeat: Date.now()
        };

        await this.plugin.vaultService.ensureParentFolder(lockPath);
        await this.plugin.vaultService.writeFile(lockPath, JSON.stringify(lockContent, null, 2));

        this.heartbeatInterval = setInterval(async () => {
            if (this.currentRunKey === runKey) {
                const updatedLock = {
                    ...lockContent,
                    lastHeartbeat: Date.now()
                };
                await this.plugin.vaultService.writeFile(lockPath, JSON.stringify(updatedLock, null, 2));
            }
        }, 30000);
    }

    /**
     * Releases the run lock.
     */
    private async releaseRunLock(runKey: string): Promise<void> {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }

        const lockPath = `.gwriter/locks/${runKey}.lock`;
        try {
            const lockFile = this.plugin.app.vault.getAbstractFileByPath(lockPath);
            if (lockFile instanceof TFile) {
                await this.plugin.app.vault.delete(lockFile);
            }
        } catch (err) {
            console.warn(`[SequentialGenerator] Failed to release lock:`, err);
        }
    }

    /**
     * Writes protection index when a run promotes lore to Story Bible.
     */
    private async writeProtectionIndex(reason: ProtectionReason): Promise<void> {
        if (!this.currentRunKey || !this.currentRunId) return;

        const protectionPath = `${RunPaths.baseDir(this.currentRunKey)}/protected.json`;

        await this.plugin.vaultService.ensureParentFolder(protectionPath);
        await this.plugin.vaultService.writeFile(protectionPath, JSON.stringify({
            runId: this.currentRunId,
            reasons: [reason],
            createdAt: Date.now()
        }, null, 2));

        await this.updateGlobalProtectionIndex(this.currentRunId, reason);
    }

    /**
     * Updates the global protection index.
     */
    private async updateGlobalProtectionIndex(runId: string, reason: ProtectionReason): Promise<void> {
        const indexPath = '.gwriter/protection-index.json';

        let index: Record<string, ProtectionReason[]> = {};
        try {
            const existingFile = this.plugin.app.vault.getAbstractFileByPath(indexPath);
            if (existingFile instanceof TFile) {
                const content = await this.plugin.app.vault.read(existingFile);
                index = JSON.parse(content);
            }
        } catch (err) {
            console.error(`[SequentialGenerator] Could not read protection index:`, err);
        }

        if (!index[runId]) {
            index[runId] = [];
        }
        index[runId].push(reason);

        await this.plugin.vaultService.ensureParentFolder(indexPath);
        await this.plugin.vaultService.writeFile(indexPath, JSON.stringify(index, null, 2));
    }

    // ---------------------------------------------------------------------------
    // computeProtectionClosure helpers
    // ---------------------------------------------------------------------------

    private async _buildRunIdToKeyMap(outputRoot: TFolder): Promise<Map<string, string>> {
        const runIdToKey = new Map<string, string>();
        for (const child of outputRoot.children) {
            if (!(child instanceof TFolder) || !child.name.startsWith('run-')) continue;
            const manifestFile = child.children.find(f => f.name === 'run.json');
            if (!(manifestFile instanceof TFile)) continue;
            try {
                const content = await this.plugin.app.vault.read(manifestFile);
                const manifest: RunManifest = JSON.parse(content);
                runIdToKey.set(manifest.runId, child.name);
            } catch (err) {
                console.error(`[SequentialGenerator] Could not read manifest for ${child.name}:`, err);
            }
        }
        return runIdToKey;
    }

    private async _expandContinuationEdges(
        manifest: RunManifest,
        closure: Set<string>,
        queue: string[],
        runIdToKey: Map<string, string>
    ): Promise<void> {
        if (!manifest.continuations) return;
        manifest.continuations.forEach((cont) => {
            if (!cont.parentRunId) return;
            const parentKey = runIdToKey.get(cont.parentRunId);
            if (parentKey && !closure.has(parentKey)) {
                closure.add(parentKey);
                queue.push(parentKey);
            }
        });
    }

    /**
     * Computes transitive closure of protected runs via BFS over provenance graph.
     */
    private async computeProtectionClosure(protectedRunKeys: Set<string>): Promise<Set<string>> {
        const MAX_CLOSURE_NODES = 10000;
        const closure = new Set<string>(protectedRunKeys);
        const queue = Array.from(protectedRunKeys);
        const visited = new Set<string>();

        const outputRoot = this.plugin.app.vault.getAbstractFileByPath('.gwriter/output');
        if (!(outputRoot instanceof TFolder)) return closure;

        const runIdToKey = await this._buildRunIdToKeyMap(outputRoot);

        while (queue.length > 0 && closure.size < MAX_CLOSURE_NODES) {
            const runKey = queue.shift()!;
            if (visited.has(runKey)) continue;
            visited.add(runKey);

            const runFolder = outputRoot.children.find(f => f.name === runKey);
            if (!(runFolder instanceof TFolder)) continue;

            const manifestFile = runFolder.children.find(f => f.name === 'run.json');
            if (!(manifestFile instanceof TFile)) continue;

            try {
                const manifestContent = await this.plugin.app.vault.read(manifestFile);
                const manifest: RunManifest = JSON.parse(manifestContent);
                await this._expandContinuationEdges(manifest, closure, queue, runIdToKey);
            } catch (err) {
                console.warn(`[SequentialGenerator] Failed to read manifest for ${runKey}:`, err);
            }
        }

        if (closure.size >= MAX_CLOSURE_NODES) {
            console.warn(`[SequentialGenerator] Protection closure limit reached (${MAX_CLOSURE_NODES}). Stopping cleanup.`);
        }

        return closure;
    }

    // ---------------------------------------------------------------------------
    // cleanupOldRuns helpers
    // ---------------------------------------------------------------------------

    private async _loadProtectedRunKeys(abstractRoot: TFolder): Promise<Set<string>> {
        const protectedRunKeys = new Set<string>();
        for (const child of abstractRoot.children) {
            if (!(child instanceof TFolder) || !child.name.startsWith('run-')) continue;
            const protectedFile = child.children.find(f => f.name === 'protected.json');
            if (protectedFile) {
                protectedRunKeys.add(child.name);
            }
        }
        return protectedRunKeys;
    }

    private _selectRunsToTrash(abstractRoot: TFolder, closure: Set<string>): TFolder[] {
        const MAX_RUNS_TO_KEEP = 10;
        const runFolders = abstractRoot.children
            .filter(f => f instanceof TFolder && f.name.startsWith('run-'))
            .sort((a, b) => b.name.localeCompare(a.name));

        const toTrash: TFolder[] = [];
        let unprotectedCount = 0;

        for (const folder of runFolders) {
            if (folder.name === this.currentRunKey) continue;
            if (closure.has(folder.name)) continue;
            unprotectedCount++;
            if (unprotectedCount > MAX_RUNS_TO_KEEP) {
                toTrash.push(folder as TFolder);
            }
        }
        return toTrash;
    }

    private async _trashRuns(toTrash: TFolder[]): Promise<void> {
        for (const folder of toTrash) {
            try {
                await this.plugin.trashService.trashRun(folder.name, folder.path, 'Automatic cleanup: exceeded keep limit');
                console.debug(`[SequentialGenerator] Moved run to trash: ${folder.name}`);
            } catch (err) {
                console.warn(`[SequentialGenerator] Failed to trash run ${folder.name}:`, err);
            }
        }
    }

    /**
     * Identifies and cleans up old runs, preserving "protected" ones.
     */
    private async cleanupOldRuns() {
        const abstractRoot = this.plugin.app.vault.getAbstractFileByPath('.gwriter/output');
        if (!(abstractRoot instanceof TFolder)) return;

        const protectedRunKeys = await this._loadProtectedRunKeys(abstractRoot);
        const closure = await this.computeProtectionClosure(protectedRunKeys);
        const toTrash = this._selectRunsToTrash(abstractRoot, closure);
        await this._trashRuns(toTrash);
    }

    // ---------------------------------------------------------------------------
    // runMonolithicCloudPath helpers
    // ---------------------------------------------------------------------------

    private _buildInitialStateForCloud(): ChapterState {
        return {
            chapterId: `chapter-${Date.now()}`,
            canonVersion: 1,
            entities: [],
            canonFacts: [],
            mutationHistory: [],
            timeline: [],
            openLoops: [],
            constraints: {
                pov: this.plugin.settings.defaultPOV || 'third-person-limited',
                tense: this.plugin.settings.defaultTense || 'past',
                tone: ['noir'],
                forbidden: []
            }
        } as ChapterState;
    }

    private async _buildCloudManifest(
        initialState: ChapterState,
        policyHash: string,
        corpusHash: string,
        storyBibleHash: string,
        targetWordCount: number
    ): Promise<void> {
        const pluginVersion = this.plugin.manifest.version || '1.0.3';
        const indexStatus = this.plugin.embeddingsIndex.getStatus();
        const environment = {
            pluginVersion,
            policyHash,
            promptTemplateHash: await sha256(JSON.stringify(this.plugin.promptEngine)),
            scoringProfileHash: policyHash,
            modelBackend: this.plugin.settings.apiProvider,
            modelId: this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model,
            vaultSnapshotHash: corpusHash,
            indexVersion: indexStatus.indexedChunks,
            timestamp: Date.now()
        };

        this.manifest = {
            runId: this.currentRunId!,
            runKey: this.currentRunKey!,
            chapterId: initialState.chapterId,
            startTime: Date.now(),
            storyBibleHash,
            initialStateHash: await sha256(JSON.stringify(initialState)),
            stages: [],
            config: {
                smartModel: this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model,
                smartModelDigest: this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model,
                fastModel: this.plugin.settings.relayCloudFastModel || this.plugin.settings.model,
                fastModelDigest: this.plugin.settings.relayCloudFastModel || this.plugin.settings.model,
                maxChunkWords: targetWordCount,
                temperature: 0.7,
                policyHash,
                corpusHash,
                pluginVersion
            },
            environment,
            replayable: false,
            interventions: [],
            continuations: [],
            plotMemorySnapshots: []
        };
    }

    private _startContinuityPulse(cloudStartTime: number): ReturnType<typeof setInterval> {
        const pulseMessages = [
            'Traversing 128k context window...',
            'Integrating retrieval hits...',
            'Respecting locked bible facts...',
            'Matching author voice signature...',
            'Stitching narrative threads...',
            'Polishing prose flow...'
        ];
        let pulseIdx = 0;
        return setInterval(() => {
            const msg = pulseMessages[pulseIdx % pulseMessages.length];
            relayEventBus.emit('run:pulse', {
                runId: this.currentRunId!,
                message: msg,
                detail: `Elapsed: ${Math.floor((Date.now() - cloudStartTime) / 1000)}s`
            });
            pulseIdx++;
        }, 3000);
    }

    private _buildViolationSummary(auditResult: AuditResult, tupleViolations: string[], citationViolations: string[]): string {
        return [
            auditResult.summary,
            tupleViolations.length > 0 ? `${tupleViolations.length} locked fact violations` : '',
            citationViolations.length > 0 ? `${citationViolations.length} citation mismatches` : ''
        ].filter(Boolean).join('; ');
    }

    private _hasCloudFatalViolations(auditResult: AuditResult, tupleViolations: string[], citationViolations: string[]): boolean {
        return auditResult.overallSeverity >= 5 || tupleViolations.length > 0 || citationViolations.length > 0;
    }

    private async _verifyCloudReplayArtifacts(): Promise<void> {
        const contextPackPath = RunPaths.baseDir(this.currentRunKey!) + '/context/context-pack.json';
        const policyPath = RunPaths.policySnapshotPath(this.currentRunKey!);
        const manifestPath = RunPaths.manifestPath(this.currentRunKey!);

        try {
            const contextPackFile = this.plugin.app.vault.getAbstractFileByPath(contextPackPath);
            const policyFile = this.plugin.app.vault.getAbstractFileByPath(policyPath);
            const manifestFile = this.plugin.app.vault.getAbstractFileByPath(manifestPath);

            if (contextPackFile && policyFile && manifestFile) {
                this.manifest!.replayable = true;
            }
        } catch (err) {
            console.warn('[SequentialGenerator] Failed to verify replay artifacts:', err);
        }
    }

    /**
     * Monolithic Cloud Path - Single-call chapter generation
     * CONTEXT_PACK -> CLOUD_CALL -> LOCAL_GATE -> COMMIT
     */
    private async runMonolithicCloudPath(targetWordCount: number, opts?: { dryRun?: boolean }): Promise<void> {
        if (!this.cloudRelay || !this.contextPacker) {
            this.failRun('Cloud relay or context packer not initialized.');
            return;
        }

        if (!this.plugin.settings.apiKey) {
            this.failRun('API key not configured. Please set your API key in settings.');
            return;
        }

        const policyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
        const corpusHash = await this.plugin.embeddingsIndex.getCorpusHash();

        const initialState = this._buildInitialStateForCloud();
        const contextManager = new ContextManager(this.plugin.app.vault, initialState);
        this.contextManager = contextManager;

        const seedResult = await contextManager.seedFromStoryBible(this.plugin.settings.storyBiblePath);
        const userInstruction = (this.plugin.settings.modeState?.chapter?.rewriteInstructions ||
                               'Write a compelling chapter that advances the plot.');

        relayEventBus.emit('stage:progress', {
            runId: this.currentRunId!,
            stageId: 'pack',
            message: 'Packing context (120k tokens)...'
        });

        const retrievalHits = await this.plugin.retrievalService.search({
            text: userInstruction,
            mode: 'chapter'
        }, {
            limit: 50,
            strictMode: false
        });

        const contextPack = await this.contextPacker.buildContextPack(
            contextManager.getState(),
            retrievalHits.map(hit => ({
                id: hit.key || hit.path,
                excerpt: hit.excerpt,
                sourcePath: hit.path,
                relevanceScore: hit.relevance?.finalScore || 0.5,
                intentHardness: 'SOFT' as const
            })),
            this.plugin.settings.relayStyleSignature,
            userInstruction
        );

        await this.contextPacker.saveContextPack(contextPack, this.currentRunKey!, this.plugin.vaultService);

        const lockMap = contextPack.lockMap;

        const estimatedCost = this.estimateCloudCost(contextPack.tokenEstimate.total, targetWordCount);
        if (this.plugin.settings.relayCostHardBudget && estimatedCost.high > this.plugin.settings.relayCostHardBudget) {
            this.failRun(`Estimated cost ($${estimatedCost.high.toFixed(2)}) exceeds hard budget ($${this.plugin.settings.relayCostHardBudget}).`);
            return;
        }

        await this._buildCloudManifest(initialState, policyHash, corpusHash, seedResult.hash, targetWordCount);

        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });

        try {
            relayEventBus.emit('stage:progress', {
                runId: this.currentRunId!,
                stageId: 'cloud-write',
                message: `Cloud generating (${this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model})...`
            });

            const cloudStartTime = Date.now();
            const writeInput: WriteChapterInput = {
                instruction: userInstruction,
                context: contextPack,
                wordCount: targetWordCount,
                lockMap
            };

            const pulseInterval = this._startContinuityPulse(cloudStartTime);

            let cloudOutput: any;
            try {
                cloudOutput = await this.cloudRelay.writeChapter(
                    writeInput,
                    this.abortController?.signal
                );
            } finally {
                clearInterval(pulseInterval);
            }

            const cloudLatency = Date.now() - cloudStartTime;

            relayEventBus.emit('stage:progress', {
                runId: this.currentRunId!,
                stageId: 'local-audit',
                message: 'Local auditing (Lore Check)...'
            });

            const fullProse = cloudOutput.paragraphs.map(p => p.text).join('\n\n');
            const auditResult = await this.auditService.auditFullChapter(
                fullProse,
                contextManager.getState()
            );

            const tupleViolations = this.verifyLockedFacts(
                cloudOutput.lockedFactAttestations,
                cloudOutput.extractedTuples || [],
                lockMap
            );

            const citationViolations = await this.verifyCitations(
                cloudOutput.paragraphs,
                contextPack.retrievalHits
            );

            if (this._hasCloudFatalViolations(auditResult, tupleViolations, citationViolations)) {
                const violationSummary = this._buildViolationSummary(auditResult, tupleViolations, citationViolations);
                const interventionGuidance = await this.handleIntervention(
                    'FAIL_MATRIX_SEVERITY',
                    violationSummary,
                    'monolithic-cloud-output',
                    auditResult.overallSeverity,
                    contextManager
                );

                if (!interventionGuidance) {
                    this.state = 'STOPPED_FATAL';
                    return;
                }
            }

            await this.commitCloudChapter(cloudOutput, contextManager, {
                latencyMs: cloudLatency,
                tokensIn: contextPack.tokenEstimate.total,
                tokensOut: estimateTokens(fullProse),
                requestId: undefined,
                estimatedCost
            });

            this.state = 'COMPLETED';
            this.manifest!.endTime = Date.now();

            await this.contextPacker!.saveContextPack(contextPack, this.currentRunKey!, this.plugin.vaultService);
            await this.writePolicySnapshot(this.currentRunKey!);
            await this._verifyCloudReplayArtifacts();

            relayEventBus.emit('run:end', {
                runId: this.currentRunId!,
                totalWords: fullProse.split(/\s+/).length,
                health: this.calculateHealth()
            } as any);

            await this.saveManifest();

        } catch (err: any) {
            this.state = 'error';
            relayEventBus.emit('run:error', {
                runId: this.currentRunId!,
                error: err.message || String(err)
            });
        } finally {
            if (this.currentRunKey) {
                await this.releaseRunLock(this.currentRunKey);
            }
            this.abortController = null;
        }
    }

    /**
     * Estimate cloud cost based on tokens
     */
    private estimateCloudCost(inputTokens: number, estimatedOutputTokens: number): { low: number; high: number } {
        const provider = this.plugin.settings.apiProvider;
        const model = this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model;

        let inputPricePer1k = 0.01;
        let outputPricePer1k = 0.03;

        if (provider === 'openai') {
            if (model.includes('gpt-4o')) {
                inputPricePer1k = 0.0025;
                outputPricePer1k = 0.01;
            } else if (model.includes('gpt-4')) {
                inputPricePer1k = 0.03;
                outputPricePer1k = 0.06;
            }
        } else if (provider === 'anthropic') {
            if (model.includes('claude-3-5-sonnet')) {
                inputPricePer1k = 0.003;
                outputPricePer1k = 0.015;
            }
        }

        const inputCost = (inputTokens / 1000) * inputPricePer1k;
        const outputCost = (estimatedOutputTokens / 1000) * outputPricePer1k;
        const total = inputCost + outputCost;

        return {
            low: total * 0.8,
            high: total * 1.2
        };
    }

    /**
     * Verify locked facts against attestations and extracted tuples
     */
    private verifyLockedFacts(
        attestations: Array<{ factId: string; status: string }>,
        extractedTuples: CanonFact[],
        lockMap: any
    ): string[] {
        const violations: string[] = [];

        attestations.forEach(att => {
            if (att.status === 'CONTRADICTED') {
                violations.push(`Locked fact ${att.factId} was contradicted`);
            }
        });

        extractedTuples.forEach(tuple => {
            const lockedFact = lockMap.canonicalTuples.find((f: CanonFact) =>
                f.entityId === tuple.entityId &&
                f.attribute === tuple.attribute
            );
            if (lockedFact && lockedFact.value !== tuple.value) {
                violations.push(`Extracted tuple contradicts locked fact: ${tuple.entityId}.${tuple.attribute}`);
            }
        });

        return violations;
    }

    /**
     * Verify citations match retrieved hits
     */
    private async verifyCitations(
        paragraphs: Array<{ citations: Array<{ hitId: string; snippetHash: string }> }>,
        retrievalHits: Array<{ id: string; snippetHash: string }>
    ): Promise<string[]> {
        const violations: string[] = [];
        const hitMap = new Map(retrievalHits.map(h => [h.id, h]));

        paragraphs.forEach((para, paraIdx) => {
            para.citations.forEach(citation => {
                const hit = hitMap.get(citation.hitId);
                if (!hit) {
                    violations.push(`Citation references unknown hit: ${citation.hitId} (paragraph ${paraIdx})`);
                } else if (hit.snippetHash !== citation.snippetHash) {
                    violations.push(`Citation hash mismatch for hit ${citation.hitId} (paragraph ${paraIdx})`);
                }
            });
        });

        return violations;
    }

    /**
     * Commit cloud-generated chapter
     */
    private async commitCloudChapter(
        output: any,
        contextManager: ContextManager,
        telemetry: {
            latencyMs: number;
            tokensIn: number;
            tokensOut: number;
            requestId?: string;
            estimatedCost: { low: number; high: number }
        }
    ): Promise<void> {
        const fullProse = output.paragraphs.map((p: any) => p.text).join('\n\n');

        const state = contextManager.getState();
        state.lastChunkId = 'monolithic-cloud-output';

        if (this.manifest) {
            this.manifest.stages.push({
                stageId: 'cloud-write',
                stageType: 'WRITE',
                startTime: Date.now() - telemetry.latencyMs,
                endTime: Date.now(),
                inputHash: 'monolithic-input',
                outputHash: await sha256(fullProse),
                data: {
                    runMode: 'CLOUD_MONOLITHIC',
                    cloudCall: {
                        provider: this.plugin.settings.apiProvider,
                        modelId: this.plugin.settings.relayCloudSmartModel || this.plugin.settings.model,
                        requestId: telemetry.requestId,
                        attempts: 1,
                        latencyMs: telemetry.latencyMs,
                        tokensIn: telemetry.tokensIn,
                        tokensOut: telemetry.tokensOut,
                        estimatedCost: telemetry.estimatedCost
                    },
                    outputBundleHash: await sha256(canonicalJsonStringify(output.paragraphs))
                }
            } as any);
        }

        if (!this.dryRun) {
            relayEventBus.emit('chunk:committed', {
                runId: this.currentRunId!,
                chunkId: 'monolithic-chapter',
                content: fullProse,
                metadata: output.paragraphs.map((p: any) => p.sidecar),
                path: this.plugin.settings.book2Path
            });
        } else {
            console.debug(`[SequentialGenerator] [DRY-RUN] Would have committed monolithic chapter to ${this.plugin.settings.book2Path}`);
        }

        contextManager.updateState([], {
            chunkId: 'monolithic-chapter',
            summary: `Cloud generated full chapter (${fullProse.split(/\s+/).length} words)`
        });

        await this.performCloudHarvest(contextManager, fullProse, output.paragraphs, output.extractedTuples);
    }

    // ---------------------------------------------------------------------------
    // performCloudHarvest helpers
    // ---------------------------------------------------------------------------

    private _applyCloudRunLocalItems(
        runLocalIds: string[],
        resolutionActions: Record<string, string>,
        harvestResult: any[],
        contextManager: ContextManager
    ): void {
        if (runLocalIds.length === 0) return;
        const runLocalItems = harvestResult.filter(c => runLocalIds.includes(c.harvestId));
        runLocalItems.forEach(item => {
            item.resolutionAction = resolutionActions[item.harvestId] || 'SCOPE_TO_SCENE';
            const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const, scope: 'SCENE' as const };
            contextManager.updateState([fact]);
            this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
        });
    }

    private async _mergeCloudApprovedItems(
        approvedIds: string[],
        resolutionActions: Record<string, string>,
        harvestResult: any[],
        contextManager: ContextManager
    ): Promise<void> {
        if (approvedIds.length === 0) return;

        approvedIds.forEach(id => {
            const item = harvestResult.find(c => c.harvestId === id);
            if (item && resolutionActions[id]) {
                item.resolutionAction = resolutionActions[id];
            }
        });

        const approvedItems = harvestResult.filter(c => approvedIds.includes(c.harvestId));
        const mergeResult = await this.plugin.vaultService.mergeHarvestIntoStoryBible(
            this.plugin.settings.storyBiblePath,
            approvedItems,
            contextManager.getState().canonVersion
        );

        if (!mergeResult.success) return;

        this.manifest!.harvestSummary!.canonVersionAfterMerge = mergeResult.canonVersionAfterMerge;
        const promotedFacts = approvedItems.map(item => ({
            ...item.proposedFact,
            lifecycleState: 'CANON' as const,
            origin: 'BIBLE' as const
        }));
        contextManager.updateState(promotedFacts);
    }

    /**
     * Perform lore harvesting for cloud-generated chapters
     */
    private async performCloudHarvest(
        contextManager: ContextManager,
        fullProse: string,
        paragraphs: Array<{ sidecar: any }>,
        modelExtractedTuples?: CanonFact[]
    ): Promise<void> {
        if (!this.manifest) return;

        const harvestResult = await this.loreHarvestService.extractCandidates(
            [{
                chunkId: 'monolithic-chapter',
                text: fullProse,
                metadata: paragraphs.map(p => p.sidecar)
            }],
            contextManager.getState(),
            this.currentRunId!
        );

        harvestResult.forEach(item => {
            item.proposedFact.origin = 'CLOUD_MONOLITHIC';
        });

        if (modelExtractedTuples && modelExtractedTuples.length > 0) {
            await this.loreHarvestService.mergeModelTuples(harvestResult, modelExtractedTuples);
        }

        if (harvestResult.length === 0) {
            console.debug('[SequentialGenerator] No lore candidates found for cloud harvest.');
            return;
        }

        this.manifest.harvestSummary = this._buildHarvestSummary(harvestResult);

        const sceneOnlyItems = harvestResult.filter(c => c.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY');
        sceneOnlyItems.forEach(item => {
            const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const };
            contextManager.updateState([fact]);
            this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
        });

        const reviewItems = harvestResult.filter(c => c.recommendedAction === 'REVIEW' || c.recommendedAction === 'QUARANTINE');
        if (reviewItems.length === 0) return;

        const result = await showHarvestChecklistModal(this.plugin.app, { items: reviewItems });
        if (!result) return;

        this.manifest.harvestSummary!.approvedIds = result.approvedIds;
        this.manifest.harvestSummary!.rejectedIds = result.rejectedIds;

        this._applyCloudRunLocalItems(result.runLocalIds, result.resolutionActions, harvestResult, contextManager);
        await this._mergeCloudApprovedItems(result.approvedIds, result.resolutionActions, harvestResult, contextManager);
    }

    async abort() {
        this.state = 'aborted';
        this.abortController?.abort();
        // Cloud requests cannot be individually cancelled.
        if (this.currentRunKey) {
            await this.releaseRunLock(this.currentRunKey);
        }
        relayEventBus.emit('control:aborted', { runId: this.currentRunId! });
    }
}
