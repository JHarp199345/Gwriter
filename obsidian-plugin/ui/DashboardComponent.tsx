import React, { useState, useEffect } from 'react';
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
	const [backendConnected, setBackendConnected] = useState(false);

	useEffect(() => {
		// Check backend connection on mount
		plugin.pythonBridge.healthCheck().then(setBackendConnected);
	}, []);

	const handleGenerate = async () => {
		setIsGenerating(true);
		setError(null);
		try {
			const result = await plugin.pythonBridge.generate({
				mode,
				selectedText: mode === 'micro-edit' ? selectedText : undefined,
				directorNotes,
				wordCount: mode === 'chapter' ? wordCount : undefined,
				settings: plugin.settings
			});
			setGeneratedText(result.text);
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
		setIsGenerating(true);
		setError(null);
		try {
			const result = await plugin.pythonBridge.extractCharacters({
				selectedText,
				settings: plugin.settings
			});
			// Apply updates to character files
			await plugin.vaultService.updateCharacterNotes(result.updates);
			setError(null);
			// Show success message
			alert(`Updated ${result.updates.length} character note(s)`);
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
			{!backendConnected && (
				<div className="backend-warning">
					⚠️ Backend not connected. Make sure the Python server is running on {plugin.settings.pythonBackendUrl}
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
							disabled={isGenerating || !backendConnected}
							className="generate-button"
						>
							{isGenerating ? 'Generating...' : mode === 'chapter' ? 'Generate Chapter' : 'Generate Edit'}
						</button>
						<button 
							onClick={handleUpdateCharacters}
							disabled={isGenerating || !selectedText || !backendConnected}
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

