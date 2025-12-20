import React, { useRef } from 'react';
import { TextChunker } from '../services/TextChunker';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

export const DirectorNotes: React.FC<{
	value: string;
	onChange: (value: string) => void;
	mode: Mode;
	onResetToDefault?: () => void;
}> = ({ value, onChange, mode, onResetToDefault }) => {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	
	const placeholder = mode === 'chapter' 
		? 'Enter your rewrite instructions...'
		: mode === 'micro-edit'
		? 'Enter your grievances, plot disagreements, or desired changes...'
		: 'Character extraction will analyze the selected text automatically...';

	const wordCount = TextChunker.getWordCount(value || '');
	const charCount = (value || '').length;
	
	return (
		<div className="director-notes">
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
				<label>
					{mode === 'chapter' ? 'Rewrite Instructions:' : mode === 'micro-edit' ? 'Grievances & Directives:' : 'Notes (optional):'}
				</label>
				<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
					<span className="generation-status" style={{ margin: 0 }}>
						{wordCount.toLocaleString()} words / {charCount.toLocaleString()} chars
					</span>
					{mode === 'chapter' && onResetToDefault && (
						<button
							type="button"
							onClick={onResetToDefault}
							className="copy-button"
						>
							Reset to default
						</button>
					)}
				</div>
			</div>
			<textarea
				ref={textareaRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				rows={6}
				disabled={mode === 'character-update'}
				className="director-notes-textarea"
			/>
		</div>
	);
};

