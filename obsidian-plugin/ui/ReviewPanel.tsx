import React, { useState, useRef, useEffect } from 'react';
import { Notice } from 'obsidian';
import WritingDashboardPlugin from '../main';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardData {
	id: number;
	text: string;         // current (possibly edited) text
	originalText: string; // as-generated, for revert
	selected: boolean;    // part of batch selection
	excluded: boolean;    // dropped from push
	modified: boolean;    // changed from originalText
	rewriting: boolean;   // AI rewrite in progress
	streamingText: string;// partial text while rewriting
}

// ── ReviewPanel ───────────────────────────────────────────────────────────────

interface ReviewPanelProps {
	fullText: string;
	plugin: WritingDashboardPlugin;
	onPush: (text: string) => void;
	onBackToEdit: () => void;
}

function splitIntoParagraphs(text: string): CardData[] {
	return text
		.split('\n\n')
		.map(p => p.trim())
		.filter(p => p.length > 0)
		.map((t, i) => ({
			id: i,
			text: t,
			originalText: t,
			selected: false,
			excluded: false,
			modified: false,
			rewriting: false,
			streamingText: '',
		}));
}

export const ReviewPanel: React.FC<ReviewPanelProps> = ({
	fullText,
	plugin,
	onPush,
	onBackToEdit,
}) => {
	const [cards, setCards] = useState<CardData[]>(() => splitIntoParagraphs(fullText));
	const [batchInstruction, setBatchInstruction] = useState('');
	const [isBatchRewriting, setIsBatchRewriting] = useState(false);
	const [activeCardId, setActiveCardId] = useState<number | null>(null);
	const [lastSelectedId, setLastSelectedId] = useState<number | null>(null);

	const selectedCards = cards.filter(c => c.selected && !c.excluded);
	const includedCards = cards.filter(c => !c.excluded);
	const totalWords = includedCards
		.reduce((sum, c) => sum + c.text.split(/\s+/).filter(Boolean).length, 0);

	// ── Selection ──────────────────────────────────────────────────────────────

	const handleSelect = (id: number, shiftHeld: boolean) => {
		setCards(prev => {
			if (shiftHeld && lastSelectedId !== null) {
				const min = Math.min(lastSelectedId, id);
				const max = Math.max(lastSelectedId, id);
				// If any in range are unselected, select all; otherwise deselect all
				const anyUnselected = prev
					.filter(c => c.id >= min && c.id <= max && !c.excluded)
					.some(c => !c.selected);
				return prev.map(c => ({
					...c,
					selected: (c.id >= min && c.id <= max && !c.excluded)
						? anyUnselected
						: c.selected,
				}));
			}
			return prev.map(c => c.id === id ? { ...c, selected: !c.selected } : c);
		});
		setLastSelectedId(id);
	};

	const clearSelection = () => setCards(prev => prev.map(c => ({ ...c, selected: false })));

	// ── Text editing ───────────────────────────────────────────────────────────

	const handleTextChange = (id: number, newText: string) => {
		setCards(prev => prev.map(c =>
			c.id === id
				? { ...c, text: newText, modified: newText !== c.originalText }
				: c
		));
	};

	// ── Exclude / include ──────────────────────────────────────────────────────

	const handleExclude = (id: number) => {
		setCards(prev => prev.map(c =>
			c.id === id ? { ...c, excluded: true, selected: false } : c
		));
	};

	const handleInclude = (id: number) => {
		setCards(prev => prev.map(c =>
			c.id === id ? { ...c, excluded: false } : c
		));
	};

	// ── Revert ─────────────────────────────────────────────────────────────────

	const handleRevert = (id: number) => {
		setCards(prev => prev.map(c =>
			c.id === id
				? { ...c, text: c.originalText, modified: false, streamingText: '' }
				: c
		));
	};

	// ── Core rewrite (single card) ─────────────────────────────────────────────

	const rewriteCard = async (
		id: number,
		instruction: string,
		snapshot: CardData[]
	) => {
		const card = snapshot.find(c => c.id === id);
		if (!card) return;

		const contextBefore = snapshot
			.filter(c => c.id < id && !c.excluded)
			.slice(-2)
			.map(c => c.text)
			.join('\n\n');

		const contextAfter = snapshot
			.filter(c => c.id > id && !c.excluded)
			.slice(0, 2)
			.map(c => c.text)
			.join('\n\n');

		const prompt = plugin.promptEngine.buildParagraphRewritePrompt({
			contextBefore,
			paragraph: card.text,
			contextAfter,
			instruction: instruction.trim() ||
				'Improve this paragraph while maintaining its purpose.',
		});

		try {
			await plugin.aiClient.generateStream(
				prompt,
				{ ...plugin.settings, generationMode: 'single' as const },
				(accumulated) => {
					setCards(prev => prev.map(c =>
						c.id === id ? { ...c, streamingText: accumulated } : c
					));
				}
			);
			// Commit the streamed text
			setCards(prev => prev.map(c =>
				c.id === id
					? {
						...c,
						text: c.streamingText || c.text,
						streamingText: '',
						rewriting: false,
						modified: true,
					}
					: c
			));
		} catch (err: any) {
			new Notice(`Rewrite failed: ${err.message}`);
			setCards(prev => prev.map(c =>
				c.id === id
					? { ...c, rewriting: false, streamingText: '' }
					: c
			));
		}
	};

	// ── Single-card rewrite (from inline instruction input) ────────────────────

	const handleSingleRewrite = async (id: number, instruction: string) => {
		setActiveCardId(null);
		const snapshot = cards; // capture before state updates
		setCards(prev => prev.map(c =>
			c.id === id ? { ...c, rewriting: true, streamingText: '' } : c
		));
		await rewriteCard(id, instruction, snapshot);
	};

	// ── Batch rewrite (shared instruction bar) ─────────────────────────────────

	const handleBatchRewrite = async () => {
		const selected = cards.filter(c => c.selected && !c.excluded);
		if (selected.length === 0 || !batchInstruction.trim()) return;

		const snapshot = [...cards]; // stable snapshot for all parallel calls
		setIsBatchRewriting(true);
		setCards(prev => prev.map(c =>
			selected.some(s => s.id === c.id)
				? { ...c, rewriting: true, streamingText: '' }
				: c
		));

		await Promise.allSettled(
			selected.map(card => rewriteCard(card.id, batchInstruction, snapshot))
		);

		setIsBatchRewriting(false);
		setBatchInstruction('');
		clearSelection();
	};

	// ── Push to vault ──────────────────────────────────────────────────────────

	const handlePush = () => {
		const finalText = cards
			.filter(c => !c.excluded)
			.map(c => c.text)
			.join('\n\n');
		onPush(finalText);
	};

	// ── Render ─────────────────────────────────────────────────────────────────

	return (
		<div className="gw-review-panel">

			{/* ── Top bar ── */}
			<div className="gw-review-topbar">
				<button className="gw-review-back-btn" onClick={onBackToEdit}>
					← Back
				</button>
				<span className="gw-review-meta">
					{cards.length} paragraphs · {totalWords.toLocaleString()} words
					{includedCards.length < cards.length && (
						<span className="gw-review-excluded-badge">
							{' '}· {cards.length - includedCards.length} excluded
						</span>
					)}
				</span>
				<button className="gw-btn gw-btn-success" onClick={handlePush}>
					↗ Push to Vault
				</button>
			</div>

			{/* ── Card list ── */}
			<div className="gw-review-cards">
				{cards.map((card, index) => (
					<ParagraphCard
						key={card.id}
						card={card}
						index={index}
						isInstructionOpen={activeCardId === card.id}
						onSelect={(id, e) => handleSelect(id, e.shiftKey)}
						onExclude={handleExclude}
						onInclude={handleInclude}
						onTextChange={handleTextChange}
						onOpenInstruction={(id) =>
							setActiveCardId(activeCardId === id ? null : id)
						}
						onCloseInstruction={() => setActiveCardId(null)}
						onRewrite={handleSingleRewrite}
						onRevert={handleRevert}
					/>
				))}
			</div>

			{/* ── Batch bar (appears when 1+ cards selected) ── */}
			{selectedCards.length > 0 && (
				<div className="gw-review-batchbar">
					<span className="gw-batchbar-label">
						{selectedCards.length} selected
					</span>
					<input
						className="gw-batchbar-input"
						placeholder={
							selectedCards.length === 1
								? 'Instruction for this paragraph…'
								: `Instruction for all ${selectedCards.length}…`
						}
						value={batchInstruction}
						onChange={e => setBatchInstruction(e.target.value)}
						onKeyDown={e => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								handleBatchRewrite();
							}
						}}
						disabled={isBatchRewriting}
						autoFocus
					/>
					<button
						className="gw-btn gw-btn-rewrite"
						onClick={handleBatchRewrite}
						disabled={!batchInstruction.trim() || isBatchRewriting}
					>
						{isBatchRewriting
							? '⏳ Rewriting…'
							: `✏ Rewrite${selectedCards.length > 1 ? ` ${selectedCards.length}` : ''}`}
					</button>
					<button className="gw-review-back-btn" onClick={clearSelection}>
						Clear
					</button>
				</div>
			)}

		</div>
	);
};

