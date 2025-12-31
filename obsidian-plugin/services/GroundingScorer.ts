import { CO_AUTHORING_POLICY } from './policy';
import { ParagraphMetadata, CanonFact } from './Schemas';

export interface GroundingPenalty {
    type: string;
    magnitude: number;
    reason: string;
}

export interface GroundingResult {
    score: number;
    isSpeculative: boolean;
    penalties: GroundingPenalty[];
}

/**
 * GroundingScorer calculates the grounded_score for a paragraph and emits explainable penalties.
 */
export class GroundingScorer {
    calculateScore(
        metadata: ParagraphMetadata, 
        currentEntities: string[], 
        retrievedFactIds: string[]
    ): GroundingResult {
        const policy = CO_AUTHORING_POLICY.PENALTIES;
        let score = 1.0;
        const penalties: GroundingPenalty[] = [];

        // 1. Entity Mismatch Penalty
        // (Simplified: check if cited facts belong to an entity not in the current entities)
        // In a real implementation, we'd check the prose for entity mentions.
        if (metadata.factIds.length > 0 && currentEntities.length === 0) {
            score += policy.ENTITY_MISMATCH;
            penalties.push({
                type: 'ENTITY_MISMATCH',
                magnitude: policy.ENTITY_MISMATCH,
                reason: 'Cited facts reference entities not present in paragraph'
            });
        }

        // 2. Bundle Absence Penalty
        for (const factId of metadata.factIds) {
            if (!retrievedFactIds.includes(factId)) {
                score += policy.BUNDLE_ABSENCE;
                penalties.push({
                    type: 'BUNDLE_ABSENCE',
                    magnitude: policy.BUNDLE_ABSENCE,
                    reason: `Fact ${factId} was not in the retrieval bundle`
                });
                break; // One penalty per paragraph for this
            }
        }

        // 3. Citation Spam Penalty
        if (metadata.factIds.length > 5) {
            score += policy.CITATION_SPAM;
            penalties.push({
                type: 'CITATION_SPAM',
                magnitude: policy.CITATION_SPAM,
                reason: 'Excessive citations (>5) detected in single paragraph'
            });
        }

        return {
            score: Math.max(0, score),
            isSpeculative: metadata.isSpeculative || metadata.factIds.length === 0,
            penalties
        };
    }
}

