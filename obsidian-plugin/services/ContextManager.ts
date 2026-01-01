import { 
    ChapterState, 
    CanonFact, 
    Entity, 
    ContextBundleManifest, 
    AttributeRegistry,
    MutationAcceptance,
    FactOrigin,
    FactScope,
    FactType
} from './Schemas';
import { CO_AUTHORING_POLICY } from './policy';
import { Vault, TFile } from 'obsidian';
import { ContextItem } from './retrieval/types';

/**
 * ContextManager is responsible for maintaining the "Memory" of the relay drafting.
 * It manages the atomic FactIndex, state snapshots, and idempotent seeding.
 * It is the sole authority for versioned canon evolution.
 */
export class ContextManager {
    private state: ChapterState;
    private vault: Vault;
    private lastStoryBibleHash: string = '';
    private stickyCount: Record<string, number> = {}; // Track how many chunks a context ID has been sticky
    private pinnedFactIds: Set<string> = new Set(); // User-pinned facts (need[])
    private pinnedTtl: Record<string, number> = {}; // factId -> chunksRemaining
    private pinnedExtensions: Record<string, number> = {}; // factId -> extensionCount

    constructor(vault: Vault, initialState: ChapterState) {
        this.vault = vault;
        this.state = {
            ...initialState,
            pendingMutations: initialState.pendingMutations || [],
            entity_redirects: initialState.entity_redirects || {}
        };
    }

    /**
     * Resolves an entity ID through the redirect registry.
     * Follows chains to a fixed point and implements path compression.
     */
    resolveEntityId(id: string): string {
        let current = id;
        const visited = new Set<string>();
        const chain: string[] = [];
        
        while (this.state.entity_redirects[current]) {
            if (visited.has(current)) {
                console.error(`[ContextManager] 🌀 Cycle detected in entity redirects for ID: ${id}`);
                return current; 
            }
            visited.add(current);
            chain.push(current);
            current = this.state.entity_redirects[current];
        }
        
        // Path compression: update all IDs in the chain to point directly to current
        if (chain.length > 1) {
            chain.forEach(oldId => {
                if (oldId !== current) {
                    this.state.entity_redirects[oldId] = current;
                }
            });
        }
        
        return current;
    }

    /**
     * Executable Truth Matrix: Determines if a source can override a target.
     * Hierarchy: BIBLE > CANON > STATE > GENERATED > SEEDED
     */
    canOverride(srcOrigin: FactOrigin, dstOrigin: FactOrigin, factType: FactType, scope: FactScope): boolean {
        const hierarchy: Record<FactOrigin, number> = {
            'BIBLE': 5,
            'USER': 4,
            'MUTATION': 4,
            'CANON': 4,
            'STATE': 3,
            'GENERATION': 2,
            'EXTRACTOR': 1
        };

        const sPower = hierarchy[srcOrigin] || 0;
        const dPower = hierarchy[dstOrigin] || 0;

        // 1. BIBLE is absolute for GLOBAL identity/relationship/timeline
        if (dstOrigin === 'BIBLE' && scope === 'GLOBAL' && ['IDENTITY', 'RELATIONSHIP', 'TIMELINE'].includes(factType)) {
            return srcOrigin === 'MUTATION'; // Only explicit retcon can touch bible
        }

        // 2. STATE can only override specific types (scene-local or run-scoped)
        if (srcOrigin === 'STATE') {
            return ['SCENE_DETAIL', 'THREAD_STATE'].includes(factType);
        }

        // 3. General power hierarchy
        return sPower >= dPower;
    }

    /**
     * Promotion Contract: Only specific origins can promote directly to CANON.
     * Facts from GENERATION/EXTRACTOR require approval or non-core auto-accept.
     */
    shouldAutoPromote(fact: CanonFact): boolean {
        if (['BIBLE', 'USER', 'MUTATION'].includes(fact.origin)) return true;
        
        // Non-core traits/details from extractor can be auto-accepted if confidence is high
        if (fact.origin === 'EXTRACTOR' && fact.confidence >= 0.9 && !['IDENTITY', 'RELATIONSHIP'].includes(fact.type)) {
            return true;
        }

        return false;
    }

