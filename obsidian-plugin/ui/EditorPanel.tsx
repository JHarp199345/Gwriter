import React from 'react';
import WritingDashboardPlugin from '../main';
import { TextChunker } from '../services/TextChunker';

export const EditorPanel: React.FC<{
	plugin: WritingDashboardPlugin;
	mode: 'chapter' | 'micro-edit' | 'character-update';
	selectedText: string;
	onSelectionChange: (text: string) => void;
	generatedText: string;
	onCopy: () => void;
}> = ({ mode, selectedText, onSelectionChange, generatedText, onCopy }) => {
	const selectedWords = TextChunker.getWordCount(selectedText || '');
	const selectedChars = (selectedText || '').length;
	const outputWords = TextChunker.getWordCount(generatedText || '');
	const outputChars = (generatedText || '').length;

	const selectedLabel =
		mode === 'chapter'
			? 'Scene summary / directions:'
			: mode === 'micro-edit'
			? 'Selected passage:'
			: 'Selected text (for character update):';

	const selectedPlaceholder =
		mode === 'chapter'
			? 'Write a rough summary of the scene you want (beats, directions, key dialogue notes, etc.)...'
			: mode === 'micro-edit'
			? 'Paste the passage you want revised...'
			: 'Paste selected text here for character extraction...';

	return (
		<div className="editor-panel">
			<div className="editor-section">
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
					<label>{selectedLabel}</label>
					<span className="generation-status" style={{ margin: 0 }}>
						{selectedWords.toLocaleString()} words / {selectedChars.toLocaleString()} chars
					</span>
				</div>
				<textarea
					value={selectedText}
					onChange={(e) => onSelectionChange(e.target.value)}
					placeholder={selectedPlaceholder}
					rows={8}
					className="editor-textarea"
				/>
			</div>
			{generatedText && (
				<div className="editor-section">
					<div className="generated-header">
						<div style={{ display: 'flex', flexDirection: 'column' }}>
							<label>Generated output:</label>
							<span className="generation-status" style={{ margin: 0 }}>
								{outputWords.toLocaleString()} words / {outputChars.toLocaleString()} chars
							</span>
						</div>
						<button onClick={onCopy} className="copy-button">Copy to clipboard</button>
					</div>
					<textarea
						value={generatedText}
						readOnly
						rows={12}
						className="generated-textarea"
					/>
				</div>
			)}
		</div>
	);
};

