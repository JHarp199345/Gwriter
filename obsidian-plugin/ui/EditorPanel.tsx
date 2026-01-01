import React, { useState } from 'react';
import WritingDashboardPlugin from '../main';
import { TextChunker } from '../services/TextChunker';

export const EditorPanel: React.FC<{
	plugin: WritingDashboardPlugin;
	mode: 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';
	selectedText: string;
	onSelectionChange: (text: string) => void;
	generatedText: string;
	generatedParagraphs: { text: string, metadata?: any }[];
	heatmapEnabled: boolean;
	onGeneratedChange?: (text: string) => void;
	onCopy: () => void;
	chunkBuffer?: string;
}> = ({ mode, selectedText, onSelectionChange, generatedText, generatedParagraphs, heatmapEnabled, onGeneratedChange, onCopy, chunkBuffer }) => {
	const [hoveredPara, setHoveredPara] = useState<number | null>(null);

	const selectedWords = TextChunker.getWordCount(selectedText || '');
	const selectedChars = (selectedText || '').length;
	const outputWords = TextChunker.getWordCount(generatedText || '');
	const outputChars = (generatedText || '').length;

	const selectedLabel =
		mode === 'chapter'
			? 'Scene summary / directions:'
			: mode === 'micro-edit'
			? 'Selected passage:'
			: mode === 'character-update'
			? 'Selected text (for character update):'
			: 'Draft to check:';

	const selectedPlaceholder =
		mode === 'chapter'
			? 'Write a rough summary of the scene you want (beats, directions, key dialogue notes, etc.)...'
			: mode === 'micro-edit'
			? 'Paste the passage you want revised...'
			: mode === 'character-update'
			? 'Paste selected text here for character extraction...'
			: 'Paste the draft you want checked for continuity...';

	const getParaClass = (metadata: any) => {
		if (!heatmapEnabled) return '';
		if (!metadata) return 'para-patterned'; // Inferred
		if (metadata.isSpeculative) return 'para-dimmed'; // Lite/Speculative
		return 'para-solid'; // Grounded
	};

	const getParaIcon = (metadata: any) => {
		if (!heatmapEnabled) return null;
		if (!metadata) return '🔍'; // Inferred icon
		if (metadata.isSpeculative) return '⚠️'; // Lite icon
		return '✅'; // Grounded icon
	};

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
			{(generatedText || chunkBuffer) && (
				<div className="editor-section">
					<div className="generated-header">
						<div style={{ display: 'flex', flexDirection: 'column' }}>
							<label>Generated output:</label>
							<span className="generation-status" style={{ margin: 0 }}>
								{outputWords.toLocaleString()} words / {outputChars.toLocaleString()} chars
							</span>
						</div>
						<div style={{ display: 'flex', gap: 8 }}>
							{heatmapEnabled && (
								<div className="heatmap-legend">
									<span title="Grounded (Full Metadata)"><span className="legend-dot solid"></span></span>
									<span title="Inferred (Metadata Missing)"><span className="legend-dot patterned"></span></span>
									<span title="Lite (Speculative/Fallback)"><span className="legend-dot dimmed"></span></span>
								</div>
							)}
							<button onClick={onCopy} className="copy-button">Copy to clipboard</button>
						</div>
					</div>
					
					{heatmapEnabled ? (
						<div className="generated-display heatmap-view">
							{generatedParagraphs.map((para, idx) => (
								<div 
									key={idx} 
									className={`generated-para ${getParaClass(para.metadata)}`}
									onMouseEnter={() => setHoveredPara(idx)}
									onMouseLeave={() => setHoveredPara(null)}
								>
									<span className="para-icon">{getParaIcon(para.metadata)}</span>
									{para.text}
									{hoveredPara === idx && para.metadata && (
										<div className="para-explanation">
											<strong>Grounding Explanation</strong>
											<div>Mode: {para.metadata.isSpeculative ? 'Creative/Lite' : 'Grounded'}</div>
											<div>Facts: {para.metadata.factIds?.length || 0}</div>
											<div>Goals: {para.metadata.goalIds?.length || 0}</div>
											{para.metadata.sourceChunkIds && (
												<div>Sources: {para.metadata.sourceChunkIds.join(', ')}</div>
											)}
										</div>
									)}
								</div>
							))}
							{chunkBuffer && (
								<div className="generated-para streaming">
									<span className="para-icon">⏳</span>
									{chunkBuffer}
								</div>
							)}
						</div>
					) : (
						<textarea
							value={generatedText + (chunkBuffer ? '\n\n' + chunkBuffer : '')}
							readOnly={!onGeneratedChange}
							onChange={onGeneratedChange ? (e) => onGeneratedChange(e.target.value) : undefined}
							rows={12}
							className="generated-textarea"
						/>
					)}
				</div>
			)}
		</div>
	);
};

