import React, { useState } from 'react';
import WritingDashboardPlugin from '../main';
import { VaultBrowser } from './VaultBrowser';
import { EditorPanel } from './EditorPanel';
import { DirectorNotes } from './DirectorNotes';
import { ModeSelector } from './ModeSelector';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

export const DashboardComponent: React.FC<{ plugin: WritingDashboardPlugin }> = ({ plugin }) => {
	const [mode, setMode] = useState<Mode>('chapter');
	const [selectedText, setSelectedText] = useState('');
	const [directorNotes, setDirectorNotes] = useState('');
	const [wordCount, setWordCount] = useState(2000);
	const [generatedText, setGeneratedText] = useState('');
	const [isGenerating, setIsGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleGenerate = async () => {
		if (!plugin.settings.apiKey) {
			setError('Please configure your API key in settings');
			return;
		}

		setIsGenerating(true);
		setError(null);
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

			const result = await plugin.aiClient.generate(prompt, plugin.settings);
			setGeneratedText(result);
		} catch (err: any) {
			setError(err.message || 'Generation failed');
			console.error('Generation error:', err);
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
		try {
			const characterNotes = await plugin.contextAggregator.getCharacterNotes();
			const storyBible = await plugin.contextAggregator.readFile(plugin.settings.storyBiblePath);
			const prompt = plugin.promptEngine.buildCharacterExtractionPrompt(selectedText, characterNotes, storyBible);
			
			const extractionResult = await plugin.aiClient.generate(prompt, plugin.settings);
			const updates = plugin.characterExtractor.parseExtraction(extractionResult);
			
			// Apply updates to character files
			await plugin.vaultService.updateCharacterNotes(updates);
			setError(null);
			// Show success message
			alert(`Updated ${updates.length} character note(s)`);
		} catch (err: any) {
			setError(err.message || 'Character extraction failed');
			console.error('Character update error:', err);
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
					<div className="controls">
						<button 
							onClick={handleGenerate}
							disabled={isGenerating || !plugin.settings.apiKey}
							className="generate-button"
						>
							{isGenerating ? 'Generating...' : mode === 'chapter' ? 'Generate Chapter' : 'Generate Edit'}
						</button>
						<button 
							onClick={handleUpdateCharacters}
							disabled={isGenerating || !selectedText || !plugin.settings.apiKey}
							className="update-characters-button"
						>
							Update Characters
						</button>
					</div>
					<ModeSelector mode={mode} onChange={setMode} />
				</div>
			</div>
		</div>
	);
};

