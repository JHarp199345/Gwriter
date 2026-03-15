import React, { useEffect, useRef, useState } from 'react';
import { TextChunker } from '../services/TextChunker';
import { ReviewPanel } from './ReviewPanel';
import WritingDashboardPlugin from '../main';

interface GenerationModalProps {
	isGenerating: boolean;
	generationStage: string;
	chunkBuffer: string;
	generatedText: string;
	error?: string | null;
	plugin: WritingDashboardPlugin;
	showPhaseTransition: boolean;
	onPhase2Continue: (direction: string | null) => void;
	onApprove: () => void;
	onPushReviewed: (text: string) => void;
	onDiscard: () => void;
	onAbort: () => void;
}

/**
 * Full-screen overlay that appears the moment generation starts.
 * Text streams directly into it in real-time, scrolling automatically.
 * When generation finishes the footer switches to Approve & Insert / Discard.
 *
 * Emergency fallback: "📋 Copy all" button is always visible whenever there
 * is content, regardless of generation state. When generation is done the
 * body switches to an editable textarea so text can be freely selected,
 * copied, and edited even if something went wrong with the normal flow.
 */
export const GenerationModal: React.FC<GenerationModalProps> = ({
	isGenerating,
	generationStage,
	chunkBuffer,
	generatedText,
	error,
	plugin,
	showPhaseTransition,
	onPhase2Continue,
	onApprove,
	onPushReviewed,
	onDiscard,
	onAbort,
}) => {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [reviewMode, setReviewMode] = useState(false);
	const [phase2Direction, setPhase2Direction] = useState('');
	const [phaseCountdown, setPhaseCountdown] = useState(10);
	const countdownRef = useRef<number | null>(null);

	// Reset review mode whenever a new generation starts
	useEffect(() => {
		if (isGenerating) setReviewMode(false);
	}, [isGenerating]);

	// Auto-scroll to the bottom as new text arrives (streaming phase only)
	useEffect(() => {
		if (reviewMode) return;
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chunkBuffer, generatedText, reviewMode]);

	// Phase transition countdown — auto-proceed when it hits 0
	useEffect(() => {
		if (!showPhaseTransition) {
			setPhase2Direction('');
			setPhaseCountdown(10);
			if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
			return;
		}
		setPhaseCountdown(10);
		countdownRef.current = window.setInterval(() => {
			setPhaseCountdown(prev => {
				if (prev <= 1) {
					clearInterval(countdownRef.current!);
					countdownRef.current = null;
					onPhase2Continue(null); // auto-skip
					return 0;
				}
				return prev - 1;
			});
		}, 1000);
		return () => {
			if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
		};
	}, [showPhaseTransition]);

	const committed = generatedText.trim();
	const streaming = chunkBuffer.trim();
	const hasContent = !!(committed || streaming);
	const fullText = committed + (streaming ? '\n\n' + streaming : '');
	const wordCount = TextChunker.getWordCount(fullText.trim());

	// Copy all text to clipboard — works regardless of generation state
	const handleCopyAll = () => {
		navigator.clipboard.writeText(fullText.trim()).catch(() => {
			// Fallback for environments where clipboard API is restricted
			const el = document.createElement('textarea');
			el.value = fullText.trim();
			el.style.position = 'fixed';
			el.style.opacity = '0';
			document.body.appendChild(el);
			el.select();
			document.execCommand('copy');
			document.body.removeChild(el);
		});
	};

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

				{/* ── Header (always visible) ── */}
				<div className="gw-gen-header">
					<div className="gw-gen-title">
						{reviewMode
							? <>✏ Review &amp; Edit</>
							: headerContent}
					</div>
					<div className="gw-gen-header-right">
						{hasContent && !reviewMode && (
							<span className="gw-gen-wordcount">
								{wordCount.toLocaleString()} words
							</span>
						)}
						{hasContent && !reviewMode && (
							<button
								className="gw-btn gw-btn-copy"
								onClick={handleCopyAll}
								title="Copy all generated text to clipboard"
							>
								📋 Copy all
							</button>
						)}
					</div>
				</div>

				{reviewMode ? (
					/* ── Review & Edit panel ── */
					<ReviewPanel
						fullText={fullText.trim()}
						plugin={plugin}
						onPush={(text) => { onPushReviewed(text); }}
						onBackToEdit={() => setReviewMode(false)}
					/>
				) : (
					<>
						{/* ── Body — streaming prose (divs) → editable textarea when done ── */}
						<div className="gw-gen-body" ref={bodyRef}>
							{hasContent && !isGenerating ? (
								// Generation finished: editable textarea — always selectable/copyable
								<textarea
									className="gw-gen-textarea"
									defaultValue={fullText.trim()}
									spellCheck={false}
								/>
							) : (
								<>
									{committed && (
										<div className="gw-gen-committed">{committed}</div>
									)}
									{streaming && (
										<div className="gw-gen-streaming">
											{streaming}
											{isGenerating && <span className="gw-gen-cursor">▌</span>}
										</div>
									)}
								</>
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

						{/* ── Phase transition UI (appears between Phase 1 and Phase 2) ── */}
						{showPhaseTransition && (
							<div className="gw-phase-transition">
								<div className="gw-phase-transition-header">
									<span className="gw-phase-badge">Phase 1 Complete</span>
									<span className="gw-phase-transition-title">Entering conclusion…</span>
									<span className="gw-phase-countdown">{phaseCountdown}s</span>
								</div>
								<div className="gw-phase-transition-body">
									<input
										className="gw-phase-direction-input"
										placeholder="Optional: steer Phase 2 — where should this chapter go? (Enter or skip)"
										value={phase2Direction}
										onChange={e => setPhase2Direction(e.target.value)}
										onKeyDown={e => {
											if (e.key === 'Enter') onPhase2Continue(phase2Direction.trim() || null);
											if (e.key === 'Escape') onPhase2Continue(null);
										}}
										autoFocus
									/>
									<div className="gw-phase-transition-actions">
										<button
											className="gw-btn gw-btn-success"
											onClick={() => onPhase2Continue(phase2Direction.trim() || null)}
										>
											Continue →
										</button>
										<button
											className="gw-review-back-btn"
											onClick={() => onPhase2Continue(null)}
										>
											Skip ({phaseCountdown}s)
										</button>
									</div>
								</div>
							</div>
						)}

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
										<>
											<button
												className="gw-btn gw-btn-review"
												onClick={() => setReviewMode(true)}
												title="Split into paragraph cards for targeted edits"
											>
												✏ Review &amp; Edit
											</button>
											<button className="gw-btn gw-btn-success" onClick={onApprove}>
												✓ Approve &amp; Insert
											</button>
										</>
									)}
								</>
							)}
						</div>
					</>
				)}

			</div>
		</div>
	);
};
