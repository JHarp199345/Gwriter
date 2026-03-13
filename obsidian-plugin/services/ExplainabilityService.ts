import { ParagraphMetadata, CanonFact } from './Schemas';
import { CO_AUTHORING_POLICY } from './policy';
import { GroundingScorer, GroundingResult } from './GroundingScorer';

/**
 * ExplainabilityService manages Paragraph-to-Fact mapping and grounding telemetry.
 */
export class ExplainabilityService {
    private scorer: GroundingScorer;

    constructor() {
        this.scorer = new GroundingScorer();
    }

    /**
     * classifySpeculative determines if a paragraph is creative/speculative
     * based on the absence of grounding anchors.
     * Rule: Speculative if 0 fact references AND 0 plan goals.
     */
    classifySpeculative(metadata: ParagraphMetadata): boolean {
        return metadata.factIds.length === 0 && metadata.goalIds.length === 0;
    }

    /**
     * Map a paragraph ID to its influencing lore and source chunks.
     * p_id is immutable across character-shift repairs.
     */
    getGroundingForParagraph(
        p_id: string, 
        allMetadata: ParagraphMetadata[], 
        allFacts: CanonFact[],
        retrievedFactIds: string[] = []
    ): { facts: CanonFact[], result: GroundingResult } {
        const meta = allMetadata.find(m => m.p_id === p_id);
        if (!meta) {
            return { 
                facts: [], 
                result: { score: 0, isSpeculative: true, penalties: [] } 
            };
        }
        
        const result = this.scorer.calculateScore(meta, [], retrievedFactIds);

        return {
            facts: allFacts.filter(f => meta.factIds.includes(f.id)),
            result
        };
    }

    /**
     * calculateGroundingDensity returns a 0-1 score of how grounded a chunk is.
     */
    calculateGroundingDensity(metadata: ParagraphMetadata[]): number {
        if (metadata.length === 0) return 0;
        const groundedParagraphs = metadata.filter(m => !this.classifySpeculative(m)).length;
        return groundedParagraphs / metadata.length;
    }

    /**
     * Detects "Drift Risk" based on fact dormancy.
     */
    detectDriftRisk(_allFacts: CanonFact[], _currentChunkIndex: number): string[] {
        const threshold = CO_AUTHORING_POLICY.GROUNDING.DORMANCY_THRESHOLD;
        const riskyFactIds: string[] = [];
        // Implementation would check f.chunkId vs currentChunkIndex
        return riskyFactIds;
    }
}