    /**
     * Registers a merge event and updates redirects with path compression.
     */
    mergeEntities(fromId: string, toId: string) {
        if (fromId === toId) return;
        
        const resolvedTo = this.resolveEntityId(toId);
        const resolvedFrom = this.resolveEntityId(fromId);
        
        if (resolvedTo === resolvedFrom) return;

        this.state.entity_redirects[resolvedFrom] = resolvedTo;
        
        // Ensure path compression for any other entries pointing to the old chain
        Object.keys(this.state.entity_redirects).forEach(old => {
            if (this.state.entity_redirects[old] === resolvedFrom) {
                this.state.entity_redirects[old] = resolvedTo;
            }
        });

        this.state.canonVersion++;
        console.log(`[ContextManager] 🤝 Merged ${fromId} into ${resolvedTo}. v${this.state.canonVersion}`);
    }

    /**
     * Pins a fact to the context for future iterations.
     */
    pinFact(factId: string) {
        this.pinnedFactIds.add(factId);
        this.pinnedTtl[factId] = CO_AUTHORING_POLICY.SPONTANEITY.PIN_TTL_CHUNKS;
        this.pinnedExtensions[factId] = 0;
        console.log(`[ContextManager] 📌 Pinned fact ${factId}`);
    }

    /**
     * Unpins a fact.
     */
    unpinFact(factId: string) {
        this.pinnedFactIds.delete(factId);
        delete this.pinnedTtl[factId];
        delete this.pinnedExtensions[factId];
    }

    /**
     * Refreshes pinned fact TTLs.
     * Pins refresh their TTL upon citation; otherwise expire.
     */
    refreshPins(citedFactIds: string[]) {
        const policy = CO_AUTHORING_POLICY.SPONTANEITY;
        
        this.pinnedFactIds.forEach(id => {
            if (citedFactIds.includes(id)) {
                // Refresh TTL if cited
                if (this.pinnedExtensions[id] < policy.MAX_PIN_EXTENSIONS) {
                    this.pinnedTtl[id] = policy.PIN_TTL_CHUNKS;
                    this.pinnedExtensions[id]++;
                    console.log(`[ContextManager] 🔄 Refreshed TTL for pinned fact ${id} (Extension ${this.pinnedExtensions[id]})`);
                }
            } else {
                // Decay TTL
                this.pinnedTtl[id]--;
                if (this.pinnedTtl[id] <= 0) {
                    this.unpinFact(id);
                    console.log(`[ContextManager] ⏰ Pin expired for fact ${id}`);
                }
            }
        });
    }

    /**
     * Gets the list of currently pinned fact IDs.
     */
    getPinnedFactIds(): string[] {
        return Array.from(this.pinnedFactIds);
    }

    /**
     * Calculates the fallback sticky set if citations are zero.
     * Order: Pinned Facts (need[]) > Top-2 Continuity Anchors > Last Chunk Tail.
     */
    getStickyFallbackSet(lastChunkId?: string): string[] {
        const fallbackSet: string[] = [];
        
        // 1. Pinned Facts (need[])
        this.pinnedFactIds.forEach(id => fallbackSet.push(id));

        // 2. Top-2 Continuity Anchors (most used/relevant)
        const topAnchors = Object.entries(this.stickyCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2)
            .map(e => e[0]);
        topAnchors.forEach(id => {
            if (!fallbackSet.includes(id)) fallbackSet.push(id);
        });

        // 3. Last Chunk Tail
        if (lastChunkId && !fallbackSet.includes(lastChunkId)) {
            fallbackSet.push(lastChunkId);
        }

        return fallbackSet;
    }

