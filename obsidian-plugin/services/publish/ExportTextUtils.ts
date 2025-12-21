import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

function decodeEntities(s: string): string {
	// Minimal decode for common entities produced by markdown-it.
	return s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

export function markdownToPlainText(markdown: string): string {
	const html = md.render(markdown || '');
	// Strip tags and collapse whitespace. Keep paragraph breaks.
	const withBreaks = html
		.replace(/<\/p>\s*<p>/g, '\n\n')
		.replace(/<br\s*\/?>/g, '\n')
		.replace(/<\/h\d>\s*<h\d[^>]*>/g, '\n\n')
		.replace(/<\/li>\s*<li>/g, '\n')
		.replace(/<\/(ul|ol)>/g, '\n\n');
	const stripped = withBreaks.replace(/<[^>]+>/g, '');
	return decodeEntities(stripped).replace(/\n{3,}/g, '\n\n').trim();
}

export function sliceFirstNWords(text: string, wordLimit: number): string {
	const limit = Math.max(0, Math.floor(wordLimit));
	if (limit <= 0) return '';
	const words = (text || '').trim().split(/\s+/g).filter(Boolean);
	if (words.length <= limit) return words.join(' ');
	return words.slice(0, limit).join(' ');
}

export function countWords(text: string): number {
	return (text || '').trim().split(/\s+/g).filter(Boolean).length;
}


