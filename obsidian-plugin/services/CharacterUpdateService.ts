import { Notice } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { PromptEngine } from './PromptEngine';
import { CharacterExtractor, CharacterUpdate } from './CharacterExtractor';
import { VaultService } from './VaultService';
import { parseCharacterRoster, rosterToBulletList, CharacterRosterEntry } from './CharacterRoster';

export interface ProcessEntireBookResult {
	roster: CharacterRosterEntry[];
	updates: CharacterUpdate[];
	chaptersProcessed: number;
}

export class CharacterUpdateService {
	constructor(
		private plugin: WritingDashboardPlugin,
		private promptEngine: PromptEngine,
		private characterExtractor: CharacterExtractor,
		private vaultService: VaultService
	) {}

	/**
	 * Route AI call to the cloud API.
	 */
	private async callAI(prompt: string): Promise<string> {
		// Use AIClient (cloud) - uses generate with settings
		const result = await this.plugin.aiClient.generate(prompt, {
			...this.plugin.settings,
			generationMode: 'single' as const
		});
		return result as string;
	}

	/**
	 * Extract characters from a single text passage.
	 */
	async extractFromText(text: string, instructions?: string): Promise<CharacterUpdate[]> {
		const effectiveInstructions = instructions?.trim()
			|| this.plugin.settings.defaultCharacterExtractionInstructions
			|| 'Extract character information from the passage. Focus on voice evidence, traits, relationships, and arc progression.';

		const storyBible = await this.vaultService.readFile(
			this.plugin.settings.storyBiblePath
		).catch(() => '');

		const existingNotes = await this.getAllCharacterNotes();

		const prompt = this.promptEngine.buildCharacterExtractionPrompt(
			text,
			existingNotes,
			storyBible,
			effectiveInstructions
		);

		const response = await this.callAI(prompt);
		return this.characterExtractor.parseExtraction(response);
	}

	/**
	 * 2-pass bulk processing: roster generation + per-chapter extraction.
	 */
	async processEntireBook(
		filePath: string,
		onProgress?: (msg: string) => void
	): Promise<ProcessEntireBookResult> {
		const content = await this.vaultService.readFile(filePath);
		const chapters = this.splitByChapters(content);

		const storyBible = await this.vaultService.readFile(
			this.plugin.settings.storyBiblePath
		).catch(() => '');

		// PASS 1: Build roster from a distributed sample across ALL chapters.
		// Takes the opening of each chapter so characters introduced anywhere in the
		// book appear in the roster — not just those from the first few chapters.
		onProgress?.(`Pass 1: Building character roster from ${chapters.length} chapters...`);
		const rosterSample = this._buildRosterSample(chapters);
		const rosterPrompt = this.promptEngine.buildCharacterRosterPrompt(
			rosterSample,
			storyBible
		);
		const rosterResponse = await this.callAI(rosterPrompt);
		const roster = parseCharacterRoster(rosterResponse);
		const rosterText = rosterToBulletList(roster);

		console.debug(`[CharacterUpdateService] Roster built: ${roster.length} characters from ${chapters.length} chapters`);

		// Read ALL existing character notes once — no file-count cap.
		// The full catalog is needed so every character's existing notes can be
		// shown to the AI when that character appears in a chapter.
		const allNotes = await this.getAllCharacterNotes();
		console.debug(`[CharacterUpdateService] Loaded ${Object.keys(allNotes).length} existing character files`);

		// PASS 2: Per-chapter extraction with roster
		const allUpdates: CharacterUpdate[] = [];
		for (let i = 0; i < chapters.length; i++) {
			onProgress?.(`Pass 2: Chapter ${i + 1}/${chapters.length}...`);

			const chapterContent = chapters[i];
			if (chapterContent.trim().length < 100) continue; // Skip tiny chunks

			// Only show notes for characters that actually appear in this chapter.
			// This keeps the prompt lean and ensures the AI focuses on the right people.
			const chapterNotes = this._filterNotesForChapter(allNotes, chapterContent);

			const prompt = this.promptEngine.buildCharacterExtractionPromptWithRoster({
				passage: chapterContent,
				roster: rosterText,
				characterNotes: chapterNotes,
				storyBible
			});

			try {
				const response = await this.callAI(prompt);
				const updates = this.characterExtractor.parseExtraction(response);
				allUpdates.push(...updates);
			} catch (err) {
				console.warn(`[CharacterUpdateService] Failed to process chapter ${i + 1}:`, err);
				// Continue with other chapters
			}
		}

		// Aggregate updates by character directly — no roundtrip through parseExtraction.
		// Collects all per-chapter updates for each character and joins them with separators.
		const aggregateMap = new Map<string, string[]>();
		for (const { character, update } of allUpdates) {
			const bucket = aggregateMap.get(character) ?? [];
			bucket.push(update);
			aggregateMap.set(character, bucket);
		}
		const aggregated: CharacterUpdate[] = Array.from(aggregateMap.entries()).map(
			([character, updates]) => ({ character, update: updates.join('\n\n---\n\n') })
		);

		console.debug(`[CharacterUpdateService] Extraction complete: ${aggregated.length} character updates from ${chapters.length} chapters`);

		return { roster, updates: aggregated, chaptersProcessed: chapters.length };
	}