    /**
     * Gets the current ChapterState.
     */
    getState(): ChapterState {
        return this.state;
    }

    /**
     * Proposes a mutation to a Hard Attribute.
     * Must be accepted via the MutationAcceptance pipeline.
     */
    proposeMutation(newFact: CanonFact, chunkId: string): MutationAcceptance {
        return {
            id: `mut-${Date.now()}`,
            timestamp: Date.now(),
            proposedFactIds: [newFact.id],
            acceptedBy: 'user',
            chunkId,
            baselineCanonVersion: this.state.canonVersion // Snapshot baseline
        };
    }

    /**
     * Defers a proposed mutation for later consideration.
     */
    deferMutation(acceptance: MutationAcceptance) {
        this.state.pendingMutations.push(acceptance);
        console.log(`[ContextManager] ⏳ Mutation ${acceptance.id} deferred.`);
    }

    /**
     * Accepts a proposed mutation, signing the record and bumping canonVersion.
     * Rule: Compare proposal against canon at its baseline version.
     */
    acceptMutation(acceptance: MutationAcceptance, newFacts: CanonFact[]) {
        // Snapshot Promotion Check: if canon has moved since proposal, we might have a conflict
        if (acceptance.baselineCanonVersion && acceptance.baselineCanonVersion < this.state.canonVersion) {
            console.warn(`[ContextManager] ⚠️ Accepting mutation ${acceptance.id} from older baseline (v${acceptance.baselineCanonVersion} vs v${this.state.canonVersion})`);
            // In a real implementation, we'd run a merge conflict check here
        }

        newFacts.forEach(f => {
            this.updateFactVersioned(f);
        });

        this.state.mutationHistory.push(acceptance);
        // Remove from pending if it was deferred
        this.state.pendingMutations = this.state.pendingMutations.filter(m => m.id !== acceptance.id);
        
        this.state.canonVersion++;
        console.log(`[ContextManager] ✅ Canon version bumped to ${this.state.canonVersion}`);
    }

    private updateFactVersioned(newFact: CanonFact) {
        const index = this.state.canonFacts.findIndex(f => f.id === newFact.id);
        if (index !== -1) {
            this.state.canonFacts[index] = newFact;
        } else {
            this.state.canonFacts.push(newFact);
        }
    }

    /**
     * Detects if a new entity collides with existing canon keys or aliases.
     * Also checks for relationship and scope conflicts.
     */
    private detectCollisions(newEntity: Entity): boolean {
        // Check ID collision
        if (this.state.entities.some(e => e.id === newEntity.id)) return true;
        
        // Check name collision (case-insensitive)
        const newName = newEntity.name.toLowerCase();
        if (this.state.entities.some(e => e.name.toLowerCase() === newName)) return true;
        
        // Check alias collision if attributes.aliases exists
        const newAliases = (newEntity.attributes.aliases || []) as string[];
        for (const alias of newAliases) {
            const lowerAlias = alias.toLowerCase();
            if (this.state.entities.some(e => 
                e.name.toLowerCase() === lowerAlias || 
                ((e.attributes.aliases || []) as string[]).some(a => a.toLowerCase() === lowerAlias)
            )) return true;
        }

        return false;
    }

    /**
     * Checks for collisions between facts, considering type, scope, and relationships.
     */
    private detectFactCollisions(newFact: CanonFact): boolean {
        const collisions = this.state.canonFacts.filter(f => {
            // Only collide if entity and attribute match
            if (f.entityId !== newFact.entityId || f.attribute !== newFact.attribute) return false;

            // Scope check: only collide within compatible scopes
            if (f.scope === 'GLOBAL' || newFact.scope === 'GLOBAL' || f.scope === newFact.scope) {
                // If value differs, it's a potential collision
                if (JSON.stringify(f.value) !== JSON.stringify(newFact.value)) {
                    // Check if one can override the other
                    if (this.canOverride(newFact.origin, f.origin, newFact.type, newFact.scope)) {
                        return false; // Override handled elsewhere, not a blocking collision
                    }
                    return true; 
                }
            }
            return false;
        });

        // Relationship-specific collision (cardinality)
        if (newFact.type === 'RELATIONSHIP' && newFact.cardinality === 'one-to-one') {
            const cardConflict = this.state.canonFacts.some(f => 
                f.type === 'RELATIONSHIP' && 
                f.entityId === newFact.entityId && 
                f.relationType === newFact.relationType &&
                JSON.stringify(f.value) !== JSON.stringify(newFact.value)
            );
            if (cardConflict) return true;
        }

        return collisions.length > 0;
    }

