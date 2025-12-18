export interface CharacterUpdate {
	character: string;
	update: string;
}

export class CharacterExtractor {
	parseExtraction(extractionText: string): CharacterUpdate[] {
		const updates: CharacterUpdate[] = [];
		
		// Split by character sections (## CharacterName)
		const characterSections = extractionText.split(/^##\s+(.+)$/m);
		
		for (let i = 1; i < characterSections.length; i += 2) {
			if (i + 1 < characterSections.length) {
				const characterName = characterSections[i].trim();
				let content = characterSections[i + 1].trim();
				
				if (characterName && content) {
					// Remove the timestamp header if present
					content = content.replace(/^###\s+.*?Update\s*\n/m, '').trim();
					
					if (content) {
						updates.push({
							character: characterName,
							update: content
						});
					}
				}
			}
		}
		
		// If no structured format found, try to extract character names from text
		if (updates.length === 0) {
			// Look for character names mentioned in the text (capitalized words)
			const characterPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
			const potentialCharacters = new Set<string>();
			let match;
			
			while ((match = characterPattern.exec(extractionText)) !== null) {
				const name = match[1];
				if (name.split(' ').length <= 3) {
					potentialCharacters.add(name);
				}
			}
			
			// Create updates for potential characters
			for (const charName of potentialCharacters) {
				updates.push({
					character: charName,
					update: extractionText
				});
			}
		}
		
		return updates;
	}
}

