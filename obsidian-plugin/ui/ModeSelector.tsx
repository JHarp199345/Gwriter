import React from 'react';

type Mode = 'chapter' | 'micro-edit' | 'character-update' | 'continuity-check';

export const ModeSelector: React.FC<{
	mode: Mode;
	onChange: (mode: Mode) => void;
}> = ({ mode, onChange }) => {
	return (
		<div className="mode-selector">
			<label>Mode:</label>
			<select 
				value={mode} 
				onChange={(e) => onChange(e.target.value as Mode)}
				className="mode-dropdown"
			>
				<option value="chapter">Generate chapter</option>
				<option value="micro-edit">Micro edit</option>
				<option value="character-update">Character update</option>
				<option value="continuity-check">Continuity check</option>
			</select>
		</div>
	);
};

