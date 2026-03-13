import { Vault, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { EvidenceSpan, EvidenceRelocationTier, EvidenceRelocationMethod, HarvestItem } from './Schemas';
import { sha256, normalizeForExcerptHash, normalizeWhitespace } from './ContentHash';

/**
 * Levenshtein distance calculation for edit distance comparison.
 */
function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,     // deletion
                    dp[i][j - 1] + 1,     // insertion
                    dp[i - 1][j - 1] + 1  // substitution
                );
            }
        }
    }

    return dp[m][n];
}

/**
 * EvidenceRelocationService provides deterministic evidence relocation
 * when manuscript edits cause paragraph IDs to shift.
 */
export class EvidenceRelocationService {
    private readonly vault: Vault;
    private readonly plugin: WritingDashboardPlugin;
    private readonly fileCache: Map<string, { content: string; hash: string }> = new Map();

    constructor(vault: Vault, plugin: WritingDashboardPlugin) {
        this.vault = vault;
        this.plugin = plugin;
    }

    /**
     * Relocates a single evidence span using v3 deterministic algorithm:
     * 1. Exact paragraphId + hash match
     * 2. Anchor-pair search (before + after context)
     * 3. File-level unique hash search
     * 4. File-level unique anchor search
     * 5. STALE (if no match found)
     */
    async relocateEvidenceSpan(span: EvidenceSpan, sourceFilePath: string): Promise<EvidenceSpan> {
        const fileContent = await this.readFileWithCache(sourceFilePath);
        if (!fileContent) {
            return { ...span, relocationTier: 'STALE' };
        }

        const currentFileHash = await sha256(fileContent);
        const isFileChanged = span.sourceFileHashAtRun !== currentFileHash;

        // If file unchanged and tier is EXACT, no relocation needed
        if (!isFileChanged && span.relocationTier === 'EXACT') {
            return span;
        }

        const relocationPath: EvidenceRelocationMethod[] = [];
        let updatedSpan = { ...span };
        updatedSpan.relocatedAt = Date.now();

        // Method 1: Exact paragraphId + hash match
        if (span.paragraphId) {
            // If paragraphId is content-hash based, we can't use it directly
            // This is best-effort only
            relocationPath.push(EvidenceRelocationMethod.PARA_ID);
            // Note: Actual paragraphId lookup would require ParagraphIdentityService
            // For now, we skip direct paragraphId matching and rely on other methods
        }

        // Method 2: Anchor-pair search
        relocationPath.push(EvidenceRelocationMethod.ANCHOR_PAIR);
        const anchorMatches = this.findAnchorMatches(fileContent, span.textAnchor.before, span.textAnchor.after, span.originalExcerptText || '');
        
        if (anchorMatches.length === 1) {
            const match = anchorMatches[0];
            updatedSpan.charRange = { start: match.start, end: match.end };
            updatedSpan.relocationTier = 'RELOCATED_UNIQUE';
            updatedSpan.relocationPath = relocationPath;
            updatedSpan.matchCount = 1;
            return updatedSpan;
        } else if (anchorMatches.length > 1) {
            // Tie-breaking: closest to original start position, then edit distance
            anchorMatches.sort((a, b) => {
                const distA = Math.abs(a.start - (span.charRange.start || 0));
                const distB = Math.abs(b.start - (span.charRange.start || 0));
                if (distA !== distB) return distA - distB;
                
                // Secondary: edit distance
                const excerptA = fileContent.substring(a.start, a.end);
                const excerptB = fileContent.substring(b.start, b.end);
                const editA = levenshteinDistance(span.originalExcerptText || '', excerptA);
                const editB = levenshteinDistance(span.originalExcerptText || '', excerptB);
                if (editA !== editB) return editA - editB;
                
                // Tertiary: smallest start position
                return a.start - b.start;
            });

            // If still ambiguous after tie-breaking, mark as ambiguous
            if (anchorMatches.length > 1) {
                updatedSpan.charRange = anchorMatches[0];
                updatedSpan.relocationTier = 'RELOCATED_AMBIGUOUS';
                updatedSpan.relocationPath = relocationPath;
                updatedSpan.matchCount = anchorMatches.length;
                return updatedSpan;
            }
        }

        // Method 3: File-level unique hash search
        relocationPath.push(EvidenceRelocationMethod.FILE_HASH);
        const hashMatches = this.findHashMatches(fileContent, span.excerptHashNormalized, span.originalExcerptText || '');
        
        if (hashMatches.length === 1) {
            const match = hashMatches[0];
            updatedSpan.charRange = { start: match.start, end: match.end };
            updatedSpan.relocationTier = 'RELOCATED_UNIQUE';
            updatedSpan.relocationPath = relocationPath;
            updatedSpan.matchCount = 1;
            updatedSpan.normalizedMatch = true;
            return updatedSpan;
        } else if (hashMatches.length > 1) {
            updatedSpan.charRange = hashMatches[0];
            updatedSpan.relocationTier = 'RELOCATED_AMBIGUOUS';
            updatedSpan.relocationPath = relocationPath;
            updatedSpan.matchCount = hashMatches.length;
            return updatedSpan;
        }

        // Method 4: File-level unique anchor search (fallback)
        relocationPath.push(EvidenceRelocationMethod.FILE_ANCHOR);
        const fileAnchorMatches = this.findFileAnchorMatches(fileContent, span.originalExcerptText || '');
        
        if (fileAnchorMatches.length === 1) {
            updatedSpan.charRange = fileAnchorMatches[0];
            updatedSpan.relocationTier = 'RELOCATED_UNIQUE';
            updatedSpan.relocationPath = relocationPath;
            updatedSpan.matchCount = 1;
            return updatedSpan;
        } else if (fileAnchorMatches.length > 1) {
            updatedSpan.charRange = fileAnchorMatches[0];
            updatedSpan.relocationTier = 'RELOCATED_AMBIGUOUS';
            updatedSpan.relocationPath = relocationPath;
            updatedSpan.matchCount = fileAnchorMatches.length;
            return updatedSpan;
        }

        // Method 5: STALE - no match found
        updatedSpan.relocationTier = 'STALE';
        updatedSpan.relocationPath = relocationPath;
        updatedSpan.matchCount = 0;
        return updatedSpan;
    }

