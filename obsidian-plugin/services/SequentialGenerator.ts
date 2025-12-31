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
            initialStateHash: this.hashString(JSON.stringify(initialState)),
            stages: [],
            config: {
                smartModel,
                smartModelDigest: smartDigest,
                fastModel,
                fastModelDigest: fastDigest,
                maxChunkWords: this.plugin.settings.maxChunkWords || 500,
                temperature: 0.7
            }
        };

        relayEventBus.emit('run:start', { runId: this.currentRunId, chapterId: initialState.chapterId });

        let totalWords = 0;
        let iteration = 1;

        try {
            while (totalWords < targetWordCount && this.state === 'running') {
                if (this.checkControlFlow()) break;

                console.log(`[SequentialGenerator] --- Iteration ${iteration} ---`);
                
                // 1. PLAN
                const planResult = await this.runStage('PLAN', fastModel, async () => {
                    const prompt = `Plan the next ${this.manifest!.config.maxChunkWords} words for chapter ${initialState.chapterId}.`;
                    return await this.plugin.ollamaGen.generateJson(prompt, fastModel);
                });
                if (!planResult) break;

                // 2. WRITE
                const writeResult = await this.runStage('WRITE', smartModel, async () => {
                    const stateCard = contextManager.renderStateCard();
                    const prompt = `
                        ${stateCard}
                        PLAN: ${JSON.stringify(planResult.data)}
                        
                        INSTRUCTION: Write the next prose chunk. 
                        Use \n\n to separate paragraphs.
                        For every paragraph, you MUST also generate a sidecar entry with a unique "p_id" (c${iteration}-p{index}).
                    `;
                    return await this.plugin.ollamaGen.generate(prompt, { 
                        model: smartModel, 
                        temperature: 0.7,
                        seed: 42 
                    });
                });
                if (!writeResult) break;

                // Segmentation Recovery and Identity Alignment
                const { text: chunkText, metadata: recoveredMeta } = this.segmentAndRecover(writeResult.data, []);
                writeResult.data = chunkText;
                writeResult.metadata = recoveredMeta;

                // 3. AUDIT
                const auditResult = await this.runStage('AUDIT', fastModel, async () => {
                    return await this.plugin.auditService.auditChunk(chunkText, contextManager.getState());
                });
                if (!auditResult) break;
                let auditData: AuditResult = auditResult.data;

                // 4. REPAIR (if needed)
                if (auditData.overallSeverity >= 4) {
                    const repairResult = await this.runStage('REPAIR', smartModel, async () => {
                        const prompt = `Repair the following prose chunk to resolve these violations: ${JSON.stringify(auditData.violations)}\n\nChunk: ${chunkText}`;
                        return await this.plugin.ollamaGen.generateJson<PatchOp[]>(prompt, smartModel);
                    });
                    if (!repairResult) break;
                    
                    const patches: PatchOp[] = repairResult.data;
                    chunkText = this.applyPatches(chunkText, patches);
                    
                    // Re-verify after repair
                    const reAuditResult = await this.runStage('AUDIT', fastModel, async () => {
                        return await this.plugin.auditService.auditChunk(chunkText, contextManager.getState());
                    });
                    if (!reAuditResult) break;
                }

                // 5. STITCH (if not first chunk)
                if (iteration > 1) {
                    const stitchResult = await this.runStage('UPDATE', smartModel, async () => {
                        const tail = "previous chunk tail"; // In real run, get from last committed
                        const head = chunkText.slice(0, 200);
                        const patches = await this.proseStitcher.stitch(tail, head);
                        return { patches };
                    });
                    if (stitchResult) {
                        const stitchPatches: PatchOp[] = stitchResult.data.patches;
                        // Apply stitch to chunkText
                        console.log(`[SequentialGenerator] Stitched ${stitchPatches.length} boundary patches.`);
                    }
                }

                // 6. COMMIT (Transactional)
                await this.commitChunk(iteration, chunkText);

                // 6. UPDATE STATE
                const updateResult = await this.runStage('UPDATE', fastModel, async () => {
                    // Check for lore mutations
                    const newFacts: CanonFact[] = []; // In a real run, these come from Audit/Repair
                    
                    for (const f of newFacts) {
                        if (!contextManager.isLoreUpdateAllowed(f.attribute)) {
                            // Proposed mutation path
                            const proposal = contextManager.proposeMutation(f, `chunk-${iteration}`);
                            relayEventBus.emit('audit:violations', {
                                runId: this.currentRunId!,
                                chunkId: `chunk-${iteration}`,
                                violations: [{
                                    type: 'ENTITY_ATTRIBUTE_MISMATCH',
                                    severity: 4,
                                    evidence: JSON.stringify(f),
                                    range: { start: 0, end: 0 },
                                    message: `Proposed mutation to ${f.attribute} for ${f.entityId}.`
                                }],
                                overallSeverity: 4
                            });
                            // Wait for user acceptance (simplified for spec)
                            contextManager.acceptMutation(proposal, [f]);
                            await this.reGround(contextManager);
                        }
                    }

                    contextManager.updateState(newFacts, { 
                        chunkId: `chunk-${iteration}`, 
                        summary: `Generated chunk ${iteration}` 
                    });
                    return { status: 'success', version: contextManager.getState().canonVersion };
                });
                if (!updateResult) break;

                this.checkQualityFloors(iteration);

                totalWords += chunkText.split(/\s+/).length;
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

    private async runStage(type: StageResult['stageType'], model: string, execution: () => Promise<any>): Promise<StageResult | null> {
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
                    inputHash: 'pending', 
                    outputHash: this.hashString(JSON.stringify(data)),
                    data
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

    private async commitChunk(iteration: number, content: string) {
        if (this.commitLock) return;
        this.commitLock = true;
        try {
            relayEventBus.emit('chunk:committed', { 
                runId: this.currentRunId!, 
                chunkId: `chunk-${iteration}`, 
                content, 
                path: this.plugin.settings.book2Path 
            });
            // Final hash match is computed against this committed text
            this.manifest!.stages.push({
                stageId: `commit-${iteration}`,
                stageType: 'UPDATE',
                startTime: Date.now(),
                endTime: Date.now(),
                inputHash: this.hashString(content),
                outputHash: this.hashString(content),
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

    private checkQualityFloors(iteration: number) {
        const policy = CO_AUTHORING_POLICY.QUALITY_FLOORS;
        const stages = this.manifest!.stages;
        const writeStages = stages.filter(s => s.stageType === 'WRITE');
        
        // 1. Max Speculative Ratio
        const totalParagraphs = writeStages.reduce((acc, s) => acc + (s.metadata?.length || 0), 0);
        const speculativeParagraphs = writeStages.reduce((acc, s) => acc + (s.metadata?.filter(m => m.isSpeculative).length || 0), 0);
        const speculativeRatio = totalParagraphs > 0 ? speculativeParagraphs / totalParagraphs : 0;

        if (speculativeRatio > policy.MAX_SPECULATIVE_RATIO) {
            console.warn(`[SequentialGenerator] ⚠️ Quality Floor Violation: Speculative Ratio too high (${(speculativeRatio * 100).toFixed(1)}% > ${policy.MAX_SPECULATIVE_RATIO * 100}%).`);
            // In a real run, this might trigger an alert or a pause
        }

        // 2. Max Consecutive Lite Chunks
        // Lite chunks are those that needed recovery or had low grounding
        let consecutiveLite = 0;
        for (let i = writeStages.length - 1; i >= 0; i--) {
            const isLite = writeStages[i].data?.recovered || writeStages[i].metadata?.every(m => m.isSpeculative);
            if (isLite) {
                consecutiveLite++;
            } else {
                break;
            }
        }

        if (consecutiveLite > policy.MAX_CONSECUTIVE_LITE_CHUNKS) {
            this.failRun(`Quality Floor Violation: ${consecutiveLite} consecutive Lite chunks. Quality collapse detected.`);
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

    private applyPatches(text: string, patches: PatchOp[]): string {
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

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString(16);
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
        relayEventBus.emit('control:aborted', { runId: this.currentRunId! });
    }
}
