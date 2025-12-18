import React from 'react';
import WritingDashboardPlugin from '../main';

export const EditorPanel: React.FC<{
	plugin: WritingDashboardPlugin;
	selectedText: string;
	onSelectionChange: (text: string) => void;
	generatedText: string;
	onCopy: () => void;
}> = ({ selectedText, onSelectionChange, generatedText, onCopy }) => {
	return (
		<div className="editor-panel">
			<div className="editor-section">
				<label>Selected Text / Clipboard Input:</label>
				<textarea
					value={selectedText}
					onChange={(e) => onSelectionChange(e.target.value)}
					placeholder="Paste selected text here, or type your instructions for chapter generation..."
					rows={8}
					className="editor-textarea"
				/>
			</div>
			{generatedText && (
				<div className="editor-section">
					<div className="generated-header">
						<label>Generated Output:</label>
						<button onClick={onCopy} className="copy-button">Copy to Clipboard</button>
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

