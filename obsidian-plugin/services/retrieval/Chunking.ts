export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'none';

export interface IndexChunk {
	startWord: number;
	endWord: number;
	text: string;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function splitWords(text: string): string[] {
	return (text || '').split(/\s+/g).filter(Boolean);
}

function isHeadingLine(line: string, level: HeadingLevel): boolean {
	const t = (line || '').trimStart();
	if (level === 'h1') return /^#(?!#)\s+/.test(t);
	if (level === 'h2') return /^##(?!#)\s+/.test(t);
	if (level === 'h3') return /^###(?!#)\s+/.test(t);
	return false;
}

function splitByHeadingLevel(text: string, level: HeadingLevel): string[] {
	if (level === 'none') return [];
	const normalized = (text || '').replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');

	const sections: string[] = [];
	let current: string[] = [];
	let seenHeading = false;

	const flush = () => {
		const body = current.join('\n').trim();
		if (body) sections.push(body);
	};

	for (const line of lines) {
		if (isHeadingLine(line, level)) {
			if (seenHeading) flush();
			seenHeading = true;
			current = [line.trimEnd()];
			continue;
		}
		current.push(line);
	}

	if (seenHeading) {
		flush();
		return sections;
	}
	return [];
}

function chunkWordsWindow(
	text: string,
	globalStartWord: number,
	targetWords: number,
	overlapWords: number
): IndexChunk[] {
	const words = splitWords(text);
	if (words.length === 0) return [];

	const size = clampInt(targetWords, 200, 2000);
	const overlap = clampInt(overlapWords, 0, Math.max(0, size - 1));
	const step = Math.max(1, size - overlap);

	const out: IndexChunk[] = [];
	for (let start = 0; start < words.length; start += step) {
		const end = Math.min(words.length, start + size);
		out.push({
			startWord: globalStartWord + start,
			endWord: globalStartWord + end,
			text: words.slice(start, end).join(' ')
		});
		if (end >= words.length) break;
	}
	return out;
}

function mergeSmallSections(sections: string[], minWords: number): string[] {
	const min = Math.max(1, Math.floor(minWords));
	const out: string[] = [];

	let buf: string[] = [];
	let bufWords = 0;

	const flush = () => {
		const merged = buf.join('\n\n').trim();
		if (merged) out.push(merged);
		buf = [];
		bufWords = 0;
	};

	for (const s of sections) {
		const words = splitWords(s).length;
		if (bufWords === 0) {
			buf = [s];
			bufWords = words;
		} else if (bufWords < min) {
			buf.push(s);
			bufWords += words;
		} else {
			flush();
			buf = [s];
			bufWords = words;
		}
	}
	if (bufWords > 0) flush();
	return out;
}

export function buildIndexChunks(params: {
	text: string;
	headingLevel: HeadingLevel;
	targetWords: number;
	overlapWords: number;
}): IndexChunk[] {
	const level = params.headingLevel;
	const target = clampInt(params.targetWords, 200, 2000);
	const overlap = clampInt(params.overlapWords, 0, 500);

	// Preferred heading-based segmentation.
	const sections = splitByHeadingLevel(params.text, level);
	if (sections.length > 0) {
		const minWords = Math.max(200, Math.floor(target * 0.5));
		const merged = mergeSmallSections(sections, minWords);

		const out: IndexChunk[] = [];
		let cursor = 0;
		for (const sec of merged) {
			const words = splitWords(sec).length;
			if (words <= target) {
				out.push({ startWord: cursor, endWord: cursor + words, text: sec });
				cursor += words;
				continue;
			}
			const sub = chunkWordsWindow(sec, cursor, target, overlap);
			out.push(...sub);
			cursor += words;
		}
		return out;
	}

	// Fallback: word-window chunking over the whole text.
	return chunkWordsWindow(params.text, 0, target, overlap);
}


