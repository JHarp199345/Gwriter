import React, { useEffect, useState } from 'react';
import { Notice } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { VaultBrowser } from './VaultBrowser';
import { EditorPanel } from './EditorPanel';
import { DirectorNotes } from './DirectorNotes';
import { ModeSelector } from './ModeSelector';
import { MultiModelResult } from '../services/AIClient';
import { TextChunker } from '../services/TextChunker';
import { fnv1a32 } from '../services/ContentHash';
import { estimateTokens } from '../services/TokenEstimate';
import { FilePickerModal } from './FilePickerModal';
import { parseCharacterRoster, rosterToBulletList } from '../services/CharacterRoster';
import { showConfirmModal } from './ConfirmModal';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

const DEFAULT_REWRITE_INSTRUCTIONS =
	'[INSTRUCTION: The Scene Summary is a rough summary OR directions. Rewrite it into a fully detailed dramatic scene. Include dialogue, sensory details, and action. Do not summarize; write the prose. Match the tone, rhythm, and pacing of the provided context.]';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const formatUnknownForUi = (value: unknown): string => {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	};

	const [mode, setMode] = useState<Mode>('chapter');
	const [isVaultPanelCollapsed, setIsVaultPanelCollapsed] = useState<boolean>(() => {
		try {
			return window.localStorage.getItem('writing-dashboard:vaultPanelCollapsed') === '1';
		} catch {
			return false;
		}
	});
	const [selectedText, setSelectedText] = useState('');
	const [directorNotes, setDirectorNotes] = useState('');
	const [minWords, setMinWords] = useState(2000);
	const [maxWords, setMaxWords] = useState(6000);
	const [generatedText, setGeneratedText] = useState('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationStage, setGenerationStage] = useState<string>('');
	const [error, setError] = useState<string | null>(null);
	const [promptTokenEstimate, setPromptTokenEstimate] = useState<number | null>(null);
	const [promptCharCount, setPromptCharCount] = useState<number | null>(null);
	const [bulkSourcePath, setBulkSourcePath] = useState<string | undefined>(
		plugin.settings.characterExtractionSourcePath
	);

	// Chapter mode default instructions
	useEffect(() => {
		const trimmed = (directorNotes || '').trim();
		const isBlank = trimmed.length === 0;
		const chapterDefault = DEFAULT_REWRITE_INSTRUCTIONS.trim();
		const characterDefault = (plugin.settings.defaultCharacterExtractionInstructions || '').trim();

		// Two-way overwrite between the two defaults:
		// - entering chapter: if blank OR still the character-update default, set chapter default
		// - entering character-update: if blank OR still the chapter default, set character default
		if (mode === 'chapter') {
			if (isBlank || (characterDefault && trimmed === characterDefault)) {
				setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS);
			}
		} else if (mode === 'character-update') {
			if (isBlank || trimmed === chapterDefault) {
				setDirectorNotes(plugin.settings.defaultCharacterExtractionInstructions || '');
			}
		} else if (mode === 'micro-edit') {
			// Always clear so the placeholder guidance is visible.
			setDirectorNotes('');
		}
		// Only run when mode changes (intentional)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: defaults apply only on mode switch
	}, [mode]);

	// Keep bulk source label in sync when entering character mode (settings changes won't otherwise re-render)
	useEffect(() => {
		if (mode === 'character-update') {
			setBulkSourcePath(plugin.settings.characterExtractionSourcePath);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sync label only on mode switch
	}, [mode]);

	useEffect(() => {
		try {
			window.localStorage.setItem(
				'writing-dashboard:vaultPanelCollapsed',
				isVaultPanelCollapsed ? '1' : '0'
			);
		} catch {
			// ignore
		}
	}, [isVaultPanelCollapsed]);

	const handleGenerate = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('');
		try {
			let prompt: string;
			let context;

			if (mode === 'chapter') {
				context = await plugin.contextAggregator.getChapterContext();
				const min = Math.max(100, Math.min(minWords, maxWords));
				const max = Math.max(100, Math.max(minWords, maxWords));
				prompt = plugin.promptEngine.buildChapterPrompt(
					context,
					directorNotes,
					selectedText,
					min,
					max
				);
			} else {
				// micro-edit
				context = await plugin.contextAggregator.getMicroEditContext(selectedText);
				prompt = plugin.promptEngine.buildMicroEditPrompt(selectedText, directorNotes, context);
			}

			// Estimate prompt size and warn if it may exceed the model's context window
			const estimatedTokens = estimateTokens(prompt);
			setPromptTokenEstimate(estimatedTokens);
			setPromptCharCount(prompt.length);
			const limit = plugin.settings.contextTokenLimit ?? 128000;
			if (estimatedTokens > limit) {
				const proceed = await showConfirmModal(plugin.app, {
					title: 'Large prompt warning',
					message:
						`Estimated prompt size: ~${estimatedTokens.toLocaleString()} tokens (limit: ${limit.toLocaleString()}).\n\n` +
						`This may exceed your model context window and cause truncation/failure.\n\n` +
						`Continue anyway?`,
					confirmText: 'Continue',
					cancelText: 'Cancel'
				});
				if (!proceed) {
					setGenerationStage('');
					return;
				}
			}

			if (plugin.settings.generationMode === 'multi') {
				setGenerationStage('Initializing multi-model generation...');
				const result = await plugin.aiClient.generate(prompt, plugin.settings as typeof plugin.settings & { generationMode: 'multi' });
				
				// Show stages if available
				if (result.stages) {
					setGenerationStage(`Finalizing (${Object.keys(result.stages).length} stages completed)...`);
				}
				
				setGeneratedText(result.primary);
			} else {
				setGenerationStage('Generating...');
				const result = await plugin.aiClient.generate(prompt, plugin.settings as typeof plugin.settings & { generationMode: 'single' });
				setGeneratedText(result);
			}
			
			setGenerationStage('');
		} catch (err: unknown) {
			const message = formatUnknownForUi(err);
			setError(message || 'Generation failed');
			console.error('Generation error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleUpdateCharacters = async () => {
		if (!selectedText) {
			setError('Please select text to extract character information from');
			return;
		}

		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Extracting character information...');
		try {
			const getEffectiveCharacterInstructions = (raw: string): string => {
				const trimmed = (raw || '').trim();
				const hasLetters = /[A-Za-z]/.test(trimmed);
				if (trimmed.length < 30 || !hasLetters) {
					return (plugin.settings.defaultCharacterExtractionInstructions || '').trim();
				}
				return trimmed;
			};

			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);
			const instructions = getEffectiveCharacterInstructions(directorNotes);
			const prompt = plugin.promptEngine.buildCharacterExtractionPrompt(
				selectedText,
				characterNotes,
				storyBible,
				instructions
			);
			
			// Character extraction always uses single mode
			const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
			const extractionResult = await plugin.aiClient.generate(prompt, singleModeSettings);
			const updates = plugin.characterExtractor.parseExtraction(extractionResult);
			
			// Apply updates to character files
			await plugin.vaultService.updateCharacterNotes(updates);
			setError(null);
			setGenerationStage('');
			// Show success message
			new Notice(`Updated ${updates.length} character note(s)`);
		} catch (err: unknown) {
			const message = formatUnknownForUi(err);
			setError(message || 'Character extraction failed');
			console.error('Character update error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleSelectCharacterExtractionSource = () => {
		const files = plugin.app.vault.getMarkdownFiles();
		const modal = new FilePickerModal({
			app: plugin.app,
			files,
			placeholder: 'Pick the manuscript to process for bulk character extraction (Book 1, Book 2, etc.)',
			onPick: async (file) => {
				plugin.settings.characterExtractionSourcePath = file.path;
				await plugin.saveSettings();
				setBulkSourcePath(file.path);
			}
		});
		modal.open();
	};

	const handleClearCharacterExtractionSource = async () => {
		delete plugin.settings.characterExtractionSourcePath;
		await plugin.saveSettings();
		setBulkSourcePath(undefined);
	};

	const handleProcessEntireBook = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Loading book...');
		
		const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
		const getErrorMessage = (err: unknown) => formatUnknownForUi(err);

		const withRetries = async <T,>(
			label: string,
			fn: () => Promise<T>,
			maxRetries = 2
		): Promise<T> => {
			let attempt = 0;
			while (true) {
				try {
					return await fn();
				} catch (err) {
					attempt++;
					if (attempt > maxRetries) throw err;
					setGenerationStage(`${label} (retry ${attempt}/${maxRetries})...`);
					// backoff: 600ms, 1200ms, ...
					await sleep(600 * attempt);
				}
			}
		};

		try {
			// Read the entire book file
			const bookPath = plugin.settings.characterExtractionSourcePath || plugin.settings.book2Path;
			const bookText = await plugin.contextAggregator.readFile(bookPath);
			
			if (!bookText || bookText.trim().length === 0) {
				setError('Book file is empty or not found');
				return;
			}

			// Skip if unchanged since last processing
			const hashNow = fnv1a32(bookText);
			const fileState = plugin.settings.fileState?.[bookPath] || {};

			// Split by H1 chapters for better coherence; fallback to word chunks if no headings exist
			const chapters = TextChunker.splitByH1(bookText);
			const totalChapters = chapters.length;
			if (totalChapters === 0) {
				setError('No content found to process.');
				return;
			}
			
			setGenerationStage(`Pass 1/2: Building roster from ${totalChapters} chapter(s)...`);
			
			// Get context for extraction
			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);

			// Decide whether we're retrying only failed chapters (same hash) or doing a full run.
			const meta = fileState.bulkProcessMeta;
			const canRetryFailures =
				meta &&
				meta.hash === hashNow &&
				typeof meta.rosterText === 'string' &&
				Array.isArray(meta.failedChapterIndices) &&
				meta.failedChapterIndices.length > 0;

			// Skip only when unchanged AND there are no recorded failures to retry
			if (fileState.lastProcessHash === hashNow && !canRetryFailures) {
				setError(null);
				setGenerationStage('');
				new Notice('Book unchanged since last processing — skipping.');
				return;
			}

			let rosterText: string;
			const failedChapterIndices: number[] = [];

			if (canRetryFailures) {
				rosterText = meta!.rosterText!;
				setGenerationStage(
					`Retrying ${meta!.failedChapterIndices!.length} failed chapter(s) (no restart)...`
				);
			} else {
				setGenerationStage(`Pass 1/2: Building roster from ${totalChapters} chapter(s)...`);

				// Pass 1: global roster (high recall)
				const rosterEntries: ReturnType<typeof parseCharacterRoster> = [];
				for (let i = 0; i < chapters.length; i++) {
					const label = `Pass 1/2: Roster scan ${i + 1} of ${totalChapters}`;
					setGenerationStage(`${label}...`);
					const passage = chapters[i].fullText;
					const rosterPrompt = plugin.promptEngine.buildCharacterRosterPrompt(passage, storyBible);
					const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
					try {
						const rosterResult = await withRetries(label, async () => {
							return await plugin.aiClient.generate(rosterPrompt, singleModeSettings);
						}, 2);
						rosterEntries.push(...parseCharacterRoster(rosterResult));
					} catch (err: unknown) {
						console.error(`Roster scan failed at chapter ${i + 1}:`, err);
						// Continue; roster is best-effort, failures here shouldn't kill the whole run.
					}
				}
				// De-dupe roster again after aggregation
				const mergedRoster = parseCharacterRoster(rosterToBulletList(rosterEntries));
				rosterText = rosterToBulletList(mergedRoster);

				// Persist roster immediately so if extraction fails, rerun can retry without re-roster
				plugin.settings.fileState = plugin.settings.fileState || {};
				plugin.settings.fileState[bookPath] = {
					...(plugin.settings.fileState[bookPath] || {}),
					bulkProcessMeta: {
						hash: hashNow,
						rosterText,
						failedChapterIndices: []
					}
				};
				await plugin.saveSettings();
			}

			setGenerationStage(`Pass 2/2: Extracting character updates from ${totalChapters} chapter(s)...`);

			// Pass 2: per-chapter extraction using roster + strict parsing
			const allUpdates: Map<string, string[]> = new Map();
			const chapterIndicesToProcess = canRetryFailures
				? meta!.failedChapterIndices!
				: chapters.map((_, idx) => idx);

			for (let k = 0; k < chapterIndicesToProcess.length; k++) {
				const i = chapterIndicesToProcess[k];
				const label = `Pass 2/2: Chapter ${i + 1} of ${totalChapters}`;
				setGenerationStage(`${label}...`);
				const passage = chapters[i].fullText;
				const prompt = plugin.promptEngine.buildCharacterExtractionPromptWithRoster({
					passage,
					roster: rosterText,
					characterNotes,
					storyBible
				});
				const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
				try {
					const extractionResult = await withRetries(label, async () => {
						return await plugin.aiClient.generate(prompt, singleModeSettings);
					}, 3);
					const updates = plugin.characterExtractor.parseExtraction(extractionResult, { strict: true });
					for (const update of updates) {
						if (!allUpdates.has(update.character)) allUpdates.set(update.character, []);
						allUpdates.get(update.character)!.push(update.update);
					}
				} catch (err: unknown) {
					console.error(`${label} failed:`, err);
					failedChapterIndices.push(i);
				}
			}
			
			// Combine updates for each character
			const aggregatedUpdates = Array.from(allUpdates.entries()).map(([character, updates]) => ({
				character,
				update: updates.join('\n\n---\n\n')
			}));
			
			// Apply updates to character files
			setGenerationStage('Saving character updates...');
			await plugin.vaultService.updateCharacterNotes(aggregatedUpdates);

			// Record processing hash/timestamp
			plugin.settings.fileState = plugin.settings.fileState || {};
			plugin.settings.fileState[bookPath] = {
				...(plugin.settings.fileState[bookPath] || {}),
				lastProcessHash: hashNow,
				lastProcessedAt: new Date().toISOString(),
				bulkProcessMeta: {
					hash: hashNow,
					rosterText,
					failedChapterIndices
				}
			};
			await plugin.saveSettings();
			
			setError(null);
			setGenerationStage('');
			if (failedChapterIndices.length > 0) {
				new Notice(
					`Processed book and updated ${aggregatedUpdates.length} character note(s). ` +
						`${failedChapterIndices.length} chapter(s) failed; re-run to retry failures.`
				);
			} else {
				new Notice(`Processed book and updated ${aggregatedUpdates.length} character note(s)`);
			}
		} catch (err: unknown) {
			setError(getErrorMessage(err) || 'Processing entire book failed');
			console.error('Process entire book error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleChunkSelectedFile = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Chunking file...');
		
		try {
			// Chunk is file-based: always chunk the current note file (not the dashboard text box)
			const sourceFilePath = plugin.lastOpenedMarkdownPath;
			if (!sourceFilePath) {
				setError('No active note detected. Open the note you want to chunk first.');
				return;
			}

			const textToChunk = await plugin.contextAggregator.readFile(sourceFilePath);
			setGenerationStage(`Reading ${sourceFilePath}...`);
			
			if (!textToChunk || textToChunk.trim().length === 0) {
				setError('No text to chunk. Ensure the note has content.');
				return;
			}

			// Only rebuild chunks when content changed
			const hashNow = fnv1a32(textToChunk);
			const prevState = plugin.settings.fileState?.[sourceFilePath];
			if (prevState?.lastChunkHash === hashNow) {
				setError(null);
				setGenerationStage('');
				new Notice('Chunks are up to date — no rebuild needed.');
				return;
			}
			
			const wordCount = TextChunker.getWordCount(textToChunk);
			setGenerationStage(`Chunking ${wordCount} words into 500-word chunks...`);
			
			// Chunk the text (overwrite mode) and clean up extra old chunks
			const result = await plugin.vaultService.chunkFile(sourceFilePath, textToChunk, 500, true);

			// Record chunk hash/timestamp
			plugin.settings.fileState = plugin.settings.fileState || {};
			plugin.settings.fileState[sourceFilePath] = {
				...(plugin.settings.fileState[sourceFilePath] || {}),
				lastChunkHash: hashNow,
				lastChunkedAt: new Date().toISOString(),
				lastChunkCount: result.totalChunks
			};
			await plugin.saveSettings();
			
			setError(null);
			setGenerationStage('');
			const written = result.created + result.overwritten;
			new Notice(
				`Chunks rebuilt (${result.totalChunks} total; ${written} written; ${result.deletedExtra} deleted)`
			);
		} catch (err: unknown) {
			const message = formatUnknownForUi(err);
			setError(message || 'Chunking failed');
			console.error('Chunking error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleCopyToClipboard = async () => {
		if (generatedText) {
			try {
				await navigator.clipboard.writeText(generatedText);
				new Notice('Copied to clipboard');
			} catch (err) {
				console.error('Copy failed:', err);
				new Notice('Copy failed');
			}
		}
	};

	return (
		<div className="writing-dashboard">
			{!plugin.settings.apiKey && (
				<div className="backend-warning">
					⚠️ Please configure your API key in settings → writing dashboard
				</div>
			)}
			<div className="dashboard-layout">
				<div className={`sidebar ${isVaultPanelCollapsed ? 'collapsed' : ''}`}>
					<VaultBrowser
						plugin={plugin}
						collapsed={isVaultPanelCollapsed}
						onToggleCollapsed={setIsVaultPanelCollapsed}
					/>
				</div>
				<div className="main-workspace">
					<EditorPanel 
						plugin={plugin}
						mode={mode}
						selectedText={selectedText}
						onSelectionChange={setSelectedText}
						generatedText={generatedText}
						onCopy={handleCopyToClipboard}
					/>
					{mode === 'chapter' && (
						<div className="word-count-input">
							<label>Target word range:</label>
							<input
								type="number"
								value={minWords}
								onChange={(e) => {
									const v = parseInt(e.target.value) || 0;
									const nextMin = Math.max(100, Math.min(2000000, v));
									setMinWords(nextMin);
									if (nextMin > maxWords) setMaxWords(nextMin);
								}}
								min="100"
								max="2000000"
							/>
							<span style={{ margin: '0 8px' }}>to</span>
							<input
								type="number"
								value={maxWords}
								onChange={(e) => {
									const v = parseInt(e.target.value) || 0;
									const nextMax = Math.max(100, Math.min(2000000, v));
									setMaxWords(nextMax);
									if (nextMax < minWords) setMinWords(nextMax);
								}}
								min="100"
								max="2000000"
							/>
						</div>
					)}
					<DirectorNotes 
						value={directorNotes}
						onChange={setDirectorNotes}
						mode={mode}
						onResetToDefault={mode === 'chapter' ? () => setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS) : undefined}
					/>
					{promptTokenEstimate !== null && (
						<div className="generation-status">
							Estimated prompt size: ~{promptTokenEstimate.toLocaleString()} tokens
							{promptCharCount !== null ? ` (${promptCharCount.toLocaleString()} chars)` : ''}
							{plugin.settings.contextTokenLimit && promptTokenEstimate > plugin.settings.contextTokenLimit
								? ` — exceeds warning limit (${plugin.settings.contextTokenLimit.toLocaleString()})`
								: ''}
						</div>
					)}
					{error && (
						<div className="error-message">
							❌ {error}
						</div>
					)}
					{isGenerating && generationStage && (
						<div className="generation-status">
							⏳ {generationStage}
						</div>
					)}
					{mode === 'character-update' && (
						<div className="generation-status">
							Bulk source: {bulkSourcePath || plugin.settings.book2Path}
							{bulkSourcePath ? ' (custom)' : ' (book main path)'}
						</div>
					)}
					<div className="controls">
						{mode !== 'character-update' && (
							<button 
								onClick={handleGenerate}
								disabled={isGenerating || !plugin.settings.apiKey}
								className="generate-button"
							>
								{isGenerating ? 'Generating...' : mode === 'chapter' ? 'Generate chapter' : 'Generate edit'}
							</button>
						)}
						{mode === 'character-update' && (
							<>
								<button 
									onClick={handleUpdateCharacters}
									disabled={isGenerating || !selectedText || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Update characters
								</button>
								<button
									onClick={handleSelectCharacterExtractionSource}
									disabled={isGenerating}
									className="update-characters-button"
								>
									Select file to process
								</button>
								<button
									onClick={handleClearCharacterExtractionSource}
									disabled={isGenerating || !plugin.settings.characterExtractionSourcePath}
									className="update-characters-button"
								>
									Use book main path
								</button>
								<button 
									onClick={handleProcessEntireBook}
									disabled={isGenerating || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Process entire book
								</button>
								<button 
									onClick={handleChunkSelectedFile}
									disabled={isGenerating || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Chunk current note
								</button>
							</>
						)}
					</div>
					<ModeSelector mode={mode} onChange={setMode} />
				</div>
			</div>
		</div>
	);
};