    /**
     * Seeds the initial state from the story bible file.
     * confidence >= 0.85 auto-accept AND no collisions; otherwise Quarantine.
     */
    async seedFromStoryBible(path: string): Promise<{ updated: boolean, hash: string, seedProposals?: any[] }> {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return { updated: false, hash: '' };

        const content = await this.vault.read(file);
        const hash = await sha256(content);

        if (hash === this.lastStoryBibleHash) {
            return { updated: false, hash };
        }

        console.log(`[ContextManager] 📚 Seeding canon from story bible (Hash: ${hash})`);
        
        // MOCK: LLM-extracted proposals
        const proposals = [
            { 
                id: 'char_alice', 
                entity: { id: 'char_alice', name: 'Alice', type: 'character', attributes: { role: 'protagonist' } },
                confidence: 0.95 
            },
            { 
                id: 'char_bob', 
                entity: { id: 'char_bob', name: 'Bob', type: 'character', attributes: { role: 'mentor' } },
                confidence: 0.82 
            }
        ];

        const seedProposals: any[] = [];

        proposals.forEach(prop => {
            const hasCollision = this.detectCollisions(prop.entity as any);
            if (prop.confidence >= 0.85 && !hasCollision) {
                this.state.entities.push(prop.entity as any);
                console.log(`[ContextManager] ✅ Auto-accepted seeding: ${prop.entity.name}`);
            } else {
                seedProposals.push(prop);
                console.log(`[ContextManager] ⚠️ Seeding proposal quarantined: ${prop.entity.name} (Conf: ${prop.confidence}, Collision: ${hasCollision})`);
            }
        });

        this.lastStoryBibleHash = hash;
        
        return { updated: true, hash, seedProposals };
    }

    /**
     * Renders a compact, human-readable "State Card" for prompt injection.
     */
    renderStateCard(): string {
        const lines: string[] = [];
        lines.push('--- CHAPTER STATE CARD ---');
        
        lines.push(`\n[CONSTRAINTS]`);
        lines.push(`POV: ${this.state.constraints.pov}`);
        lines.push(`Tense: ${this.state.constraints.tense}`);
        lines.push(`Tone: ${this.state.constraints.tone.join(', ')}`);
        
        lines.push(`\n[ENTITIES]`);
        this.state.entities.forEach(e => {
            const attrs = Object.entries(e.attributes)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            lines.push(`- ${e.name} (${e.type}): ${attrs}`);
        });

        lines.push(`\n[ACTIVE CANON]`);
        this.state.canonFacts.slice(-10).forEach(f => {
            lines.push(`- ${f.attribute} of ${f.entityId} is ${f.value} [ID: ${f.id}]`);
        });

        if (this.pinnedFactIds.size > 0) {
            lines.push(`\n[PINNED FACTS]`);
            this.pinnedFactIds.forEach(id => {
                const fact = this.state.canonFacts.find(f => f.id === id);
                if (fact) {
                    lines.push(`- ${fact.attribute} of ${fact.entityId} is ${fact.value} [ID: ${id}] (TTL: ${this.pinnedTtl[id]})`);
                }
            });
        }

        lines.push(`\n[RECENT TIMELINE]`);
        this.state.timeline.slice(-3).forEach(t => {
            lines.push(`- Chunk ${t.chunkId}: ${t.summary}`);
        });

        lines.push('\n--------------------------');
        return lines.join('\n');
    }