// ── ParagraphCard ─────────────────────────────────────────────────────────────

interface ParagraphCardProps {
	card: CardData;
	index: number;
	isInstructionOpen: boolean;
	onSelect: (id: number, event: React.MouseEvent) => void;
	onExclude: (id: number) => void;
	onInclude: (id: number) => void;
	onTextChange: (id: number, newText: string) => void;
	onOpenInstruction: (id: number) => void;
	onCloseInstruction: () => void;
	onRewrite: (id: number, instruction: string) => void;
	onRevert: (id: number) => void;
}

const ParagraphCard: React.FC<ParagraphCardProps> = ({
	card,
	index,
	isInstructionOpen,
	onSelect,
	onExclude,
	onInclude,
	onTextChange,
	onOpenInstruction,
	onCloseInstruction,
	onRewrite,
	onRevert,
}) => {
	const [localInstruction, setLocalInstruction] = useState('');
	const [isEditing, setIsEditing] = useState(false);
	const [editValue, setEditValue] = useState(card.text);
	const instructionRef = useRef<HTMLInputElement>(null);

	// Sync edit value when card text changes externally (after rewrite/revert)
	useEffect(() => {
		if (!isEditing) setEditValue(card.text);
	}, [card.text, isEditing]);

	// Auto-focus the instruction input when it opens
	useEffect(() => {
		if (isInstructionOpen && instructionRef.current) {
			instructionRef.current.focus();
		}
	}, [isInstructionOpen]);

	const handleInstructionSubmit = () => {
		if (localInstruction.trim()) {
			onRewrite(card.id, localInstruction);
			setLocalInstruction('');
		}
	};

	const handleEditBlur = () => {
		setIsEditing(false);
		onTextChange(card.id, editValue);
	};

	const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Escape') {
			setEditValue(card.text);
			setIsEditing(false);
		}
	};

	const cardClass = [
		'gw-para-card',
		card.selected ? 'gw-para-card--selected' : '',
		card.excluded ? 'gw-para-card--excluded' : '',
		card.rewriting ? 'gw-para-card--rewriting' : '',
		card.modified && !card.rewriting ? 'gw-para-card--modified' : '',
	].filter(Boolean).join(' ');

	return (
		<div className={cardClass}>

			{/* ── Header row: number + actions ── */}
			<div
				className="gw-para-card-header"
				onClick={e => {
					if (!card.excluded && !card.rewriting && !isEditing) {
						onSelect(card.id, e);
					}
				}}
			>
				<span className="gw-para-num">{index + 1}</span>

				{card.modified && !card.rewriting && (
					<span className="gw-para-modified-dot" title="Modified from original" />
				)}

				<div className="gw-para-actions">
					{!card.excluded && !card.rewriting && (
						<>
							{card.modified && (
								<button
									className="gw-para-action-btn"
									title="Revert to original"
									onClick={e => { e.stopPropagation(); onRevert(card.id); }}
								>
									↩
								</button>
							)}
							<button
								className={`gw-para-action-btn${isInstructionOpen ? ' gw-para-action-btn--active' : ''}`}
								title="AI rewrite"
								onClick={e => { e.stopPropagation(); onOpenInstruction(card.id); }}
							>
								✏
							</button>
							<button
								className="gw-para-action-btn gw-para-action-btn--danger"
								title="Exclude from push"
								onClick={e => { e.stopPropagation(); onExclude(card.id); }}
							>
								✕
							</button>
						</>
					)}
					{card.excluded && (
						<button
							className="gw-para-action-btn"
							title="Re-include in push"
							onClick={e => { e.stopPropagation(); onInclude(card.id); }}
						>
							+ Include
						</button>
					)}
				</div>
			</div>

			{/* ── Body: text / editing / streaming ── */}
			<div className="gw-para-card-body">
				{card.rewriting ? (
					<div className="gw-para-rewriting">
						<div className="gw-para-old-text">{card.text}</div>
						{card.streamingText && (
							<div className="gw-para-new-text">
								{card.streamingText}
								<span className="gw-gen-cursor">▌</span>
							</div>
						)}
					</div>
				) : isEditing ? (
					<textarea
						className="gw-para-edit-textarea"
						value={editValue}
						onChange={e => setEditValue(e.target.value)}
						onBlur={handleEditBlur}
						onKeyDown={handleEditKeyDown}
						autoFocus
					/>
				) : (
					<div
						className={`gw-para-text${card.excluded ? ' gw-para-text--excluded' : ''}`}
						onClick={() => {
							if (!card.excluded && !card.rewriting) {
								setIsEditing(true);
							}
						}}
						title={card.excluded ? '' : 'Click to edit'}
					>
						{card.text}
					</div>
				)}
			</div>

			{/* ── Inline instruction input (single-card rewrite) ── */}
			{isInstructionOpen && !card.rewriting && !card.excluded && (
				<div className="gw-para-instruction">
					<input
						ref={instructionRef}
						className="gw-para-instruction-input"
						placeholder="What should change? (Enter to rewrite)"
						value={localInstruction}
						onChange={e => setLocalInstruction(e.target.value)}
						onKeyDown={e => {
							if (e.key === 'Enter') {
								e.preventDefault();
								handleInstructionSubmit();
							}
							if (e.key === 'Escape') {
								onCloseInstruction();
								setLocalInstruction('');
							}
						}}
					/>
					<button
						className="gw-btn gw-btn-rewrite"
						onClick={handleInstructionSubmit}
						disabled={!localInstruction.trim()}
					>
						Rewrite
					</button>
					<button
						className="gw-review-back-btn"
						onClick={() => { onCloseInstruction(); setLocalInstruction(''); }}
					>
						Cancel
					</button>
				</div>
			)}

		</div>
	);
};
