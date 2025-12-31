import { ChapterState, AuditResult, Violation, CanonFact } from './Schemas';

/**
 * AuditService performs a two-pass validation on generated prose chunks.
 * Pass 1: Heuristic (Non-LLM) checks for POV and Tense shifts.
 * Pass 2: LLM-based comparison against the CanonFactsList.
 */
export class AuditService {
    /**
     * Main entry point for auditing a chunk.
     */
    async auditChunk(chunk: string, state: ChapterState, llmAuditFn?: (chunk: string, state: ChapterState) => Promise<AuditResult>): Promise<AuditResult> {
        const violations: Violation[] = [];

        // --- PASS 1: Heuristic Checks (Narration-only) ---
        // We get spans of narration text to keep offsets accurate
        const narrationSpans = this.getNarrationSpans(chunk);
        
        for (const span of narrationSpans) {
            const povViolation = this.checkPOV(span.text, state.constraints.pov, span.start);
            if (povViolation) violations.push(povViolation);

            const tenseViolation = this.checkTense(span.text, state.constraints.tense, span.start);
            if (tenseViolation) violations.push(tenseViolation);
        }

        // --- PASS 2: LLM Comparison (if provided) ---
        if (llmAuditFn) {
            const llmResult = await llmAuditFn(chunk, state);
            violations.push(...llmResult.violations);
        }

        const overallSeverity = violations.length > 0 
            ? Math.max(...violations.map(v => v.severity)) 
            : 0;

        return {
            violations,
            overallSeverity,
            summary: violations.length > 0 
                ? `Found ${violations.length} violations (Max Severity: ${overallSeverity}).`
                : 'No violations detected.'
        };
    }

    /**
     * Identifies narration spans by excluding dialogue blocks.
     * Rule: Offsets are UTF-16 JavaScript string indices.
     */
    private getNarrationSpans(text: string): { text: string, start: number }[] {
        const spans: { text: string, start: number }[] = [];
        const dialogueRegex = /["“].*?["”]|['‘].*?['’]|—.*$/gm;
        
        let lastIndex = 0;
        let match;
        
        while ((match = dialogueRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                const narration = text.slice(lastIndex, match.index);
                if (narration.trim()) {
                    spans.push({ text: narration, start: lastIndex });
                }
            }
            lastIndex = dialogueRegex.lastIndex;
        }
        
        if (lastIndex < text.length) {
            const finalNarration = text.slice(lastIndex);
            if (finalNarration.trim()) {
                spans.push({ text: finalNarration, start: lastIndex });
            }
        }
        
        return spans;
    }

    /**
     * Basic heuristic for POV detection.
     */
    private checkPOV(text: string, targetPov: string, globalOffset: number): Violation | null {
        const firstPersonProngs = /\b(I|me|my|mine|we|us|our)\b/i;
        
        const match = text.match(firstPersonProngs);
        if (targetPov.includes('third') && match) {
            const start = globalOffset + (match.index || 0);
            return {
                type: 'POV_HEADHOP',
                severity: 4,
                evidence: match[0],
                range: { start, end: start + match[0].length },
                message: `Target POV is ${targetPov}, but first-person pronoun detected in narration.`
            };
        }
        return null;
    }

    /**
     * Basic heuristic for Tense detection.
     */
    private checkTense(text: string, targetTense: string, globalOffset: number): Violation | null {
        const presentIndicators = /\b(is|are|am|goes|looks|sees|thinks)\b/i;
        const pastIndicators = /\b(was|were|went|looked|saw|thought)\b/i;

        if (targetTense === 'past') {
            const match = text.match(presentIndicators);
            if (match) {
                const start = globalOffset + (match.index || 0);
                return {
                    type: 'TENSE_SHIFT',
                    severity: 3,
                    evidence: match[0],
                    range: { start, end: start + match[0].length },
                    message: `Target tense is past, but present tense verb detected.`
                };
            }
        }

        if (targetTense === 'present') {
            const match = text.match(pastIndicators);
            if (match) {
                const start = globalOffset + (match.index || 0);
                return {
                    type: 'TENSE_SHIFT',
                    severity: 3,
                    evidence: match[0],
                    range: { start, end: start + match[0].length },
                    message: `Target tense is present, but past tense verb detected.`
                };
            }
        }
        return null;
    }
}
