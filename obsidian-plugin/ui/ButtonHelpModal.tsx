import { Modal } from 'obsidian';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';

type Mode = 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';

interface WorkflowItem {
	buttonLabel: string;
	workflow: string[];
	mode?: Mode[];
}

const WORKFLOWS: Record<string, WorkflowItem[]> = {
	'Content Generation': [
		{
			buttonLabel: 'Generate chapter',
			mode: ['chapter'],
			workflow: [
				'Write your Scene Summary / Directions',
				'Set target word range (Min → Max)',
				'Optional: Review/edit Rewrite Instructions',
				'Click "Generate chapter"',
				'Review output and copy to your manuscript'
			]
		},
		{
			buttonLabel: 'Generate edit',
			mode: ['micro-edit'],
			workflow: [
				'Paste problematic passage in "Selected Text"',
				'Enter grievances/directives in the textarea',
				'Click "Generate edit"',
				'Copy the refined alternative into your manuscript'
			]
		},
		{
			buttonLabel: 'Run continuity check',
			mode: ['continuity-check'],
			workflow: [
				'Paste draft text to check (or use last generated output)',
				'Optional: Adjust focus toggles (Knowledge, Timeline, POV, Naming)',
				'Click "Run continuity check"',
				'Review violations report with suggested patches'
			]
		}
	],
	'Character Management': [
		{
			buttonLabel: 'Update characters',
			mode: ['character-update'],
			workflow: [
				'Paste character-relevant text in "Selected Text" field',
				'Click "Update characters"',
				'Character notes are automatically updated with timestamped entries in the Characters/ folder'
			]
		},
		{
			buttonLabel: 'Select file to process',
			mode: ['character-update'],
			workflow: [
				'Click to open file tree picker',
				'Select a manuscript file for bulk character extraction',
				'Selected file will be used by "Process entire book" button'
			]
		},
		{
			buttonLabel: 'Use book main path',
			mode: ['character-update'],
			workflow: [
				'Resets the source file back to your main book file (configured in settings)',
				'Useful when you want to switch from a custom file back to the default'
			]
		},
		{
			buttonLabel: 'Process entire book',
			mode: ['character-update'],
			workflow: [
				'Optional: Select custom file with "Select file to process"',
				'Click to perform 2-pass scan (roster + per-chapter extraction)',
				'Character notes updated from entire manuscript automatically'
			]
		},
		{
			buttonLabel: 'Chunk current note',
			mode: ['character-update'],
			workflow: [
				'Select a file to process first',
				'Click to chunk it into smaller sections for processing'
			]
		}
	],
	'Story Bible': [
		{
			buttonLabel: 'Update story bible',
			mode: ['chapter'],
			workflow: [
				'Write or generate a chapter',
				'Click "Update story bible" to extract updates from the text',
				'Review the merged output in the generated text area',
				'Use "Save merged story bible" or "Replace story bible" to save'
			]
		},
		{
			buttonLabel: 'Save merged story bible',
			mode: ['chapter'],
			workflow: [
				'After updating story bible, review the merged output',
				'Click to save as a new versioned file in Story bibles/ folder',
				'File will be named "Story bible - YYYY-MM-DD.md"'
			]
		},
		{
			buttonLabel: 'Replace story bible',
			mode: ['chapter'],
			workflow: [
				'After updating story bible, review the merged output',
				'Click to save new version and automatically update the active story bible path in settings'
			]
		}
	],
	'Utilities': [
		{
			buttonLabel: 'Export to epub',
			workflow: [
				'Click to open export wizard',
				'Step 1: Select source (book main file or TOC note)',
				'Step 2: Enter metadata (title, author, language, subtitle)',
				'Step 3: Configure front matter (title page, copyright page, license)',
				'Step 4: Choose typography and optional font embedding',
				'Step 5: Select output folder and file name',
				'Step 6: Click export to generate EPUB, DOCX, RTF, or plain text'
			]
		},
		{
			buttonLabel: 'Preview prompt',
			workflow: [
				'Configure all inputs (scene summary, selected text, etc.)',
				'Click to preview the full prompt that will be sent to AI',
				'Review token estimates and retrieved context summary',
				'Useful for debugging or understanding what context the AI sees'
			]
		}
	]
};

interface ButtonHelpModalComponentProps {
	onClose: () => void;
}

export const ButtonHelpModalComponent: React.FC<ButtonHelpModalComponentProps> = ({ onClose }) => {
	const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

	const toggleCategory = (category: string) => {
		setExpandedCategory(expandedCategory === category ? null : category);
	};

	return (
		<div style={{ padding: '20px', maxHeight: '70vh', overflowY: 'auto' }}>
			<h2 style={{ marginTop: 0 }}>Button Workflows</h2>
			<p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '20px' }}>
				Click on a category to expand and see detailed workflows for each button.
			</p>
			{Object.entries(WORKFLOWS).map(([category, items]) => (
				<div key={category} style={{ marginBottom: '16px' }}>
					<button
						onClick={() => toggleCategory(category)}
						style={{
							width: '100%',
							textAlign: 'left',
							padding: '12px',
							background: 'var(--background-secondary)',
							border: '1px solid var(--background-modifier-border)',
							borderRadius: '4px',
							cursor: 'pointer',
							fontSize: '16px',
							fontWeight: 600,
							display: 'flex',
							justifyContent: 'space-between',
							alignItems: 'center'
						}}
					>
						<span>{category}</span>
						<span>{expandedCategory === category ? '−' : '+'}</span>
					</button>
					{expandedCategory === category && (
						<div style={{ marginTop: '8px', paddingLeft: '12px' }}>
							{items.map((item, index) => (
								<div
									key={index}
									style={{
										marginBottom: '20px',
										padding: '12px',
										background: 'var(--background-primary)',
										border: '1px solid var(--background-modifier-border)',
										borderRadius: '4px'
									}}
								>
									<h3
										style={{
											margin: '0 0 8px 0',
											fontSize: '14px',
											fontWeight: 600,
											color: 'var(--text-accent)'
										}}
									>
										{item.buttonLabel}
									</h3>
									{item.mode && (
										<div
											style={{
												fontSize: '12px',
												color: 'var(--text-muted)',
												marginBottom: '8px',
												fontStyle: 'italic'
											}}
										>
											Available in: {item.mode.join(', ')} mode
										</div>
									)}
									<ol style={{ margin: 0, paddingLeft: '20px' }}>
										{item.workflow.map((step, stepIndex) => (
											<li key={stepIndex} style={{ marginBottom: '4px', fontSize: '13px' }}>
												{step}
											</li>
										))}
									</ol>
								</div>
							))}
						</div>
					)}
				</div>
			))}
		</div>
	);
};

export class ButtonHelpModal extends Modal {
	private reactRoot: { render: (node: unknown) => void; unmount: () => void } | null = null;

	onOpen() {
		this.titleEl.setText('Button Workflows & Usage Guide');
		this.contentEl.empty();
		const container = this.contentEl.createDiv();
		this.reactRoot = createRoot(container);
		this.reactRoot.render(React.createElement(ButtonHelpModalComponent, { onClose: () => this.close() }));
	}

	onClose() {
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
		this.contentEl.empty();
	}
}

