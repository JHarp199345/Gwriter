/**
 * Frozen schemas for the Engineering-Complete Relay Generation System.
 * These interfaces ensure deterministic validation and contract-based interaction
 * between the Planner, Writer, Auditor, and SequentialGenerator.
 */

import { ReplayPrereqs } from '../contracts/ReplayContract';
import { HelpDensity } from '../ui/HelpRegistry';

export type FactLifecycleState = 'PROPOSED' | 'QUARANTINED' | 'ACCEPTED' | 'CANON';
export type FactScope = 'SCENE' | 'CHAPTER' | 'GLOBAL';
export type FactOrigin = 'BIBLE' | 'USER' | 'EXTRACTOR' | 'GENERATION' | 'MUTATION' | 'STATE' | 'DERIVED_SUMMARY' | 'CLOUD_MONOLITHIC';
export type FactType = 'IDENTITY' | 'RELATIONSHIP' | 'TIMELINE' | 'TRAIT' | 'SCENE_DETAIL' | 'TONE_RULE' | 'THREAD_STATE';
export type RunState = 'RUNNING' | 'PAUSED_FOR_INTERVENTION' | 'RESUMING' | 'STOPPED_FATAL' | 'COMPLETED' | 'idle' | 'aborted' | 'error';
export type InterventionTriggerReason = 'FAIL_MATRIX_SEVERITY' | 'FAIL_REPAIR_CAP';
export type HarvestTierImpact = 'CORE' | 'SUPPORTING' | 'SCENE_ONLY';
export type HarvestRecommendedAction = 'QUARANTINE' | 'REVIEW' | 'AUTO_ACCEPT_SCENE_ONLY';
export type EvidenceRelocationTier = 'EXACT' | 'RELOCATED_UNIQUE' | 'RELOCATED_AMBIGUOUS' | 'STALE';

export enum EvidenceRelocationMethod {
    PARA_ID = 'PARA_ID',
    ANCHOR_PAIR = 'ANCHOR_PAIR',
    FILE_HASH = 'FILE_HASH',
    FILE_ANCHOR = 'FILE_ANCHOR'
}
export type ProtectionEdgeType = 'PROMOTION_EVIDENCE' | 'MIGRATION_CHAIN' | 'BRANCH_PARENT' | 'REFERENCED_BY_PROTECTED' | 'MANUAL';
export type BranchStatus = 'ACTIVE' | 'ABANDONED';
export type RunHealthCode = 'OK' | 'MISSING_PROMPT_BODY' | 'MISSING_HITS' | 'SCHEMA_MISMATCH' | 'STALE_EVIDENCE_PRESENT' | 'LOCK_RECOVERED' | 'BRANCH_ORPHANED' | 'EVIDENCE_AMBIGUOUS' | 'MISSING_PROTECTION_EDGE';
export type ConflictTaxonomy = 'CONFLICT_IDENTITY' | 'CONFLICT_RELATIONSHIP' | 'CONFLICT_TIMELINE' | 'CONFLICT_SCOPE' | 'CONFLICT_CARDINALITY';
export type SpanConfidence = 'EXACT' | 'RELOCATED_UNIQUE' | 'RELOCATED_AMBIGUOUS' | 'INVALID';
export type ApprovalType = 'PROMOTE_CORE' | 'MERGE_ENTITY' | 'RETCON' | 'FACT_EDIT';
export type RAGFailureCode = 
    | 'FAIL_CONFIDENCE'
    | 'FAIL_RELEVANCE'
    | 'FAIL_REQUIRED_ENTITIES'
    | 'FAIL_INTENT_TYPE'
    | 'FAIL_SCOPE_TIMERANGE'
    | 'FAIL_MIN_HITS'
    | 'FAIL_TIME_BUDGET'
    | 'FAIL_DUPLICATE_HIT';

export interface ParagraphMetadata {
    p_id: string;
    goalIds: string[];
    factIds: string[];
    sourceChunkIds: string[];
    isSpeculative: boolean; // True if referencing 0 facts and 0 goals
    citations?: { intentId: string, snippetId: string, sourceDocId: string, span: { start: number, end: number }, relevanceScore: number }[];
}

