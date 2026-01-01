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
import { sha256, contentHash, canonicalJsonStringify, normalizeWhitespace } from './ContentHash';
import { showInterventionModal } from '../ui/InterventionModal';
import { LoreHarvestService } from './LoreHarvestService';
import { showHarvestChecklistModal } from '../ui/HarvestChecklistModal';
import { RunPaths } from './RunPaths';
import { CloudRelay, WriteChapterInput, EditChapterInput } from './CloudRelay';
import { ContextPacker } from './ContextPacker';
import { estimateTokens } from './TokenEstimate';

/**
 * SequentialGenerator is the "Brain" of the relay drafting race.
 * It manages the Plan-Retrieve-Write-Verify-Repair loop as a version-pinned state machine.
 */
export class SequentialGenerator {
    private plugin: WritingDashboardPlugin;
    private proseStitcher: ProseStitcher;
    private identityService: ParagraphIdentityService;
    private loreHarvestService: LoreHarvestService;
    private auditService: AuditService;
    private abortController: AbortController | null = null;
    
    private state: RunState = 'idle';
    private currentRunId: string | null = null; // UUID (logical identity)
    private currentRunKey: string | null = null; // Folder name (e.g., "run-1735689600")
    private manifest: RunManifest | null = null;
    private commitLock: boolean = false;
    private dryRun: boolean = false;
    private interventionCount: number = 0;
    private interventionCountPerChunk: Map<string, number> = new Map();
    private contextManager: ContextManager | null = null;
    private entitiesMentionedHistory: Map<string, string[]> = new Map(); // chunkId -> entityIds
    private rollingWindow: { id: string, text: string, hash: string, status: 'STREAMING' | 'FINALIZED' | 'USER_DIRTY' }[][] = []; // Last 3 chunks
    private lastAppliedSeqNo: Map<string, number> = new Map(); // seamId -> seqNo
    private seamTaskCounters: Map<string, number> = new Map(); // seamId -> counter
    private sessionId: string = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private cloudRelay: CloudRelay | null = null;
    private contextPacker: ContextPacker | null = null;

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
            model: this.plugin.settings.relaySmartModel,
            temperature: isMechanical ? 0.1 : 0.7,
            max_tokens: isMechanical ? 1024 : 4096,
            format: isMechanical ? 'json' as const : undefined
        };
    }

    /**
     * Main entry point to generate a chapter in stages.
     */
    async generateChapter(targetWordCount: number, opts?: { dryRun?: boolean }) {
        if (this.state === 'RUNNING' || this.state === 'PAUSED_FOR_INTERVENTION' || this.state === 'RESUMING') {
            new Notice('Generation is already running.');
            return;
        }

        this.dryRun = !!opts?.dryRun;
        if (this.dryRun) {
            new Notice('🚀 Running in DRY-RUN mode. No changes will be saved.');
        }

        // Generate runId (UUID) and runKey (folder name)
        this.currentRunKey = `run-${Date.now()}`;
        this.currentRunId = (globalThis.crypto?.randomUUID?.() || `uuid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
        this.state = 'RUNNING';
        this.abortController = new AbortController();
        this.interventionCount = 0;
        this.interventionCountPerChunk.clear();

        // Acquire heartbeat lock (use runKey for lock path)
        await this.acquireRunLock(this.currentRunKey!);

        const smartModel = this.plugin.settings.relaySmartModel;
        const smartProfile = this.getTaskProfile('WRITE');
        const mechanicalProfile = this.getTaskProfile('MECHANICAL');
        
        // 1. Pre-flight checks
        const ollamaVer = await this.plugin.ollamaGen.getOllamaVersion();
        if (!ollamaVer) {
            this.failRun('Ollama not reachable. Please ensure Ollama is running.');
            return;
        }

        const smartDigest = await this.plugin.ollamaModels.getModelDigest(smartModel);

        const policyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
        const indexStatus = this.plugin.embeddingsIndex.getStatus();
        const corpusHash = await this.plugin.embeddingsIndex.getCorpusHash();

        if (!smartDigest) {
            new Notice('Warning: Smart model digest is missing. Strict Replay will be disabled.');
        }

        const initialState = {
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

        const contextManager = new ContextManager(this.plugin.app.vault, initialState);
        this.contextManager = contextManager;
        
        // 2. Schema Drift Check
        this.verifySchemaDrift(initialState);
        
        // Seed from Story Bible
        const seedResult = await contextManager.seedFromStoryBible(this.plugin.settings.storyBiblePath);

        // Get plugin version from manifest.json
        const pluginVersion = this.plugin.manifest.version || '1.0.3';
        const generatorVersion = `${pluginVersion}+policy-${policyHash.slice(0, 8)}`;

        // Build environment metadata
        const environment = {
            pluginVersion,
            policyHash,
            promptTemplateHash: await sha256(JSON.stringify(this.plugin.promptEngine)), // Simplified - would hash actual templates
            scoringProfileHash: policyHash, // Simplified - would hash scoring profile
            modelBackend: 'ollama',
            modelId: smartModel,
            vaultSnapshotHash: corpusHash,
            indexVersion: indexStatus.indexedChunks,
            timestamp: Date.now()
        };

        this.manifest = {
            runId: this.currentRunId!,
            runKey: this.currentRunKey!,
            chapterId: initialState.chapterId,
            startTime: Date.now(),
            ollamaVersion: ollamaVer,
            storyBibleHash: seedResult.hash,
            initialStateHash: await sha256(JSON.stringify(initialState)),
            stages: [],
            config: {
                smartModel,
                smartModelDigest: smartDigest,
                maxChunkWords: this.plugin.settings.maxChunkWords || 500,
                temperature: 0.7,
                policyHash,
                corpusHash,
                pluginVersion
            },
            environment,
            replayable: false, // Can be set to true if user requests replayability
            interventions: [],
            continuations: [],
            plotMemorySnapshots: []
        };

        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });

        let totalWords = 0;
        let iteration = 1;

        try {
            while (totalWords < targetWordCount && (this.state === 'RUNNING' || this.state === 'RESUMING')) {
                if (this.checkControlFlow()) break;

                console.log(`[SequentialGenerator] --- Iteration ${iteration} ---`);
                
                // --- SPONTANEITY & RISK ---
                const sliderValue = (this.plugin.settings as any).spontaneitySlider || 50;
                const rawParams = this.getSpontaneityParams(sliderValue);
                const risk = iteration > 1 ? this.calculateContinuityRisk(iteration - 1, contextManager) : 0;
                const effectiveNovelty = this.applySmoothClamp(rawParams.novelty, risk);
                
                this.manifest!.config.spontaneityProfile = {
                    sliderValue,
                    temp: rawParams.temp,
                    novelty: effectiveNovelty,
                    stickyMin: rawParams.stickyMin
                };

                // --- FAST BATCH 1: PLAN & RETRIEVE ---
                // 1. PLAN
                const planResult = await this.runStage('PLAN', smartProfile.model, async () => {
                    const prompt = `Plan the next ${this.manifest!.config.maxChunkWords} words for chapter ${initialState.chapterId}.`;
                    return await this.plugin.ollamaGen.enqueue(3, `${this.currentRunId}__plan__${iteration}`, (signal) => 
                        this.plugin.ollamaGen.generate(prompt, { ...mechanicalProfile, model: smartProfile.model }, signal)
                    );
                }, undefined, await sha256(`Plan the next ${this.manifest!.config.maxChunkWords} words for chapter ${initialState.chapterId}.`));
                if (!planResult) break;

                // 2. RETRIEVE
                const retrieveResult = await this.runStage('RETRIEVE', smartProfile.model, async () => {
                    const query = {
                        text: planResult.data.summary || 'next scene',
                        mode: 'chapter' as const,
                        hints: planResult.data.hints,
                        intents: planResult.data.retrievalIntents // New
                    };
                    const searchResult = await this.plugin.retrievalService.search(query, { 
                        limit: 8, 
                        strictMode: true,
                        noveltyBias: effectiveNovelty,
                        stickyMin: rawParams.stickyMin,
                        fallbackSet: contextManager.getStickyFallbackSet(contextManager.getState().lastChunkId),
                        scoringVersion: 1
                    });

                    // Track miss metrics
                    const intents = (query as any).intents || [];
                    intents.forEach((intent: any) => {
                        if (intent.hardness === 'HARD') {
                            const fulfilled = searchResult.some(hit => 
                                hit.intentType === intent.type && 
                                hit.relevance && hit.relevance.finalScore >= hit.relevance.threshold
                            );
                            if (!fulfilled) {
                                console.warn(`[SequentialGenerator] HARD intent miss: ${intent.type}`);
                                relayEventBus.emit('pilot:miss', { type: intent.type, runId: this.currentRunId });
                            }
                        }
                    });

                    return searchResult;
                }, undefined, await sha256(JSON.stringify(planResult.data)));
                if (!retrieveResult) break;

                // --- MECHANICAL DEGRADE ---
                const missedHardIntents = ((planResult.data.retrievalIntents || []) as any[])
                    .filter(intent => intent.hardness === 'HARD' && !retrieveResult.data.some((hit: any) => hit.intentType === intent.type));
                
                const restrictedDomains = missedHardIntents.map(i => i.domain || i.type);
                const isDegraded = restrictedDomains.length > 0;

                // --- SMART BATCH 1: WRITE ---
                // 3. WRITE (WRITE)
                const writeResult = await this.runStage('WRITE', smartProfile.model, async () => {
                    const stateCard = contextManager.renderStateCard();
                    const retrieved = retrieveResult.data.map((r: any) => r.excerpt).join('\n\n');
                    const plotMemory = contextManager.getState().plotMemory?.denseSummary || '';
                    
                    const plotMemoryBlock = plotMemory 
                        ? `\nPLOT MEMORY: ${plotMemory}\n(Use this for plot trajectory and high-level continuity.)`
                        : '';
                    
                    const constraintBlock = isDegraded 
                        ? `\n[DEGRADED MODE] Restricted Domains: ${restrictedDomains.join(', ')}\nConstraint: Do not assert new canonical facts about these domains.`
                        : '';

                    const prompt = `
                        ${stateCard}${plotMemoryBlock}
                        PLAN: ${JSON.stringify(planResult.data)}
                        CONTEXT: ${retrieved}${constraintBlock}
                        
                        INSTRUCTION: Write the next prose chunk. 
                        Use \n\n to separate paragraphs.
                        For every paragraph, you MUST also generate a sidecar entry with a unique "p_id" (c${iteration}-p{index}).
                        ${isDegraded ? 'Flag missingHardIntent: true if relevant.' : ''}
                    `;
                    
                    return await this.plugin.ollamaGen.enqueue(10, `${this.currentRunId}__write__${iteration}`, (signal) => 
                        this.plugin.ollamaGen.generateStream(
                            prompt, 
                            { ...smartProfile, model: smartProfile.model, temperature: rawParams.temp },
                            (token) => relayEventBus.emit('chunk:buffer:update', { content: token }),
                            signal
                        ),
                        this.abortController!
                    );
                }, await (async () => {
                    const stateCard = contextManager.renderStateCard();
                    const retrieved = retrieveResult.data.map((r: any) => r.excerpt).join('\n\n');
                    const prompt = `
                        ${stateCard}
                        PLAN: ${JSON.stringify(planResult.data)}
                        CONTEXT: ${retrieved}
                        
                        INSTRUCTION: Write the next prose chunk. 
                        Use \n\n to separate paragraphs.
                        For every paragraph, you MUST also generate a sidecar entry with a unique "p_id" (c${iteration}-p{index}).
                    `;
                    const manifest = contextManager.generateManifest(retrieveResult.data, [], prompt);
                    manifest.promptHash = await sha256(prompt);
                    return manifest;
                })());
                if (!writeResult) break;

                // --- DOMAIN QUARANTINE ---
                if (isDegraded && writeResult.metadata) {
                    writeResult.metadata.forEach((m: any) => {
                        if (m.newFactsProposed) {
                            m.newFactsProposed.forEach((f: any) => {
                                if (restrictedDomains.some(d => f.type === d || f.attribute === d)) {
                                    f.lifecycleState = 'QUARANTINED';
                                    console.log(`[SequentialGenerator] Auto-quarantined fact in restricted domain: ${f.attribute}`);
                                }
                            });
                        }
                    });
                }

                // --- FAST BATCH 2: METADATA & AUDIT ---
                // 4. METADATA (Mocked parsing from writeResult or separate step)
                const { text: chunkText, metadata: recoveredMeta } = this.segmentAndRecover(writeResult.data, []);
                writeResult.data = chunkText;
                writeResult.metadata = recoveredMeta;

                // 5. AUDIT (MECHANICAL)
                const auditResult = await this.runStage('AUDIT', smartProfile.model, async () => {
                    const prompt = this.plugin.promptEngine.buildAuditPrompt(contextManager.getState(), chunkText, contextManager.getState());
                    const res = await this.plugin.ollamaGen.enqueue(3, `${this.currentRunId}__audit__${iteration}`, (signal) => 
                        this.plugin.ollamaGen.generate(prompt, { ...mechanicalProfile, model: smartProfile.model }, signal)
                    );
                    return JSON.parse(res) as AuditResult;
                }, undefined, await sha256(chunkText));
                if (!auditResult) break;
                let auditData: AuditResult = auditResult.data;

                // Check for intervention triggers
                const chunkId = `chunk-${iteration}`;
                const matrixCheck = this.shouldTriggerIntervention(auditData, chunkId);
                let interventionGuidance: InterventionGuidance | null = null;

                if (matrixCheck.trigger) {
                    interventionGuidance = await this.handleIntervention(
                        matrixCheck.trigger,
                        matrixCheck.violationSummary,
                        chunkId,
                        auditData.overallSeverity,
                        contextManager
                    );
                    if (!interventionGuidance) {
                        // User cancelled intervention
                        break;
                    }
                }

                // --- SMART BATCH 2: REPAIR & STITCH ---
                // 6. REPAIR (WRITE)
                if (auditData.overallSeverity >= 4) {
                    const repairCapCheck = this.checkRepairCap();
                    if (repairCapCheck.trigger) {
                        interventionGuidance = await this.handleIntervention(
                            repairCapCheck.trigger,
                            repairCapCheck.violationSummary,
                            chunkId,
                            auditData.overallSeverity,
                            contextManager
                        );
                        if (!interventionGuidance) {
                            break;
                        }
                    }
                    const repairResult = await this.runStage('REPAIR', smartProfile.model, async () => {
                        let prompt = `Repair the following prose chunk to resolve these violations: ${JSON.stringify(auditData.violations)}\n\nChunk: ${chunkText}`;
                        
                        // Add intervention guidance if present
                        if (interventionGuidance) {
                            prompt = `
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

                        return await this.plugin.ollamaGen.enqueue(10, `${this.currentRunId}__repair__${iteration}`, (signal) => 
                            this.plugin.ollamaGen.generateStream(
                                prompt, 
                                { ...smartProfile, model: smartProfile.model, temperature: 0.3 }, // Slightly lower temp for repair
                                (token) => relayEventBus.emit('chunk:buffer:update', { content: token }),
                                signal
                            ),
                            this.abortController!
                        );
                    }, undefined, await sha256(chunkText + JSON.stringify(auditData)));
                    if (repairResult) {
                        const patches: PatchOp[] = repairResult.data;
                        writeResult.data = this.applyPatches(writeResult.data, patches);
                    }
                }

                // 7. STITCH (Asynchronous via commitChunk)
                // Handled in commitChunk now to be non-blocking.

                // 8. COMMIT (Transactional)
                await this.commitChunk(iteration, writeResult.data, writeResult.metadata);

                // --- FAST BATCH 3: UPDATE STATE ---
                    // 9. UPDATE STATE (MECHANICAL)
                    const updateResult = await this.runStage('UPDATE', smartProfile.model, async () => {
                        // Check for lore mutations
                        const newFacts: CanonFact[] = []; 
                        // ... mutation logic ...
                        contextManager.updateState(newFacts, { 
                            chunkId: `chunk-${iteration}`, 
                            summary: `Generated chunk ${iteration}` 
                        });

                        // Refresh pinned facts based on what was actually cited
                        const citedFactIds = writeResult.metadata?.flatMap(m => m.factIds) || [];
                        contextManager.refreshPins(citedFactIds);

                        // Track entities mentioned for adaptive telescoping
                        const state = contextManager.getState();
                        const mentionedEntities = new Set<string>();
                        citedFactIds.forEach(id => {
                            const fact = state.canonFacts.find(f => f.id === id);
                            if (fact) mentionedEntities.add(fact.entityId);
                        });
                        this.entitiesMentionedHistory.set(`chunk-${iteration}`, Array.from(mentionedEntities));

                        return { status: 'success', version: contextManager.getState().canonVersion };
                    }, undefined, await sha256(`Generated chunk ${iteration}`));
                if (!updateResult) break;

                this.checkQualityFloors(iteration);

                totalWords += writeResult.data.split(/\s+/).length;
                
                // Check if telescoping should be triggered
                const shouldTelescope = this.shouldTriggerTelescoping(iteration, contextManager);
                if (shouldTelescope) {
                    await this.performTelescoping(iteration, contextManager);
                }
                
                iteration++;

                await this.saveManifest();
            }

            if (this.state === 'RUNNING' || this.state === 'RESUMING') {
                this.state = 'COMPLETED';
                this.manifest!.endTime = Date.now();
                
                // Emit Run Health Summary
                const health = this.calculateHealth();
                relayEventBus.emit('run:end', { 
                    runId: this.currentRunId!, 
                    totalWords,
                    health 
                } as any);
                
                // Post-run: Lore Harvesting (Phase 6)
                await this.performPostRunHarvest(contextManager);
                
                // Finalize Replay Prereqs
                this.manifest!.replayPrereqs = await this.computeReplayPrereqs();

                await this.saveManifest();
                await this.cleanupOldRuns();
            }

        } catch (err) {
            this.state = 'error';
            relayEventBus.emit('run:error', { runId: this.currentRunId!, error: err.message });
        } finally {
            if (this.currentRunKey) {
                await this.releaseRunLock(this.currentRunKey);
            }
            this.abortController = null;
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
                [], // No new hits for edit usually
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

            // Audit result
            const fullEditedProse = output.resultParagraphs.map(p => p.text).join('\n\n');
            const auditResult = await this.auditService.auditFullChapter(fullEditedProse, this.contextManager!.getState());

            if (auditResult.overallSeverity >= 4) {
                new Notice(`Edit completed with ${auditResult.violations.length} violations.`);
            }

            // Commit edited chapter
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
            // 1. Create paragraph objects with lifecycle
            const paras = content.split('\n\n').filter(p => p.trim()).map((p, i) => {
                const text = p.trim();
                const id = metadata?.[i]?.p_id || `chunk-${iteration}-p${i}`;
                const hash = fnv1a32(normalizeWhitespace(text));
                return { id, text, hash, status: 'FINALIZED' as const };
            });

            // 2. Update rolling window (max 3 chunks)
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
            }

            // 3. Queue Stitch Task for the new seam (iteration-1 __ iteration)
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
        const smartModel = this.manifest!.config.smartModel;

        // Find the actual chunks in rolling window
        // Note: leftIdx and rightIdx are iteration numbers (1-based)
        // We need to find them relative to the current tail of rollingWindow
        const leftParas = this.rollingWindow.find(chunk => chunk[0]?.id.startsWith(`chunk-${leftIdx}`));
        const rightParas = this.rollingWindow.find(chunk => chunk[0]?.id.startsWith(`chunk-${rightIdx}`));

        if (!leftParas || !rightParas) {
            console.warn(`[SequentialGenerator] Stitch skipped: Chunks ${leftIdx} or ${rightIdx} not in rolling window.`);
            return;
        }

        // Filter out USER_DIRTY paragraphs
        const cleanLeft = leftParas.filter(p => p.status === 'FINALIZED');
        const cleanRight = rightParas.filter(p => p.status === 'FINALIZED');

        if (cleanLeft.length === 0 || cleanRight.length === 0) return;

        void this.plugin.ollamaGen.enqueue(3, taskKey, async (signal) => {
            if (signal?.aborted) return;

            const startTime = Date.now();
            try {
                // Get stable prefix for KV cache warmth
                const state = this.contextManager!.getState();
                const context = await this.contextPacker!.packContext(this.plugin, state);
                const stablePrefix = this.plugin.promptEngine.buildStablePrefix(context);
                const mechanicalProfile = this.getTaskProfile('STITCH');

                const response = await this.proseStitcher.stitch(
                    cleanLeft,
                    cleanRight,
                    state,
                    { runId: this.currentRunId!, sessionId: this.sessionId, seamId, seqNo },
                    stablePrefix,
                    signal
                );

                if (response && response.patchOps.length > 0) {
                    // Check if run/session still active
                    if (this.currentRunId !== response.runId || this.sessionId !== response.sessionId) return;

                    // Emit patch event
                    relayEventBus.emit('chunk:patch', response);
                    
                    // Log success
                    console.log(`[SequentialGenerator] Stitch success: ${seamId} (seq ${seqNo})`);
                }
            } catch (err) {
                console.error(`[SequentialGenerator] Stitch task failed for ${seamId}:`, err);
            }
        });
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
        // Check intervention caps
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

        // Pause the run
        this.state = 'PAUSED_FOR_INTERVENTION';
        await this.saveManifest(); // Save partial snapshot

        // Show intervention modal
        const result = await showInterventionModal(this.plugin.app, {
            triggerReason,
            violationSummary,
            chunkId,
            severity
        });

        if (!result || !result.proceed) {
            // User cancelled
            this.state = 'STOPPED_FATAL';
            return null;
        }

        // Create continuation record with hierarchical support
        const continuationId = `cont-${String((this.manifest!.continuations?.length || 0) + 1).padStart(3, '0')}`;
        const snapshotHash = await sha256(JSON.stringify(contextManager.getState()));
        const parentContId = this.manifest!.continuations?.length ? this.manifest!.continuations[this.manifest!.continuations.length - 1].continuationId : undefined;
        
        const continuation: RunContinuation = {
            continuationId,
            parentRunId: this.currentRunId!,
            parentContId,
            pauseEventId: `intervention-${Date.now()}`,
            resumedAt: Date.now(),
            snapshotHash,
            status: 'ACTIVE',
            resumePlan: {
                rerunRetrieval: false, // Default: reuse hits
                reuseHits: true,
                reusePlotMemory: true,
                reuseAnchors: true,
                reusePromptBodies: true,
                reusePromptTemplates: true,
                resumeStage: 'WRITE' // Default resume at WRITE stage
            }
        };

        if (!this.manifest!.continuations) {
            this.manifest!.continuations = [];
        }
        this.manifest!.continuations.push(continuation);

        // Log intervention event
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

        this.interventionCount++;
        this.interventionCountPerChunk.set(chunkId, chunkCount + 1);

        // Resume
        this.state = 'RESUMING';
        relayEventBus.emit('control:resumed', { runId: this.currentRunId! });

        // Transition to RUNNING
        this.state = 'RUNNING';

        return result.guidance;
    }

    /**
     * Determines if telescoping should be triggered based on adaptive criteria.
     */
    private shouldTriggerTelescoping(iteration: number, contextManager: ContextManager): boolean {
        const policy = CO_AUTHORING_POLICY.TELESCOPING;
        
        // 1. Chunk Cadence
        if (iteration % policy.CHUNK_CADENCE === 0) {
            return true;
        }
        
        // 2. Context Pressure Check
        // Find last WRITE stage manually (findLast not available in ES2020)
        let lastWriteStage: StageResult | undefined;
        for (let i = (this.manifest?.stages.length || 0) - 1; i >= 0; i--) {
            if (this.manifest!.stages[i].stageType === 'WRITE') {
                lastWriteStage = this.manifest!.stages[i];
                break;
            }
        }
        if (lastWriteStage?.manifest) {
            const contextLimit = this.plugin.settings.contextTokenLimit || 128000;
            const usage = lastWriteStage.manifest.tokenEstimate / contextLimit;
            if (usage > policy.CONTEXT_PRESSURE_THRESHOLD) {
                console.log(`[SequentialGenerator] 🚀 Telescoping triggered by context pressure: ${Math.round(usage * 100)}%`);
                return true;
            }
        }
        
        // 3. High Entity Density Check
        const window = policy.ENTITY_DENSITY_WINDOW;
        const recentChunks = Array.from(this.entitiesMentionedHistory.keys()).slice(-window);
        if (recentChunks.length >= window) {
            const uniqueEntities = new Set<string>();
            recentChunks.forEach(id => {
                this.entitiesMentionedHistory.get(id)?.forEach(e => uniqueEntities.add(e));
            });
            if (uniqueEntities.size > policy.HIGH_ENTITY_DENSITY_THRESHOLD) {
                console.log(`[SequentialGenerator] 🚀 Telescoping triggered by high entity density: ${uniqueEntities.size} entities in last ${window} chunks`);
                return true;
            }
        }
        
        return false;
    }

    /**
     * Performs structured telescoping: extracts plot memory from recent chunks.
     */
    private async performTelescoping(iteration: number, contextManager: ContextManager) {
        const policy = CO_AUTHORING_POLICY.TELESCOPING;
        const state = contextManager.getState();
        
        // Get recent chunks (last N chunks based on cadence)
        const recentChunks = state.timeline.slice(-policy.CHUNK_CADENCE).map(t => {
            // Find the write stage for this chunk
            const writeStage = this.manifest!.stages.find(s => 
                s.stageType === 'WRITE' && s.data && s.data.includes && s.data.includes(t.chunkId)
            );
            return {
                chunkId: t.chunkId,
                summary: t.summary,
                text: writeStage?.data || ''
            };
        });

        // Build telescoping prompt
        const prompt = this.plugin.promptEngine.buildTelescopingPrompt({
            recentChunks,
            currentPlotMemory: state.plotMemory?.denseSummary
        });

        // Generate structured plot memory
        const telescopeResult = await this.runStage('TELESCOPE', this.plugin.settings.relaySmartModel, async () => {
            return await this.plugin.ollamaGen.enqueue(10, (signal) => 
                this.plugin.ollamaGen.generateJson(prompt, this.plugin.settings.relaySmartModel)
            );
        });

        if (!telescopeResult) return;

        const structured = telescopeResult.data;
        
        // Create new plot memory
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

        // Update context manager state with new plot memory
        // Direct assignment is acceptable here as we're updating a derived artifact
        contextManager.getState().plotMemory = plotMemory;
        
        // Store plot memory snapshot in manifest
        if (!this.manifest!.plotMemorySnapshots) {
            this.manifest!.plotMemorySnapshots = [];
        }
        this.manifest!.plotMemorySnapshots.push({
            version: plotMemory.version,
            hash: plotMemory.hash,
            sourceChunkIds,
            timestamp: plotMemory.timestamp
        });

        console.log(`[SequentialGenerator] 📊 Telescoped plot memory v${plotMemory.version} from chunks ${sourceChunkIds.join(', ')}`);
    }

    /**
     * Post-run lore harvesting workflow.
     */
    private async performPostRunHarvest(contextManager: ContextManager) {
        if (!this.manifest) return;

        // 1. Get all prose chunks from the run
        const proseChunks = this.manifest.stages
            .filter(s => s.stageType === 'WRITE' && typeof s.data === 'string')
            .map(s => ({
                chunkId: s.stageId, // Or map back to iteration
                text: s.data as string,
                metadata: s.metadata
            }));

        if (proseChunks.length === 0) return;

        // 2. Extract stable lore candidates
        const candidates = await this.loreHarvestService.extractCandidates(
            proseChunks,
            contextManager.getState(),
            this.currentRunId!
        );

        if (candidates.length === 0) {
            console.log('[SequentialGenerator] 🌾 No lore candidates found for harvesting.');
            return;
        }

        // 3. Log harvest candidates to manifest
        this.manifest.harvestSummary = {
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

        // 4. Handle auto-accepted SCENE_ONLY items (run-local)
        const sceneOnlyItems = candidates.filter(c => c.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY');
        if (sceneOnlyItems.length > 0) {
            sceneOnlyItems.forEach(item => {
                const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const };
                contextManager.updateState([fact]);
                this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
                console.log(`[SequentialGenerator] ✅ Auto-accepted run-local lore: ${item.proposedFact.attribute} of ${item.proposedFact.entityId}`);
            });
        }

        // 5. Show harvest checklist for remaining items
        const reviewItems = candidates.filter(c => c.recommendedAction === 'REVIEW' || c.recommendedAction === 'QUARANTINE');
        if (reviewItems.length > 0) {
            const result = await showHarvestChecklistModal(this.plugin.app, { items: reviewItems });
            if (result) {
                this.manifest.harvestSummary.approvedIds = result.approvedIds;
                this.manifest.harvestSummary.rejectedIds = result.rejectedIds;

                // Handle run-local items
                if (result.runLocalIds.length > 0) {
                    const runLocalItems = candidates.filter(c => result.runLocalIds.includes(c.harvestId));
                    runLocalItems.forEach(item => {
                        // Apply resolution action
                        item.resolutionAction = result.resolutionActions[item.harvestId] || 'SCOPE_TO_SCENE';
                        const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const, scope: 'SCENE' as const };
                        contextManager.updateState([fact]);
                        this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
                        console.log(`[SequentialGenerator] ✅ Accepted run-local lore: ${item.proposedFact.attribute} of ${item.proposedFact.entityId}`);
                    });
                }

                // 6. Transactional Story Bible Merge for approved items
                if (result.approvedIds.length > 0) {
                    // Apply resolution actions to approved items
                    result.approvedIds.forEach(id => {
                        const item = candidates.find(c => c.harvestId === id);
                        if (item && result.resolutionActions[id]) {
                            item.resolutionAction = result.resolutionActions[id];
                        }
                    });
                    const approvedItems = candidates.filter(c => result.approvedIds.includes(c.harvestId));
                    const mergeResult = await this.plugin.vaultService.mergeHarvestIntoStoryBible(
                        this.plugin.settings.storyBiblePath,
                        approvedItems,
                        contextManager.getState().canonVersion
                    );

                    if (mergeResult.success) {
                        this.manifest.harvestSummary.canonVersionAfterMerge = mergeResult.canonVersionAfterMerge;
                        
                        // Update local state to reflect merge
                        const promotedFacts = approvedItems.map(item => ({
                            ...item.proposedFact,
                            lifecycleState: 'CANON' as const,
                            origin: 'BIBLE' as const // Promoted to bible
                        }));
                        contextManager.updateState(promotedFacts);
                        
                        // Write protection index
                        await this.writeProtectionIndex({
                            code: 'PROMOTION_TO_BIBLE',
                            createdAt: Date.now(),
                            sourceEventId: `harvest-${this.currentRunId}`,
                            canonVersion: mergeResult.canonVersionAfterMerge,
                            factIds: result.approvedIds
                        });
                        
                        // Emit state update event to refresh index/UI
                        relayEventBus.emit('state:updated', { 
                            runId: this.currentRunId!, 
                            chapterId: this.manifest!.chapterId,
                            diffSummary: `Canon version updated to ${mergeResult.canonVersionAfterMerge}`
                        });
                        
                        new Notice(`Successfully merged ${result.approvedIds.length} items into Story Bible.`);
                    }
                }
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
        console.log('[SequentialGenerator] 🔄 Post-mutation re-grounding triggered.');
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

        const hasPromptBodies = await adapter.exists(`${base}/context/prompt.chunk-1.json`); // Check at least first chunk
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

    /**
     * Calculates the continuity risk score for the current iteration.
     * weighted sum: dormancy (35%) + drop (25%) + repairs (25%) + reliance (15%)
     */
    private calculateContinuityRisk(iteration: number, contextManager: ContextManager): number {
        const policy = CO_AUTHORING_POLICY.CONTINUITY_RISK;
        const weights = policy.WEIGHTS;
        const windows = policy.WINDOWS;

        // 1. Dormancy (35%)
        let dormancyRisk = 0;
        const state = contextManager.getState();
        const keyFacts = state.canonFacts.filter(f => AttributeRegistry.includes(f.attribute));
        if (keyFacts.length > 0) {
            const dormantCount = keyFacts.filter(f => {
                const lastUsed = f.chunkId ? parseInt(f.chunkId.replace('chunk-', '')) : 0;
                return (iteration - lastUsed) >= windows.DORMANCY_CHUNKS;
            }).length;
            dormancyRisk = dormantCount / keyFacts.length;
        }

        // 2. Density Drop (25%)
        let densityDropRisk = 0;
        const writeStages = this.manifest!.stages.filter(s => s.stageType === 'WRITE');
        if (writeStages.length >= 2) {
            const last2 = writeStages.slice(-2);
            const scores = last2.map(s => {
                const metadata = s.metadata || [];
                const grounded = metadata.filter(m => !m.isSpeculative).length;
                return metadata.length > 0 ? grounded / metadata.length : 0;
            });
            const drop = Math.max(0, scores[0] - scores[1]);
            densityDropRisk = drop; // Normalizing drop 0-1
        }

        // 3. Repair Rate (25%)
        let repairRisk = 0;
        const recentStages = this.manifest!.stages.slice(-windows.REPAIR_RATE_CHUNKS * 5); // Approximate stages per iteration
        const auditStages = recentStages.filter(s => s.stageType === 'AUDIT');
        if (auditStages.length > 0) {
            const repairs = recentStages.filter(s => s.stageType === 'REPAIR').length;
            repairRisk = Math.min(1, repairs / auditStages.length);
        }

        // 4. Over-reliance (15%)
        let relianceRisk = 0;
        const lastWrite = writeStages[writeStages.length - 1];
        if (lastWrite && lastWrite.metadata) {
            const factCounts: Record<string, number> = {};
            lastWrite.metadata.forEach(m => {
                m.factIds.forEach(id => {
                    factCounts[id] = (factCounts[id] || 0) + 1;
                });
            });
            const totalParas = lastWrite.metadata.length;
            const maxFactCount = Math.max(0, ...Object.values(factCounts));
            relianceRisk = totalParas > 0 ? maxFactCount / totalParas : 0;
        }

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

        // Linear interpolation within the range
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
        
        // 1. Max Speculative Ratio (Denominator: grounded-mode paragraphs only)
        // For simplicity in this spec, assume all paragraphs are 'grounded' unless marked otherwise
        const totalGrounded = writeStages.reduce((acc, s) => acc + (s.metadata?.length || 0), 0);
        const speculativeCount = writeStages.reduce((acc, s) => acc + (s.metadata?.filter(m => m.isSpeculative).length || 0), 0);
        const speculativeRatio = totalGrounded > 0 ? speculativeCount / totalGrounded : 0;

        let hasViolation = false;
        if (speculativeRatio > policy.MAX_SPECULATIVE_RATIO) {
            hasViolation = true;
            console.warn(`[SequentialGenerator] ⚠️ Quality Floor Violation: Speculative Ratio too high.`);
        }

        // 2. Max Consecutive Lite Chunks
        let consecutiveLite = 0;
        for (let i = writeStages.length - 1; i >= 0; i--) {
            const isLite = writeStages[i].data?.recovered || writeStages[i].metadata?.every(m => m.isSpeculative);
            if (isLite) consecutiveLite++;
            else break;
        }

        if (consecutiveLite > policy.MAX_CONSECUTIVE_LITE_CHUNKS) {
            hasViolation = true;
        }

        // Escalation Ladder
        if (hasViolation) {
            this.consecutiveViolations++;
            if (this.consecutiveViolations === 1) {
                new Notice('⚠️ Quality Warning: grounding density low. Auto-refreshing context next chunk.');
                // MOCK: flag for next chunk to increase novelty/refresh
            } else if (this.consecutiveViolations >= 2) {
                this.state = 'PAUSED_FOR_INTERVENTION';
                relayEventBus.emit('control:paused', { 
                    runId: this.currentRunId!
                });
                new Notice('⏸ Generation paused: multiple quality violations. Review lore/context.');
            }
        } else {
            this.consecutiveViolations = 0;
        }
    }

    private segmentAndRecover(text: string, oldMetadata: ParagraphMetadata[]): { text: string, metadata: ParagraphMetadata[] } {
        const policy = CO_AUTHORING_POLICY.SEGMENTATION;
        let paragraphs = text.split('\n\n').filter(p => p.trim());

        // Recovery: if \n\n is missing or paragraphs are too long
        if (paragraphs.length <= 1 && text.length > policy.HARD_MAX_CHARS_PER_PARA) {
            console.log('[SequentialGenerator] ⚠️ Segmentation drift detected. Recovering...');
            paragraphs = this.fallbackSegment(text);
        }

        const oldParas = oldMetadata.map(m => ({ p_id: m.p_id, text: '' })); // Simplified for now
        const recovered = this.identityService.recoverIdentities(paragraphs, oldParas);

        return {
            text: paragraphs.join('\n\n'),
            metadata: recovered.map(r => ({
                p_id: r.p_id,
                goalIds: [],
                factIds: [],
                sourceChunkIds: [],
                isSpeculative: true // Default for recovered
            }))
        };
    }

    private fallbackSegment(text: string): string[] {
        const policy = CO_AUTHORING_POLICY.SEGMENTATION;
        // Improved regex to avoid splitting inside quotes/parentheses
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
                // For monolithic cloud, we don't have per-paragraph Tier A/B logic in the same way yet
                // but we can assume the provided paragraphs are all Tier A if they passed local audit
                // or just count them toward total.
                // Assuming cloud output is always one "chunk" in this context.
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
        // Implementation of UTF-16 offset-based patching
        let result = text;
        // Sort patches in reverse order to keep offsets valid
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
        
        // Use RunPaths helper for deterministic paths
        const manifestPath = `${RunPaths.baseDir(this.currentRunKey)}/run.json`;
        
        // Ensure subfolders exist using RunPaths
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.logsDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.contextDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.harvestDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.snapshotsDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.replaysDir(this.currentRunKey)}/dummy.txt`);
        await this.plugin.vaultService.ensureParentFolder(`${RunPaths.branchesDir(this.currentRunKey)}/dummy.txt`);

        // Add ArtifactMetadata to manifest
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

        // Save continuation manifests if any
        if (this.manifest.continuations && this.manifest.continuations.length > 0) {
            for (const cont of this.manifest.continuations) {
                if (cont.status === 'ACTIVE') {
                    await this.saveContinuationManifest(cont.continuationId);
                }
            }
        }

        // Write policy snapshot
        await this.writePolicySnapshot(this.currentRunKey);

        // Write RunIndex
        await this.writeRunIndex(this.currentRunKey);
    }

    /**
     * Saves a continuation delta manifest to branches/cont-XXX/cont.json
     */
    private async saveContinuationManifest(contId: string): Promise<void> {
        if (!this.manifest || !this.currentRunKey) return;

        // Get stages executed in this continuation (simplified - would track per continuation)
        const contManifest = {
            continuationId: contId,
            parentRunId: this.manifest.runId,
            runKey: this.currentRunKey,
            stages: this.manifest.stages.filter(s => {
                // Filter stages by continuation (would need to track this)
                return true; // Simplified for now
            }),
            interventions: this.manifest.interventions?.filter(i => {
                // Filter interventions for this continuation
                return true; // Simplified
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

        // Update root manifest to link to continuation manifest
        if (!this.manifest.continuations) {
            this.manifest.continuations = [];
        }
        const cont = this.manifest.continuations.find(c => c.continuationId === contId);
        if (cont) {
            // Link is implicit via continuationId matching folder structure
        }
    }

    /**
     * Writes a policy snapshot for the run.
     */
    private async writePolicySnapshot(runKey: string): Promise<void> {
        const policy = CO_AUTHORING_POLICY;
        const policyHash = await sha256(canonicalJsonStringify(policy));
        
        // Get plugin version from manifest.json (fallback to package.json)
        let pluginVersion = this.plugin.manifest.version;
        if (!pluginVersion) {
            try {
                // Try to read package.json (may not be available in bundled plugin)
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
                schemaVersion: ArtifactSchemaVersions.DECISIONS, // Use DECISIONS version for policy snapshot
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
            healthCodes: healthResult.codes, // Array of health codes
            stagesCompleted: this.manifest.stages.map(s => s.stageType),
            artifacts: {},
            requiredArtifactsByStage: RequiredArtifactsByStage as unknown as Record<string, string[]>, // Type assertion for readonly arrays
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
        
        // Check for missing stage data
        if (this.manifest.stages.some(s => !s.data)) {
            codes.push('MISSING_PROMPT_BODY');
        }

        // Check for stale evidence in harvest
        if (this.manifest.harvestSummary) {
            // Would need to check evidence spans for STALE tier
            // For now, simplified check
        }

        // Check for branch orphaning (continuations without valid parent references)
        if (this.manifest.continuations) {
            const contIds = new Set(this.manifest.continuations.map(c => c.continuationId));
            for (const cont of this.manifest.continuations) {
                if (cont.parentContId && !contIds.has(cont.parentContId)) {
                    codes.push('BRANCH_ORPHANED');
                    break;
                }
            }
        }

        // Determine worst severity
        if (codes.length === 0) {
            return { health: 'OK', codes: [] };
        }

        // Sort by severity (higher = worse) and return worst
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

        // Start heartbeat interval (every 30 seconds)
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

        // Update global protection index
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
            // Index doesn't exist yet
        }

        if (!index[runId]) {
            index[runId] = [];
        }
        index[runId].push(reason);

        await this.plugin.vaultService.ensureParentFolder(indexPath);
        await this.plugin.vaultService.writeFile(indexPath, JSON.stringify(index, null, 2));
    }

    /**
     * Computes transitive closure of protected runs via BFS over provenance graph.
     * Graph Edges:
     * - AcceptedRun -> EvidenceRuns (from citations in harvestSummary)
     * - ContinuationRun -> ParentRun
     * - MigrationRun -> PreviousMigrationRuns (via mutationHistory)
     */
    private async computeProtectionClosure(protectedRunKeys: Set<string>): Promise<Set<string>> {
        const MAX_CLOSURE_NODES = 10000;
        const closure = new Set<string>(protectedRunKeys);
        const queue = Array.from(protectedRunKeys);
        const visited = new Set<string>();

        // Build runId -> runKey mapping by scanning all manifests
        const runIdToKey = new Map<string, string>();
        const outputRoot = this.plugin.app.vault.getAbstractFileByPath('.gwriter/output');
        if (!(outputRoot instanceof TFolder)) return closure;

        // First pass: Build runId -> runKey mapping
        for (const child of outputRoot.children) {
            if (!(child instanceof TFolder) || !child.name.startsWith('run-')) continue;
            const manifestFile = child.children.find(f => f.name === 'run.json');
            if (manifestFile instanceof TFile) {
                try {
                    const content = await this.plugin.app.vault.read(manifestFile);
                    const manifest: RunManifest = JSON.parse(content);
                    runIdToKey.set(manifest.runId, child.name);
                } catch (err) {
                    // Skip corrupted manifests
                }
            }
        }

        // BFS to compute closure
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

                // Edge: ContinuationRun -> ParentRun
                if (manifest.continuations) {
                    manifest.continuations.forEach((cont) => {
                        if (cont.parentRunId) {
                            const parentKey = runIdToKey.get(cont.parentRunId);
                            if (parentKey && !closure.has(parentKey)) {
                                closure.add(parentKey);
                                queue.push(parentKey);
                            }
                        }
                    });
                }

                // Edge: AcceptedRun -> EvidenceRuns (from harvestSummary citations)
                if (manifest.harvestSummary?.approvedIds) {
                    // Evidence runs are tracked via evidence spans in harvest items
                    // Would need to read harvest/decisions.json to get sourceRunIds
                    // For now, this edge is deferred - would require reading harvest artifacts
                }

                // Edge: MigrationRun -> PreviousMigrationRuns (via mutationHistory)
                // This is tracked in the Story Bible mutationHistory, not in run manifests
                // Would require cross-referencing Story Bible to find prior runs
            } catch (err) {
                console.warn(`[SequentialGenerator] Failed to read manifest for ${runKey}:`, err);
            }
        }

        if (closure.size >= MAX_CLOSURE_NODES) {
            console.warn(`[SequentialGenerator] Protection closure limit reached (${MAX_CLOSURE_NODES}). Stopping cleanup.`);
        }

        return closure;
    }

    /**
     * Identifies and cleans up old runs, preserving "protected" ones.
     */
    private async cleanupOldRuns() {
        const outputRoot = '.gwriter/output';
        const abstractRoot = this.plugin.app.vault.getAbstractFileByPath(outputRoot);
        if (!(abstractRoot instanceof TFolder)) return;

        // 1. Find all protected runs (by runKey - folder name)
        const protectedRunKeys = new Set<string>();
        const globalIndexPath = '.gwriter/protection-index.json';
        try {
            const globalIndexFile = this.plugin.app.vault.getAbstractFileByPath(globalIndexPath);
            if (globalIndexFile instanceof TFile) {
                const content = await this.plugin.app.vault.read(globalIndexFile);
                const index: Record<string, ProtectionReason[]> = JSON.parse(content);
                // Index uses runId, but we need runKey - would need to read manifests
                // For now, check protected.json files
            }
        } catch (err) {
            // Global index doesn't exist yet
        }

        // Also check per-run protected.json files
        for (const child of abstractRoot.children) {
            if (!(child instanceof TFolder) || !child.name.startsWith('run-')) continue;
            const protectedFile = child.children.find(f => f.name === 'protected.json');
            if (protectedFile) {
                protectedRunKeys.add(child.name); // child.name is runKey
            }
        }

        // 2. Compute transitive closure via BFS
        const closure = await this.computeProtectionClosure(protectedRunKeys);

        // 3. Find unprotected runs
        const runFolders = abstractRoot.children
            .filter(f => f instanceof TFolder && f.name.startsWith('run-'))
            .sort((a, b) => b.name.localeCompare(a.name)); // Newest first

        const MAX_RUNS_TO_KEEP = 10;
        const toTrash: TFolder[] = [];

        let unprotectedCount = 0;
        for (const folder of runFolders) {
            if (folder.name === this.currentRunKey) continue; // Never trash current run
            if (closure.has(folder.name)) continue; // Never trash protected runs

            unprotectedCount++;
            if (unprotectedCount > MAX_RUNS_TO_KEEP) {
                toTrash.push(folder as TFolder);
            }
        }

        // 4. Move to trash
        for (const folder of toTrash) {
            try {
                await this.plugin.trashService.trashRun(folder.name, folder.path, 'Automatic cleanup: exceeded keep limit');
                console.log(`[SequentialGenerator] 🧹 Moved run to trash: ${folder.name}`);
            } catch (err) {
                console.warn(`[SequentialGenerator] Failed to trash run ${folder.name}:`, err);
            }
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

        // Pre-flight: Check API key
        if (!this.plugin.settings.apiKey) {
            this.failRun('API key not configured. Please set your API key in settings.');
            return;
        }

        const policyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
        const indexStatus = this.plugin.embeddingsIndex.getStatus();
        const corpusHash = await this.plugin.embeddingsIndex.getCorpusHash();

        const initialState = {
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

        const contextManager = new ContextManager(this.plugin.app.vault, initialState);
        this.contextManager = contextManager;
        
        // Seed from Story Bible
        const seedResult = await contextManager.seedFromStoryBible(this.plugin.settings.storyBiblePath);

        // Get user instruction (from modeState or default)
        const userInstruction = (this.plugin.settings.modeState?.chapter?.rewriteInstructions || 
                               'Write a compelling chapter that advances the plot.');

        // Build context pack
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

        // Save context pack artifact
        await this.contextPacker.saveContextPack(contextPack, this.currentRunKey!, this.plugin.vaultService);

        // Build lock map
        const lockMap = contextPack.lockMap;

        // Pre-flight cost check
        const estimatedCost = this.estimateCloudCost(contextPack.tokenEstimate.total, targetWordCount);
        if (this.plugin.settings.relayCostHardBudget && estimatedCost.high > this.plugin.settings.relayCostHardBudget) {
            this.failRun(`Estimated cost ($${estimatedCost.high.toFixed(2)}) exceeds hard budget ($${this.plugin.settings.relayCostHardBudget}).`);
            return;
        }

        // Initialize manifest
        const pluginVersion = this.plugin.manifest.version || '1.0.3';
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
            storyBibleHash: seedResult.hash,
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

        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });

        try {
            // Single cloud call
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

            // Start "Continuity Pulse" animation
            const pulseMessages = [
                'Traversing 128k context window...',
                'Integrating retrieval hits...',
                'Respecting locked bible facts...',
                'Matching author voice signature...',
                'Stitching narrative threads...',
                'Polishing prose flow...'
            ];
            let pulseIdx = 0;
            const pulseInterval = setInterval(() => {
                const msg = pulseMessages[pulseIdx % pulseMessages.length];
                relayEventBus.emit('run:pulse', { 
                    runId: this.currentRunId!, 
                    message: msg,
                    detail: `Elapsed: ${Math.floor((Date.now() - cloudStartTime) / 1000)}s`
                });
                pulseIdx++;
            }, 3000);

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

            // Local gate: Audit full chapter
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

            // Local gate: Tuple verification
            const tupleViolations = this.verifyLockedFacts(
                cloudOutput.lockedFactAttestations,
                cloudOutput.extractedTuples || [],
                lockMap
            );

            // Local gate: Citation guard
            const citationViolations = await this.verifyCitations(
                cloudOutput.paragraphs,
                contextPack.retrievalHits
            );

            // Check for fatal violations
            if (auditResult.overallSeverity >= 5 || tupleViolations.length > 0 || citationViolations.length > 0) {
                const violationSummary = [
                    auditResult.summary,
                    tupleViolations.length > 0 ? `${tupleViolations.length} locked fact violations` : '',
                    citationViolations.length > 0 ? `${citationViolations.length} citation mismatches` : ''
                ].filter(Boolean).join('; ');

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

            // Commit chapter
            await this.commitCloudChapter(cloudOutput, contextManager, {
                latencyMs: cloudLatency,
                tokensIn: contextPack.tokenEstimate.total,
                tokensOut: estimateTokens(fullProse),
                requestId: undefined, // Would come from provider response
                estimatedCost
            });

            this.state = 'COMPLETED';
            this.manifest!.endTime = Date.now();

            // Save context pack and policy snapshot for replayability
            await this.contextPacker!.saveContextPack(contextPack, this.currentRunKey!, this.plugin.vaultService);
            await this.writePolicySnapshot(this.currentRunKey!);
            
            // Set replayable flag if critical artifacts exist
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

        // Rough pricing estimates (as of 2024)
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

        // Add 20% variance for estimation
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

        // Check attestations
        attestations.forEach(att => {
            if (att.status === 'CONTRADICTED') {
                violations.push(`Locked fact ${att.factId} was contradicted`);
            }
        });

        // Check extracted tuples against lock map
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
        
        // Update chapter state
        const state = contextManager.getState();
        state.lastChunkId = 'monolithic-cloud-output';
        
        // Record cloud call telemetry in manifest
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

        // Transactional commit to vault and UI
        if (!this.dryRun) {
            relayEventBus.emit('chunk:committed', { 
                runId: this.currentRunId!, 
                chunkId: 'monolithic-chapter', 
                content: fullProse, 
                metadata: output.paragraphs.map((p: any) => p.sidecar),
                path: this.plugin.settings.book2Path 
            });
        } else {
            console.log(`[SequentialGenerator] [DRY-RUN] Would have committed monolithic chapter to ${this.plugin.settings.book2Path}`);
        }

        // Update timeline in state
        contextManager.updateState([], { 
            chunkId: 'monolithic-chapter', 
            summary: `Cloud generated full chapter (${fullProse.split(/\s+/).length} words)` 
        });

        // Post-run: Lore Harvesting for Cloud Mode
        await this.performCloudHarvest(contextManager, fullProse, output.paragraphs, output.extractedTuples);
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

        // Extract candidates treating monolithic output as single synthetic chunk
        const harvestResult = await this.loreHarvestService.extractCandidates(
            [{ 
                chunkId: 'monolithic-chapter', 
                text: fullProse, 
                metadata: paragraphs.map(p => p.sidecar) 
            }],
            contextManager.getState(),
            this.currentRunId!
        );

        // Apply CLOUD_MONOLITHIC origin tag
        harvestResult.forEach(item => {
            item.proposedFact.origin = 'CLOUD_MONOLITHIC';
        });

        // Merge model-provided tuples if available
        if (modelExtractedTuples && modelExtractedTuples.length > 0) {
            await this.loreHarvestService.mergeModelTuples(harvestResult, modelExtractedTuples);
        }

        if (harvestResult.length === 0) {
            console.log('[SequentialGenerator] 🌾 No lore candidates found for cloud harvest.');
            return;
        }

        // Log to manifest
        this.manifest.harvestSummary = {
            totalCandidates: harvestResult.length,
            clusteredCount: harvestResult.length,
            approvedIds: [],
            rejectedIds: [],
            autoAcceptedSceneOnly: [],
            conflicts: harvestResult.filter(c => c.conflictCheckResult.hasConflict).map(c => ({
                harvestId: c.harvestId,
                conflictReason: 'Lore conflict detected',
                conflictingFactIds: c.conflictCheckResult.conflictingFactIds || []
            }))
        };

        // Handle auto-accepted SCENE_ONLY items
        const sceneOnlyItems = harvestResult.filter(c => c.recommendedAction === 'AUTO_ACCEPT_SCENE_ONLY');
        if (sceneOnlyItems.length > 0) {
            sceneOnlyItems.forEach(item => {
                const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const };
                contextManager.updateState([fact]);
                this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
            });
        }

        // Show harvest checklist for remaining items
        const reviewItems = harvestResult.filter(c => c.recommendedAction === 'REVIEW' || c.recommendedAction === 'QUARANTINE');
        if (reviewItems.length > 0) {
            const result = await showHarvestChecklistModal(this.plugin.app, { items: reviewItems });
            if (result) {
                this.manifest.harvestSummary!.approvedIds = result.approvedIds;
                this.manifest.harvestSummary!.rejectedIds = result.rejectedIds;

                // Handle run-local items
                if (result.runLocalIds.length > 0) {
                    const runLocalItems = harvestResult.filter(c => result.runLocalIds.includes(c.harvestId));
                    runLocalItems.forEach(item => {
                        item.resolutionAction = result.resolutionActions[item.harvestId] || 'SCOPE_TO_SCENE';
                        const fact = { ...item.proposedFact, lifecycleState: 'CANON' as const, scope: 'SCENE' as const };
                        contextManager.updateState([fact]);
                        this.manifest!.harvestSummary!.autoAcceptedSceneOnly.push(item.harvestId);
                    });
                }

                // Transactional Story Bible Merge for approved items
                if (result.approvedIds.length > 0) {
                    result.approvedIds.forEach(id => {
                        const item = harvestResult.find(c => c.harvestId === id);
                        if (item && result.resolutionActions[id]) {
                            item.resolutionAction = result.resolutionActions[id];
                        }
                    });
                    const approvedItems = harvestResult.filter(c => result.approvedIds.includes(c.harvestId));
                    const mergeResult = await this.plugin.vaultService.mergeHarvestIntoStoryBible(
                        this.plugin.settings.storyBiblePath,
                        approvedItems,
                        contextManager.getState().canonVersion
                    );

                    if (mergeResult.success) {
                        this.manifest.harvestSummary!.canonVersionAfterMerge = mergeResult.canonVersionAfterMerge;
                        const promotedFacts = approvedItems.map(item => ({
                            ...item.proposedFact,
                            lifecycleState: 'CANON' as const,
                            origin: 'BIBLE' as const
                        }));
                        contextManager.updateState(promotedFacts);
                    }
                }
            }
        }
    }

    async abort() {
        this.state = 'aborted';
        this.abortController?.abort();
        this.plugin.ollamaGen.cancelAll();
        if (this.currentRunKey) {
            await this.releaseRunLock(this.currentRunKey);
        }
        relayEventBus.emit('control:aborted', { runId: this.currentRunId! });
    }
}
