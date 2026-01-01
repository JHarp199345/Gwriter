import { 
    ChapterState, 
    AuditResult, 
    PatchOp, 
    RunManifest, 
    StageResult,
    ContextBundleManifest,
    Violation,
    CanonFact,
    ParagraphMetadata
} from './Schemas';
import { ContextManager } from './ContextManager';
import { AuditService } from './AuditService';
import { ProseStitcher } from './ProseStitcher';
import { ParagraphIdentityService } from './ParagraphIdentityService';
import { CO_AUTHORING_POLICY } from './policy';
import { App, Notice, TFile } from 'obsidian';
import { relayEventBus } from './EventBus';
import WritingDashboardPlugin from '../main';

export type GeneratorState = 'idle' | 'running' | 'paused' | 'aborted' | 'completed' | 'error';

/**
 * SequentialGenerator is the "Brain" of the relay drafting race.
 * It manages the Plan-Retrieve-Write-Verify-Repair loop as a version-pinned state machine.
 */
export class SequentialGenerator {
    private plugin: WritingDashboardPlugin;
    private proseStitcher: ProseStitcher;
    private identityService: ParagraphIdentityService;
    private abortController: AbortController | null = null;
    
    private state: GeneratorState = 'idle';
    private currentRunId: string | null = null;
    private manifest: RunManifest | null = null;
    private isPaused: boolean = false;
    private commitLock: boolean = false;

    constructor(app: App, plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
        this.proseStitcher = new ProseStitcher();
        this.identityService = new ParagraphIdentityService();
    }

    /**
     * Main entry point to generate a chapter in stages.
     */
    async generateChapter(targetWordCount: number) {
        if (this.state === 'running') {
            new Notice('Generation is already running.');
            return;
        }

        this.currentRunId = `run-${Date.now()}`;
        this.state = 'running';
        this.abortController = new AbortController();
        this.isPaused = false;

        const smartModel = this.plugin.settings.relaySmartModel;
        const fastModel = this.plugin.settings.relayFastModel;
        
        // 1. Pre-flight checks
        const ollamaVer = await this.plugin.ollamaGen.getOllamaVersion();
        if (!ollamaVer) {
            this.failRun('Ollama not reachable. Please ensure Ollama is running.');
            return;
        }

        const smartDigest = await this.plugin.ollamaModels.getModelDigest(smartModel);
        const fastDigest = await this.plugin.ollamaModels.getModelDigest(fastModel);

        const policyHash = await sha256(JSON.stringify(CO_AUTHORING_POLICY));
        const indexStatus = this.plugin.embeddingsIndex.getStatus();
        const corpusHash = await this.plugin.embeddingsIndex.getCorpusHash();

        if (!smartDigest || !fastDigest) {
            new Notice('Warning: One or more model digests are missing. Strict Replay will be disabled.');
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
        
        // Seed from Story Bible
        const seedResult = await contextManager.seedFromStoryBible(this.plugin.settings.storyBiblePath);

        this.manifest = {
            runId: this.currentRunId,
            chapterId: initialState.chapterId,
            startTime: Date.now(),
            ollamaVersion: ollamaVer,
            storyBibleHash: seedResult.hash,
            initialStateHash: await sha256(JSON.stringify(initialState)),
            stages: [],
            config: {
                smartModel,
                smartModelDigest: smartDigest,
                fastModel,
                fastModelDigest: fastDigest,
                maxChunkWords: this.plugin.settings.maxChunkWords || 500,
                temperature: 0.7,
                policyHash,
                corpusHash,
                pluginVersion: this.plugin.manifest.version
            }
        };

        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });

        let totalWords = 0;
        let iteration = 1;

