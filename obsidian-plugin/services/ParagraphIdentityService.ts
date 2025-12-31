import { CO_AUTHORING_POLICY } from './policy';

/**
 * ParagraphIdentityService manages the stability of p_ids across recovery events.
 */
export class ParagraphIdentityService {
    /**
     * Attempts to map a new set of paragraphs to existing p_ids using fuzzy alignment.
     * Rule: Reuse p_id if similarity >= threshold.
     */
    recoverIdentities(
        newParagraphs: string[], 
        oldParagraphs: { p_id: string, text: string }[]
    ): { p_id: string, text: string, event?: 'split' | 'merge' | 'recovered' }[] {
        const threshold = CO_AUTHORING_POLICY.SEGMENTATION.FUZZY_IDENTITY_THRESHOLD;
        
        return newParagraphs.map((text, idx) => {
            let bestMatch = { id: '', score: 0 };

            for (const old of oldParagraphs) {
                const score = this.calculateSimilarity(text, old.text);
                if (score > bestMatch.score) {
                    bestMatch = { id: old.p_id, score };
                }
            }

            if (bestMatch.score >= threshold) {
                return { p_id: bestMatch.id, text, event: 'recovered' };
            }

            // Mint new p_id if no good match
            return { p_id: `p-new-${Date.now()}-${idx}`, text };
        });
    }

    /**
     * Simple Jaccard Similarity based on word sets.
     */
    private calculateSimilarity(a: string, b: string): number {
        const setA = new Set(a.toLowerCase().split(/\W+/));
        const setB = new Set(b.toLowerCase().split(/\W+/));
        
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        
        return intersection.size / union.size;
    }
}

