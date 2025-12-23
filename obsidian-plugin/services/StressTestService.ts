import WritingDashboardPlugin from '../main';
import { TFile, TFolder } from 'obsidian';

export class StressTestService {
	private plugin: WritingDashboardPlugin;
	private log: string[] = [];
	private testFolder = 'StressTest-Temp';
	private testFiles: string[] = [];
	private testFolders: string[] = [];
	private startTime: number = 0;

	constructor(plugin: WritingDashboardPlugin) {
		this.plugin = plugin;
	}

	async runFullStressTest(): Promise<string> {
		this.log = [];
		this.startTime = Date.now();
		this.logEntry('=== WRITING DASHBOARD STRESS TEST ===');
		this.logEntry(`Started: ${new Date().toISOString()}`);
		this.logEntry(`Vault: ${this.plugin.app.vault.getName()}`);
		this.logEntry('');

		try {
			// Phase 1: Setup
			await this.phase1_Setup();

			// Phase 2: Indexing Tests
			await this.phase2_Indexing();

			// Phase 3: File Operations
			await this.phase3_FileOperations();

			// Phase 4: Writing Mode Tests (if API key available)
			if (this.plugin.settings.apiKey) {
				await this.phase4_WritingModes();
			} else {
				this.logEntry('Phase 4: Skipped (no API key configured)');
			}

			// Phase 5: Retrieval Tests
			await this.phase5_Retrieval();

		} catch (error) {
			this.logEntry(`FATAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
			this.logEntry(`Stack: ${error instanceof Error ? error.stack : 'N/A'}`);
		} finally {
			// Always cleanup
			await this.phase6_Cleanup();
		}

		const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
		this.logEntry('');
		this.logEntry('=== STRESS TEST COMPLETED ===');
		this.logEntry(`Duration: ${duration} seconds`);
		this.logEntry(`Ended: ${new Date().toISOString()}`);

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
			// Create test folder
			await this.plugin.vaultService.createFolderIfNotExists(this.testFolder);
			this.testFolders.push(this.testFolder);
			this.logEntry(`✓ Created test folder: ${this.testFolder}`);

			// Create test files with various content
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
			this.logEntry(`✗ Phase 1 failed: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	private async phase2_Indexing() {
		this.logEntry('--- Phase 2: Indexing Tests ---');
		const phaseStart = Date.now();

		try {
			// Check current index status
			const statusBefore = this.plugin.embeddingsIndex?.getStatus?.();
			this.logEntry(`Index status before: ${statusBefore ? `${statusBefore.indexedFiles} files, ${statusBefore.indexedChunks} chunks, ${statusBefore.queued} queued` : 'N/A'}`);

			// Get all markdown files including test files
			const allFiles = this.plugin.vaultService.getIncludedMarkdownFiles();
			this.logEntry(`Total markdown files in vault: ${allFiles.length}`);
			
			const testFileCount = allFiles.filter(f => f.path.startsWith(this.testFolder)).length;
			this.logEntry(`Test files created: ${testFileCount}`);

			// Check if files are being excluded
			const excludedTestFiles: string[] = [];
			for (const file of allFiles) {
				if (this.plugin.vaultService.isExcludedPath(file.path)) {
					excludedTestFiles.push(file.path);
				}
			}
			if (excludedTestFiles.length > 0) {
				this.logEntry(`⚠ WARNING: ${excludedTestFiles.length} files are excluded from indexing:`);
				excludedTestFiles.slice(0, 10).forEach(path => {
					this.logEntry(`  - ${path}`);
				});
				if (excludedTestFiles.length > 10) {
					this.logEntry(`  ... and ${excludedTestFiles.length - 10} more`);
				}
			}

			// Check retrieval profile settings
			const profiles = this.plugin.settings.retrievalProfiles || [];
			const activeProfile = profiles.find(p => p.id === this.plugin.settings.retrievalActiveProfileId);
			this.logEntry(`Active retrieval profile: ${activeProfile?.name || 'N/A'} (${activeProfile?.id || 'N/A'})`);
			this.logEntry(`Included folders: ${activeProfile?.includedFolders?.length || 0} (empty = whole vault)`);
			if (activeProfile?.includedFolders && activeProfile.includedFolders.length > 0) {
				activeProfile.includedFolders.forEach(folder => {
					this.logEntry(`  - ${folder}`);
				});
			}
			this.logEntry(`Excluded folders: ${this.plugin.settings.retrievalExcludedFolders?.length || 0}`);
			if (this.plugin.settings.retrievalExcludedFolders && this.plugin.settings.retrievalExcludedFolders.length > 0) {
				this.plugin.settings.retrievalExcludedFolders.forEach(folder => {
					this.logEntry(`  - ${folder}`);
				});
			}

			// Trigger full rescan
			if (this.plugin.settings.retrievalEnableSemanticIndex && !this.plugin.settings.retrievalIndexPaused) {
				this.logEntry('Triggering full index rescan...');
				this.plugin.embeddingsIndex.enqueueFullRescan();
				this.plugin.bm25Index.enqueueFullRescan();

				// Wait a bit and check status
				await new Promise(resolve => setTimeout(resolve, 2000));
				
				const statusAfter = this.plugin.embeddingsIndex?.getStatus?.();
				this.logEntry(`Index status after 2s: ${statusAfter ? `${statusAfter.indexedFiles} files, ${statusAfter.indexedChunks} chunks, ${statusAfter.queued} queued` : 'N/A'}`);

				// Wait more and check again
				await new Promise(resolve => setTimeout(resolve, 5000));
				
				const statusFinal = this.plugin.embeddingsIndex?.getStatus?.();
				this.logEntry(`Index status after 7s: ${statusFinal ? `${statusFinal.indexedFiles} files, ${statusFinal.indexedChunks} chunks, ${statusFinal.queued} queued` : 'N/A'}`);

				if (statusFinal) {
					if (statusFinal.queued > 0) {
						this.logEntry(`⚠ WARNING: ${statusFinal.queued} files still queued - indexing may be slow or stuck`);
					}
					if (statusFinal.indexedFiles === 0 && allFiles.length > 0) {
						this.logEntry(`⚠ ERROR: No files indexed despite ${allFiles.length} files available`);
						this.logEntry(`  - Index paused: ${statusFinal.paused}`);
						this.logEntry(`  - Semantic retrieval enabled: ${this.plugin.settings.retrievalEnableSemanticIndex}`);
					}
				}
			} else {
				this.logEntry('⚠ Indexing is disabled or paused');
				this.logEntry(`  - Semantic retrieval enabled: ${this.plugin.settings.retrievalEnableSemanticIndex}`);
				this.logEntry(`  - Index paused: ${this.plugin.settings.retrievalIndexPaused}`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 2 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 2 failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase3_FileOperations() {
		this.logEntry('--- Phase 3: File Operations ---');
		const phaseStart = Date.now();

		try {
			// Test file reading
			if (this.testFiles.length > 0) {
				const testPath = this.testFiles[0];
				const content = await this.plugin.vaultService.readFile(testPath);
				this.logEntry(`✓ Read file: ${testPath} (${content.length} chars)`);
			}

			// Test file writing
			const writeTestPath = `${this.testFolder}/write-test.md`;
			const writeContent = 'This is a write test file.';
			await this.plugin.vaultService.writeFile(writeTestPath, writeContent);
			this.testFiles.push(writeTestPath);
			this.logEntry(`✓ Write file: ${writeTestPath}`);

			// Test folder creation
			const testSubFolder = `${this.testFolder}/subfolder`;
			await this.plugin.vaultService.createFolderIfNotExists(testSubFolder);
			this.testFolders.push(testSubFolder);
			this.logEntry(`✓ Create folder: ${testSubFolder}`);

			// Test vault structure
			const structure = this.plugin.vaultService.getVaultStructure();
			this.logEntry(`✓ Vault structure: ${structure.length} items total`);

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 3 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 3 failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase4_WritingModes() {
		this.logEntry('--- Phase 4: Writing Mode Tests ---');
		const phaseStart = Date.now();

		try {
			// Test context aggregation
			if (!this.plugin.queryBuilder) {
				this.logEntry('⚠ QueryBuilder not available - skipping context aggregation test');
				return;
			}
			
			this.logEntry('Testing context aggregation...');
			const context = await this.plugin.contextAggregator.getChapterContext(
				this.plugin.queryBuilder.build({
					mode: 'chapter',
					activeFilePath: this.plugin.settings.book2Path,
					primaryText: 'Test scene summary',
					directorNotes: ''
				})
			);
			this.logEntry(`✓ Context aggregated: ${Object.keys(context).length} context sections`);

			// Test prompt building
			this.logEntry('Testing prompt building...');
			const prompt = this.plugin.promptEngine.buildChapterPrompt(
				context,
				'Test rewrite instructions',
				'Test scene summary',
				1000,
				2000
			);
			this.logEntry(`✓ Prompt built: ${prompt.length} chars`);

			// Note: We don't actually call AI to avoid costs during stress test
			this.logEntry('⚠ AI generation skipped (stress test mode)');

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 4 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 4 failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase5_Retrieval() {
		this.logEntry('--- Phase 5: Retrieval Tests ---');
		const phaseStart = Date.now();

		try {
			if (!this.plugin.settings.retrievalEnableSemanticIndex) {
				this.logEntry('⚠ Semantic retrieval disabled - skipping retrieval tests');
				return;
			}

			if (!this.plugin.queryBuilder || !this.plugin.retrievalService) {
				this.logEntry('⚠ Retrieval services not available - skipping retrieval tests');
				return;
			}

			// Test retrieval query
			this.logEntry('Testing retrieval query...');
			const query = this.plugin.queryBuilder.build({
				mode: 'chapter',
				activeFilePath: this.plugin.settings.book2Path,
				primaryText: 'test query text about characters and plot',
				directorNotes: ''
			});

			const results = await this.plugin.retrievalService.search(query, { limit: 10 });
			this.logEntry(`✓ Retrieval query returned ${results.length} results`);

			if (results.length > 0) {
				results.slice(0, 3).forEach((result, idx) => {
					this.logEntry(`  Result ${idx + 1}: ${result.path} (${result.excerpt.length} chars)`);
				});
			} else {
				this.logEntry(`⚠ No retrieval results - index may be empty or query too specific`);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 5 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 5 failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async phase6_Cleanup() {
		this.logEntry('--- Phase 6: Cleanup ---');
		const phaseStart = Date.now();

		try {
			// Delete all test files
			for (const filePath of this.testFiles) {
				try {
					const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						await this.plugin.app.vault.delete(file);
						this.logEntry(`✓ Deleted: ${filePath}`);
					}
				} catch (error) {
					this.logEntry(`⚠ Failed to delete ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// Delete test folders (in reverse order to handle nested folders)
			for (const folderPath of this.testFolders.reverse()) {
				try {
					const folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
					if (folder instanceof TFolder) {
						// Check if folder is empty
						if (folder.children.length === 0) {
							await this.plugin.app.vault.delete(folder);
							this.logEntry(`✓ Deleted folder: ${folderPath}`);
						} else {
							this.logEntry(`⚠ Folder not empty, skipping: ${folderPath}`);
						}
					}
				} catch (error) {
					this.logEntry(`⚠ Failed to delete folder ${folderPath}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// Remove test files from index if they were indexed
			for (const filePath of this.testFiles) {
				this.plugin.embeddingsIndex?.queueRemoveFile(filePath);
				this.plugin.bm25Index?.queueRemoveFile(filePath);
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry(`Phase 6 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 6 failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private generateTestChapter(num: number): string {
		return `# Chapter ${num}

This is a test chapter for stress testing the Writing Dashboard plugin.

## Scene 1

The protagonist walked through the ancient forest, feeling the weight of their mission. Trees towered overhead, their branches creating a canopy that filtered the sunlight into dappled patterns on the forest floor.

## Scene 2

A sound in the distance caught their attention. Something was moving through the underbrush, something large. The protagonist paused, hand moving to their weapon.

## Scene 3

The creature emerged from the shadows - a massive wolf with intelligent eyes. It studied the protagonist for a moment, then turned and disappeared back into the forest, leaving only the memory of its presence.

The protagonist continued on their journey, now more aware of the dangers that lurked in this place.
`;
	}

	private generateCharacterScene(): string {
		return `# Character Test Scene

This scene involves multiple characters for testing character extraction.

Ava stood at the edge of the cliff, looking down at the city below. Marcus joined her, his expression grim.

"We need to move quickly," Marcus said. "They know we're here."

Ava nodded, her mind racing through the possibilities. The mission had become more complicated than expected.

"Can we trust them?" she asked.

Marcus hesitated before answering. "We don't have a choice."

Together, they began their descent into the city, each step bringing them closer to their goal - and to danger.
`;
	}

	private generateLongContent(): string {
		const paragraphs = [
			'This is a long test document designed to test chunking and indexing.',
			'It contains multiple paragraphs that should be split into chunks.',
			'Each paragraph adds to the word count to ensure proper chunking behavior.',
			'The content is intentionally repetitive to test the indexing system.',
			'This helps verify that large files are properly processed.',
			'Chunking should break this into manageable pieces.',
			'Each chunk should be around 500 words by default.',
			'This document should create multiple chunks when indexed.',
			'Testing the chunking algorithm is important for retrieval quality.',
			'Proper chunking ensures relevant context is found during searches.'
		];

		// Repeat paragraphs to create a long document
		let content = '# Long Test Document\n\n';
		for (let i = 0; i < 20; i++) {
			content += paragraphs.join('\n\n') + '\n\n';
		}

		return content;
	}
}

