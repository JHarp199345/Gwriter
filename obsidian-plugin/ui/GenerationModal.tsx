import React, { useEffect, useRef } from 'react';
import { TextChunker } from '../services/TextChunker';

interface GenerationModalProps {
	isGenerating: boolean;
	generationStage: string;
	chunkBuffer: string;
	generatedText: string;
	error?: string | null;
	onApprove: () => void;
	onDiscard: () => void;
	onAbort: () => void;
}

/**
 * Full-screen overlay that appears the moment generation starts.
 * Text streams directly into it in real-time, scrolling automatically.
 * When generation finishes the footer switches to Approve & Insert / Discard.
 */
export const GenerationModal: React.FC<GenerationModalProps> = ({
	isGenerating,
	generationStage,
	chunkBuffer,
	generatedText,
	error,
	onApprove,
	onDiscard,
	onAbort,
}) => {
	const bodyRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to the bottom as new text arrives
	useEffect(() => {
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chunkBuffer, generatedText]);

	const committed = generatedText.trim();
	const streaming = chunkBuffer.trim();
	const hasContent = committed || streaming;
	const wordCount = TextChunker.getWordCount((committed + ' ' + streaming).trim());

	// Determine header state
	const headerContent = (() => {
		if (isGenerating) {
			return <><span className="gw-gen-spinner">⏳</span> {generationStage || 'Generating…'}</>;
		}
		if (error && !hasContent) {
			return <span className="gw-gen-error">⚠ {error}</span>;
		}
		return <>✓ Done — {wordCount.toLocaleString()} words</>;
	})();

	return (
		<div className="gw-gen-overlay">
			<div className="gw-gen-modal">

				{/* ── Header ── */}
				<div className="gw-gen-header">
					<div className="gw-gen-title">
						{headerContent}
					</div>
					{hasContent && (
						<div className="gw-gen-wordcount">
							{wordCount.toLocaleString()} words
						</div>
					)}
				</div>

				{/* ── Body — streaming prose ── */}
				<div className="gw-gen-body" ref={bodyRef}>
					{committed && (
						<div className="gw-gen-committed">{committed}</div>
					)}
					{streaming && (
						<div className="gw-gen-streaming">
							{streaming}
							{isGenerating && <span className="gw-gen-cursor">▌</span>}
						</div>
					)}
					{!hasContent && error && (
						<div className="gw-gen-error-detail">
							<p><strong>Generation failed.</strong></p>
							<p>{error}</p>
							<p style={{ marginTop: 8, fontSize: '0.85em', color: 'var(--text-muted)' }}>
								Check your API key and model name in Settings, then try again.
							</p>
						</div>
					)}
					{!hasContent && !error && (
						<div className="gw-gen-waiting">Waiting for output…</div>
					)}
				</div>

				{/* ── Footer ── */}
				<div className="gw-gen-footer">
					{isGenerating ? (
						<button className="gw-btn gw-btn-danger" onClick={onAbort}>
							✕ Abort
						</button>
					) : (
						<>
							<button className="gw-btn gw-btn-danger" onClick={onDiscard}>
								✕ Discard
							</button>
							{hasContent && (
								<button className="gw-btn gw-btn-success" onClick={onApprove}>
									✓ Approve &amp; Insert
								</button>
							)}
						</>
					)}
				</div>

			</div>
		</div>
	);
};