export interface GenerationStep {
    id: string;
    label: string;
    status: 'pending' | 'running' | 'completed' | 'error';
    startTime?: number;
    endTime?: number;
}

export interface MutationAcceptance {
    id: string;
    timestamp: number;
    proposedFactIds: string[];
    acceptedBy: 'user';
    reason?: string;
    chunkId: string;
    baselineCanonVersion?: number; // Snapshot baseline for conflict evaluation
    previousCanonVersion: number;
    forwardPatch?: any;
    reversePatch?: any;
    requiresReindex: boolean;
    indexesImpacted: string[];
}

export interface CanonFact {
    id: string; // Unique ID for the fact (e.g., 'fact-001')
    entityId: string; // ID of the entity this fact involves (e.g., 'char-john')
    type: FactType; // New: Categorical type of the fact
    attribute: string; // The specific attribute (e.g., 'location', 'eye_color', 'alive_status')
    value: any; // The value of the attribute
    chunkId?: string; // The ID of the chunk that introduced or confirmed this fact
    source?: string; // Optional reference to a specific document or note
    
    // Phase 1: Executable Truth & Scoped Facts
    scope: FactScope;
    validity?: { fromSceneId?: string, toSceneId?: string };
    origin: FactOrigin;
    
    // Provenance Checklist
    sourceDocId?: string;
    sourceSpan?: { 
        start: number, 
        end: number,
        anchorTextBefore?: string,
        anchorTextAfter?: string
    };
    sourceHash?: string;
    spanConfidence?: SpanConfidence;
    extractorPass?: 'FAST' | 'SMART';
    resolverRuleId?: string;
    approvedByEventId?: string;
    approvalType?: ApprovalType;
    timestamp: number;
    confidence: number;
    lifecycleState: FactLifecycleState;

    // Relationship Model
    relationType?: string; 
    directionality?: 'directed' | 'undirected';
    isSymmetric?: boolean;
    cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-many';
}

export interface Entity {
    id: string;
    name: string;
    type: 'character' | 'location' | 'object' | 'concept';
    attributes: Record<string, any>;
}

export type ViolationType = 
    | 'ENTITY_ATTRIBUTE_MISMATCH' 
    | 'TIMELINE_ORDER_CONFLICT' 
    | 'RELATIONSHIP_CONFLICT' 
    | 'POV_HEADHOP' 
    | 'TENSE_SHIFT' 
    | 'FORBIDDEN_REVEAL';

export interface Violation {
    type: ViolationType;
    severity: number; // 1-5, where >= 4 triggers a Repair branch
    evidence: string; // The specific text span causing the violation
    /**
     * Evidence range in the chunk text.
     * Rule: 0-based, end-exclusive UTF-16 JavaScript string indices.
     */
    range: { start: number, end: number }; 
    factId?: string; // The ID of the CanonFact being violated
    message: string;
}

export interface AuditResult {
    violations: Violation[];
    overallSeverity: number;
    summary: string;
}

export interface PatchOp {
    op: 'replace' | 'insert' | 'delete';
    path?: string; // Optional path for structured data
    /**
     * Target range in the text.
     * Rule: 0-based, end-exclusive UTF-16 JavaScript string indices.
     * Coordinate Space: The pre-commit finalized chunk text.
     */
    range: { start: number, end: number }; 
    oldValue?: string;
    newValue: string;
    justification: string; // MUST cite a CanonFact ID or specific constraint
    reasonCode?: 'POV_ALIGN' | 'TENSE_ALIGN' | 'SEAM_SMOOTH' | 'DEDUP' | 'LORE_FIX';
}

export interface PlotMemory {
    version: number; // Increments each telescope
    sourceChunkIds: string[]; // Chunks that contributed to this memory
    hash: string; // Hash of the dense summary
    denseSummary: string; // The 200-word plot memory
    structured: {
        events: string[]; // Bullets with entity IDs
        openThreads: string[];
        resolvedThreads: string[];
        anchorState: {
            location?: string;
            time?: string;
            cast: string[]; // Entity IDs
        };
        newEntityStrings: string[]; // Names not resolved to IDs
        uncertainEvents: string[]; // Events with uncertainty flags
    };
    timestamp: number;
}

