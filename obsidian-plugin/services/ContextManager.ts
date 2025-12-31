import { 
    ChapterState, 
    CanonFact, 
    Entity, 
    ContextBundleManifest, 
    AttributeRegistry,
    MutationAcceptance
} from './Schemas';
import { CO_AUTHORING_POLICY } from './policy';
import { Vault, TFile } from 'obsidian';

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

    constructor(vault: Vault, initialState: ChapterState) {
        this.vault = vault;
        this.state = {
            ...initialState,
            pendingMutations: initialState.pendingMutations || []
        };
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
     * Seeds the initial state from the story bible file.
     * Idempotent: only updates if the story bible has changed.
     */
    async seedFromStoryBible(path: string): Promise<{ updated: boolean, hash: string }> {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return { updated: false, hash: '' };

        const content = await this.vault.read(file);
        const hash = this.hashString(content);

        if (hash === this.lastStoryBibleHash) {
            return { updated: false, hash };
        }

        console.log(`[ContextManager] 📚 Seeding canon from story bible (Hash: ${hash})`);
        
        // MOCK: In a real implementation, we would use an LLM/Parser 
        // to extract entities and facts from the markdown content.
        // For now, we'll just track the hash.
        this.lastStoryBibleHash = hash;
        
        return { updated: true, hash };
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
    generateManifest(chunks: {id: string, content: string}[], factIds: string[], prompt: string): ContextBundleManifest {
        const chunkHashes: Record<string, string> = {};
        chunks.forEach(c => {
            chunkHashes[c.id] = this.hashString(c.content);
        });

        return {
            chunkIds: chunks.map(c => c.id),
            chunkHashes,
            factIds,
            tokenEstimate: Math.ceil(prompt.length / 4),
            promptHash: this.hashString(prompt),
            timestamp: Date.now()
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

    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString(16);
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
