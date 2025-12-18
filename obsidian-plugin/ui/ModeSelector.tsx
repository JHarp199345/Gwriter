import React from 'react';

type Mode = 'chapter' | 'micro-edit' | 'character-update';

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
				<option value="chapter">Chapter Generate</option>
				<option value="micro-edit">Micro Edit</option>
				<option value="character-update">Character Update</option>
			</select>
		</div>
	);
};