	/**
	 * Commit character updates to vault files.
	 */
	async commitUpdates(updates: CharacterUpdate[]): Promise<void> {
		if (updates.length === 0) {
			console.debug('[CharacterUpdateService] No updates to commit');
			return;
		}
		await this.vaultService.updateCharacterNotes(updates);
		console.debug(`[CharacterUpdateService] Committed ${updates.length} character updates`);
	}

	/**
	 * Build a representative text sample for roster generation.
	 *
	 * Word-first: the unit is words, not characters.
	 * Takes the first 2,000 words of every chapter opening and 1,000 words
	 * from the mid-point — enough to catch characters introduced anywhere
	 * in the chapter, not just the first paragraph.
	 *
	 * For a 40-chapter, 300K-word manuscript this produces roughly 120,000
	 * words (~160K tokens) — well within any cloud model's context window.
	 */
	private _buildRosterSample(chapters: string[]): string {
		if (chapters.length === 0) return '';

		const OPENING_WORDS = 2000;
		const MIDDLE_WORDS  = 1000;

		const samples = chapters.map((ch, i) => {
			const words = ch.split(/\s+/);

			const opening = words.slice(0, OPENING_WORDS).join(' ').trim();

			const midWordStart = Math.floor(words.length * 0.5);
			const middle = words.slice(midWordStart, midWordStart + MIDDLE_WORDS).join(' ').trim();

			const parts = [`[Chapter ${i + 1} — opening]\n${opening}`];
			if (middle && middle !== opening) {
				parts.push(`[Chapter ${i + 1} — mid-chapter]\n${middle}`);
			}
			return parts.join('\n\n');
		});

		return samples.join('\n\n---\n\n');
	}

	/**
	 * Split content by H1 headings (chapters).
	 */
	private splitByChapters(content: string): string[] {
		// Split by H1 headings
		const parts = content.split(/^#\s+/m);
		// Filter out empty/tiny parts and reconstruct with heading
		return parts
			.filter(p => p.trim().length > 100)
			.map((p, i) => i === 0 ? p : `# ${p}`);
	}

	/**
	 * Read ALL existing character notes from the character folder, in full.
	 * No file-count cap, no character/word cap — the entire file is returned.
	 * Cloud context windows are large enough that truncating character history
	 * is counterproductive; the AI needs the full picture to respect and extend
	 * what is already written rather than re-extracting stale facts.
	 */
	private async getAllCharacterNotes(): Promise<Record<string, string>> {
		const folder = this.plugin.settings.characterFolder || 'Characters';
		const notes: Record<string, string> = {};

		try {
			const files = this.plugin.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith(`${folder}/`));

			for (const file of files) {
				const content = await this.plugin.app.vault.cachedRead(file);
				notes[file.basename] = content; // full file — no truncation
			}
		} catch (err) {
			console.warn('[CharacterUpdateService] Failed to read existing character notes:', err);
		}

		return notes;
	}

	/**
	 * Filter a full character notes catalog down to only the characters
	 * that appear by name in the given chapter text.
	 * This keeps each chapter's prompt lean while still ensuring the AI
	 * can see the complete existing notes for every character it actually meets.
	 */
	private _filterNotesForChapter(
		allNotes: Record<string, string>,
		chapterText: string
	): Record<string, string> {
		const haystack = chapterText.toLowerCase();
		const filtered: Record<string, string> = {};
		for (const [name, content] of Object.entries(allNotes)) {
			if (haystack.includes(name.toLowerCase())) {
				filtered[name] = content;
			}
		}
		return filtered;
	}
}

