import { PatchOp } from './Schemas';

/**
 * ProseStitcher is responsible for eliminating "seams" between chunks.
 * It uses reason-coded PatchOps for auditable boundary smoothing.
 * 
 * INVARIANT: It can only modify surface form (cadence, tense agreement).
 * It is strictly forbidden from altering canonical claim tuples.
 */
export class ProseStitcher {
    /**
     * Normalizes a claim tuple for stable equality checking.
     * Schema: (subjectId, predicate, objectValue, qualifiers)
     */
    normalizeTuple(tuple: any): string {
        const { subjectId, predicate, objectValue, qualifiers } = tuple;
        // Normalize values (lowercase, standard date formats, etc.)
        const normValue = typeof objectValue === 'string' ? objectValue.toLowerCase().trim() : objectValue;
        return JSON.stringify({ subjectId, predicate, objectValue: normValue, qualifiers });
    }

    /**
     * Extracts canonical claims from text as normalized tuples.
     */
    extractTuples(text: string): string[] {
        // MOCK: This would be a fast LLM pass in production
        return [];
    }

    /**
     * Validates that a stitch hasn't altered any canonical claims.
     */
    validateClaimIntegrity(originalText: string, stitchedText: string): { valid: boolean, changes?: string[] } {
        const origTuples = this.extractTuples(originalText);
        const newTuples = this.extractTuples(stitchedText);

        const changes = newTuples.filter(t => !origTuples.includes(t));
        if (changes.length > 0) {
            return { valid: false, changes };
        }

        return { valid: true };
    }

    /**
     * Stitches two chunks together by analyzing the boundary.
     * Boundary is typically last 200 of prev + first 200 of next.
     */
    async stitch(prevChunkTail: string, nextChunkHead: string): Promise<PatchOp[]> {
        const patches: PatchOp[] = [];
        
        // MOCK: In a real implementation, we would use an LLM
        // to detect tense shifts or repetitive phrasing at the boundary.
        
        // Example: Tense Alignment
        patches.push({
            op: 'replace',
            range: { start: 0, end: 10 },
            newValue: 'Aligned text',
            justification: 'Smoothing boundary for tense alignment.',
            reasonCode: 'TENSE_ALIGN'
        });

        return patches;
    }

    /**
     * Applies a list of stitch patches to a boundary string.
     */
    applyStitch(boundary: string, patches: PatchOp[]): string {
        let result = boundary;
        const sorted = [...patches].sort((a, b) => b.range.start - a.range.start);
        for (const patch of sorted) {
            result = result.slice(0, patch.range.start) + patch.newValue + result.slice(patch.range.end);
        }
        return result;
    }
}