    /**
     * Generates a manifest of exactly what context is being used for a prompt.
     * Includes content hashes for strict replay fidelity.
     */
    generateManifest(
        chunks: ContextItem[], 
        factIds: string[], 
        prompt: string,
        candidatePools?: { lexical: number, semantic: number }
    ): ContextBundleManifest {
        const chunkHashes: Record<string, string> = {};
        const staleFlags: Record<string, boolean> = {};
        const penaltiesApplied: Record<string, boolean> = {};

        chunks.forEach(c => {
            chunkHashes[c.key] = (c as any).textHash || 'unknown'; // In a real implementation, it would be the hash
            staleFlags[c.key] = !!c.isStale;
            penaltiesApplied[c.key] = !!c.stalePenaltyApplied;
        });

        return {
            chunkIds: chunks.map(c => c.key),
            chunkHashes,
            factIds,
            staleFlags,
            penaltiesApplied,
            tokenEstimate: Math.ceil(prompt.length / 4),
            promptHash: 'pending', // Will be hashed via sha256
            timestamp: Date.now(),
            candidatePools
        };
    }

    /**
     * Performs a stable, deterministic rotation of context chunks.
     * Sorts by score DESC, then ID ASC to ensure identical results across replays.
     * Implements Sticky Decay: drops anchors that exceed MAX_STICKY_LIFETIME.
     */
    stableRotateContext(results: {id: string, score: number, content: string}[], limit: number) {
        const policy = CO_AUTHORING_POLICY.RETRIEVAL;
        
        // Filter out items that have exceeded their sticky lifetime
        const candidates = results.filter(r => (this.stickyCount[r.id] || 0) < policy.MAX_STICKY_LIFETIME);

        const rotated = candidates
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.id.localeCompare(b.id);
            })
            .slice(0, limit);

        // Update sticky counts
        rotated.forEach(r => {
            this.stickyCount[r.id] = (this.stickyCount[r.id] || 0) + 1;
        });

        // Decay counts for items NOT in the current rotation
        const currentIds = new Set(rotated.map(r => r.id));
        Object.keys(this.stickyCount).forEach(id => {
            if (!currentIds.has(id)) {
                this.stickyCount[id] = Math.max(0, this.stickyCount[id] - 1);
            }
        });

        return rotated;
    }

    /**
     * Applies deterministic scoring boosts for alias preference.
     * Rule: +0.1 for resolved entities, -0.1 for ambiguous ones.
     */
    /**
     * Appends new facts and timeline events to the state.
     */
    updateState(newFacts: CanonFact[], timelineEvent?: { chunkId: string, summary: string }) {
        newFacts.forEach(newFact => {
            const index = this.state.canonFacts.findIndex(f => f.id === newFact.id);
            if (index !== -1) {
                this.state.canonFacts[index] = newFact;
            } else {
                this.state.canonFacts.push(newFact);
            }
        });

        if (timelineEvent) {
            this.state.timeline.push(timelineEvent);
            this.state.lastChunkId = timelineEvent.chunkId;
        }
    }

    /**
     * Validates if an attribute update is allowed by the LoreCheck gate.
     */
    isLoreUpdateAllowed(attribute: string): boolean {
        return !AttributeRegistry.includes(attribute);
    }

    async saveSnapshot(path: string) {
        const existingFile = this.vault.getAbstractFileByPath(path);
        if (existingFile instanceof TFile) {
            await this.vault.modify(existingFile, JSON.stringify(this.state, null, 2));
        } else {
            // Ensure folder exists
            const folderPath = path.substring(0, path.lastIndexOf('/'));
            const folder = this.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.vault.createFolder(folderPath);
            }
            await this.vault.create(path, JSON.stringify(this.state, null, 2));
        }
    }
}