export interface ChapterState {
    chapterId: string;
    canonVersion: number; // Incremented on every MutationAcceptance
    schemaVersion: number; // For forward-compat and migrations
    entities: Entity[];
    canonFacts: CanonFact[];
    mutationHistory: MutationAcceptance[];
    pendingMutations: MutationAcceptance[]; // Mutations that are 'Deferred'
    entity_redirects: Record<string, string>; // old_id -> new_id for merges
    redirectRegistryVersion: number; // New: Incremented on merge/rollback
    timeline: { chunkId: string, summary: string }[];
    anchors?: {
        locationId: string;
        sceneTime: string;
        castIds: string[];
        threadIds: string[];
    };
    openLoops: string[];
    constraints: {
        pov: string;
        tense: string;
        tone: string[];
        forbidden: string[];
    };
    indexVersion?: string; // New: Version of retrieval index for strict replay
    lastChunkId?: string;
    plotMemory?: PlotMemory; // Current derived plot memory (non-canonical)
}

export interface ContextBundleManifest {
    chunkIds: string[];
    chunkHashes: Record<string, string>; // ID -> Content Hash for strict replay
    factIds: string[];
    staleFlags: Record<string, boolean>; // ID -> isStale
    penaltiesApplied: Record<string, boolean>; // ID -> stalePenaltyApplied
    tokenEstimate: number;
    promptHash: string;
    timestamp: number;
    candidatePools?: { lexical: number, semantic: number };
}

export interface StageResult {
    stageId: string;
    stageType: 'PLAN' | 'RETRIEVE' | 'WRITE' | 'AUDIT' | 'REPAIR' | 'UPDATE' | 'STITCH' | 'TELESCOPE' | 'HARVEST';
    startTime: number;
    endTime: number;
    inputHash: string; // Hash of prompt + context
    outputHash: string; // Hash of the result content
    manifest?: ContextBundleManifest;
    metadata?: ParagraphMetadata[]; // Sidecar for WRITE stages
    data: any; // Stage-specific payload (e.g., AuditResult, PatchOp[])
}

export interface MismatchReport {
    field: string;
    expected: string;
    actual: string;
    canProceed: boolean;
    severity: 'warn' | 'error';
}

export interface InterventionGuidance {
    goal: string; // What the user wants to achieve
    mustPreserve: string[]; // Anchors/canon tuples that must be preserved
    mustAvoid: string[]; // Forbidden claims/domains
    userPrompt: string; // The user's freeform guidance
}

export interface InterventionEvent {
    eventId: string;
    runId: string;
    chunkId: string;
    paragraphId?: string;
    triggerReason: InterventionTriggerReason;
    severity: number;
    violationSummary: string;
    guidance: InterventionGuidance;
    policyMode: 'LIVE' | 'DRY_RUN';
    appliedAtStage: 'WRITE';
    timestamp: number;
    blockedActions: string[]; // e.g., "stitch skipped", "write prevented"
    appliedConstraints: string[]; // e.g., "restricted domains injected"
    retrievalReused?: boolean; // Whether retrieval was re-run or reused on resume
}

export interface ProtectionReason {
    code: string; // e.g., 'PROMOTION_TO_BIBLE', 'MANUAL_PIN'
    createdAt: number;
    details?: string;
    sourceRunId?: string;
    sourceEventId?: string; // Promotion id / harvest promotion id
    canonVersion?: number; // canonVersionAfter
    factIds?: string[]; // evidenceRefs
}

export interface ProtectionEdge {
    fromRunId: string;
    toRunId: string;
    edgeType: ProtectionEdgeType;
    sourcePointer: string; // Manifest field reference (e.g., 'harvestSummary.approvedIds[0]')
    createdAt: number;
}

export interface RunContinuation {
    continuationId: string;
    parentRunId: string;
    parentContId?: string; // For hierarchical branches
    pauseEventId: string; // Links to the InterventionEvent that caused the pause
    resumedAt: number;
    snapshotHash: string; // Hash of state snapshot taken before pause
    status: BranchStatus;
    resumePlan?: {
        rerunRetrieval: boolean;
        reuseHits: boolean;
        reusePlotMemory: boolean;
        reuseAnchors: boolean;
        reusePromptBodies: boolean;
        reusePromptTemplates: boolean;
        resumeStage?: 'RETRIEVE' | 'WRITE';
    };
}

