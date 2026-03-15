import React, { useEffect, useRef } from 'react';
import { TextChunker } from '../services/TextChunker';

interface GenerationModalProps {
	isGenerating: boolean;
	generationStage: string;
	chunkBuffer: string;
	generatedText: string;
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
	const wordCount = TextChunker.getWordCount((committed + ' ' + streaming).trim());

	return (
		<div className="gw-gen-overlay">
			<div className="gw-gen-modal">

				{/* ── Header ── */}
				<div className="gw-gen-header">
					<div className="gw-gen-title">
						{isGenerating
							? <><span className="gw-gen-spinner">⏳</span> {generationStage || 'Generating…'}</>
							: <>✓ Done — {wordCount.toLocaleString()} words</>
						}
					</div>
					<div className="gw-gen-wordcount">
						{wordCount.toLocaleString()} words
					</div>
				</div>

				{/* ── Body — streaming prose ── */}
				<div className="gw-gen-body" ref={bodyRef}>
					{committed && (
						<div className="gw-gen-committed">{committed}</div>
					)}
					{streaming && (
						<div className="gw-gen-streaming">
							{streaming}
							<span className="gw-gen-cursor">▌</span>
						</div>
					)}
					{!committed && !streaming && (
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
							<button className="gw-btn gw-btn-success" onClick={onApprove}>
								✓ Approve &amp; Insert
							</button>
						</>
					)}
				</div>

			</div>
		</div>
	);
};
