import React from 'react';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

export const DirectorNotes: React.FC<{
	value: string;
	onChange: (value: string) => void;
	mode: Mode;
}> = ({ value, onChange, mode }) => {
	const placeholder = mode === 'chapter' 
		? 'Enter your slate instructions, directions, and story elements...'
		: mode === 'micro-edit'
		? 'Enter your grievances, plot disagreements, or desired changes...'
		: 'Character extraction will analyze the selected text automatically...';
	
	return (
		<div className="director-notes">
			<label>
				{mode === 'chapter' ? 'Author Instructions:' : mode === 'micro-edit' ? 'Grievances & Directives:' : 'Notes (optional):'}
			</label>
			<textarea
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

