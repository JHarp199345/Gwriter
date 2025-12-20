export class TextChunker {
	/**
	 * Split text into chunks of approximately the specified word count
	 * Tries to break at sentence boundaries when possible
	 */
	static chunkText(text: string, wordsPerChunk: number = 500): string[] {
		const chunks: string[] = [];
		const words = text.trim().split(/\s+/);
		
		if (words.length === 0) {
			return [];
		}
		
		let currentChunk: string[] = [];
		let currentWordCount = 0;
		
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			currentChunk.push(word);
			currentWordCount++;
			
			// Check if we've reached the target word count
			if (currentWordCount >= wordsPerChunk) {
				// Try to find a sentence boundary (period, exclamation, question mark)
				// Look ahead up to 50 words to find a good break point
				let foundBreak = false;
				for (let j = i + 1; j < Math.min(i + 50, words.length); j++) {
					const nextWord = words[j];
					// Check if previous word ended with sentence punctuation
					if (j > 0 && /[.!?]$/.test(words[j - 1])) {
						// Found a sentence boundary, break here
						const chunkText = currentChunk.join(' ');
						if (chunkText.trim()) {
							chunks.push(chunkText.trim());
						}
						currentChunk = [];
						currentWordCount = 0;
						foundBreak = true;
						i = j - 1; // Adjust i to account for words we've already processed
						break;
					}
				}
				
				// If no sentence boundary found, break at current position
				if (!foundBreak) {
					const chunkText = currentChunk.join(' ');
					if (chunkText.trim()) {
						chunks.push(chunkText.trim());
					}
					currentChunk = [];
					currentWordCount = 0;
				}
			}
		}
		
		// Add remaining words as final chunk
		if (currentChunk.length > 0) {
			const chunkText = currentChunk.join(' ');
			if (chunkText.trim()) {
				chunks.push(chunkText.trim());
			}
		}
		
		return chunks;
	}
	
	/**
	 * Get word count of text
	 */
	static getWordCount(text: string): number {
		return text.trim().split(/\s+/).filter(word => word.length > 0).length;
	}
}

