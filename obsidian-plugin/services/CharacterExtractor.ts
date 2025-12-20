export interface CharacterUpdate {
	character: string;
	update: string;
}

export class CharacterExtractor {
	/**
	 * Process multiple text chunks and aggregate character updates
	 */
	processChunks(
		chunks: string[],
		parseExtractionFn: (extractionText: string) => CharacterUpdate[]
	): CharacterUpdate[] {
		const allUpdates: Map<string, string[]> = new Map();
		
		// Process each chunk
		for (const chunk of chunks) {
			const updates = parseExtractionFn(chunk);
			
			// Aggregate updates by character
			for (const update of updates) {
				const existing = allUpdates.get(update.character) ?? [];
				existing.push(update.update);
				allUpdates.set(update.character, existing);
			}
		}
		
		// Combine updates for each character
		const aggregatedUpdates: CharacterUpdate[] = [];
		for (const [character, updates] of allUpdates.entries()) {
			// Combine all updates for this character
			const combinedUpdate = updates.join('\n\n---\n\n');
			aggregatedUpdates.push({
				character,
				update: combinedUpdate
			});
		}
		
		return aggregatedUpdates;
	}

	parseExtraction(extractionText: string, opts?: { strict?: boolean }): CharacterUpdate[] {
		const updates: CharacterUpdate[] = [];
		const strict = opts?.strict ?? false;
		
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
		
		// If no structured format found, try to extract character names from text (optional)
		if (!strict && updates.length === 0) {
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

