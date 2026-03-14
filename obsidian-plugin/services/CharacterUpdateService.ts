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

		const existingNotes = await this.getExistingCharacterNotes();

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

		// Cache existing character notes once — avoids re-reading the vault on every chapter
		const existingNotes = await this.getExistingCharacterNotes();

		// PASS 2: Per-chapter extraction with roster
		const allUpdates: CharacterUpdate[] = [];
		for (let i = 0; i < chapters.length; i++) {
			onProgress?.(`Pass 2: Chapter ${i + 1}/${chapters.length}...`);

			const chapterContent = chapters[i];
			if (chapterContent.trim().length < 100) continue; // Skip tiny chunks

			const prompt = this.promptEngine.buildCharacterExtractionPromptWithRoster({
				passage: chapterContent,
				roster: rosterText,
				characterNotes: existingNotes,
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

		// Aggregate updates by character
		const aggregated = this.characterExtractor.processChunks(
			allUpdates.map(u => `## ${u.character}\n${u.update}`),
			text => this.characterExtractor.parseExtraction(text)
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
	 * Build a representative text sample for roster generation by taking the
	 * opening of every chapter across the entire book.
	 *
	 * Characters are almost always introduced (or re-introduced) near the start
	 * of a chapter, so sampling chapter openings gives far better coverage than
	 * a naive content.slice(0, 50000) which only sees the first few chapters.
	 *
	 * Total sample is capped at ~80K characters to keep the roster prompt
	 * within a reasonable size regardless of book length.
	 */
	private _buildRosterSample(chapters: string[]): string {
		if (chapters.length === 0) return '';

		const TARGET_TOTAL = 80000;
		// Give each chapter an equal slice, but never more than 3000 chars
		const charsPerChapter = Math.min(3000, Math.floor(TARGET_TOTAL / chapters.length));

		const samples = chapters.map((ch, i) => {
			const excerpt = ch.slice(0, charsPerChapter).trim();
			return `[Chapter ${i + 1}]\n${excerpt}`;
		});

		return samples.join('\n\n---\n\n').slice(0, TARGET_TOTAL);
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
	 * Get existing character notes from the character folder.
	 */
	private async getExistingCharacterNotes(): Promise<Record<string, string>> {
		const folder = this.plugin.settings.characterFolder || 'Characters';
		const notes: Record<string, string> = {};

		try {
			const files = this.plugin.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith(`${folder}/`));

			// Limit to first 20 files to avoid overwhelming the prompt
			for (const file of files.slice(0, 20)) {
				const content = await this.plugin.app.vault.cachedRead(file);
				notes[file.basename] = content.slice(0, 2000);
			}
		} catch (err) {
			console.warn('[CharacterUpdateService] Failed to read existing character notes:', err);
		}

		return notes;
	}
}

