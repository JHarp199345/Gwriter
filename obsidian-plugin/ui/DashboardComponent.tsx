import React, { useEffect, useState } from 'react';
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

type Mode = 'chapter' | 'micro-edit' | 'character-update';

const DEFAULT_REWRITE_INSTRUCTIONS =
	'[INSTRUCTION: The Scene Summary is a rough summary OR directions. Rewrite it into a fully detailed dramatic scene. Include dialogue, sensory details, and action. Do not summarize; write the prose. Match the tone, rhythm, and pacing of the provided context.]';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [mode, setMode] = useState<Mode>('chapter');
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

	// Chapter mode default instructions
	useEffect(() => {
		if (mode === 'chapter' && (!directorNotes || directorNotes.trim().length === 0)) {
			setDirectorNotes(DEFAULT_REWRITE_INSTRUCTIONS);
		}
		// Only run when mode changes (intentional)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mode]);

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
				const proceed = window.confirm(
					`Estimated prompt size: ~${estimatedTokens.toLocaleString()} tokens (limit: ${limit.toLocaleString()}).\n\n` +
					`This may exceed your model context window and cause truncation/failure.\n\n` +
					`Continue anyway?`
				);
				if (!proceed) {
					setGenerationStage('');
					return;
				}
			}

			if (plugin.settings.generationMode === 'multi') {
				setGenerationStage('Initializing multi-model generation...');
				const result = await plugin.aiClient.generate(prompt, plugin.settings) as MultiModelResult;
				
				// Show stages if available
				if (result.stages) {
					setGenerationStage(`Finalizing (${Object.keys(result.stages).length} stages completed)...`);
				}
				
				setGeneratedText(result.primary);
			} else {
				setGenerationStage('Generating...');
				const result = await plugin.aiClient.generate(prompt, plugin.settings) as string;
				setGeneratedText(result);
			}
			
			setGenerationStage('');
		} catch (err: any) {
			setError(err.message || 'Generation failed');
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
			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);
			const prompt = plugin.promptEngine.buildCharacterExtractionPrompt(selectedText, characterNotes, storyBible);
			
			// Character extraction always uses single mode
			const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
			const extractionResult = await plugin.aiClient.generate(prompt, singleModeSettings) as string;
			const updates = plugin.characterExtractor.parseExtraction(extractionResult);
			
			// Apply updates to character files
			await plugin.vaultService.updateCharacterNotes(updates);
			setError(null);
			setGenerationStage('');
			// Show success message
			alert(`Updated ${updates.length} character note(s)`);
		} catch (err: any) {
			setError(err.message || 'Character extraction failed');
			console.error('Character update error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleSelectCharacterExtractionSource = async () => {
		const files = plugin.app.vault.getMarkdownFiles();
		const modal = new FilePickerModal({
			app: plugin.app,
			files,
			placeholder: 'Pick the manuscript to process for bulk character extraction (Book 1, Book 2, etc.)',
			onPick: async (file) => {
				plugin.settings.characterExtractionSourcePath = file.path;
				await plugin.saveSettings();
			}
		});
		modal.open();
	};

	const handleClearCharacterExtractionSource = async () => {
		delete plugin.settings.characterExtractionSourcePath;
		await plugin.saveSettings();
	};

	const handleProcessEntireBook = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
		setGenerationStage('Loading book...');
		
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
			if (fileState.lastProcessHash === hashNow) {
				setError(null);
				setGenerationStage('');
				alert('Book unchanged since last processing — skipping.');
				return;
			}

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

			// Pass 1: global roster (high recall)
			const rosterEntries: ReturnType<typeof parseCharacterRoster> = [];
			for (let i = 0; i < chapters.length; i++) {
				setGenerationStage(`Pass 1/2: Roster scan ${i + 1} of ${totalChapters}...`);
				const passage = chapters[i].fullText;
				const rosterPrompt = plugin.promptEngine.buildCharacterRosterPrompt(passage, storyBible);
				const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
				const rosterResult = await plugin.aiClient.generate(rosterPrompt, singleModeSettings) as string;
				rosterEntries.push(...parseCharacterRoster(rosterResult));
			}
			// De-dupe roster again after aggregation
			const mergedRoster = parseCharacterRoster(rosterToBulletList(rosterEntries));
			const rosterText = rosterToBulletList(mergedRoster);

			setGenerationStage(`Pass 2/2: Extracting character updates from ${totalChapters} chapter(s)...`);

			// Pass 2: per-chapter extraction using roster + strict parsing
			const allUpdates: Map<string, string[]> = new Map();
			for (let i = 0; i < chapters.length; i++) {
				setGenerationStage(`Pass 2/2: Chapter ${i + 1} of ${totalChapters}...`);
				const passage = chapters[i].fullText;
				const prompt = plugin.promptEngine.buildCharacterExtractionPromptWithRoster({
					passage,
					roster: rosterText,
					characterNotes,
					storyBible
				});
				const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
				const extractionResult = await plugin.aiClient.generate(prompt, singleModeSettings) as string;
				const updates = plugin.characterExtractor.parseExtraction(extractionResult, { strict: true });
				for (const update of updates) {
					if (!allUpdates.has(update.character)) allUpdates.set(update.character, []);
					allUpdates.get(update.character)!.push(update.update);
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
				lastProcessedAt: new Date().toISOString()
			};
			await plugin.saveSettings();
			
			setError(null);
			setGenerationStage('');
			alert(`Processed entire book and updated ${aggregatedUpdates.length} character note(s)`);
		} catch (err: any) {
			setError(err.message || 'Processing entire book failed');
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
				alert('Chunks are up to date — no rebuild needed.');
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
			alert(
				`Chunks rebuilt for ${sourceFilePath}\n\n` +
				`- Total chunks: ${result.totalChunks}\n` +
				`- Written: ${written} (overwritten ${result.overwritten}, created ${result.created})\n` +
				`- Deleted extra: ${result.deletedExtra}\n\n` +
				`Folder: ${result.folder}/`
			);
		} catch (err: any) {
			setError(err.message || 'Chunking failed');
			console.error('Chunking error:', err);
			setGenerationStage('');
		} finally {
			setIsGenerating(false);
		}
	};

	const handleCopyToClipboard = () => {
		if (generatedText) {
			navigator.clipboard.writeText(generatedText);
			alert('Copied to clipboard!');
		}
	};

	return (
		<div className="writing-dashboard">
			{!plugin.settings.apiKey && (
				<div className="backend-warning">
					⚠️ Please configure your API key in Settings → Writing Dashboard
				</div>
			)}
			<div className="dashboard-layout">
				<div className="sidebar">
					<VaultBrowser plugin={plugin} />
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
							<label>Target Word Range:</label>
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
							Bulk source: {plugin.settings.characterExtractionSourcePath || plugin.settings.book2Path}
							{plugin.settings.characterExtractionSourcePath ? ' (custom)' : ' (Book Main Path)'}
						</div>
					)}
					<div className="controls">
						{mode !== 'character-update' && (
							<button 
								onClick={handleGenerate}
								disabled={isGenerating || !plugin.settings.apiKey}
								className="generate-button"
							>
								{isGenerating ? 'Generating...' : mode === 'chapter' ? 'Generate Chapter' : 'Generate Edit'}
							</button>
						)}
						{mode === 'character-update' && (
							<>
								<button 
									onClick={handleUpdateCharacters}
									disabled={isGenerating || !selectedText || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Update Characters
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
									Use Book Main Path
								</button>
								<button 
									onClick={handleProcessEntireBook}
									disabled={isGenerating || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Process Entire Book
								</button>
								<button 
									onClick={handleChunkSelectedFile}
									disabled={isGenerating || !plugin.settings.apiKey}
									className="update-characters-button"
								>
									Chunk Current Note
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

