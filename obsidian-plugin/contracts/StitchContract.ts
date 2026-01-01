/**
 * StitchContract defines the strict interface for the ProseStitcher.
 * It ensures that stitching operations are surface-only and narrative-safe.
 */

export type StitchReasonCode = 'CADENCE' | 'TENSE' | 'REPETITION' | 'PUNCTUATION';

export type StitchSkipReason = 'HASH_MISMATCH' | 'LOCKMAP' | 'TUPLE_DIFF' | 'BUDGET' | 'BOUNDS' | 'USER_DIRTY';

export interface PatchOp {
    paragraphId: string;
    beforeHash: string; // SHA-256 of normalized text before patch
    start: number;
    end: number;
    replacementText: string;
    reasonCode: StitchReasonCode;
}

export interface StitchReport {
    changedChars: number;
    changedPct: number;
    reasonCounts: Record<StitchReasonCode, number>;
    skipReason?: StitchSkipReason;
    latencyMs?: number;
}

export interface StitchResponse {
    runId: string;
    sessionId: string;
    seamId: string;
    seqNo: number;
    patchOps: PatchOp[];
    stitchReport: StitchReport;
}

export const STITCH_CONFIG = {
    SEAM_WINDOW_CHARS: 1200,
    MAX_PATCH_OPS: 8,
    MAX_CHARS_CHANGED_PCT: 0.08,
    PROPER_NOUN_PATTERN: /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
    SENTENCE_START_PATTERN: /(?:^|[.!?])\s*/,
    NOUN_EXEMPTIONS: ['I', 'The', 'A', 'An', 'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.'],
};

/**
 * Implementation Invariant: Patch Application
 * Rule: Apply in order: (paragraphId asc, start desc, end desc).
 * Applying in reverse start/end order ensures that index offsets 
 * remain valid for subsequent patches in the same paragraph.
 */
export function sortPatchOps(ops: PatchOp[]): PatchOp[] {
    return [...ops].sort((a, b) => {
        if (a.paragraphId !== b.paragraphId) {
            return a.paragraphId.localeCompare(b.paragraphId);
        }
        if (a.start !== b.start) {
            return b.start - a.start;
        }
        return b.end - a.end;
    });
}

