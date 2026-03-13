import { 
    HarvestItem, 
    CanonFact, 
    FactType, 
    FactScope,
    HarvestTierImpact,
    HarvestRecommendedAction,
    AttributeRegistry,
    EvidenceSpan,
    EvidenceRelocationTier,
    ConflictTaxonomy
} from './Schemas';
import { CO_AUTHORING_POLICY } from './policy';
import { ChapterState } from './Schemas';
import WritingDashboardPlugin from '../main';
import { sha256, normalizeForExcerptHash, normalizeWhitespace } from './ContentHash';
import { ParagraphIdentityService } from './ParagraphIdentityService';
import { TFile } from 'obsidian';

/**
 * LoreHarvestService extracts "stable hallucinations" from generated prose
 * and prepares them for user review and Story Bible merge.
 */
export class LoreHarvestService {
    private readonly plugin: WritingDashboardPlugin;

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    /**
     * Extracts harvest candidates from a run's generated prose.
     * Performs clustering, conflict checks, and stability scoring.
     */
    async extractCandidates(
        proseChunks: Array<{ chunkId: string; text: string; metadata?: any }>,
        chapterState: ChapterState,
        runId: string
    ): Promise<HarvestItem[]> {
        const policy = CO_AUTHORING_POLICY.HARVEST;
        const candidatesMap: Map<string, HarvestItem> = new Map();

        // Step 1: Extract raw candidates from each chunk via AI
        const existingEntityIds = chapterState.entities.map(e => e.id);
        
        for (const chunk of proseChunks) {
            const prompt = this.plugin.promptEngine.buildLoreHarvestPrompt({
                chunkText: chunk.text,
                existingEntities: existingEntityIds
            });

            try {
                const result = await this.plugin.ollamaGen.enqueue(3, `${runId}__harvest__${chunk.chunkId}`, (signal) => 
                    this.plugin.ollamaGen.generate(prompt, { 
                        model: this.plugin.settings.relaySmartModel,
                        temperature: 0.1,
                        max_tokens: 1024,
                        format: 'json'
                    }, signal)
                );

                if (result && typeof result === 'string') {
                    const parsed = JSON.parse(result);
                    if (parsed && parsed.candidates) {
                        for (const c of parsed.candidates) {
                        const harvestId = `harvest-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
                        const proposedFact: CanonFact = {
                            id: `fact-harvest-${Date.now()}`,
                            entityId: c.entityId,
                            type: c.type.toUpperCase() as FactType,
                            attribute: c.attribute,
                            value: c.value,
                            scope: c.scope.toUpperCase() as FactScope,
                            origin: 'EXTRACTOR',
                            timestamp: Date.now(),
                            confidence: c.confidence,
                            lifecycleState: 'PROPOSED'
                        };

                        // Create triple-anchored evidence span with content-hash paragraph IDs
                        const excerptIndex = chunk.text.indexOf(c.excerpt);
                        const startPos = excerptIndex >= 0 ? excerptIndex : 0;
                        const endPos = excerptIndex >= 0 ? excerptIndex + c.excerpt.length : c.excerpt.length;
                        
                        // Trim anchors to max 500 chars at word boundary
                        const trimToBoundary = (text: string, maxLen: number): string => {
                            if (text.length <= maxLen) return text;
                            let trimmed = text.slice(-maxLen);
                            // Expand backward to nearest whitespace/punctuation
                            const match = trimmed.match(/^[\s\.,;:!?]*/);
                            if (match) {
                                const prefix = match[0];
                                trimmed = text.slice(-maxLen + prefix.length);
                            }
                            return trimmed;
                        };
                        
                        const textBefore = trimToBoundary(chunk.text.substring(Math.max(0, startPos - 500), startPos), 500);
                        const textAfter = trimToBoundary(chunk.text.substring(endPos, Math.min(chunk.text.length, endPos + 500)), 500);
                        
                        // Compute hashes
                        const excerptHashRaw = await sha256(c.excerpt);
                        const excerptHashNormalized = await sha256(normalizeForExcerptHash(c.excerpt));
                        
                        // Generate paragraph ID using content-hash strategy
                        // paragraphId = sha256(headingPath + normalizeParagraphText(paragraph))
                        const headingPath = ''; // TODO: Extract from chunk metadata if available
                        const paragraphText = c.excerpt;
                        const normalizedParagraph = normalizeWhitespace(paragraphText);
                        const paragraphId = await sha256(headingPath + normalizedParagraph);
                        
                        // Get source file path (map from chunk metadata or manifest)
                        const sourceFilePath = chunk.metadata?.sourceFilePath || chunk.chunkId;
                        
                        // Compute source file hash at run time (if file available)
                        let sourceFileHashAtRun = '';
                        try {
                            const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourceFilePath);
                            if (sourceFile instanceof TFile) {
                                const fileContent = await this.plugin.app.vault.read(sourceFile);
                                sourceFileHashAtRun = await sha256(fileContent);
                            }
                        } catch (err) {
                            // File not available, leave empty for now
                        }
                        
                        const evidenceSpan: EvidenceSpan = {
                            // Required fields
                            sourceFilePath,
                            excerptHashRaw,
                            excerptHashNormalized,
                            textAnchor: {
                                before: textBefore,
                                after: textAfter
                            },
                            charRange: { start: startPos, end: endPos }, // UTF-16 code units
                            sourceFileHashAtRun,
                            relocationTier: 'EXACT' as EvidenceRelocationTier, // Initial extraction is always EXACT
                            
                            // Optional / Best Effort
                            paragraphId,
                            headingPath: headingPath || undefined,
                            originalExcerptText: c.excerpt
                        };

                        const item: HarvestItem = {
                            harvestId,
                            proposedFact,
                            factType: proposedFact.type,
                            scope: proposedFact.scope,
                            entityIds: [proposedFact.entityId],
                            supportingEvidence: [evidenceSpan],
                            confidence: c.confidence,
                            conflictCheckResult: { hasConflict: false },
                            tierImpact: 'SUPPORTING',
                            recommendedAction: 'REVIEW',
                            appearanceCount: 1
                        };

                        const clusterKey = this.getClusterKey(item);
                        const existing = candidatesMap.get(clusterKey);
                        if (existing) {
                            existing.supportingEvidence.push(...item.supportingEvidence);
                            existing.appearanceCount++;
                            existing.confidence = Math.max(existing.confidence, item.confidence);
                        } else {
                            candidatesMap.set(clusterKey, item);
                        }
                    }
                }
            }
        } catch (err) {
                console.error(`[LoreHarvestService] AI extraction failed for chunk ${chunk.chunkId}:`, err);
            }
        }

        // Step 2: Final Clustering & Conflict/Tier Assignment
        const clustered = Array.from(candidatesMap.values());

        const enriched = clustered.map(candidate => {
            const conflictCheck = this.checkConflicts(candidate, chapterState);
            const tierImpact = this.determineTierImpact(candidate.proposedFact);
            const recommendedAction = this.determineRecommendedAction(tierImpact, conflictCheck.hasConflict);

            return {
                ...candidate,
                conflictCheckResult: conflictCheck,
                tierImpact,
                recommendedAction
            };
        });

        // Step 3: Filter by stability criteria
        const stable = enriched.filter(candidate => {
            if (candidate.appearanceCount >= policy.STABILITY_MIN_APPEARANCES) {
                return true;
            }
            if (candidate.confidence >= policy.STABILITY_CITATION_CONFIDENCE) {
                return true;
            }
            return false;
        });

        return stable;
    }

    /**
     * Clusters candidates by normalized fact tuples to deduplicate.
     */
    private clusterCandidates(candidates: HarvestItem[]): HarvestItem[] {
        const clusters = new Map<string, HarvestItem>();

        for (const candidate of candidates) {
            const key = this.getClusterKey(candidate);
            const existing = clusters.get(key);

            if (existing) {
                // Merge: combine evidence, increment count
                existing.supportingEvidence.push(...candidate.supportingEvidence);
                existing.appearanceCount += candidate.appearanceCount;
                existing.confidence = Math.max(existing.confidence, candidate.confidence);
            } else {
                clusters.set(key, { ...candidate });
            }
        }

        return Array.from(clusters.values());
    }

    /**
     * Generates a cluster key from a candidate's fact tuple.
     */
    private getClusterKey(candidate: HarvestItem): string {
        const fact = candidate.proposedFact;
        const valueKey = typeof fact.value === 'string' ? fact.value : JSON.stringify(fact.value);
        return `${fact.entityId}|${fact.attribute}|${valueKey}|${fact.scope}`;
    }

    /**
     * Checks for conflicts with existing canon.
     */
    private checkConflicts(candidate: HarvestItem, chapterState: ChapterState): {
        hasConflict: boolean;
        conflictingFactIds?: string[];
        conflictingCanonVersion?: number;
        conflictType?: ConflictTaxonomy;
    } {
        const fact = candidate.proposedFact;
        const conflicts: string[] = [];
        let conflictType: ConflictTaxonomy | undefined;

        // Check against existing canon facts
        for (const existingFact of chapterState.canonFacts) {
            if (existingFact.entityId === fact.entityId && existingFact.attribute === fact.attribute) {
                if (JSON.stringify(existingFact.value) !== JSON.stringify(fact.value)) {
                    conflicts.push(existingFact.id);
                    
                    // Determine conflict type
                    if (fact.type === 'IDENTITY') conflictType = 'CONFLICT_IDENTITY';
                    else if (fact.type === 'RELATIONSHIP') conflictType = 'CONFLICT_RELATIONSHIP';
                    else if (fact.type === 'TIMELINE') conflictType = 'CONFLICT_TIMELINE';
                    else if (fact.scope !== existingFact.scope) conflictType = 'CONFLICT_SCOPE';
                    else conflictType = 'CONFLICT_CARDINALITY';
                }
            }
        }

        return {
            hasConflict: conflicts.length > 0,
            conflictingFactIds: conflicts.length > 0 ? conflicts : undefined,
            conflictingCanonVersion: conflicts.length > 0 ? chapterState.canonVersion : undefined,
            conflictType
        };
    }

    /**
     * Determines the tier impact of a harvested fact.
     */
    private determineTierImpact(fact: CanonFact): HarvestTierImpact {
        // CORE: Identity, Relationship, Timeline, or Hard Attributes
        if (['IDENTITY', 'RELATIONSHIP', 'TIMELINE'].includes(fact.type)) {
            return 'CORE';
        }
        if (AttributeRegistry.includes(fact.attribute)) {
            return 'CORE';
        }
        // SCENE_ONLY: Scene-specific details
        if (fact.scope === 'SCENE') {
            return 'SCENE_ONLY';
        }
        // SUPPORTING: Everything else
        return 'SUPPORTING';
    }

    /**
     * Determines the recommended action based on tier and conflicts.
     */
    private determineRecommendedAction(
        tierImpact: HarvestTierImpact,
        hasConflict: boolean
    ): HarvestRecommendedAction {
        const policy = CO_AUTHORING_POLICY.HARVEST.TIER_RULES;

        if (hasConflict) {
            return 'REVIEW'; // Conflicts always require review
        }

        if (tierImpact === 'CORE') {
            return policy.CORE_REQUIRES_REVIEW ? 'REVIEW' : 'QUARANTINE';
        }

        if (tierImpact === 'SCENE_ONLY' && policy.SCENE_ONLY_AUTO_ACCEPT) {
            return 'AUTO_ACCEPT_SCENE_ONLY';
        }

        return 'REVIEW'; // Default to review for safety
    }

    /**
     * Merges model-provided tuples with locally extracted candidates.
     * Rewards agreement between cloud model and local extractor by boosting confidence.
     */
    async mergeModelTuples(
        localCandidates: HarvestItem[],
        modelTuples: CanonFact[]
    ): Promise<void> {
        // Create a map of local candidates by cluster key for fast lookup
        const localMap = new Map<string, HarvestItem>();
        localCandidates.forEach(item => {
            const key = this.getClusterKey(item);
            localMap.set(key, item);
        });

        // For each model tuple, check if it matches a local candidate
        for (const modelTuple of modelTuples) {
            // Build cluster key from model tuple
            const valueKey = typeof modelTuple.value === 'string' 
                ? modelTuple.value 
                : JSON.stringify(modelTuple.value);
            const key = `${modelTuple.entityId}|${modelTuple.attribute}|${valueKey}|${modelTuple.scope}`;

            const localCandidate = localMap.get(key);
            if (localCandidate) {
                // Match found: boost confidence to "Tier A" (max confidence)
                localCandidate.confidence = 1.0;
                localCandidate.appearanceCount += 1; // Reward agreement
                console.debug(`[LoreHarvestService] ✅ Model-local agreement: ${modelTuple.entityId}.${modelTuple.attribute}`);
            }
        }
    }
}

