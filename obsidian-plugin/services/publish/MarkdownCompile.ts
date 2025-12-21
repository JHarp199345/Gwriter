import type { App } from 'obsidian';
import { TFile } from 'obsidian';

export interface CompiledChapter {
	title: string;
	sourcePath: string;
	markdown: string;
}

export interface CompileResult {
	titleGuess?: string;
	chapters: CompiledChapter[];
}

function trimBom(s: string): string {
	return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseH1Chapters(markdown: string, sourcePath: string): CompiledChapter[] {
	const text = trimBom(markdown);
	const lines = text.split(/\r?\n/);
	const chapters: CompiledChapter[] = [];

	let currentTitle = '';
	let currentBody: string[] = [];

	const flush = () => {
		const body = currentBody.join('\n').trim();
		if (!currentTitle && !body) return;
		const title = currentTitle || 'Chapter';
		chapters.push({ title, sourcePath, markdown: body });
	};

	for (const line of lines) {
		const m = /^#\s+(.+?)\s*$/.exec(line);
		if (m) {
			// New chapter
			if (currentTitle || currentBody.length) flush();
			currentTitle = m[1].trim();
			currentBody = [];
			continue;
		}
		currentBody.push(line);
	}
	flush();

	if (chapters.length === 0) {
		return [{ title: 'Book', sourcePath, markdown: text.trim() }];
	}
	return chapters;
}

function extractTocBlock(markdown: string): string[] | null {
	// Prefer a section headed by "# TOC" (case-insensitive).
	const lines = trimBom(markdown).split(/\r?\n/);
	const startIdx = lines.findIndex((l) => /^#\s+toc\s*$/i.test(l.trim()));
	if (startIdx < 0) return null;

	const block: string[] = [];
	for (let i = startIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (/^#\s+/.test(line.trim())) break; // stop at next H1
		block.push(line);
	}
	return block;
}

function extractListLinks(lines: string[]): string[] {
	const links: string[] = [];
	for (const line of lines) {
		if (!/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)) continue;

		// Wikilinks: [[Chapter 01]] or [[Folder/Chapter 01|Title]]
		const wikiMatches = Array.from(line.matchAll(/\[\[([^\]|#]+)(?:#[^\]]+)?(?:\|[^\]]+)?\]\]/g));
		for (const m of wikiMatches) links.push(m[1].trim());

		// Markdown links: [Title](path/to/chapter.md)
		const mdMatches = Array.from(line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g));
		for (const m of mdMatches) links.push(m[1].trim());
	}
	return links.filter(Boolean);
}

function uniquePreserveOrder(items: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const it of items) {
		const key = it;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(it);
	}
	return out;
}

function normalizeLinkTarget(raw: string): string {
	// Remove any fragment for our purposes.
	const noFrag = raw.split('#')[0].trim();
	if (!noFrag) return '';
	// Remove angle brackets used in markdown autolinks.
	return noFrag.replace(/^<|>$/g, '').trim();
}

function resolveLinkToFile(app: App, linkTarget: string, fromPath: string): TFile | null {
	const t = normalizeLinkTarget(linkTarget);
	if (!t) return null;

	// If it's a full path and exists, use it.
	const direct = app.vault.getAbstractFileByPath(t);
	if (direct instanceof TFile) return direct;

	// Try adding .md for wikilink-like targets.
	const directMd = app.vault.getAbstractFileByPath(`${t}.md`);
	if (directMd instanceof TFile) return directMd;

	// Use metadata cache link resolution.
	const dest = app.metadataCache.getFirstLinkpathDest(t, fromPath);
	if (dest instanceof TFile) return dest;

	return null;
}

export class MarkdownCompile {
	private readonly app: App;

	constructor(app: App) {
		this.app = app;
	}

	async compileFromBookMain(sourcePath: string): Promise<CompileResult> {
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(file instanceof TFile)) {
			throw new Error(`Book main file not found: ${sourcePath}`);
		}
		const text = await this.app.vault.read(file);
		const chapters = parseH1Chapters(text, file.path);
		return { titleGuess: file.basename, chapters };
	}

	async compileFromTocNote(tocPath: string): Promise<CompileResult> {
		const file = this.app.vault.getAbstractFileByPath(tocPath);
		if (!(file instanceof TFile)) throw new Error(`TOC note not found: ${tocPath}`);

		const text = await this.app.vault.read(file);
		const lines = trimBom(text).split(/\r?\n/);
		const tocBlock = extractTocBlock(text);
		const linkTargets = tocBlock ? extractListLinks(tocBlock) : extractListLinks(lines);
		const ordered = uniquePreserveOrder(linkTargets);
		if (ordered.length === 0) {
			throw new Error('No chapter links found in the TOC note.');
		}

		const chapters: CompiledChapter[] = [];
		for (const target of ordered) {
			const dest = resolveLinkToFile(this.app, target, file.path);
			if (!dest) continue;
			const md = await this.app.vault.read(dest);
			const title = (() => {
				const m = /^#\s+(.+?)\s*$/m.exec(md);
				return m ? m[1].trim() : dest.basename;
			})();
			chapters.push({ title, sourcePath: dest.path, markdown: md });
		}

		if (chapters.length === 0) {
			throw new Error('No linked chapter files could be resolved.');
		}

		return { titleGuess: file.basename, chapters };
	}
}


