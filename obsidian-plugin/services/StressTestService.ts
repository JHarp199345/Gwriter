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
		this.logEntry('=== PLUGIN CONFIGURATION ===');
		this.logEntry(`API Key: ${this.plugin.settings.apiKey ? '✓ Configured' : '✗ Missing'}`);
		this.logEntry(`API Provider: ${this.plugin.settings.apiProvider || 'Not set'}`);
		this.logEntry(`Model: ${this.plugin.settings.model || 'Not set'}`);
		this.logEntry(`Generation Mode: ${this.plugin.settings.generationMode || 'single'}`);
		this.logEntry(`Book Main Path: ${this.plugin.settings.book2Path || 'Not configured'}`);
		this.logEntry(`Story Bible Path: ${this.plugin.settings.storyBiblePath || 'Not configured'}`);
		this.logEntry(`Character Folder: ${this.plugin.settings.characterFolder || 'Not configured (will use default: Characters)'}`);
		this.logEntry(`Semantic Retrieval: ${this.plugin.settings.retrievalEnableSemanticIndex ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`Embedding Backend: ${this.plugin.settings.retrievalEmbeddingBackend || 'minilm'}`);
		this.logEntry(`BM25 Retrieval: ${this.plugin.settings.retrievalEnableBm25 ? 'Enabled' : 'Disabled'}`);
		this.logEntry(`Index Paused: ${this.plugin.settings.retrievalIndexPaused ? 'Yes' : 'No'}`);
		this.logEntry(`Retrieval Top K: ${this.plugin.settings.retrievalTopK || 24}`);
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

			// Phase 7: Character Operations (if API key available)
			if (this.plugin.settings.apiKey) {
				await this.phase7_CharacterOperations();
			} else {
				this.logEntry('Phase 7: Skipped (no API key configured)');
			}

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
			this.logEntry('=== Indexing Configuration ===');
			this.logEntry(`Semantic retrieval enabled: ${this.plugin.settings.retrievalEnableSemanticIndex}`);
			this.logEntry(`Embedding backend: ${this.plugin.settings.retrievalEmbeddingBackend || 'minilm'}`);
			this.logEntry(`Index paused: ${this.plugin.settings.retrievalIndexPaused}`);
			this.logEntry(`Chunk size: ${this.plugin.settings.retrievalChunkWords || 500} words`);
			this.logEntry(`Chunk overlap: ${this.plugin.settings.retrievalChunkOverlapWords || 100} words`);
			this.logEntry(`Chunk heading level: ${this.plugin.settings.retrievalChunkHeadingLevel || 'h1'}`);
			this.logEntry('');

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
				this.logEntry(`Embedding backend: ${this.plugin.settings.retrievalEmbeddingBackend || 'minilm'}`);
				
				// Check model readiness for minilm backend
				if (this.plugin.settings.retrievalEmbeddingBackend === 'minilm') {
					this.logEntry('Checking embedding model readiness...');
					try {
						const model = (this.plugin.embeddingsIndex as any)?.model;
						if (model && typeof model.isReady === 'function') {
							const isReady = await model.isReady();
							this.logEntry(`  Model ready: ${isReady}`);
							if (!isReady) {
								this.logEntry(`  ⚠ Model not ready - attempting to load (this may take time on first run)...`);
							}
						} else {
							this.logEntry(`  ⚠ Cannot check model readiness (isReady method not available)`);
						}
					} catch (modelErr) {
						this.logEntry(`  ✗ Model readiness check failed: ${modelErr instanceof Error ? modelErr.message : String(modelErr)}`);
					}
				}
				
				this.plugin.embeddingsIndex.enqueueFullRescan();
				this.plugin.bm25Index.enqueueFullRescan();

				// Check status multiple times to see progress
				for (let i = 0; i < 10; i++) {
					await new Promise(resolve => setTimeout(resolve, 1000));
					const status = this.plugin.embeddingsIndex?.getStatus?.();
					if (status) {
						this.logEntry(`Index status after ${i + 1}s: ${status.indexedFiles} files, ${status.indexedChunks} chunks, ${status.queued} queued`);
						
						// If queue is empty and we have files, check if they're actually indexed
						if (status.queued === 0 && status.indexedFiles === 0 && allFiles.length > 0 && i >= 3) {
							// Check console for worker logs
							this.logEntry(`  ⚠ Queue empty but no files indexed - check browser console for worker logs`);
							break;
						}
						
						// If we're making progress, continue
						if (status.indexedFiles > 0 || status.queued === 0) {
							break;
						}
					}
				}
				
				const statusFinal = this.plugin.embeddingsIndex?.getStatus?.();
				this.logEntry(`Final index status: ${statusFinal ? `${statusFinal.indexedFiles} files, ${statusFinal.indexedChunks} chunks, ${statusFinal.queued} queued` : 'N/A'}`);

				// Check what's actually in the index
				const indexedPaths = this.plugin.embeddingsIndex?.getIndexedPaths?.() || [];
				const allChunks = this.plugin.embeddingsIndex?.getAllChunks?.() || [];
				this.logEntry(`Actual indexed paths (getIndexedPaths): ${indexedPaths.length}`);
				this.logEntry(`Actual chunks (getAllChunks): ${allChunks.length}`);
				
				if (indexedPaths.length > 0) {
					this.logEntry(`Indexed files:`);
					indexedPaths.slice(0, 10).forEach(path => {
						this.logEntry(`  - ${path}`);
					});
					if (indexedPaths.length > 10) {
						this.logEntry(`  ... and ${indexedPaths.length - 10} more`);
					}
				}

				// Check BM25 index status
				const bm25Status = this.plugin.bm25Index?.getStatus?.();
				if (bm25Status) {
					this.logEntry(`BM25 index status: ${bm25Status.indexedFiles} files, ${bm25Status.indexedChunks} chunks, ${bm25Status.queued} queued`);
				}

				if (statusFinal) {
					if (statusFinal.queued > 0) {
						this.logEntry(`⚠ WARNING: ${statusFinal.queued} files still queued - indexing may be slow or stuck`);
					}
					if (statusFinal.indexedFiles === 0 && allFiles.length > 0) {
						this.logEntry(`⚠ ERROR: Status shows 0 files but getIndexedPaths() shows ${indexedPaths.length} files`);
						this.logEntry(`  - This suggests a bug in status reporting OR chunks are being created then removed`);
						this.logEntry(`  - Index paused: ${statusFinal.paused}`);
						this.logEntry(`  - Semantic retrieval enabled: ${this.plugin.settings.retrievalEnableSemanticIndex}`);
						this.logEntry(`  - Embedding backend: ${this.plugin.settings.retrievalEmbeddingBackend || 'minilm'}`);
						this.logEntry(`  - Check browser console (F12) for detailed worker logs`);
						
						if (indexedPaths.length === 0 && allChunks.length === 0) {
							this.logEntry(`  - CONFIRMED: No chunks exist in memory - embedding generation likely failing`);
							this.logEntry(`  - Check browser console (F12) for detailed [EmbeddingsIndex] and [LocalEmbeddingModel] logs`);
							this.logEntry(`  - Common causes:`);
							this.logEntry(`    * Model loading failure (check network/disk space for model download)`);
							this.logEntry(`    * Transformers library not available (@xenova/transformers)`);
							this.logEntry(`    * WASM/Web Worker issues in browser`);
							this.logEntry(`    * Memory constraints (large model)`);
						} else if (indexedPaths.length > 0 || allChunks.length > 0) {
							this.logEntry(`  - CONFIRMED: Chunks DO exist but status is wrong - bug in getStatus()`);
						}
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
			if (!this.plugin.queryBuilder) {
				this.logEntry('⚠ QueryBuilder not available - skipping writing mode tests');
				return;
			}

			// Test 1: Chapter Generation
			this.logEntry('');
			this.logEntry('=== Test 1: Chapter Generation ===');
			try {
				this.logEntry('Building context for chapter generation...');
				const chapterQuery = this.plugin.queryBuilder.build({
					mode: 'chapter',
					activeFilePath: this.plugin.settings.book2Path,
					primaryText: 'A test scene where the protagonist discovers a hidden door in an ancient library.',
					directorNotes: 'Write in third person, maintain a suspenseful and mysterious tone. Include sensory details.'
				});
				const chapterContext = await this.plugin.contextAggregator.getChapterContext(chapterQuery);
				this.logEntry(`✓ Context aggregated: ${Object.keys(chapterContext).length} context sections`);
				
				this.logEntry('Building chapter generation prompt...');
				const chapterPrompt = this.plugin.promptEngine.buildChapterPrompt(
					chapterContext,
					'[INSTRUCTION: Rewrite the scene summary into fully detailed dramatic prose. Include dialogue, sensory details, and action.]',
					'A test scene where the protagonist discovers a hidden door in an ancient library.',
					500,
					1000
				);
				this.logEntry(`✓ Prompt built: ${chapterPrompt.length} chars (~${Math.round(chapterPrompt.length / 4)} tokens)`);
				
				this.logEntry('Calling AI for chapter generation...');
				const chapterStart = Date.now();
				const chapterResult = await this.plugin.aiClient.generate(
					chapterPrompt,
					{ ...this.plugin.settings, generationMode: 'single' as const }
				);
				const chapterDuration = ((Date.now() - chapterStart) / 1000).toFixed(2);
				const chapterText = typeof chapterResult === 'string' ? chapterResult : (chapterResult as { primary: string }).primary;
				const wordCount = chapterText.split(/\s+/).length;
				this.logEntry(`✓ Chapter generated in ${chapterDuration}s: ${chapterText.length} chars, ${wordCount} words`);
				this.logEntry(`  Preview: ${chapterText.substring(0, 150).replace(/\n/g, ' ')}...`);
			} catch (error) {
				this.logEntry(`✗ Chapter generation failed: ${error instanceof Error ? error.message : String(error)}`);
				if (error instanceof Error && error.stack) {
					this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
				}
			}

			// Test 2: Micro-Edit
			this.logEntry('');
			this.logEntry('=== Test 2: Micro-Edit ===');
			try {
				const testPassage = 'The protagonist walked through the door. They were nervous. The room was dark.';
				this.logEntry(`Selected passage: "${testPassage}"`);
				
				this.logEntry('Building context for micro-edit...');
				const microEditQuery = this.plugin.queryBuilder.build({
					mode: 'micro-edit',
					activeFilePath: this.plugin.settings.book2Path,
					primaryText: testPassage,
					directorNotes: 'Make the prose more vivid and engaging. Add sensory details and improve the pacing.'
				});
				const microEditContext = await this.plugin.contextAggregator.getMicroEditContext(testPassage, microEditQuery);
				this.logEntry(`✓ Context aggregated: ${Object.keys(microEditContext).length} context sections`);
				if (microEditContext.surrounding_before) {
					this.logEntry(`  Surrounding before: ${microEditContext.surrounding_before.split(/\s+/).length} words`);
				}
				if (microEditContext.surrounding_after) {
					this.logEntry(`  Surrounding after: ${microEditContext.surrounding_after.split(/\s+/).length} words`);
				}
				
				this.logEntry('Building micro-edit prompt...');
				const microEditPrompt = this.plugin.promptEngine.buildMicroEditPrompt(
					testPassage,
					'Make the prose more vivid and engaging. Add sensory details and improve the pacing.',
					microEditContext
				);
				this.logEntry(`✓ Prompt built: ${microEditPrompt.length} chars (~${Math.round(microEditPrompt.length / 4)} tokens)`);
				
				this.logEntry('Calling AI for micro-edit...');
				const microEditStart = Date.now();
				const microEditResult = await this.plugin.aiClient.generate(
					microEditPrompt,
					{ ...this.plugin.settings, generationMode: 'single' as const }
				);
				const microEditDuration = ((Date.now() - microEditStart) / 1000).toFixed(2);
				const microEditText = typeof microEditResult === 'string' ? microEditResult : (microEditResult as { primary: string }).primary;
				const microEditWordCount = microEditText.split(/\s+/).length;
				this.logEntry(`✓ Micro-edit generated in ${microEditDuration}s: ${microEditText.length} chars, ${microEditWordCount} words`);
				this.logEntry(`  Original: "${testPassage}"`);
				this.logEntry(`  Edited: "${microEditText.substring(0, 150).replace(/\n/g, ' ')}..."`);
			} catch (error) {
				this.logEntry(`✗ Micro-edit failed: ${error instanceof Error ? error.message : String(error)}`);
				if (error instanceof Error && error.stack) {
					this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
				}
			}

			// Test 3: Continuity Check
			this.logEntry('');
			this.logEntry('=== Test 3: Continuity Check ===');
			try {
				const testDraft = 'The protagonist entered the library. They found a book about ancient magic. The book was written in an unknown language.';
				this.logEntry(`Test draft: "${testDraft}"`);
				
				this.logEntry('Building context for continuity check...');
				const continuityQuery = this.plugin.queryBuilder.build({
					mode: 'continuity-check',
					activeFilePath: this.plugin.settings.book2Path,
					primaryText: testDraft,
					directorNotes: ''
				});
				// Continuity check uses micro-edit context (includes character notes + story bible + retrieved context)
				const continuityContext = await this.plugin.contextAggregator.getMicroEditContext(testDraft, continuityQuery);
				this.logEntry(`✓ Context aggregated: ${Object.keys(continuityContext).length} context sections`);
				
				this.logEntry('Building continuity check prompt...');
				const continuityPrompt = this.plugin.promptEngine.buildContinuityCheckPrompt({
					draft: testDraft,
					context: continuityContext,
					focus: {
						knowledge: true,
						timeline: true,
						pov: true,
						naming: true
					}
				});
				this.logEntry(`✓ Prompt built: ${continuityPrompt.length} chars (~${Math.round(continuityPrompt.length / 4)} tokens)`);
				
				this.logEntry('Calling AI for continuity check...');
				const continuityStart = Date.now();
				const continuityResult = await this.plugin.aiClient.generate(
					continuityPrompt,
					{ ...this.plugin.settings, generationMode: 'single' as const }
				);
				const continuityDuration = ((Date.now() - continuityStart) / 1000).toFixed(2);
				const continuityText = typeof continuityResult === 'string' ? continuityResult : (continuityResult as { primary: string }).primary;
				this.logEntry(`✓ Continuity check completed in ${continuityDuration}s: ${continuityText.length} chars`);
				this.logEntry(`  Result preview: ${continuityText.substring(0, 200).replace(/\n/g, ' ')}...`);
			} catch (error) {
				this.logEntry(`✗ Continuity check failed: ${error instanceof Error ? error.message : String(error)}`);
				if (error instanceof Error && error.stack) {
					this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
				}
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry('');
			this.logEntry(`Phase 4 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 4 failed: ${error instanceof Error ? error.message : String(error)}`);
			if (error instanceof Error && error.stack) {
				this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 5).join('\n  ')}`);
			}
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

	private async phase7_CharacterOperations() {
		this.logEntry('--- Phase 7: Character Operations ---');
		const phaseStart = Date.now();

		try {
			// Auto-create character folder if not configured (use default "Characters")
			let characterFolder = this.plugin.settings.characterFolder;
			if (!characterFolder) {
				characterFolder = 'Characters'; // Default folder name
				this.logEntry(`⚠ Character folder not configured, using default: ${characterFolder}`);
				this.logEntry(`  Note: This is a test-only folder. Configure in settings for production use.`);
			} else {
				this.logEntry(`Using configured character folder: ${characterFolder}`);
			}

			// Ensure character folder exists
			const folderCreated = await this.plugin.vaultService.createFolderIfNotExists(characterFolder);
			if (folderCreated) {
				this.logEntry(`✓ Created character folder: ${characterFolder}`);
			} else {
				this.logEntry(`✓ Character folder already exists: ${characterFolder}`);
			}

			// Test 1: Character Extraction from Selected Text
			this.logEntry('');
			this.logEntry('=== Test 1: Character Extraction (Selected Text) ===');
			try {
				const characterTestText = this.generateCharacterScene();
				this.logEntry(`Test text: ${characterTestText.split(/\s+/).length} words`);
				this.logEntry(`  Preview: ${characterTestText.substring(0, 100)}...`);
				
				this.logEntry('Building character extraction prompt...');
				const characterNotes = await this.plugin.contextAggregator.getCharacterNotes();
				const storyBible = await this.plugin.contextAggregator.readFile(this.plugin.settings.storyBiblePath);
				const characterQuery = this.plugin.queryBuilder.build({
					mode: 'character-update',
					activeFilePath: this.plugin.settings.book2Path,
					primaryText: characterTestText,
					directorNotes: ''
				});
				const retrievedItems = await this.plugin.retrievalService.search(characterQuery, {
					limit: this.plugin.settings.retrievalTopK ?? 24
				});
				const retrievedContext = retrievedItems.length === 0
					? '[No retrieved context]'
					: retrievedItems.map((it, idx) => `[${idx + 1}] ${it.path}\n${it.excerpt}`.trim()).join('\n\n---\n\n');
				
				const extractionPrompt = this.plugin.promptEngine.buildCharacterExtractionPrompt(
					characterTestText,
					characterNotes,
					storyBible,
					this.plugin.settings.defaultCharacterExtractionInstructions || 'Extract character information from the provided text.',
					retrievedContext
				);
				this.logEntry(`✓ Prompt built: ${extractionPrompt.length} chars (~${Math.round(extractionPrompt.length / 4)} tokens)`);
				this.logEntry(`  Retrieved context: ${retrievedItems.length} items`);
				
				this.logEntry('Calling AI for character extraction...');
				const extractionStart = Date.now();
				const extractionResult = await this.plugin.aiClient.generate(
					extractionPrompt,
					{ ...this.plugin.settings, generationMode: 'single' as const }
				);
				const extractionDuration = ((Date.now() - extractionStart) / 1000).toFixed(2);
				const extractionText = typeof extractionResult === 'string' ? extractionResult : (extractionResult as { primary: string }).primary;
				this.logEntry(`✓ Extraction completed in ${extractionDuration}s: ${extractionText.length} chars`);
				this.logEntry(`  Result preview: ${extractionText.substring(0, 200).replace(/\n/g, ' ')}...`);
				
				// Parse and update character notes
				this.logEntry('Parsing character extraction results...');
				const updates = this.plugin.characterExtractor.parseExtraction(extractionText);
				this.logEntry(`✓ Parsed ${updates.length} character update(s)`);
				updates.forEach((update, idx) => {
					this.logEntry(`  Update ${idx + 1}: ${update.character} (${update.update.split(/\s+/).length} words)`);
				});
				
				if (updates.length > 0) {
					this.logEntry('Updating character notes...');
					// Use the characterFolder variable (may be default "Characters" if not configured)
					await this.plugin.vaultService.updateCharacterNotes(updates, characterFolder);
					this.logEntry(`✓ Updated ${updates.length} character note(s) in ${characterFolder}`);
					
					// Verify files were created/updated
					for (const update of updates) {
						const characterPath = `${characterFolder}/${update.character}.md`;
						const file = this.plugin.app.vault.getAbstractFileByPath(characterPath);
						if (file instanceof TFile) {
							const content = await this.plugin.vaultService.readFile(characterPath);
							this.logEntry(`  ✓ Verified: ${characterPath} (${content.length} chars)`);
							// Log a preview of the character note
							const preview = content.substring(0, 150).replace(/\n/g, ' ');
							this.logEntry(`    Preview: ${preview}...`);
						} else {
							this.logEntry(`  ✗ Character note not found: ${characterPath}`);
						}
					}
				} else {
					this.logEntry('⚠ No character updates parsed from extraction result');
					this.logEntry(`  Extraction text length: ${extractionText.length} chars`);
					this.logEntry(`  Extraction preview: ${extractionText.substring(0, 300)}...`);
				}
			} catch (error) {
				this.logEntry(`✗ Character extraction failed: ${error instanceof Error ? error.message : String(error)}`);
				if (error instanceof Error && error.stack) {
					this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n  ')}`);
				}
			}

			const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(2);
			this.logEntry('');
			this.logEntry(`Phase 7 completed in ${phaseDuration}s`);
			this.logEntry('');

		} catch (error) {
			this.logEntry(`✗ Phase 7 failed: ${error instanceof Error ? error.message : String(error)}`);
			if (error instanceof Error && error.stack) {
				this.logEntry(`  Stack: ${error.stack.split('\n').slice(0, 5).join('\n  ')}`);
			}
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

