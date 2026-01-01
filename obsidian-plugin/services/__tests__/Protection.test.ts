import { describe, it, expect } from 'vitest';
import { ProtectionReason, ProtectionEdge } from '../Schemas';

// Protection logic is currently data-only in Schemas, but we can test
// how closures and hierarchies would be calculated if we added a service for it.
// For now, we'll verify the integrity of the protection types.

describe('Protection Logic Integrity', () => {
    it('should define valid protection reasons', () => {
        const reason: ProtectionReason = {
            code: 'PROMOTION_TO_BIBLE',
            createdAt: Date.now(),
            details: 'Fact promoted after successful harvest',
            sourceRunId: 'run-123',
            factIds: ['fact-001', 'fact-002']
        };
        
        expect(reason.code).toBe('PROMOTION_TO_BIBLE');
        expect(reason.factIds?.length).toBe(2);
    });

    it('should define valid protection edges', () => {
        const edge: ProtectionEdge = {
            fromRunId: 'run-123',
            toRunId: 'run-124',
            edgeType: 'MIGRATION_CHAIN',
            sourcePointer: 'harvestSummary.approvedIds[0]',
            createdAt: Date.now()
        };
        
        expect(edge.edgeType).toBe('MIGRATION_CHAIN');
        expect(edge.fromRunId).toBe('run-123');
    });
});

