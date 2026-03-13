import { ChapterState, CanonFact } from './Schemas';
import { ContextPack, LockMap } from './CloudRelay';
import { estimateTokens } from './TokenEstimate';
import { sha256, normalizeWhitespace } from './ContentHash';

/**
 * ContextPacker - Deterministic priority-based packing for 128k+ context windows
 * 
 * Fixed order:
 * 1. Lock Map (40k tokens max)
 * 2. Chapter State (10k tokens max)
 * 3. Style Signature (5k tokens max)
 * 4. RAG Hits (fill remaining)
 */
export class ContextPacker {
    private readonly maxLockMapTokens: number = 40000;
    private readonly maxStateTokens: number = 10000;
    private readonly maxStyleTokens: number = 5000;
    private readonly maxTotalTokens: number = 128000;

    /**
     * Legacy wrapper for packing context.
     */
    async packContext(plugin: any, state: ChapterState): Promise<any> {
        // Mock retrieval hits for the stitch task prefix
        return {
            smart_connections: '',
            story_bible: '',
            plot_memory: state.plotMemory?.denseSummary || ''
        };
    }

    /**
     * Build deterministic context pack from chapter state and retrieval hits
     */
    async buildContextPack(
        chapterState: ChapterState,
        retrievalHits: Array<{
            id: string;
            excerpt: string;
            sourcePath: string;
            relevanceScore: number;
            intentHardness?: 'HARD' | 'SOFT';
        }>,
        styleSignature?: string[],
        directorNotes?: string
    ): Promise<ContextPack> {
        // Build lock map
        const lockMap = this.buildLockMap(chapterState);
        const lockMapText = JSON.stringify(lockMap, null, 2);
        const lockMapTokens = estimateTokens(lockMapText);

        // Build state section
        const stateText = this.buildStateSection(chapterState, directorNotes);
        const stateTokens = estimateTokens(stateText);

        // Build style signature
        const styleText = styleSignature ? styleSignature.join('\n\n---\n\n') : '';
        const styleTokens = estimateTokens(styleText);

        // Calculate remaining budget for hits
        const usedTokens = Math.min(lockMapTokens, this.maxLockMapTokens) +
                          Math.min(stateTokens, this.maxStateTokens) +
                          Math.min(styleTokens, this.maxStyleTokens);
        const remainingTokens = this.maxTotalTokens - usedTokens;

        // Sort hits deterministically: (intentHardness desc, score desc, id asc)
        const sortedHits = [...retrievalHits].sort((a, b) => {
            // HARD > SOFT > undefined
            const hardnessA = a.intentHardness === 'HARD' ? 2 : (a.intentHardness === 'SOFT' ? 1 : 0);
            const hardnessB = b.intentHardness === 'HARD' ? 2 : (b.intentHardness === 'SOFT' ? 1 : 0);
            if (hardnessA !== hardnessB) return hardnessB - hardnessA;

            // Score descending
            if (a.relevanceScore !== b.relevanceScore) {
                return b.relevanceScore - a.relevanceScore;
            }

            // ID ascending (deterministic tie-breaker)
            return a.id.localeCompare(b.id);
        });

        // Pack hits until budget exhausted
        const includedHits: typeof sortedHits = [];
        const droppedItems: Array<{ id: string; reason: string; score: number }> = [];
        let hitTokensUsed = 0;

        for (const hit of sortedHits) {
            const hitText = `[${hit.id}] ${hit.excerpt}`;
            const hitTokens = estimateTokens(hitText);

            if (hitTokensUsed + hitTokens <= remainingTokens) {
                includedHits.push(hit);
                hitTokensUsed += hitTokens;
            } else {
                droppedItems.push({
                    id: hit.id,
                    reason: 'BUDGET_EXCEEDED',
                    score: hit.relevanceScore
                });
            }
        }

        // Compute snippet hashes for included hits
        const hitsWithHashes = await Promise.all(includedHits.map(async (hit) => {
            const snippetHash = await sha256(normalizeWhitespace(hit.excerpt));
            return {
                id: hit.id,
                excerpt: hit.excerpt,
                snippetHash,
                sourcePath: hit.sourcePath,
                relevanceScore: hit.relevanceScore,
                intentHardness: hit.intentHardness
            };
        }));

        return {
            lockMap,
            chapterState: {
                plotMemory: chapterState.plotMemory?.denseSummary,
                directorNotes,
                currentLocation: chapterState.anchors?.locationId,
                currentTime: chapterState.anchors?.sceneTime,
                activeCast: chapterState.anchors?.castIds || []
            },
            styleSignature: styleSignature || undefined,
            retrievalHits: hitsWithHashes,
            tokenEstimate: {
                lockMap: Math.min(lockMapTokens, this.maxLockMapTokens),
                state: Math.min(stateTokens, this.maxStateTokens),
                style: Math.min(styleTokens, this.maxStyleTokens),
                hits: hitTokensUsed,
                total: usedTokens + hitTokensUsed
            }
        };
    }

    /**
     * Build lock map from chapter state
     */
    private buildLockMap(chapterState: ChapterState): LockMap {
        const canonicalTuples: CanonFact[] = chapterState.canonFacts.filter(f => 
            f.lifecycleState === 'CANON' || f.lifecycleState === 'ACCEPTED'
        );

        const protectedEntities = chapterState.entities.map(e => e.id);

        const protectedNumbers: Array<{ entityId: string; attribute: string; value: number }> = [];
        canonicalTuples.forEach(fact => {
            if (typeof fact.value === 'number') {
                protectedNumbers.push({
                    entityId: fact.entityId,
                    attribute: fact.attribute,
                    value: fact.value
                });
            }
        });

        const protectedRelations: Array<{ fromId: string; toId: string; relationType: string }> = [];
        canonicalTuples.forEach(fact => {
            if (fact.type === 'RELATIONSHIP' && fact.relationType) {
                // Extract relationship direction from fact
                const toId = fact.value as string; // Assuming value contains target entity ID
                if (toId) {
                    protectedRelations.push({
                        fromId: fact.entityId,
                        toId,
                        relationType: fact.relationType
                    });
                }
            }
        });

        return {
            canonicalTuples,
            protectedEntities,
            protectedNumbers,
            protectedRelations
        };
    }

    /**
     * Build state section text
     */
    private buildStateSection(chapterState: ChapterState, directorNotes?: string): string {
        const parts: string[] = [];

        if (chapterState.plotMemory?.denseSummary) {
            parts.push(`Plot Memory: ${chapterState.plotMemory.denseSummary}`);
        }

        if (directorNotes) {
            parts.push(`Director Notes: ${directorNotes}`);
        }

        if (chapterState.anchors) {
            parts.push(`Location: ${chapterState.anchors.locationId || 'Unknown'}`);
            parts.push(`Time: ${chapterState.anchors.sceneTime || 'Unknown'}`);
            parts.push(`Cast: ${chapterState.anchors.castIds?.join(', ') || 'None'}`);
        }

        return parts.join('\n');
    }

    /**
     * Save context pack artifact for audit
     */
    async saveContextPack(
        pack: ContextPack,
        runKey: string,
        vaultService: any
    ): Promise<void> {
        const packJson = {
            lockMap: pack.lockMap,
            tokenEstimate: pack.tokenEstimate,
            includedHitIds: pack.retrievalHits.map(h => h.id),
            droppedItems: [] // Would be populated if we tracked drops during packing
        };

        const packPath = `.gwriter/output/${runKey}/context/context-pack.json`;
        await vaultService.writeFile(packPath, JSON.stringify(packJson, null, 2));
    }
}

