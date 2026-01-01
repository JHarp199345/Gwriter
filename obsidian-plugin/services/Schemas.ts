/**
 * Frozen schemas for the Engineering-Complete Relay Generation System.
 * These interfaces ensure deterministic validation and contract-based interaction
 * between the Planner, Writer, Auditor, and SequentialGenerator.
 */

export type FactLifecycleState = 'PROPOSED' | 'QUARANTINED' | 'ACCEPTED' | 'CANON';
export type FactScope = 'SCENE' | 'CHAPTER' | 'GLOBAL';
export type FactOrigin = 'BIBLE' | 'USER' | 'EXTRACTOR' | 'GENERATION' | 'MUTATION';
export type FactType = 'IDENTITY' | 'RELATIONSHIP' | 'TIMELINE' | 'TRAIT' | 'SCENE_DETAIL' | 'TONE_RULE' | 'THREAD_STATE';
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
    openLoops: string[];
    constraints: {
        pov: string;
        tense: string;
        tone: string[];
        forbidden: string[];
    };
    indexVersion?: string; // New: Version of retrieval index for strict replay
    lastChunkId?: string;
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
    stageType: 'PLAN' | 'RETRIEVE' | 'WRITE' | 'AUDIT' | 'REPAIR' | 'UPDATE';
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

export interface RunManifest {
    runId: string;
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
    continuityRisks?: Record<string, number>; // iteration -> risk score
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

