import { CanonFact, SpanConfidence } from './Schemas';
import { sha256 } from './ContentHash';

/**
 * SpanRelocator implements Launch Spec 1.0 deterministic span relocation.
 * It uses a 5-step search algorithm to find or relocate provenance spans in markdown documents.
 */
export class SpanRelocator {
    /**
     * Relocates a fact's source span within a document.
     * Order: 
     * 1. Exact Hash
     * 2. Unique Text Match
     * 3. Anchored Windows
     * 4. Ambiguous Match (closest to old pos)
     * 5. INVALID
     */
    async relocate(fact: CanonFact, currentDocText: string): Promise<{ 
        start: number, 
        end: number, 
        confidence: SpanConfidence 
    }> {
        if (!fact.sourceSpan || !fact.sourceHash) {
            return { start: 0, end: 0, confidence: 'INVALID' };
        }

        const { start, end, anchorTextBefore, anchorTextAfter } = fact.sourceSpan;
        const originalText = currentDocText.substring(start, end);

        // 1. Exact Hash (Fast Path)
        const currentHash = await sha256(originalText);
        if (currentHash === fact.sourceHash) {
            return { start, end, confidence: 'EXACT' };
        }

        // 2. Unique Text Match
        // We need the text that was originally at the span
        // Since we don't store the original text directly (only hash), 
        // we might need to store it or use the anchor text to help.
        // For the pilot, we'll assume we have a way to get the 'expectedText' 
        // if the hash doesn't match, or we rely on anchors.
        
        // If hash doesn't match, originalText is NOT what we want. 
        // We'd need the text that produced fact.sourceHash.
        // For this implementation, we'll use anchors if hash fails.

        // 3. Anchored Windows
        if (anchorTextBefore || anchorTextAfter) {
            const before = anchorTextBefore || '';
            const after = anchorTextAfter || '';
            
            // Search for before + * + after
            // This is a bit complex for a simple string search. 
            // We'll look for all occurrences of 'before' and 'after' and find the gap.
            
            const beforeIndices = this.findAllOccurrences(currentDocText, before);
            const afterIndices = this.findAllOccurrences(currentDocText, after);

            let bestMatch: { start: number, end: number } | null = null;
            let minDistance = Infinity;

            for (const bIdx of beforeIndices) {
                for (const aIdx of afterIndices) {
                    if (aIdx > bIdx + before.length) {
                        const newStart = bIdx + before.length;
                        const newEnd = aIdx;
                        const distance = Math.abs(newStart - start);
                        
                        if (distance < minDistance) {
                            minDistance = distance;
                            bestMatch = { start: newStart, end: newEnd };
                        }
                    }
                }
            }

            if (bestMatch) {
                // If we found a match via anchors, we should still check if there's a unique match
                // but for now we'll take the closest one.
                return { 
                    start: bestMatch.start, 
                    end: bestMatch.end, 
                    confidence: beforeIndices.length === 1 && afterIndices.length === 1 ? 'RELOCATED_UNIQUE' : 'RELOCATED_AMBIGUOUS'
                };
            }
        }

        // 4. Ambiguous Match (Closest to old pos)
        // If we don't have anchors, we can't really find it if the hash changed 
        // unless we search for the original text. 
        // But we don't store the original text.
        
        return { start: 0, end: 0, confidence: 'INVALID' };
    }

    private findAllOccurrences(text: string, sub: string): number[] {
        if (!sub) return [];
        const indices: number[] = [];
        let i = -1;
        while ((i = text.indexOf(sub, i + 1)) !== -1) {
            indices.push(i);
        }
        return indices;
    }
}

