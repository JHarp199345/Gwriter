/**
 * ReplayContract defines the prerequisites and downgrade logic for Strict Replay.
 */

export type ReplayTier = 'EXACT' | 'FULL' | 'AUDIT';

export interface ReplayPrereqs {
    hasPromptBodies: boolean;
    hasHitsBodies: boolean;
    hasTemplateSnapshot: boolean;
    hasScoringSnapshot: boolean;
    hasModelIdentity: boolean;
}

export type DowngradeReason = 
    | 'MISSING_PROMPT_BODY' 
    | 'MISSING_HITS' 
    | 'MISSING_TEMPLATE' 
    | 'MISSING_SCORING' 
    | 'MISSING_MODEL_IDENTITY'
    | 'MODEL_MISMATCH'
    | 'PREREQ_MISMATCH';

export interface ReplayManifest {
    tier: ReplayTier;
    prereqs: ReplayPrereqs;
    downgradeReason?: DowngradeReason;
    modelIdentity?: {
        ollamaVersion?: string;
        modelName: string;
        modelDigest?: string;
        modelfileHash?: string;
    };
}

/**
 * Deterministic Downgrade Logic
 */
export function determineReplayTier(prereqs: ReplayPrereqs): { tier: ReplayTier; reason?: DowngradeReason } {
    if (!prereqs.hasPromptBodies) return { tier: 'FULL', reason: 'MISSING_PROMPT_BODY' };
    if (!prereqs.hasHitsBodies) return { tier: 'FULL', reason: 'MISSING_HITS' };
    if (!prereqs.hasTemplateSnapshot) return { tier: 'FULL', reason: 'MISSING_TEMPLATE' };
    if (!prereqs.hasScoringSnapshot) return { tier: 'FULL', reason: 'MISSING_SCORING' };
    if (!prereqs.hasModelIdentity) return { tier: 'FULL', reason: 'MISSING_MODEL_IDENTITY' };
    
    return { tier: 'EXACT' };
}

