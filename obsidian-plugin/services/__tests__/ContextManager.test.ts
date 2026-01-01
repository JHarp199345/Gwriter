import { describe, it, expect, vi } from 'vitest';
import { ContextManager } from '../ContextManager';
import { ChapterState, FactOrigin, FactType, FactScope } from '../Schemas';

// Mock Obsidian
const mockVault = {} as any;

const initialChapterState: ChapterState = {
    chapterId: 'test-chapter',
    canonVersion: 1,
    schemaVersion: 1,
    entities: [],
    canonFacts: [],
    mutationHistory: [],
    pendingMutations: [],
    entity_redirects: {},
    redirectRegistryVersion: 0,
    timeline: [],
    openLoops: [],
    constraints: {
        pov: 'third-person-limited',
        tense: 'past',
        tone: ['noir'],
        forbidden: []
    }
};

describe('ContextManager', () => {
    describe('resolveEntityId', () => {
        it('should resolve direct redirects', () => {
            const state = { ...initialChapterState, entity_redirects: { 'a': 'b' } };
            const cm = new ContextManager(mockVault, state);
            expect(cm.resolveEntityId('a')).toBe('b');
        });

        it('should resolve multi-hop redirects with path compression', () => {
            const state = { ...initialChapterState, entity_redirects: { 'a': 'b', 'b': 'c' } };
            const cm = new ContextManager(mockVault, state);
            expect(cm.resolveEntityId('a')).toBe('c');
            expect(state.entity_redirects['a']).toBe('c'); // Path compression
        });

        it('should handle circular redirects gracefully', () => {
            const state = { ...initialChapterState, entity_redirects: { 'a': 'b', 'b': 'a' } };
            const cm = new ContextManager(mockVault, state);
            // Should detect cycle and return the current node to prevent infinite loop
            expect(cm.resolveEntityId('a')).toBe('b'); 
        });
    });

    describe('canOverride', () => {
        const cm = new ContextManager(mockVault, initialChapterState);

        it('should allow BIBLE to override EXTRACTOR', () => {
            expect(cm.canOverride('BIBLE', 'EXTRACTOR', 'IDENTITY', 'GLOBAL')).toBe(true);
        });

        it('should NOT allow EXTRACTOR to override BIBLE', () => {
            expect(cm.canOverride('EXTRACTOR', 'BIBLE', 'IDENTITY', 'GLOBAL')).toBe(false);
        });

        it('should allow MUTATION to override BIBLE (retcon)', () => {
            expect(cm.canOverride('MUTATION', 'BIBLE', 'IDENTITY', 'GLOBAL')).toBe(true);
        });

        it('should allow USER to override GENERATION', () => {
            expect(cm.canOverride('USER', 'GENERATION', 'TRAIT', 'GLOBAL')).toBe(true);
        });
    });

    describe('shouldAutoPromote', () => {
        const cm = new ContextManager(mockVault, initialChapterState);

        it('should auto-promote BIBLE origin facts', () => {
            const fact = { origin: 'BIBLE', lifecycleState: 'PROPOSED', attribute: 'location', type: 'IDENTITY' } as any;
            expect(cm.shouldAutoPromote(fact)).toBe(true);
        });

        it('should NOT auto-promote CORE facts from EXTRACTOR', () => {
            const fact = { origin: 'EXTRACTOR', lifecycleState: 'PROPOSED', attribute: 'identity', type: 'IDENTITY' } as any;
            expect(cm.shouldAutoPromote(fact)).toBe(false);
        });

        it('should auto-promote non-core high-confidence EXTRACTOR facts', () => {
            const fact = { origin: 'EXTRACTOR', lifecycleState: 'PROPOSED', attribute: 'random_detail', type: 'TRAIT', confidence: 0.95 } as any;
            expect(cm.shouldAutoPromote(fact)).toBe(true);
        });

        it('should NOT auto-promote USER facts without approval event for core attributes', () => {
            const fact = { origin: 'USER', lifecycleState: 'PROPOSED', attribute: 'identity', type: 'IDENTITY' } as any;
            expect(cm.shouldAutoPromote(fact)).toBe(false);
        });

        it('should auto-promote USER facts with approval event', () => {
            const fact = { origin: 'USER', lifecycleState: 'PROPOSED', attribute: 'identity', type: 'IDENTITY', approvedByEventId: 'evt-123' } as any;
            expect(cm.shouldAutoPromote(fact)).toBe(true);
        });
    });

    describe('Execution Truth Matrix', () => {
        const cm = new ContextManager(mockVault, initialChapterState);

        it('should enforce BIBLE hierarchy for GLOBAL identities', () => {
            // srcOrigin, dstOrigin, factType, scope
            expect(cm.canOverride('USER', 'BIBLE', 'IDENTITY', 'GLOBAL')).toBe(false);
            expect(cm.canOverride('MUTATION', 'BIBLE', 'IDENTITY', 'GLOBAL')).toBe(true); // Retcon
        });

        it('should allow GENERATION to be overridden by almost anything', () => {
            expect(cm.canOverride('EXTRACTOR', 'GENERATION', 'TRAIT', 'GLOBAL')).toBe(false); // Hierarchy: GENERATION(2) > EXTRACTOR(1)
            expect(cm.canOverride('STATE', 'GENERATION', 'TRAIT', 'GLOBAL')).toBe(true); // STATE(3) > GENERATION(2)
        });
    });
});