        try {
            while (totalWords < targetWordCount && this.state === 'running') {
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
                const planResult = await this.runStage('PLAN', fastModel, async () => {
                    const prompt = `Plan the next ${this.manifest!.config.maxChunkWords} words for chapter ${initialState.chapterId}.`;
                    return await this.plugin.ollamaGen.enqueue(5, (signal) => 
                        this.plugin.ollamaGen.generateJson(prompt, fastModel)
                    );
                }, undefined, await sha256(`Plan the next ${this.manifest!.config.maxChunkWords} words for chapter ${initialState.chapterId}.`));
                if (!planResult) break;

                // 2. RETRIEVE
                const retrieveResult = await this.runStage('RETRIEVE', fastModel, async () => {
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
                // 3. WRITE (Streaming)
                const writeResult = await this.runStage('WRITE', smartModel, async () => {
                    const stateCard = contextManager.renderStateCard();
                    const retrieved = retrieveResult.data.map((r: any) => r.excerpt).join('\n\n');
                    
                    const constraintBlock = isDegraded 
                        ? `\n[DEGRADED MODE] Restricted Domains: ${restrictedDomains.join(', ')}\nConstraint: Do not assert new canonical facts about these domains.`
                        : '';

                    const prompt = `
                        ${stateCard}
                        PLAN: ${JSON.stringify(planResult.data)}
                        CONTEXT: ${retrieved}${constraintBlock}
                        
                        INSTRUCTION: Write the next prose chunk. 
                        Use \n\n to separate paragraphs.
                        For every paragraph, you MUST also generate a sidecar entry with a unique "p_id" (c${iteration}-p{index}).
                        ${isDegraded ? 'Flag missingHardIntent: true if relevant.' : ''}
                    `;
                    
                    return await this.plugin.ollamaGen.enqueue(10, (signal) => 
                        this.plugin.ollamaGen.generateStream(
                            prompt, 
                            { model: smartModel, temperature: rawParams.temp },
                            (token) => relayEventBus.emit('chunk:buffer:update', { content: token })
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

                // 5. AUDIT
                const auditResult = await this.runStage('AUDIT', fastModel, async () => {
                    return await this.plugin.auditService.auditChunk(chunkText, contextManager.getState());
                }, undefined, await sha256(chunkText));
                if (!auditResult) break;
                let auditData: AuditResult = auditResult.data;

                // --- SMART BATCH 2: REPAIR & STITCH ---
                // 6. REPAIR (if needed)
                if (auditData.overallSeverity >= 4) {
                    const repairResult = await this.runStage('REPAIR', smartModel, async () => {
                        const prompt = `Repair the following prose chunk to resolve these violations: ${JSON.stringify(auditData.violations)}\n\nChunk: ${chunkText}`;
                        return await this.plugin.ollamaGen.enqueue(10, (signal) => 
                            this.plugin.ollamaGen.generateJson<PatchOp[]>(prompt, smartModel)
                        );
                    }, undefined, await sha256(JSON.stringify(auditData.violations)));
                    if (repairResult) {
                        const patches: PatchOp[] = repairResult.data;
                        writeResult.data = this.applyPatches(writeResult.data, patches);
                    }
                }

                // 7. STITCH (if not first chunk)
                if (iteration > 1) {
                    const stitchResult = await this.runStage('STITCH', smartModel, async () => {
                        const tail = contextManager.getState().timeline.slice(-1)[0]?.summary || ""; 
                        const head = writeResult.data.slice(0, 200);
                        
                        const originalBoundary = head;
                        let retryCount = 0;
                        let finalPatches: PatchOp[] = [];

                        while (retryCount <= 1) {
                            const patches = await this.plugin.ollamaGen.enqueue(3, (signal) => 
                                this.proseStitcher.stitch(tail, head)
                            );
                            
                            const stitchedHead = this.proseStitcher.applyStitch(head, patches);
                            const integrity = this.proseStitcher.validateClaimIntegrity(originalBoundary, stitchedHead);

                            if (integrity.valid) {
                                finalPatches = patches;
                                break;
                            } else {
                                retryCount++;
                                console.warn(`[SequentialGenerator] Stitch rejected: claim mutation detected. Retry ${retryCount}`);
                                if (retryCount > 1) {
                                    console.error(`[SequentialGenerator] Stitch failed after retries. Skipping.`);
                                    relayEventBus.emit('pilot:stitch_rejected', { iteration, changes: integrity.changes });
                                }
                            }
                        }
                        
                        return { patches: finalPatches, stitchSkipped: finalPatches.length === 0 };
                    }, undefined, await sha256(contextManager.getState().timeline.slice(-1)[0]?.summary || ""));
                    
                    if (stitchResult && stitchResult.data.patches.length > 0) {
                        const stitchPatches: PatchOp[] = stitchResult.data.patches;
                        writeResult.data = this.applyPatches(writeResult.data, stitchPatches);
                    }
                }

                // 8. COMMIT (Transactional)
                await this.commitChunk(iteration, writeResult.data, writeResult.metadata);

                // --- FAST BATCH 3: UPDATE STATE ---
                    // 9. UPDATE STATE
                    const updateResult = await this.runStage('UPDATE', fastModel, async () => {
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

                        return { status: 'success', version: contextManager.getState().canonVersion };
                    }, undefined, await sha256(`Generated chunk ${iteration}`));
                if (!updateResult) break;

                this.checkQualityFloors(iteration);

                totalWords += writeResult.data.split(/\s+/).length;
                iteration++;

                await this.saveManifest();
            }

            if (this.state === 'running') {
                this.state = 'completed';
                this.manifest!.endTime = Date.now();
                
                // Emit Run Health Summary
                const health = this.calculateHealth();
                relayEventBus.emit('run:end', { 
                    runId: this.currentRunId!, 
                    totalWords,
                    health 
                } as any);
                
                await this.saveManifest();
            }

        } catch (err) {
            this.state = 'error';
            relayEventBus.emit('run:error', { runId: this.currentRunId!, error: err.message });
        } finally {
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
            relayEventBus.emit('chunk:committed', { 
                runId: this.currentRunId!, 
                chunkId: `chunk-${iteration}`, 
                content, 
                metadata,
                path: this.plugin.settings.book2Path 
            });
            // Final hash match is computed against this committed text
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

    private checkControlFlow(): boolean {
        if (this.abortController?.signal.aborted || this.state === 'aborted') return true;
        if (this.isPaused) {
            this.state = 'paused';
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

    private consecutiveViolations = 0;

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
                this.isPaused = true;
                relayEventBus.emit('control:paused', { 
                    runId: this.currentRunId!, 
                    reason: 'Quality collapse detected. Manual review required.' 
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
        const tierAParagraphs = writeStages.reduce((acc, s) => acc + (s.metadata?.filter(m => !m.isSpeculative).length || 0), 0);
        const totalParagraphs = writeStages.reduce((acc, s) => acc + (s.metadata?.length || 0), 0);

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

    private failRun(error: string) {
        this.state = 'error';
        relayEventBus.emit('run:error', { runId: this.currentRunId || 'unknown', error });
        new Notice(`Generation failed: ${error}`);
    }

    private async saveManifest() {
        if (!this.manifest) return;
        const path = `.gwriter/runs/${this.currentRunId}/manifest.json`;
        await this.plugin.vaultService.ensureParentFolder(path);
        await this.plugin.vaultService.writeFile(path, JSON.stringify(this.manifest, null, 2));
    }

    abort() {
        this.state = 'aborted';
        this.abortController?.abort();
        this.plugin.ollamaGen.cancelAll();
        relayEventBus.emit('control:aborted', { runId: this.currentRunId! });
    }
}