export interface EvidenceSpan {
    // Required fields
    sourceFilePath: string;
    excerptHashRaw: string;
    excerptHashNormalized: string;
    textAnchor: { 
        before: string; // Max 500 chars, trimmed to word boundary
        after: string;  // Max 500 chars, trimmed to word boundary
    };
    charRange: { start: number; end: number }; // UTF-16 code units (JS string indices)
    sourceFileHashAtRun: string;
    relocationTier: EvidenceRelocationTier;
    
    // Optional / Best Effort
    paragraphId?: string;
    headingPath?: string;
    originalExcerptText?: string;
    relocationPath?: EvidenceRelocationMethod[]; // Ordered sequence of methods tried
    matchCount?: number;
    relocatedAt?: number;
    normalizedMatch?: boolean;
    
    // Reconfirm fields (for audit clarity)
    reconfirmedAt?: number;
    reconfirmedBy?: string;
    reconfirmedFromTier?: EvidenceRelocationTier;
    reconfirmNote?: string;
}

export interface HarvestItem {
    harvestId: string;
    proposedFact: CanonFact;
    factType: FactType;
    scope: FactScope;
    entityIds: string[]; // All entities involved
    supportingEvidence: EvidenceSpan[];
    confidence: number;
    conflictCheckResult: {
        hasConflict: boolean;
        conflictingFactIds?: string[];
        conflictingCanonVersion?: number;
        conflictType?: ConflictTaxonomy;
    };
    tierImpact: HarvestTierImpact;
    recommendedAction: HarvestRecommendedAction;
    appearanceCount: number; // How many times this fact appeared in the run
    resolutionAction?: string; // e.g., 'SCOPE_TO_SCENE', 'MARK_UNCERTAIN'
}

export interface HarvestSummary {
    totalCandidates: number;
    clusteredCount: number; // After deduplication
    approvedIds: string[];
    rejectedIds: string[];
    autoAcceptedSceneOnly: string[]; // Run-local only
    conflicts: Array<{
        harvestId: string;
        conflictReason: string;
        conflictType?: ConflictTaxonomy;
        conflictingFactIds: string[];
    }>;
    canonVersionAfterMerge?: number;
}

export interface InterventionRollbackEvent {
    eventId: string;
    rollbackTimestamp: number;
    discardedContId: string;
    rollbackToSnapshotId: string;
    reasonCode: string;
    discardedArtifacts?: string[]; // Paths to branch artifacts
}

/**
 * Artifact schema versions - bump when fields are removed/renamed or semantics change.
 */
export const ArtifactSchemaVersions = {
    RUN_MANIFEST: 1,
    STAGE_MANIFEST: 1,
    CONTEXT_HITS: 1,
    PROMPT: 1,
    SNAPSHOT: 1,
    DECISIONS: 1,
    RUN_INDEX: 1,
    PROTECTION_INDEX: 1,
    TOMBSTONE_INDEX: 1,
    LOCK_RECOVERY_LOG: 1
} as const;

/**
 * Metadata required for all artifacts (except append-only logs).
 * Ensures reproducibility and integrity verification.
 */
export interface ArtifactMetadata {
    runId: string; // UUID (logical identity)
    runKey: string; // Folder name (e.g., "run-1735689600")
    contentHash: string; // SHA256 over UTF-8 bytes of canonical JSON
    schemaVersion: number;
    generatorVersion: string; // e.g., "1.0.3+policy-a1b2c3d4"
    timestamp: number;
}

/**
 * Required artifacts per stage (glob patterns for chunk-indexed files).
 */
export const RequiredArtifactsByStage = {
    PLAN: ['logs/plan.chunk-*.json'],
    RETRIEVE: ['context/hits.chunk-*.json'],
    WRITE: ['context/prompt.chunk-*.json', 'logs/write.chunk-*.json'],
    REPAIR: ['logs/repair.chunk-*.json'],
    UPDATE: ['snapshots/update.chunk-*.json']
} as const;

