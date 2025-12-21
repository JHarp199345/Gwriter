import type { Vault } from 'obsidian';
import { TFile, TFolder } from 'obsidian';

export interface ResolveResult {
	/**
	 * If set, we are confident this maps to an existing character note basename.
	 */
	resolvedName?: string;
	/**
	 * If set, we are not confident and the UI should ask the user.
	 * Candidates are basenames (without .md).
	 */
	needsConfirmation?: {
		proposedName: string;
		candidates: string[];
	};
}

function normalizeForMatch(name: string): string {
	return (name || '')
		.toLowerCase()
		.trim()
		.replace(/[_\-]+/g, ' ')
		.replace(/[^\p{L}\p{N}\s]/gu, '') // remove punctuation, keep unicode letters/numbers
		.replace(/\s+/g, ' ')
		.trim();
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (!a) return b.length;
	if (!b) return a.length;

	const m = a.length;
	const n = b.length;
	const dp = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) dp[j] = j;

	for (let i = 1; i <= m; i++) {
		let prev = dp[0];
		dp[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = dp[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min(
				dp[j] + 1, // delete
				dp[j - 1] + 1, // insert
				prev + cost // substitute
			);
			prev = tmp;
		}
	}
	return dp[n];
}

function similarityScore(a: string, b: string): number {
	const na = normalizeForMatch(a);
	const nb = normalizeForMatch(b);
	if (!na || !nb) return 0;
	if (na === nb) return 1;
	const dist = levenshtein(na, nb);
	const maxLen = Math.max(na.length, nb.length) || 1;
	return 1 - dist / maxLen;
}

async function listCharacterBasenames(vault: Vault, folderPath: string): Promise<string[]> {
	const folder = vault.getAbstractFileByPath(folderPath);
	if (!(folder instanceof TFolder)) return [];
	const names: string[] = [];
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') {
			names.push(child.basename);
		}
	}
	return names;
}

/**
 * Resolve an AI-proposed character header to an existing character note basename when possible.
 */
export class CharacterNameResolver {
	private readonly vault: Vault;
	private readonly characterFolder: string;

	constructor(vault: Vault, characterFolder: string) {
		this.vault = vault;
		this.characterFolder = characterFolder;
	}

	async resolve(proposedName: string): Promise<ResolveResult> {
		const proposed = (proposedName || '').trim();
		if (!proposed) return { needsConfirmation: { proposedName: proposedName, candidates: [] } };

		const existing = await listCharacterBasenames(this.vault, this.characterFolder);
		if (existing.length === 0) {
			return { needsConfirmation: { proposedName: proposed, candidates: [] } };
		}

		const normalized = normalizeForMatch(proposed);
		const exact = existing.find((e) => normalizeForMatch(e) === normalized);
		if (exact) return { resolvedName: exact };

		// Rank candidates by similarity.
		const ranked = existing
			.map((e) => ({ name: e, score: similarityScore(proposed, e) }))
			.sort((a, b) => b.score - a.score);

		const best = ranked[0];
		// High confidence threshold: auto-resolve.
		if (best && best.score >= 0.92) {
			return { resolvedName: best.name };
		}

		const candidates = ranked.filter((r) => r.score >= 0.78).slice(0, 5).map((r) => r.name);
		return {
			needsConfirmation: {
				proposedName: proposed,
				candidates
			}
		};
	}
}


