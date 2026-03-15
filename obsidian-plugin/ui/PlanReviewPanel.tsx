import React, { useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlanCardData {
	id: number;
	content: string;
	originalContent: string;
	modified: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split the AI-generated plan text into editable cards.
 * Each double-newline-separated block becomes one card.
 * The NARRATIVE WALL block is included so the author sees it,
 * but it is filtered from the approved text sent to the write stage.
 */
function splitPlanIntoCards(planText: string): PlanCardData[] {
	return planText
		.split('\n\n')
		.map(b => b.trim())
		.filter(b => b.length > 0)
		.map((content, i) => ({
			id: i,
			content,
			originalContent: content,
			modified: false,
		}));
}

/**
 * Re-assemble cards into a single plan string, stripping the NARRATIVE WALL
 * block so it doesn't pollute the write prompt with meta-instructions that
 * are already embedded directly in the prompt template.
 */
function assemblePlan(cards: PlanCardData[]): string {
	return cards
		.filter(c => !c.content.startsWith('⚠ NARRATIVE WALL'))
		.map(c => c.content)
		.join('\n\n');
}

// ── PlanReviewPanel ────────────────────────────────────────────────────────────

interface PlanReviewPanelProps {
	planText: string;
	onApprove: (editedPlanText: string) => void;
}

export const PlanReviewPanel: React.FC<PlanReviewPanelProps> = ({ planText, onApprove }) => {
	const [cards, setCards] = useState<PlanCardData[]>(() => splitPlanIntoCards(planText));

	const handleTextChange = (id: number, newContent: string) => {
		setCards(prev => prev.map(c =>
			c.id === id
				? { ...c, content: newContent, modified: newContent !== c.originalContent }
				: c
		));
	};

	const handleRevert = (id: number) => {
		setCards(prev => prev.map(c =>
			c.id === id ? { ...c, content: c.originalContent, modified: false } : c
		));
	};

	const handleApprove = () => {
		onApprove(assemblePlan(cards));
	};

	const modifiedCount = cards.filter(c => c.modified).length;

	return (
		<div className="gw-plan-panel">

			{/* ── Header ── */}
			<div className="gw-plan-header">
				<span className="gw-plan-title">📋 Scene Plan</span>
				<span className="gw-plan-meta">
					{cards.length} sections
					{modifiedCount > 0 && (
						<span className="gw-plan-modified-badge"> · {modifiedCount} edited</span>
					)}
				</span>
				<button className="gw-btn gw-btn-success gw-plan-approve-btn" onClick={handleApprove}>
					✓ Approve Plan → Write
				</button>
			</div>

			{/* ── Cards ── */}
			<div className="gw-plan-cards">
				{cards.map(card => (
					<PlanCard
						key={card.id}
						card={card}
						onChange={handleTextChange}
						onRevert={handleRevert}
					/>
				))}
			</div>

		</div>
	);
};

// ── PlanCard ──────────────────────────────────────────────────────────────────

interface PlanCardProps {
	card: PlanCardData;
	onChange: (id: number, newContent: string) => void;
	onRevert: (id: number) => void;
}

const PlanCard: React.FC<PlanCardProps> = ({ card, onChange, onRevert }) => {
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(card.content);

	// Sync if parent resets (e.g. revert)
	const handleRevertClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		setEditValue(card.originalContent);
		onRevert(card.id);
		setIsEditing(false);
	};

	const handleBlur = () => {
		setIsEditing(false);
		onChange(card.id, editValue);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Escape') {
			setEditValue(card.content);
			setIsEditing(false);
		}
	};

	// Detect if this is the NARRATIVE WALL block — show it dimmed, non-editable
	const isWall = card.content.startsWith('⚠ NARRATIVE WALL');

	const cardClass = [
		'gw-plan-card',
		isWall ? 'gw-plan-card--wall' : '',
		card.modified ? 'gw-plan-card--modified' : '',
	].filter(Boolean).join(' ');

	return (
		<div className={cardClass}>
			{/* Header row */}
			<div className="gw-plan-card-header">
				{card.modified && (
					<span className="gw-para-modified-dot" title="Edited from AI original" />
				)}
				<div className="gw-plan-card-actions">
					{card.modified && !isWall && (
						<button
							className="gw-para-action-btn"
							title="Revert to AI original"
							onClick={handleRevertClick}
						>
							↩
						</button>
					)}
				</div>
			</div>

			{/* Body */}
			{isWall ? (
				<div className="gw-plan-card-wall-text">{card.content}</div>
			) : isEditing ? (
				<textarea
					className="gw-plan-card-textarea"
					value={editValue}
					onChange={e => setEditValue(e.target.value)}
					onBlur={handleBlur}
					onKeyDown={handleKeyDown}
					autoFocus
				/>
			) : (
				<div
					className="gw-plan-card-text"
					onClick={() => { setIsEditing(true); setEditValue(card.content); }}
					title="Click to edit"
				>
					{card.content}
				</div>
			)}
		</div>
	);
};
