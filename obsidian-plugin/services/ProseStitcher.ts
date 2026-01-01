import { 
    STITCH_CONFIG, 
    PatchOp as StitchPatchOp, 
    StitchResponse, 
    sortPatchOps,
    StitchReasonCode,
    StitchSkipReason
} from '../contracts/StitchContract';
import { AttributeRegistry, ChapterState, CanonFact } from './Schemas';
import WritingDashboardPlugin from '../main';
import { fnv1a32, normalizeWhitespace } from './ContentHash';

/**
 * ProseStitcher is responsible for eliminating "seams" between chunks.
 * It uses contract-enforced PatchOps for auditable boundary smoothing.
 * 
 * INVARIANT: It can only modify surface form (cadence, tense agreement).
 * It is strictly forbidden from altering canonical claim tuples.
 */
export class ProseStitcher {
    private plugin: WritingDashboardPlugin;

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    /**
     * Normalizes a claim tuple for stable equality checking.
     */
    normalizeTuple(fact: CanonFact): string {
        const predicate = (fact.attribute || '').toLowerCase().trim();
        const value = typeof fact.value === 'string' ? fact.value.toLowerCase().trim() : fact.value;
        // Normalize quotes/dashes if they were strings
        const normValue = typeof value === 'string' ? value.replace(/[""']/g, '"').replace(/[–—]/g, '-') : value;
        
        return JSON.stringify({ 
            entityId: fact.entityId, 
            predicate, 
            value: normValue, 
            scope: fact.scope 
        });
    }

    /**
     * Extracts canonical claims from text using local LLM.
     * Implements the two-pass gate logic.
     */
    async extractTuples(text: string, state: ChapterState): Promise<string[]> {
        const prompt = `Extract all atomic narrative facts from the following text as a JSON list of tuples.
Format: { "entityId": "string", "attribute": "string", "value": "any", "scope": "SCENE|GLOBAL" }

Text:
"""
${text}
"""

Active Entities: ${state.entities.map(e => e.id).join(', ')}
Hard Attributes: ${AttributeRegistry.join(', ')}

Respond ONLY with valid JSON.`;

        try {
            const response = await this.plugin.ollamaGen.generate(prompt, { 
                model: this.plugin.settings.relaySmartModel,
                temperature: 0.1,
                max_tokens: 1024,
                format: 'json'
            });
            const parsed = JSON.parse(response);
            if (!Array.isArray(parsed)) return [];
            
            return parsed.map((f: any) => this.normalizeTuple(f as CanonFact));
        } catch (e) {
            console.error('[ProseStitcher] Failed to extract tuples', e);
            return [];
        }
    }

    /**
     * Validates that a stitch hasn't altered any canonical claims.
     * Fails on Contradiction or New Canon (GLOBAL or CORE).
     */
    async validateClaimIntegrity(
        originalText: string, 
        stitchedText: string, 
        state: ChapterState
    ): Promise<{ valid: boolean, reason?: string }> {
        const origTuples = await this.extractTuples(originalText, state);
        const newTuples = await this.extractTuples(stitchedText, state);

        for (const newT of newTuples) {
            const parsed = JSON.parse(newT);
            
            // Check for New Canon (GLOBAL or CORE)
            const isCore = AttributeRegistry.includes(parsed.predicate);
            const isGlobal = parsed.scope === 'GLOBAL';
            
            if ((isGlobal || isCore) && !origTuples.includes(newT)) {
                return { valid: false, reason: `NEW_CANON_DETECTED: ${parsed.predicate} of ${parsed.entityId}` };
            }

            // Check for Contradiction
            const contradiction = origTuples.find(oldT => {
                const pOld = JSON.parse(oldT);
                return pOld.entityId === parsed.entityId && 
                       pOld.predicate === parsed.predicate && 
                       pOld.value !== parsed.value;
            });

            if (contradiction) {
                return { valid: false, reason: `CONTRADICTION_DETECTED: ${parsed.predicate} changed` };
            }
        }

        return { valid: true };
    }

    /**
     * Detects if a token is a protected proper noun.
     */
    isTokenProtected(token: string, context: { text: string, index: number, entities: string[] }): boolean {
        // 1. Match entity registry
        if (context.entities.some(e => token.toLowerCase().includes(e.toLowerCase()))) return true;

        // 2. Capitalized sequence check
        const isCapitalized = /^[A-Z]/.test(token);
        if (!isCapitalized) return false;

        // 3. Exemption allowlist
        if (STITCH_CONFIG.NOUN_EXEMPTIONS.includes(token)) return false;

        // 4. Sentence start rule
        const textBefore = context.text.substring(0, context.index);
        const isSentenceStart = STITCH_CONFIG.SENTENCE_START_PATTERN.test(textBefore.slice(-5)) || context.index === 0;
        
        if (isSentenceStart) return false;

        return true;
    }

    /**
     * Stitches two chunks together by analyzing the boundary.
     * Uses anchored seam paragraphs and proper noun protection.
     */
    async stitch(
        prevParas: { id: string, text: string, hash: string }[], 
        nextParas: { id: string, text: string, hash: string }[],
        state: ChapterState,
        routing: { runId: string, sessionId: string, seamId: string, seqNo: number },
        stablePrefix: string,
        signal?: AbortSignal
    ): Promise<StitchResponse | null> {
        const startTime = Date.now();
        
        // 1. Compute anchored seam window
        const seamTail = this.getSeamWindow(prevParas, true);
        const seamHead = this.getSeamWindow(nextParas, false);
        const boundaryText = seamTail.map(p => p.text).join('\n\n') + '\n\n' + seamHead.map(p => p.text).join('\n\n');

        const prompt = `${stablePrefix}

-------------------------------------------------------------
TASK: PROSE STITCHER
-------------------------------------------------------------
Smooth the transition between these two text segments.
Allowed: Tense alignment, cadence fixes, reducing repetitive phrases, punctuation.
FORBIDDEN: Changing facts, adding characters, changing plot beats, modifying proper nouns.

Boundary Text:
"""
${boundaryText}
"""

Respond with a JSON object containing:
1. patchOps: list of { "paragraphId": "string", "start": number, "end": number, "replacementText": "string", "reasonCode": "CADENCE|TENSE|REPETITION|PUNCTUATION" }
2. stitchReport: { "changedChars": number, "changedPct": number, "reasonCounts": { ... } }

Max patches: ${STITCH_CONFIG.MAX_PATCH_OPS}
Max churn: ${STITCH_CONFIG.MAX_CHARS_CHANGED_PCT * 100}%`;

        let retryCount = 0;
        let response: StitchResponse | null = null;

        const attemptStitch = async (temp: number): Promise<StitchResponse | null> => {
            try {
                if (signal?.aborted) throw new Error('Aborted');
                const res = await this.plugin.ollamaGen.generate(prompt, {
                    model: this.plugin.settings.relaySmartModel,
                    temperature: temp,
                    max_tokens: 1024,
                    format: 'json'
                }, signal);
                const result = JSON.parse(res) as StitchResponse;
                
                // 2. Fast Gate: Bounds and Budget
                if (result.patchOps.length > STITCH_CONFIG.MAX_PATCH_OPS) throw new Error('BUDGET');
                let totalChanged = 0;
                for (const op of result.patchOps) {
                    if (op.start < 0 || op.end < op.start || op.replacementText.length > 1200) throw new Error('BOUNDS');
                    totalChanged += op.replacementText.length;
                }
                if (totalChanged > 800) throw new Error('BUDGET');

                // 3. Fast Gate: LockMap (Protected Nouns)
                for (const op of result.patchOps) {
                    const entities = state.entities.map(e => e.name);
                    const matches = op.replacementText.match(STITCH_CONFIG.PROPER_NOUN_PATTERN) || [];
                    for (const match of matches) {
                        if (this.isTokenProtected(match, { text: op.replacementText, index: op.replacementText.indexOf(match), entities })) {
                            const originalPara = [...prevParas, ...nextParas].find(p => p.id === op.paragraphId);
                            if (originalPara && !originalPara.text.includes(match)) {
                                throw new Error('LOCKMAP');
                            }
                        }
                    }
                }

                // 4. Slow Gate: Tuple Integrity
                const sortedOps = sortPatchOps(result.patchOps);
                const stitchedBoundary = this.applyStitch(boundaryText, sortedOps, [...seamTail, ...seamHead]);
                const integrity = await this.validateClaimIntegrity(boundaryText, stitchedBoundary, state);
                if (!integrity.valid) throw new Error('TUPLE_DIFF');

                // 5. Final validation: beforeHash
                result.patchOps.forEach(op => {
                    const para = [...prevParas, ...nextParas].find(p => p.id === op.paragraphId);
                    op.beforeHash = para?.hash || '';
                });

                return {
                    ...result,
                    ...routing,
                    patchOps: sortedOps,
                    stitchReport: {
                        ...result.stitchReport,
                        latencyMs: Date.now() - startTime
                    }
                };
            } catch (err) {
                console.warn(`[ProseStitcher] Attempt failed: ${err.message}`);
                return null;
            }
        };

        response = await attemptStitch(0.3);
        if (!response) {
            retryCount++;
            response = await attemptStitch(0.1); // Deterministic retry
        }

        if (!response) {
            console.log(`[ProseStitcher] All attempts failed for ${routing.seamId}. Skipping silently.`);
            return null;
        }

        return response;
    }

    private getSeamWindow(paras: { id: string, text: string }[], isTail: boolean): { id: string, text: string }[] {
        const window: { id: string, text: string }[] = [];
        let charCount = 0;
        const source = isTail ? [...paras].reverse() : paras;

        for (let i = 0; i < source.length; i++) {
            const p = source[i];
            window.push(p);
            charCount += p.text.length;
            if (charCount >= STITCH_CONFIG.SEAM_WINDOW_CHARS || window.length >= 6) break;
        }

        return isTail ? window.reverse() : window;
    }

    private applyStitch(text: string, ops: StitchPatchOp[], paras: { id: string, text: string }[]): string {
        const paraMap = new Map(paras.map(p => [p.id, p.text]));
        
        for (const op of ops) {
            const currentText = paraMap.get(op.paragraphId);
            if (currentText) {
                const updated = currentText.substring(0, op.start) + op.replacementText + currentText.substring(op.end);
                paraMap.set(op.paragraphId, updated);
            }
        }

        return paras.map(p => paraMap.get(p.id)).join('\n\n');
    }
}
