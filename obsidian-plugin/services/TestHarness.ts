import { ChapterState, AuditResult, CanonFact, PatchOp } from './Schemas';

/**
 * TestHarness provides a corpus of "Intentional Violations" to verify that
 * the Heuristic Engine, LLM Auditor, and LoreCheck Gate are functioning correctly.
 */
export const IntentionalViolationsCorpus = [
    {
        name: 'POV Head-hop (Third to First)',
        state: {
            constraints: { pov: 'third-person-limited', tense: 'past', tone: ['noir'], forbidden: [] }
        } as Partial<ChapterState>,
        chunk: `John walked into the room. He felt the cold steel of the gun in his pocket. I knew I had to act fast or it would all be over.`,
        expectedViolation: 'POV_HEADHOP'
    },
    {
        name: 'Tense Shift (Past to Present)',
        state: {
            constraints: { pov: 'third-person-limited', tense: 'past', tone: ['noir'], forbidden: [] }
        } as Partial<ChapterState>,
        chunk: `John walked into the room. He looks at the shadows dancing on the wall. The rain beat against the window.`,
        expectedViolation: 'TENSE_SHIFT'
    },
    {
        name: 'Lore Contradiction (Eye Color)',
        state: {
            canonFacts: [
                { id: 'fact-001', entityId: 'char-john', attribute: 'eye_color', value: 'blue' }
            ]
        } as Partial<ChapterState>,
        chunk: `John stared back, his piercing brown eyes narrowed in suspicion. He hadn't expected to see her here.`,
        expectedViolation: 'ENTITY_ATTRIBUTE_MISMATCH'
    }
];

export class TestHarness {
    /**
     * Verifies if an AuditResult contains the expected violation type.
     */
    static verifyAudit(result: AuditResult, expectedType: string): boolean {
        return result.violations.some(v => v.type === expectedType);
    }

    /**
     * Verifies if a PatchOp correctly addresses a violation without introducing lore leakage.
     */
    static verifyPatch(patch: PatchOp, originalChunk: string, state: ChapterState): { success: boolean; reason?: string } {
        // 1. Basic Patch Validation
        if (!patch.newValue || patch.newValue === '') {
            return { success: false, reason: 'Patch produced empty content.' };
        }

        // 2. Lore Leakage Guard (Heuristic)
        const hardKeys = ['location', 'eye_color', 'identity', 'age']; // Example hard keys
        for (const key of hardKeys) {
            if (patch.newValue.toLowerCase().includes(key) && !patch.justification.includes(key)) {
                return { success: false, reason: `Patch mentions hard key '${key}' without explicit justification.` };
            }
        }

        // 3. Justification Check
        if (!patch.justification || patch.justification.length < 10) {
            return { success: false, reason: 'Patch lacks substantive justification.' };
        }

        return { success: true };
    }

    /**
     * Runs a full suite of automated tests against the corpus.
     */
    static async runSuite(
        auditFn: (chunk: string, state: ChapterState) => Promise<AuditResult>,
        repairFn: (chunk: string, audit: AuditResult, state: ChapterState) => Promise<PatchOp>
    ) {
        console.log('🚀 Starting Relay Generation Test Suite...');
        
        for (const testCase of IntentionalViolationsCorpus) {
            console.log(`\n--- Testing: ${testCase.name} ---`);
            
            const auditResult = await auditFn(testCase.chunk, testCase.state as ChapterState);
            const auditPassed = this.verifyAudit(auditResult, testCase.expectedViolation);
            
            console.log(`${auditPassed ? '✅' : '❌'} Audit: ${testCase.expectedViolation} detected: ${auditPassed}`);
            
            if (auditPassed && auditResult.overallSeverity >= 4) {
                console.log(`   Attempting Repair...`);
                const patch = await repairFn(testCase.chunk, auditResult, testCase.state as ChapterState);
                const patchResult = this.verifyPatch(patch, testCase.chunk, testCase.state as ChapterState);
                console.log(`${patchResult.success ? '✅' : '❌'} Repair: ${patchResult.success ? 'Succeeded' : 'Failed - ' + patchResult.reason}`);
            }
        }
        
        console.log('\n🏁 Test Suite Complete.');
    }
}

