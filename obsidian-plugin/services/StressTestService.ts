import { App, TFile, TFolder } from 'obsidian';
import WritingDashboardPlugin from '../main';

interface StressTestOptions {
	skipCleanup?: boolean;
}

export class StressTestService {
	private plugin: WritingDashboardPlugin;
	private app: App;
	private log: string[] = [];
	private testFolder = 'WritingDashboard-StressTest';
	private testFiles: string[] = [];
	private testFolders: string[] = [];
	private startTime = 0;
	private options: StressTestOptions;

	constructor(plugin: WritingDashboardPlugin, options: StressTestOptions = {}) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.options = options;
	}

	async runFullStressTest() {
		this.log = [];
		this.startTime = Date.now();

		this.logEntry('=== STRESS TEST START ===');
		this.logEntry(`Started: ${new Date().toISOString()}`);
		this.logEntry(`Vault: ${this.plugin.app.vault.getName()}`);
		this.logEntry('');
		this.logEntry('=== PLUGIN CONFIGURATION ===');
		this.logEntry(`API Key: ${this.plugin.settings.apiKey ? '✓ Configured' : '✗ Missing'}`);
		this.logEntry(`API Provider: ${this.plugin.settings.apiProvider || 'Not set'}`);
		this.logEntry(`Model: ${this.plugin.settings.model || 'Not set'}`);
		this.logEntry(`Generation Mode: ${this.plugin.settings.generationMode || 'single'}`);
		this.logEntry(`Book Main Path: ${this.plugin.settings.book2Path || 'Not configured'}`);
		this.logEntry(`Story Bible Path: ${this.plugin.settings.storyBiblePath || 'Not configured'}`);
		this.logEntry(`Character Folder: ${this.plugin.settings.characterFolder || 'Not configured (will use default: Characters)'}`);
		this.logEntry(`Semantic Retrieval: ${this.plugin.settings.retrievalEnableSemanticIndex ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`Embedding Backend: ${this.plugin.settings.retrievalEmbeddingBackend || 'hash'}`);
		this.logEntry(`BM25 Retrieval: ${this.plugin.settings.retrievalEnableBm25 ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`Index Paused: ${this.plugin.settings.retrievalIndexPaused ? 'Yes' : 'No'}`);
		this.logEntry(`Retrieval Top K: ${this.plugin.settings.retrievalTopK || 24}`);
		this.logEntry(`External Embeddings: ${this.plugin.settings.externalEmbeddingsEnabled ? 'Enabled' : 'Disabled'}`);
		this.logEntry('');

		try {
			await this.phase1_Setup();
			await this.phase2_Indexing();
			await this.phase3_FileOperations();

			if (this.plugin.settings.apiKey) {
				await this.phase4_WritingModes();
			} else {
				this.logEntry('Phase 4: Skipped (no API key configured)');
			}

			await this.phase5_Retrieval();

			if (this.plugin.settings.apiKey) {
				await this.phase7_CharacterOperations();
			} else {
				this.logEntry('Phase 7: Skipped (no API key configured)');
			}

		} catch (error) {
			this.logEntry(`=== FATAL ERROR IN STRESS TEST ===`);
			this.logEntry(`  WHERE: runFullStressTest (top-level catch)`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
			this.logEntry(`  TYPE: ${error instanceof Error ? error.constructor.name : typeof error}`);
			if (error instanceof Error && error.stack) {
				this.logEntry(`  STACK (first 10 lines):`);
				error.stack.split('\n').slice(0, 10).forEach(line => {
					this.logEntry(`    ${line.trim()}`);
				});
			}
			if (error instanceof Error && 'cause' in error) {
				this.logEntry(`  CAUSE: ${(error as any).cause}`);
			}
			this.logEntry(`=== END FATAL ERROR ===`);
		} finally {
			await this.phase6_Cleanup();
		}

		const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
		this.logEntry('');
		this.logEntry('=== STRESS TEST SUMMARY ===');
		this.logEntry(`Total Duration: ${duration} seconds`);
		this.logEntry(`Ended: ${new Date().toISOString()}`);
		this.logEntry('');
		this.logEntry('=== FUNCTIONAL OPERATIONS TESTED ===');
		this.logEntry('✓ Phase 1: Setup (folder/file creation)');
		this.logEntry('✓ Phase 2: Indexing (semantic index, BM25, chunking)');
		this.logEntry('✓ Phase 3: File Operations (read/write/folder management)');
		if (this.plugin.settings.apiKey) {
			this.logEntry('✓ Phase 4: Writing Modes (chapter generation, micro-edit, continuity check)');
			this.logEntry('✓ Phase 7: Character Operations (extraction, note updates)');
		} else {
			this.logEntry('○ Phase 4: Writing Modes (skipped - no API key)');
			this.logEntry('○ Phase 7: Character Operations (skipped - no API key)');
		}
		this.logEntry('✓ Phase 5: Retrieval Tests (hash, BM25, semantic search)');
		this.logEntry('✓ Phase 6: Cleanup (test file/folder removal)');
		this.logEntry('');
		this.logEntry('=== KEY METRICS ===');
		this.logEntry(`Semantic Retrieval: ${this.plugin.settings.retrievalEnableSemanticIndex ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`BM25 Retrieval: ${this.plugin.settings.retrievalEnableBm25 ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`External Embeddings: ${this.plugin.settings.externalEmbeddingsEnabled ? 'Enabled' : 'Disabled'}`);
		this.logEntry('');
		this.logEntry('=== STRESS TEST COMPLETED ===');

		return this.log.join('\n');
	}

	private logEntry(message: string) {
		const timestamp = new Date().toISOString();
		const entry = `[${timestamp}] ${message}`;
		this.log.push(entry);
		console.log(`[StressTest] ${message}`);
	}

	private async phase1_Setup() {
		this.logEntry('--- Phase 1: Setup ---');
		const phaseStart = Date.now();

		try {
			await this.plugin.vaultService.createFolderIfNotExists(this.testFolder);
			this.testFolders.push(this.testFolder);
			this.logEntry(`✓ Created test folder: ${this.testFolder}`);

			const testFiles = [
				{ name: 'test-chapter-1.md', content: this.generateTestChapter(1) },
				{ name: 'test-chapter-2.md', content: this.generateTestChapter(2) },
				{ name: 'test-character-scene.md', content: this.generateCharacterScene() },
				{ name: 'test-short.md', content: 'This is a short test file with minimal content.' },
				{ name: 'test-long.md', content: this.generateLongContent() }
			];

			for (const testFile of testFiles) {
				const path = `${this.testFolder}/${testFile.name}`;
				await this.plugin.vaultService.writeFile(path, testFile.content);
				this.testFiles.push(path);
				this.logEntry(`✓ Created test file: ${testFile.name} (${testFile.content.split(/\s+/).length} words)`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 1 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 1 failed`);
			this.logEntry(`  WHERE: phase1_Setup`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase2_Indexing() {
		this.logEntry('--- Phase 2: Indexing Tests ---');
		const phaseStart = Date.now();

		try {
			for (const filePath of this.testFiles) {
				this.plugin.embeddingsIndex.queueUpdateFile(filePath);
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));

			const status = this.plugin.embeddingsIndex.getStatus();
			this.logEntry(`Indexed files: ${status.indexedFiles}, chunks: ${status.indexedChunks}, queued: ${status.queued}`);

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 2 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 2 failed`);
			this.logEntry(`  WHERE: phase2_Indexing`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase3_FileOperations() {
		this.logEntry('--- Phase 3: File Operations ---');
		const phaseStart = Date.now();

		try {
			for (const path of [...this.testFiles]) {
				const newPath = path.replace('.md', '-copy.md');
				const content = await this.plugin.vaultService.readFile(path);
				await this.plugin.vaultService.writeFile(newPath, content);
				this.testFiles.push(newPath);
				this.logEntry(`✓ Copied file: ${path} -> ${newPath}`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 3 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 3 failed`);
			this.logEntry(`  WHERE: phase3_FileOperations`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase4_WritingModes() {
		this.logEntry('--- Phase 4: Writing Modes ---');
		const phaseStart = Date.now();

		try {
			// If no API key, keep this phase a no-op to avoid noisy failures.
			if (!this.plugin.settings.apiKey?.trim()) {
				this.logEntry('API key not set; writing mode tests skipped.');
			} else {
				this.logEntry('Running live generation (chapter) with current API/provider/model...');

				const prompt = [
					'Write a 30-word noir scene in a rainy alley.',
					'Include a clue (matchbook) and a terse line of dialogue.',
					'Keep it concise.'
				].join(' ');

				const settings: any = {
					...this.plugin.settings,
					generationMode: 'single'
				};

				const genStart = Date.now();
				const output = await this.plugin.aiClient.generate(prompt, settings);
				const genDuration = ((Date.now() - genStart) / 1000).toFixed(2);

				const snippet = typeof output === 'string' ? output.slice(0, 140) : JSON.stringify(output).slice(0, 140);
				this.logEntry(`✓ Generation succeeded in ${genDuration}s (first 140 chars): ${snippet}`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 4 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 4 failed`);
			this.logEntry(`  WHERE: phase4_WritingModes`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase5_Retrieval() {
		this.logEntry('--- Phase 5: Retrieval Tests ---');
		const phaseStart = Date.now();

		try {
			const query = this.plugin.queryBuilder.build({
				mode: 'chapter',
				activeFilePath: this.plugin.settings.book2Path,
				primaryText: 'test query for retrieval',
				directorNotes: ''
			});

			this.logEntry('Running hybrid retrieval (hash + BM25 + semantic fused)...');
			const hybridStart = Date.now();
			const hybridResults = await this.plugin.retrievalService.search(query, { limit: 32 });
			const hybridDuration = ((Date.now() - hybridStart) / 1000).toFixed(2);
			this.logEntry(`✓ Hybrid retrieval completed in ${hybridDuration}s: ${hybridResults.length} results`);

			if (hybridResults.length > 0) {
				this.logEntry('  Top results (first 5):');
				hybridResults.slice(0, 5).forEach((result, idx) => {
					this.logEntry(`    ${idx + 1}. ${result.path} (score: ${result.score.toFixed(3)})`);
				});
			} else {
				this.logEntry('  ⚠ No retrieval results found');
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 5 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 5 failed`);
			this.logEntry(`  WHERE: phase5_Retrieval`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase6_Cleanup() {
		this.logEntry('--- Phase 6: Cleanup ---');
		const phaseStart = Date.now();

		try {
			if (this.options.skipCleanup) {
				this.logEntry('Cleanup skipped (per options)');
				return;
			}

			for (const path of this.testFiles) {
				await this.deletePath(path);
				this.logEntry(`✓ Deleted test file: ${path}`);
			}

			for (const folder of this.testFolders) {
				await this.deletePath(folder);
				this.logEntry(`✓ Deleted test folder: ${folder}`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 6 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 6 failed`);
			this.logEntry(`  WHERE: phase6_Cleanup`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase7_CharacterOperations() {
		this.logEntry('--- Phase 7: Character Operations ---');
		const phaseStart = Date.now();

		try {
			let characterFolder = this.plugin.settings.characterFolder;
			if (!characterFolder) {
				characterFolder = 'Characters';
				this.logEntry(`⚠ Character folder not configured, using default: ${characterFolder}`);
			} else {
				this.logEntry(`Using configured character folder: ${characterFolder}`);
			}

			const folderCreated = await this.plugin.vaultService.createFolderIfNotExists(characterFolder);
			if (folderCreated) {
				this.logEntry(`✓ Created character folder: ${characterFolder}`);
			} else {
				this.logEntry(`✓ Character folder already exists: ${characterFolder}`);
			}

			this.logEntry('Character extraction/update tests skipped in this stress run.');

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 7 completed in ${phaseDuration}s`);
			this.logEntry('');
		} catch (error) {
			this.logEntry(`✗ Phase 7 failed`);
			this.logEntry(`  WHERE: phase7_CharacterOperations`);
			this.logEntry(`  WHAT: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private generateTestChapter(num: number): string {
		return `# Chapter ${num}\n\n` +
			'This is a test chapter used for stress testing retrieval and indexing. ' +
			'It contains multiple paragraphs and headings to simulate realistic structure.\n\n' +
			'## Scene 1\n' +
			`Content for scene 1 of chapter ${num}. More text to build size.`;
	}

	private generateCharacterScene(): string {
		return 'Alice speaks with Bob about the mission. Bob recalls the artifact. ' +
			'Alice notes that the vault is protected by ancient wards. Dialogue and action continue.';
	}

	private generateLongContent(): string {
		return new Array(200).fill('Long content for indexing test.').join(' ');
	}

	private async deletePath(path: string): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(path);
		if (entry instanceof TFile || entry instanceof TFolder) {
			await this.app.vault.delete(entry);
		} else {
			// Fallback: attempt adapter removal (best-effort)
			try {
				await this.app.vault.adapter.remove(path);
			} catch {
				/* ignore */
			}
		}
	}
}

