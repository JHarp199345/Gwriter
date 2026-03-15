import React, { useEffect, useRef, useState } from 'react';
import { TextChunker } from '../services/TextChunker';
import { PlanReviewPanel } from './PlanReviewPanel';
import { ReviewPanel } from './ReviewPanel';
import WritingDashboardPlugin from '../main';

interface GenerationModalProps {
	isGenerating: boolean;
	generationStage: string;
	chunkBuffer: string;
	generatedText: string;
	error?: string | null;
	plugin: WritingDashboardPlugin;
	/** Non-empty when the plan is ready for author review. Empty string = not in plan review. */
	planText: string;
	onApprovePlan: (editedPlanText: string) => void;
	onApprove: () => void;
	onPushReviewed: (text: string) => void;
	onDiscard: () => void;
	onAbort: () => void;
}

/**
 * Full-screen overlay for the generation workflow.
 *
 * Modal states (in order):
 *   1. planText non-empty  → PlanReviewPanel (author edits/approves plan before writing)
 *   2. isGenerating        → streaming prose body
 *   3. done + reviewMode   → ReviewPanel (paragraph cards for final edit)
 *   4. done                → editable textarea + footer buttons
 */
export const GenerationModal: React.FC<GenerationModalProps> = ({
	isGenerating,
	generationStage,
	chunkBuffer,
	generatedText,
	error,
	plugin,
	planText,
	onApprovePlan,
	onApprove,
	onPushReviewed,
	onDiscard,
	onAbort,
}) => {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [reviewMode, setReviewMode] = useState(false);

	// Reset review mode whenever a new generation starts
	useEffect(() => {
		if (isGenerating) setReviewMode(false);
	}, [isGenerating]);

	// Auto-scroll to the bottom as new text arrives (streaming only)
	useEffect(() => {
		if (reviewMode) return;
		const el = bodyRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [chunkBuffer, generatedText, reviewMode]);

	const committed = generatedText.trim();
	const streaming = chunkBuffer.trim();
	const hasContent = !!(committed || streaming);
	const fullText = committed + (streaming ? '\n\n' + streaming : '');
	const wordCount = TextChunker.getWordCount(fullText.trim());

	const handleCopyAll = () => {
		navigator.clipboard.writeText(fullText.trim()).catch(() => {
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

	// ── Plan review state ──────────────────────────────────────────────────────
	// When planText is non-empty the modal shows PlanReviewPanel instead of prose.
	if (planText) {
		return (
			<div className="gw-gen-overlay">
				<div className="gw-gen-modal">
					<div className="gw-gen-header">
						<div className="gw-gen-title">📋 Review Scene Plan</div>
						<div className="gw-gen-header-right">
							<span className="gw-gen-wordcount" style={{ color: 'var(--text-muted)', fontSize: '0.85em' }}>
								Edit any section, then approve to begin writing
							</span>
						</div>
					</div>
					<PlanReviewPanel
						planText={planText}
						onApprove={onApprovePlan}
					/>
				</div>
			</div>
		);
	}

	// ── Header content ─────────────────────────────────────────────────────────
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
						{reviewMode ? <>✏ Review &amp; Edit</> : headerContent}
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
					/* ── Prose Review & Edit panel ── */
					<ReviewPanel
						fullText={fullText.trim()}
						plugin={plugin}
						onPush={(text) => { onPushReviewed(text); }}
						onBackToEdit={() => setReviewMode(false)}
					/>
				) : (
					<>
						{/* ── Body ── */}
						<div className="gw-gen-body" ref={bodyRef}>
							{hasContent && !isGenerating ? (
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