    /**
     * Batch relocation of evidence spans with memoized file reads.
     */
    async relocateEvidenceSpans(
        items: HarvestItem[],
        sourceFilePaths: Map<string, string> // harvestItemId -> filePath
    ): Promise<HarvestItem[]> {
        // Clear cache for fresh reads
        this.fileCache.clear();

        const relocatedItems: HarvestItem[] = [];
        
        for (const item of items) {
            const filePath = sourceFilePaths.get(item.harvestId) || item.supportingEvidence[0]?.sourceFilePath;
            if (!filePath) {
                relocatedItems.push(item);
                continue;
            }

            const relocatedEvidence: EvidenceSpan[] = [];
            for (const span of item.supportingEvidence) {
                const relocated = await this.relocateEvidenceSpan(span, filePath);
                relocatedEvidence.push(relocated);
            }

            relocatedItems.push({
                ...item,
                supportingEvidence: relocatedEvidence
            });
        }

        return relocatedItems;
    }

    /**
     * Checks if a file has changed since evidence extraction.
     */
    async checkFileFreshness(filePath: string, storedHash: string): Promise<{ isFresh: boolean; currentHash: string }> {
        const fileContent = await this.readFileWithCache(filePath);
        if (!fileContent) {
            return { isFresh: false, currentHash: '' };
        }

        const currentHash = await sha256(fileContent);
        return {
            isFresh: currentHash === storedHash,
            currentHash
        };
    }

    /**
     * Finds matches using before + after anchor context.
     */
    private findAnchorMatches(
        content: string,
        before: string,
        after: string,
        excerpt: string
    ): Array<{ start: number; end: number }> {
        const matches: Array<{ start: number; end: number }> = [];
        
        // Normalize for search
        const normalizedBefore = normalizeWhitespace(before);
        const normalizedAfter = normalizeWhitespace(after);
        const normalizedContent = normalizeWhitespace(content);

        // Search for before context
        let searchStart = 0;
        while (true) {
            const beforeIndex = normalizedContent.indexOf(normalizedBefore, searchStart);
            if (beforeIndex === -1) break;

            const excerptStart = beforeIndex + normalizedBefore.length;
            const afterIndex = normalizedContent.indexOf(normalizedAfter, excerptStart);
            
            if (afterIndex !== -1) {
                const excerptEnd = afterIndex;
                matches.push({
                    start: excerptStart,
                    end: excerptEnd
                });
            }

            searchStart = beforeIndex + 1;
        }

        return matches;
    }

    /**
     * Finds matches by searching for text that hashes to the expected normalized hash.
     */
    private findHashMatches(
        content: string,
        expectedHash: string,
        originalExcerpt: string
    ): Array<{ start: number; end: number }> {
        const matches: Array<{ start: number; end: number }> = [];
        const normalizedContent = normalizeForExcerptHash(content);
        const normalizedOriginal = normalizeForExcerptHash(originalExcerpt);

        // Search for normalized excerpt text
        let searchStart = 0;
        while (true) {
            const index = normalizedContent.indexOf(normalizedOriginal, searchStart);
            if (index === -1) break;

            // Note: We're comparing normalized text for performance rather than computing a hash
            matches.push({
                start: index,
                end: index + normalizedOriginal.length
            });

            searchStart = index + 1;
        }

        return matches;
    }

    /**
     * Finds matches by searching for original excerpt text anywhere in file.
     */
    private findFileAnchorMatches(
        content: string,
        excerpt: string
    ): Array<{ start: number; end: number }> {
        const matches: Array<{ start: number; end: number }> = [];
        const normalizedExcerpt = normalizeWhitespace(excerpt);
        const normalizedContent = normalizeWhitespace(content);

        let searchStart = 0;
        while (true) {
            const index = normalizedContent.indexOf(normalizedExcerpt, searchStart);
            if (index === -1) break;

            matches.push({
                start: index,
                end: index + normalizedExcerpt.length
            });

            searchStart = index + 1;
        }

        return matches;
    }

    /**
     * Reads file with caching to avoid repeated reads during batch relocation.
     */
    private async readFileWithCache(filePath: string): Promise<string | null> {
        if (this.fileCache.has(filePath)) {
            return this.fileCache.get(filePath)!.content;
        }

        try {
            const file = this.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) {
                return null;
            }

            const content = await this.vault.read(file);
            const hash = await sha256(content);
            
            this.fileCache.set(filePath, { content, hash });
            return content;
        } catch (err) {
            console.warn(`[EvidenceRelocationService] Failed to read file ${filePath}:`, err);
            return null;
        }
    }
}

