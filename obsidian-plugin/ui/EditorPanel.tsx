import React, { useState } from 'react';
import WritingDashboardPlugin from '../main';
import { TextChunker } from '../services/TextChunker';

type DebugMode = 'off' | 'summary' | 'raw';

export const EditorPanel: React.FC<{
	plugin: WritingDashboardPlugin;
	mode: 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';
	selectedText: string;
	onSelectionChange: (text: string) => void;
	generatedText: string;
	generatedParagraphs: { id: string, text: string, hash: string, metadata?: any, status: 'STREAMING' | 'FINALIZED' | 'USER_DIRTY', lastPatched?: number }[];
	heatmapEnabled: boolean;
	onGeneratedChange?: (text: string) => void;
	onCopy: () => void;
	onUndo?: (paraId: string) => void;
	chunkBuffer?: string;
}> = ({ mode, selectedText, onSelectionChange, generatedText, generatedParagraphs, heatmapEnabled, onGeneratedChange, onCopy, onUndo, chunkBuffer }) => {
	const [hoveredPara, setHoveredPara] = useState<number | null>(null);
	const [debugMode, setDebugMode] = useState<DebugMode>('off');

	const selectedWords = TextChunker.getWordCount(selectedText || '');
	const selectedChars = (selectedText || '').length;
	const outputWords = TextChunker.getWordCount(generatedText || '');
	const outputChars = (generatedText || '').length;

	let selectedLabel: string;
	if (mode === 'chapter') selectedLabel = 'Scene summary / directions:';
	else if (mode === 'micro-edit') selectedLabel = 'Selected passage:';
	else if (mode === 'character-update') selectedLabel = 'Selected text (for character update):';
	else selectedLabel = 'Draft to check:';

	let selectedPlaceholder: string;
	if (mode === 'chapter') selectedPlaceholder = 'Write a rough summary of the scene you want (beats, directions, key dialogue notes, etc.)...';
	else if (mode === 'micro-edit') selectedPlaceholder = 'Paste the passage you want revised...';
	else if (mode === 'character-update') selectedPlaceholder = 'Paste selected text here for character extraction...';
	else selectedPlaceholder = 'Paste the draft you want checked for continuity...';

	const getParaClass = (para: any) => {
		const classes = [];
		if (heatmapEnabled) {
			if (!para.metadata) classes.push('para-inferred');
			else if (para.metadata.isSpeculative) classes.push('para-speculative');
			else classes.push('para-grounded');
		}
		if (para.lastPatched && Date.now() - para.lastPatched < 3000) {
			classes.push('para-patched-highlight');
		}
		if (para.status === 'USER_DIRTY') {
			classes.push('para-user-dirty');
		}
		return classes.join(' ');
	};

	const getGroundingMode = (para: any): string => {
		if (para.metadata?.isSpeculative) return 'Creative/Lite';
		if (para.metadata) return 'Grounded';
		return 'Inferred';
	};

	const getParaIcon = (para: any) => {
		if (!heatmapEnabled) return null;
		if (debugMode === 'off') {
			if (para.lastPatched && Date.now() - para.lastPatched < 3000) return '✨';
			if (para.status === 'USER_DIRTY') return '👤';
			return null;
		}
		if (!para.metadata) return '🟡'; 
		if (para.metadata.isSpeculative) return '🔴'; 
		return '🟢'; 
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
							<span className="output-label">Generated output:</span>
							<span className="generation-status" style={{ margin: 0 }}>
								{outputWords.toLocaleString()} words / {outputChars.toLocaleString()} chars
							</span>
						</div>
						<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
							{heatmapEnabled && (
								<>
									<div className="debug-mode-selector" style={{ display: 'flex', gap: 4 }}>
										<button 
											className={`btn-xs ${debugMode === 'off' ? 'mod-cta' : ''}`} 
											onClick={() => setDebugMode('off')}
											title="Debug Off"
										>None</button>
										<button 
											className={`btn-xs ${debugMode === 'summary' ? 'mod-cta' : ''}`} 
											onClick={() => setDebugMode('summary')}
											title="Summary Tooltips"
										>Sum</button>
										<button 
											className={`btn-xs ${debugMode === 'raw' ? 'mod-cta' : ''}`} 
											onClick={() => setDebugMode('raw')}
											title="Raw Metadata JSON"
										>Raw</button>
									</div>
									<div className="heatmap-legend" style={{ display: 'flex', gap: 8, fontSize: '0.8em' }}>
										<span title="Grounded (Full Metadata)"><span className="legend-dot" style={{ backgroundColor: 'var(--text-success)' }}></span> 🟢</span>
										<span title="Inferred (Metadata Missing)"><span className="legend-dot" style={{ backgroundColor: 'var(--text-warning)' }}></span> 🟡</span>
										<span title="Speculative (Fallback)"><span className="legend-dot" style={{ backgroundColor: 'var(--text-error)' }}></span> 🔴</span>
									</div>
								</>
							)}
							<button onClick={onCopy} className="copy-button">Copy to clipboard</button>
						</div>
					</div>
					
					{heatmapEnabled ? (
						<div className="generated-display heatmap-view">
						{generatedParagraphs.map((para, idx) => (
							<div 
								key={para.id}
								className={`generated-para ${getParaClass(para)}`}
								onMouseEnter={() => setHoveredPara(idx)}
								onMouseLeave={() => setHoveredPara(null)}
									style={{ position: 'relative' }}
								>
									<span className="para-icon">{getParaIcon(para)}</span>
									{para.text}
									{onUndo && para.lastPatched && (
										<button 
											className="btn-xs undo-patch-btn" 
											onClick={() => onUndo(para.id)}
											title="Undo AI Refinement"
											style={{ marginLeft: 8, opacity: 0.6 }}
										>↩</button>
									)}
									{hoveredPara === idx && debugMode !== 'off' && (
										<div className="para-explanation" style={{ 
											position: 'absolute', 
											top: '100%', 
											left: '0', 
											zIndex: 10, 
											backgroundColor: 'var(--background-secondary)', 
											border: '1px solid var(--background-modifier-border)',
											padding: '8px',
											borderRadius: '4px',
											width: '300px',
											boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
										}}>
								{debugMode === 'summary' ? (
										<>
											<strong>Grounding Explanation</strong>
											<div>Mode: {getGroundingMode(para)}</div>
													<div>Facts: {para.metadata?.factIds?.length || 0}</div>
													<div>Goals: {para.metadata?.goalIds?.length || 0}</div>
													{para.metadata?.sourceChunkIds && (
														<div>Sources: {para.metadata.sourceChunkIds.join(', ')}</div>
													)}
												</>
											) : (
												<pre style={{ fontSize: '0.75em', margin: 0, overflowX: 'auto' }}>
													{JSON.stringify(para.metadata || { status: 'inferred' }, null, 2)}
												</pre>
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
