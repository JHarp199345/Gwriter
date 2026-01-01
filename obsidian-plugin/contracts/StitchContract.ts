/**
 * StitchContract defines the strict interface for the ProseStitcher.
 * It ensures that stitching operations are surface-only and narrative-safe.
 */

export type StitchReasonCode = 'CADENCE' | 'TENSE' | 'REPETITION' | 'PUNCTUATION';

export interface PatchOp {
    paragraphId: string;
    start: number;
    end: number;
    replacementText: string;
    reasonCode: StitchReasonCode;
}

export interface StitchReport {
    changedChars: number;
    changedPct: number;
    reasonCounts: Record<StitchReasonCode, number>;
}

export interface StitchResponse {
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
 * Rule: Apply in order: (paragraphId asc, start desc).
 */
export function sortPatchOps(ops: PatchOp[]): PatchOp[] {
    return [...ops].sort((a, b) => {
        if (a.paragraphId !== b.paragraphId) {
            return a.paragraphId.localeCompare(b.paragraphId);
        }
        return b.start - a.start;
    });
}

