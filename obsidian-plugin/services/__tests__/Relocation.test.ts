import { describe, it, expect, vi } from 'vitest';
import { EvidenceRelocationService } from '../EvidenceRelocationService';
import { EvidenceSpan, EvidenceRelocationMethod } from '../Schemas';

// Mock Obsidian
const mockVault = {
    getAbstractFileByPath: vi.fn(),
    read: vi.fn()
} as any;

const mockPlugin = {
    settings: {
        book2Path: 'manuscript.md'
    }
} as any;

describe('EvidenceRelocationService', () => {
    const service = new EvidenceRelocationService(mockVault, mockPlugin);

    describe('relocateEvidenceSpan', () => {
        it('should return STALE if file is missing', async () => {
            mockVault.getAbstractFileByPath.mockReturnValue(null);
            
            const span: EvidenceSpan = {
                sourceFilePath: 'missing.md',
                excerptHashRaw: 'abc',
                excerptHashNormalized: 'abc',
                textAnchor: { before: '', after: '' },
                charRange: { start: 0, end: 10 },
                sourceFileHashAtRun: 'old-hash',
                relocationTier: 'EXACT'
            };

            const result = await service.relocateEvidenceSpan(span, 'missing.md');
            expect(result.relocationTier).toBe('STALE');
        });

        it('should return original span if file is unchanged and tier is EXACT', async () => {
            const content = 'This is the original content.';
            const hash = '89e0ad2ce990523121ef240cf39e91ad74950ca7984cd1674bc1aa39f4c36326'; // sha256 of content
            
            mockVault.getAbstractFileByPath.mockReturnValue({ extension: 'md' });
            mockVault.read.mockResolvedValue(content);

            const span: EvidenceSpan = {
                sourceFilePath: 'file.md',
                excerptHashRaw: 'abc',
                excerptHashNormalized: 'abc',
                textAnchor: { before: '', after: '' },
                charRange: { start: 0, end: 10 },
                sourceFileHashAtRun: hash,
                relocationTier: 'EXACT'
            };

            const result = await service.relocateEvidenceSpan(span, 'file.md');
            expect(result).toEqual(span);
        });

        it('should relocate using ANCHOR_PAIR when content shifts', async () => {
            const oldContent = 'Prefix. Target evidence. Suffix.';
            const newContent = 'Added noise at the start. Prefix. Target evidence. Suffix.';
            
            // Normalize whitespace matches the service logic
            const before = 'Prefix.';
            const after = 'Suffix.';
            const target = ' Target evidence. ';
            
            mockVault.getAbstractFileByPath.mockReturnValue({ extension: 'md' });
            mockVault.read.mockResolvedValue(newContent);

            const span: EvidenceSpan = {
                sourceFilePath: 'file.md',
                excerptHashRaw: 'hash',
                excerptHashNormalized: 'hash',
                textAnchor: { before, after },
                charRange: { start: 8, end: 24 },
                sourceFileHashAtRun: 'old-hash',
                relocationTier: 'EXACT',
                originalExcerptText: target
            };

            const result = await service.relocateEvidenceSpan(span, 'file.md');
            expect(result.relocationTier).toBe('RELOCATED_UNIQUE');
            expect(result.relocationPath).toContain(EvidenceRelocationMethod.ANCHOR_PAIR);
            
            // Verify relocated range
            const relocatedText = newContent.substring(result.charRange.start, result.charRange.end);
            expect(relocatedText).toBe(target);
        });
    });
});

