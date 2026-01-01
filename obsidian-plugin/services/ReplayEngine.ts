import { App, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { RunManifest, RunState, PolicySnapshot, RunIndex } from './Schemas';
import { sha256 } from './ContentHash';
import { 
    ReplayTier as ReplayMode, 
    determineReplayTier, 
    ReplayPrereqs,
    DowngradeReason 
} from '../contracts/ReplayContract';
import { RunPaths } from './RunPaths';

export interface ReplayResult {
    success: boolean;
    mode: ReplayMode;
    downgradeReason?: string;
    diffs?: {
        proseDiffs?: Array<{ chunkId: string; diff: string }>;
        tupleDiffs?: Array<{ factId: string; change: string }>;
        schemaDiffs?: Array<{ field: string; expected: any; actual: any }>;
    };
    driftAttribution?: Array<{ reason: string; impact: 'HIGH' | 'MEDIUM' | 'LOW' }>;
}

export interface ReplayManifest {
    replayId: string;
    originalRunId: string;
    mode: ReplayMode;
    startedAt: number;
    completedAt?: number;
    success: boolean;
    downgradeReason?: string;
    driftAttribution?: Array<{ reason: string; impact: 'HIGH' | 'MEDIUM' | 'LOW' }>;
    inputsHash: string;
    outputsHash?: string;
}

/**
 * ReplayEngine supports deterministic replay of generation runs for debugging and regression testing.
 */
export class ReplayEngine {
    private plugin: WritingDashboardPlugin;

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    /**
     * Replays a run in the specified mode.
     */
    async replayRun(runId: string, mode: ReplayMode = 'EXACT'): Promise<ReplayResult> {
        const runFolder = `.gwriter/output/${runId}`;
        
        // Load original manifest
        const manifestPath = `${runFolder}/run.json`;
        const manifestFile = this.plugin.app.vault.getAbstractFileByPath(manifestPath);
        if (!(manifestFile instanceof TFile)) {
            throw new Error(`Run manifest not found: ${runId}`);
        }

        const manifestContent = await this.plugin.app.vault.read(manifestFile);
        const originalManifest: RunManifest = JSON.parse(manifestContent);

        // Load policy snapshot
        const policyPath = `${runFolder}/policy.json`;
        let originalPolicy: PolicySnapshot | null = null;
        try {
            const policyFile = this.plugin.app.vault.getAbstractFileByPath(policyPath);
            if (policyFile instanceof TFile) {
                const policyContent = await this.plugin.app.vault.read(policyFile);
                originalPolicy = JSON.parse(policyContent);
            }
        } catch (err) {
            // Policy snapshot not found
        }

        // Determine effective mode (may downgrade)
        const { mode: effectiveMode, reason: downgradeReason } = await this.determineEffectiveMode(mode, originalManifest, originalPolicy);
        
        if (effectiveMode !== mode) {
            console.warn(`[ReplayEngine] Downgraded from ${mode} to ${effectiveMode}. Reason: ${downgradeReason}`);
        }

        // Execute replay based on mode
        let result: ReplayResult;
        switch (effectiveMode) {
            case 'EXACT':
                result = await this.replayExact(originalManifest, runId);
                break;
            case 'FULL':
                result = await this.replayFull(originalManifest, runId);
                break;
            case 'AUDIT':
                result = await this.replayAudit(originalManifest, runId);
                break;
        }

        // Write replay manifest
        const replayManifest: ReplayManifest = {
            replayId: `replay-${Date.now()}`,
            originalRunId: runId,
            mode: effectiveMode,
            startedAt: Date.now(),
            completedAt: Date.now(),
            success: result.success,
            downgradeReason: downgradeReason || result.downgradeReason,
            driftAttribution: result.driftAttribution,
            inputsHash: await sha256(JSON.stringify(originalManifest))
        };

        const replayFolder = `${runFolder}/replays/${replayManifest.replayId}`;
        await this.plugin.vaultService.ensureParentFolder(`${replayFolder}/replay.json`);
        await this.plugin.vaultService.writeFile(`${replayFolder}/replay.json`, JSON.stringify(replayManifest, null, 2));

        return result;
    }

    /**
     * Determines the effective replay mode, potentially downgrading if prerequisites aren't met.
     */
    private async determineEffectiveMode(
        requestedMode: ReplayMode,
        originalManifest: RunManifest,
        originalPolicy: PolicySnapshot | null
    ): Promise<{ mode: ReplayMode; reason?: DowngradeReason }> {
        if (requestedMode === 'AUDIT') {
            return { mode: 'AUDIT' };
        }

        // Verify prereqs from manifest
        const prereqs = originalManifest.replayPrereqs || {
            hasPromptBodies: false,
            hasHitsBodies: false,
            hasTemplateSnapshot: false,
            hasScoringSnapshot: false,
            hasModelIdentity: false
        };

        const { tier: manifestTier, reason: manifestReason } = determineReplayTier(prereqs);

        // Verify file existence against manifest claims (Health Verification)
        const runKey = originalManifest.runKey;
        const adapter = this.plugin.app.vault.adapter;
        const base = RunPaths.baseDir(runKey);

        if (prereqs.hasPromptBodies && !(await adapter.exists(`${base}/context/prompt.chunk-1.json`))) {
            return { mode: 'FULL', reason: 'PREREQ_MISMATCH' };
        }

        if (requestedMode === 'EXACT') {
            if (manifestTier !== 'EXACT') {
                return { mode: manifestTier, reason: manifestReason };
            }
            
            // Check model identity match if possible
            if (originalManifest.config.smartModelDigest) {
                const currentDigest = await this.plugin.ollamaModels.getModelDigest(originalManifest.config.smartModel);
                if (currentDigest !== originalManifest.config.smartModelDigest) {
                    return { mode: 'FULL', reason: 'MODEL_MISMATCH' };
                }
            }
        }

        return { mode: requestedMode };
    }

    /**
     * EXACT replay: Reuses recorded retrieval hits and prompts, only re-runs model calls.
     */
    private async replayExact(originalManifest: RunManifest, runId: string): Promise<ReplayResult> {
        // Check if this is a cloud monolithic run
        const isCloudMonolithic = originalManifest.stages.some(s => s.data?.runMode === 'CLOUD_MONOLITHIC');
        
        if (isCloudMonolithic) {
            return await this.replayCloudMonolithic(originalManifest, runId);
        }

        // TODO: Implement exact replay logic for local chunked runs
        // - Load recorded prompts from context/
        // - Load recorded hits from context/
        // - Re-run model calls with same inputs
        // - Compare outputs
        return {
            success: true,
            mode: 'EXACT',
            driftAttribution: []
        };
    }

    /**
     * Replay for cloud monolithic runs: Load frozen ContextPack and bypass retrieval.
     */
    private async replayCloudMonolithic(originalManifest: RunManifest, runId: string): Promise<ReplayResult> {
        const runKey = originalManifest.runKey || runId;
        const contextPackPath = `.gwriter/output/${runKey}/context/context-pack.json`;
        
        // Load frozen context pack
        const contextPackFile = this.plugin.app.vault.getAbstractFileByPath(contextPackPath);
        if (!(contextPackFile instanceof TFile)) {
            return {
                success: false,
                mode: 'EXACT',
                downgradeReason: 'Context pack not found - cannot replay cloud monolithic run'
            };
        }

        const contextPackContent = await this.plugin.app.vault.read(contextPackFile);
        const contextPack = JSON.parse(contextPackContent);

        // Verify orchestration flow: Check if we can reconstruct the same input
        const cloudStage = originalManifest.stages.find(s => s.data?.runMode === 'CLOUD_MONOLITHIC');
        if (!cloudStage) {
            return {
                success: false,
                mode: 'EXACT',
                downgradeReason: 'No cloud monolithic stage found in manifest'
            };
        }

        // Note: Actual replay would require re-injecting contextPack into CloudRelay
        // For now, we verify the orchestration artifacts exist
        return {
            success: true,
            mode: 'EXACT',
            driftAttribution: []
        };
    }

    /**
     * FULL replay: Re-runs retrieval using recorded criteria, re-runs model calls.
     */
    private async replayFull(originalManifest: RunManifest, runId: string): Promise<ReplayResult> {
        // TODO: Implement full replay logic
        // - Re-run retrieval using original criteria
        // - Re-run model calls
        // - Compare outputs
        return {
            success: true,
            mode: 'FULL',
            driftAttribution: []
        };
    }

    /**
     * AUDIT replay: Validates manifest invariants without model calls.
     */
    private async replayAudit(originalManifest: RunManifest, runId: string): Promise<ReplayResult> {
        const issues: string[] = [];

        // Validate schema
        if (!originalManifest.runId) issues.push('Missing runId');
        if (!originalManifest.stages || originalManifest.stages.length === 0) {
            issues.push('No stages recorded');
        }

        // Validate stage integrity
        for (const stage of originalManifest.stages) {
            if (!stage.stageType) issues.push(`Stage missing type: ${stage.stageId}`);
            if (!stage.data) issues.push(`Stage missing data: ${stage.stageId}`);
        }

        // Validate intervention/continuation consistency
        if (originalManifest.interventions && originalManifest.continuations) {
            const interventionIds = new Set(originalManifest.interventions.map(i => i.eventId));
            const continuationPauseIds = new Set(originalManifest.continuations.map(c => c.pauseEventId));
            for (const pauseId of continuationPauseIds) {
                if (!interventionIds.has(pauseId)) {
                    issues.push(`Continuation references missing intervention: ${pauseId}`);
                }
            }
        }

        return {
            success: issues.length === 0,
            mode: 'AUDIT',
            diffs: {
                schemaDiffs: issues.map(issue => ({ field: 'validation', expected: 'valid', actual: issue }))
            }
        };
    }
}

