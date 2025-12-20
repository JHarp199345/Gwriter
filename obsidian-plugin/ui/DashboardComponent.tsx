import React, { useState } from 'react';
import WritingDashboardPlugin from '../main';
import { VaultBrowser } from './VaultBrowser';
import { EditorPanel } from './EditorPanel';
import { DirectorNotes } from './DirectorNotes';
import { ModeSelector } from './ModeSelector';
import { MultiModelResult } from '../services/AIClient';
import { TextChunker } from '../services/TextChunker';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [mode, setMode] = useState<Mode>('chapter');
	const [selectedText, setSelectedText] = useState('');
	const [directorNotes, setDirectorNotes] = useState('');
	const [wordCount, setWordCount] = useState(2000);
	const [generatedText, setGeneratedText] = useState('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [generationStage, setGenerationStage] = useState<string>('');
	const [error, setError] = useState<string | null>(null);

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
				prompt = plugin.promptEngine.buildChapterPrompt(context, directorNotes, wordCount);
			} else {
				// micro-edit
				context = await plugin.contextAggregator.getMicroEditContext(selectedText);
				prompt = plugin.promptEngine.buildMicroEditPrompt(selectedText, directorNotes, context);
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
			const bookText = await plugin.contextAggregator.readFile(plugin.settings.book2Path);
			
			if (!bookText || bookText.trim().length === 0) {
				setError('Book file is empty or not found');
				return;
			}

			// Chunk the book into 500-word pieces
			const chunks = TextChunker.chunkText(bookText, 500);
			const totalChunks = chunks.length;
			
			setGenerationStage(`Processing ${totalChunks} chunks...`);
			
			// Get context for extraction
			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);
			
			// Process each chunk
			const allUpdates: Map<string, string[]> = new Map();
			
			for (let i = 0; i < chunks.length; i++) {
				setGenerationStage(`Processing chunk ${i + 1} of ${totalChunks}...`);
				
				const chunk = chunks[i];
				const prompt = plugin.promptEngine.buildCharacterExtractionPrompt(chunk, characterNotes, storyBible);
				
				// Character extraction always uses single mode
				const singleModeSettings = { ...plugin.settings, generationMode: 'single' as const };
				const extractionResult = await plugin.aiClient.generate(prompt, singleModeSettings) as string;
				const updates = plugin.characterExtractor.parseExtraction(extractionResult);
				
				// Aggregate updates by character
				for (const update of updates) {
					if (!allUpdates.has(update.character)) {
						allUpdates.set(update.character, []);
					}
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
			// Determine source file - use book2Path as default
			const sourceFilePath = plugin.settings.book2Path;
			let textToChunk: string;
			
			if (selectedText && selectedText.trim().length > 0) {
				// Use selected text if available
				textToChunk = selectedText;
				setGenerationStage('Chunking selected text...');
			} else {
				// Use entire file
				textToChunk = await plugin.contextAggregator.readFile(sourceFilePath);
				setGenerationStage(`Chunking ${sourceFilePath}...`);
			}
			
			if (!textToChunk || textToChunk.trim().length === 0) {
				setError('No text to chunk. Please select text or ensure the file has content.');
				return;
			}
			
			const wordCount = TextChunker.getWordCount(textToChunk);
			setGenerationStage(`Chunking ${wordCount} words into 500-word chunks...`);
			
			// Chunk the text
			const createdFiles = await plugin.vaultService.chunkFile(sourceFilePath, textToChunk, 500);
			
			setError(null);
			setGenerationStage('');
			const folderName = sourceFilePath.replace(/\.md$/, '').replace(/\.\w+$/, '');
			alert(`Created ${createdFiles.length} chunk file(s) in ${folderName}-Chunked/`);
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
						selectedText={selectedText}
						onSelectionChange={setSelectedText}
						generatedText={generatedText}
						onCopy={handleCopyToClipboard}
					/>
					{mode === 'chapter' && (
						<div className="word-count-input">
							<label>Target Word Count:</label>
							<input
								type="number"
								value={wordCount}
								onChange={(e) => setWordCount(parseInt(e.target.value) || 2000)}
								min="100"
								max="10000"
							/>
						</div>
					)}
					<DirectorNotes 
						value={directorNotes}
						onChange={setDirectorNotes}
						mode={mode}
					/>
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
									Chunk Selected File
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