/**
 * Health code severity mapping (0 = OK, higher = worse).
 */
export function healthSeverity(code: RunHealthCode): number {
    const map: Record<RunHealthCode, number> = {
        'OK': 0, // Only 0 if no other codes present
        'LOCK_RECOVERED': 1,
        'MISSING_PROTECTION_EDGE': 1,
        'EVIDENCE_AMBIGUOUS': 2,
        'STALE_EVIDENCE_PRESENT': 2,
        'BRANCH_ORPHANED': 3,
        'MISSING_HITS': 4,
        'MISSING_PROMPT_BODY': 4,
        'SCHEMA_MISMATCH': 5,
    };
    return map[code] ?? 0;
}

export interface ArtifactManifest {
    path: string;
    hash?: string;
    sizeBytes?: number;
    exists: boolean;
    contentEncoding?: 'gzip' | 'json';
}

export interface RunIndex {
    indexSchemaVersion: number;
    runId: string;
    health: RunHealthCode;
    healthCodes?: RunHealthCode[]; // Multiple issues
    stagesCompleted: string[]; // Stage type list
    artifacts: Record<string, ArtifactManifest>; // key -> manifest
    requiredArtifactsByStage?: Record<string, string[]>; // stageType -> artifact keys
    metrics: {
        repairs: number;
        misses: number;
        interventions: number;
        harvestCandidates: number;
    };
    latestContinuationId?: string;
    computedAt: number;
}

export interface PolicySnapshot {
    policyHash: string;
    policyVersion?: string;
    thresholds: Record<string, any>; // Relevant policy values
    timestamp: number;
}

export interface SnapshotBundle {
    schemaVersion: number;
    snapshotHash: string;
    timestamp: number;
    chapterState: ChapterState;
    redirectRegistryVersion?: number;
    indexVersion?: number;
    canonVersion?: number;
    activeAnchors?: Array<{ entityId: string; factId: string }>;
    lastStableStagePointer?: string; // Stage ID of last stable point
}

export interface RunManifest {
    runId: string; // UUID (logical identity)
    runKey: string; // Folder name (e.g., "run-1735689600")
    chapterId: string;
    startTime: number;
    endTime?: number;
    ollamaVersion?: string;
    storyBibleHash: string;
    initialStateHash: string;
    stages: StageResult[];
    config: {
        smartModel: string;
        smartModelDigest?: string;
        fastModel: string;
        fastModelDigest?: string;
        maxChunkWords: number;
        temperature: number;
        policyHash: string;
        corpusHash: string;
        pluginVersion: string;
        spontaneityProfile?: {
            sliderValue: number;
            temp: number;
            novelty: number;
            stickyMin: number;
        };
    };
    environment?: {
        pluginVersion: string; // from manifest.json
        policyHash: string;
        promptTemplateHash: string;
        scoringProfileHash: string;
        modelBackend: string;
        modelId: string;
        tokenizerVersion?: string;
        vaultSnapshotHash?: string;
        indexVersion?: number;
        timestamp: number;
        snapshots?: {
            templateSnapshot?: string; // Stored template body if replayable=true
            scoringSnapshot?: string;  // Stored scoring profile if replayable=true
        };
    };
    replayable?: boolean; // If true, prompts/hits/templates/scoring MUST be stored
    continuityRisks?: Record<string, number>; // iteration -> risk score
    // v47 additions
    interventions?: InterventionEvent[];
    continuations?: RunContinuation[];
    rollbackEvents?: InterventionRollbackEvent[];
    plotMemorySnapshots?: Array<{
        version: number;
        hash: string;
        sourceChunkIds: string[];
        timestamp: number;
    }>;
    harvestSummary?: HarvestSummary;
    replayPrereqs?: ReplayPrereqs;
}

/**
 * AttributeRegistry defines "Hard Lore" keys that must be strictly verified.
 * Hallucinations in these keys during Repair will be blocked by the LoreCheck gate.
 */
export const AttributeRegistry = [
    'location',
    'alive_status',
    'identity',
    'eye_color',
    'hair_color',
    'age',
    'rank',
    'injury_status',
    'relationship_to',
    'possession_of'
];

