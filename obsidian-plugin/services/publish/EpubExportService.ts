import { Vault } from 'obsidian';
import JSZip from 'jszip';
import MarkdownIt from 'markdown-it';
import type { LicenseTemplateId } from './LicenseTemplates';
import { getLicenseTemplate } from './LicenseTemplates';

export interface ExportFontFiles {
	regularPath: string;
	boldPath?: string;
	italicPath?: string;
	boldItalicPath?: string;
}

export interface ExportEpubParams {
	// Source
	bookTitle: string;
	author: string;
	language: string;
	subtitle?: string;

	// Chapters (already ordered)
	chapters: Array<{ title: string; markdown: string; sourcePath: string }>;

	// Front matter
	includeTitlePage: boolean;
	includeCopyrightPage: boolean;
	licenseTemplateId: LicenseTemplateId;
	copyrightYear: string;
	copyrightHolder: string;

	// Typography
	embedCustomFonts: boolean;
	customFonts?: ExportFontFiles;

	// Output
	outputFolder: string; // vault-relative folder
	outputFileName: string; // should end with .epub
}

interface ManifestItem {
	id: string;
	href: string;
	mediaType: string;
	properties?: string;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function sanitizeFileName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return 'book';
	const forbidden = '<>:"/\\\\|?*';
	let out = '';
	for (const ch of trimmed) {
		const code = ch.charCodeAt(0);
		if (code < 32) {
			out += '_';
			continue;
		}
		out += forbidden.includes(ch) ? '_' : ch;
	}
	return out.length ? out : 'book';
}

function normalizeFolder(folder: string): string {
	const f = folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	return f.length ? f : 'Exports';
}

function ensureEpubExt(name: string): string {
	return name.toLowerCase().endsWith('.epub') ? name : `${name}.epub`;
}

function nowIsoUtc(): string {
	// EPUB requires UTC-ish modified timestamp
	return new Date().toISOString();
}

function uuidLike(): string {
	// Prefer crypto.randomUUID if present.
	try {
		const c = globalThis.crypto as unknown as { randomUUID?: () => string } | undefined;
		if (c?.randomUUID) return c.randomUUID();
	} catch {
		// ignore
	}
	// Fallback: not cryptographically strong, but OK for an identifier.
	return `wd-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}

function xhtmlDocument(title: string, bodyInner: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>\n` +
		`<!DOCTYPE html>\n` +
		`<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">\n` +
		`<head>\n` +
		`  <title>${escapeXml(title)}</title>\n` +
		`  <meta charset="utf-8" />\n` +
		`  <link rel="stylesheet" type="text/css" href="../Styles/style.css" />\n` +
		`</head>\n` +
		`<body>\n` +
		bodyInner +
		`\n</body>\n` +
		`</html>\n`;
}

function buildNavXhtml(chapters: Array<{ title: string; href: string }>, bookTitle: string): string {
	const items = chapters
		.map((c) => `<li><a href="${escapeXml(c.href)}">${escapeXml(c.title)}</a></li>`)
		.join('\n');
	return `<?xml version="1.0" encoding="utf-8"?>\n` +
		`<!DOCTYPE html>\n` +
		`<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">\n` +
		`<head>\n` +
		`  <title>${escapeXml(bookTitle)}</title>\n` +
		`  <meta charset="utf-8" />\n` +
		`  <link rel="stylesheet" type="text/css" href="Styles/style.css" />\n` +
		`</head>\n` +
		`<body>\n` +
		`  <nav epub:type="toc" id="toc">\n` +
		`    <h1>Contents</h1>\n` +
		`    <ol>\n` +
		items +
		`\n    </ol>\n` +
		`  </nav>\n` +
		`</body>\n` +
		`</html>\n`;
}

function buildTocNcx(uuid: string, chapters: Array<{ title: string; href: string }>, bookTitle: string): string {
	const navPoints = chapters
		.map((c, idx) => {
			const order = idx + 1;
			return (
				`<navPoint id="navPoint-${order}" playOrder="${order}">\n` +
				`  <navLabel><text>${escapeXml(c.title)}</text></navLabel>\n` +
				`  <content src="${escapeXml(c.href)}"/>\n` +
				`</navPoint>`
			);
		})
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">\n` +
		`<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
		`<head>\n` +
		`  <meta name="dtb:uid" content="${escapeXml(uuid)}"/>\n` +
		`  <meta name="dtb:depth" content="1"/>\n` +
		`  <meta name="dtb:totalPageCount" content="0"/>\n` +
		`  <meta name="dtb:maxPageNumber" content="0"/>\n` +
		`</head>\n` +
		`<docTitle><text>${escapeXml(bookTitle)}</text></docTitle>\n` +
		`<navMap>\n` +
		navPoints +
		`\n</navMap>\n` +
		`</ncx>\n`;
}

function inferMediaType(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'xhtml':
		case 'html':
			return 'application/xhtml+xml';
		case 'css':
			return 'text/css';
		case 'ncx':
			return 'application/x-dtbncx+xml';
		case 'ttf':
			return 'font/ttf';
		case 'otf':
			return 'font/otf';
		case 'woff':
			return 'font/woff';
		case 'woff2':
			return 'font/woff2';
		default:
			return 'application/octet-stream';
	}
}

function buildDefaultCss(fontFamily: string, embedFonts: boolean, fontFileNames?: Partial<Record<keyof ExportFontFiles, string>>): string {
	const base = [
		`html, body { margin: 0; padding: 0; }`,
		`body { font-family: ${fontFamily}; font-size: 1em; line-height: 1.55; padding: 0 0.8em; }`,
		`h1, h2, h3 { font-family: ${fontFamily}; line-height: 1.2; }`,
		`h1 { font-size: 1.6em; margin: 1.1em 0 0.6em; }`,
		`p { margin: 0.9em 0; }`,
		`.chapter-title { page-break-before: always; }`,
		`.front-matter { page-break-before: always; }`,
		`a { color: inherit; }`
	];

	if (!embedFonts || !fontFileNames?.regularPath) return base.join('\n');

	const faces: string[] = [];
	const addFace = (key: keyof ExportFontFiles, weight: number, style: 'normal' | 'italic') => {
		const file = fontFileNames[key];
		if (!file) return;
		faces.push(
			`@font-face { font-family: "CustomSerif"; src: url("../Fonts/${file}"); font-weight: ${weight}; font-style: ${style}; }`
		);
	};

	addFace('regularPath', 400, 'normal');
	addFace('boldPath', 700, 'normal');
	addFace('italicPath', 400, 'italic');
	addFace('boldItalicPath', 700, 'italic');

	return [...faces, ``, ...base.map((l) => l.replace(fontFamily, `"CustomSerif", serif`))].join('\n');
}

export class EpubExportService {
	private readonly vault: Vault;
	private readonly md: MarkdownIt;

	constructor(vault: Vault) {
		this.vault = vault;
		this.md = new MarkdownIt({
			html: false,
			linkify: true,
			typographer: true
		});
	}

	async exportEpub(params: ExportEpubParams): Promise<{ outputPath: string }> {
		const bookTitle = params.bookTitle.trim() || 'Untitled';
		const author = params.author.trim();
		const language = params.language.trim() || 'en';
		const subtitle = (params.subtitle || '').trim();

		const folder = normalizeFolder(params.outputFolder);
		const fileName = ensureEpubExt(sanitizeFileName(params.outputFileName || bookTitle));
		const outputPath = `${folder}/${fileName}`.replace(/\\/g, '/');

		await this.ensureFolder(folder);

		const uuid = uuidLike();
		const modified = nowIsoUtc();

		const zip = new JSZip();
		// mimetype must be first and uncompressed
		zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

		zip.folder('META-INF')?.file(
			'container.xml',
			`<?xml version="1.0" encoding="UTF-8"?>\n` +
				`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
				`  <rootfiles>\n` +
				`    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n` +
				`  </rootfiles>\n` +
				`</container>\n`
		);

		const oebps = zip.folder('OEBPS');
		if (!oebps) throw new Error('Failed to initialize EPUB container.');

		const textFolder = oebps.folder('Text');
		const stylesFolder = oebps.folder('Styles');
		const fontsFolder = oebps.folder('Fonts');
		if (!textFolder || !stylesFolder || !fontsFolder) throw new Error('Failed to initialize EPUB folders.');

		const manifest: ManifestItem[] = [];
		const spine: string[] = [];

		// Navigation
		manifest.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' });
		manifest.push({ id: 'toc', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' });

		// Styles
		const fontFamily = `"Literata", "Georgia", serif`;
		const fontFileNames: Partial<Record<keyof ExportFontFiles, string>> = {};
		if (params.embedCustomFonts && params.customFonts?.regularPath) {
			fontFileNames.regularPath = this.basename(params.customFonts.regularPath);
			if (params.customFonts.boldPath) fontFileNames.boldPath = this.basename(params.customFonts.boldPath);
			if (params.customFonts.italicPath) fontFileNames.italicPath = this.basename(params.customFonts.italicPath);
			if (params.customFonts.boldItalicPath) fontFileNames.boldItalicPath = this.basename(params.customFonts.boldItalicPath);
		}
		const css = buildDefaultCss(fontFamily, params.embedCustomFonts, fontFileNames);
		stylesFolder.file('style.css', css);
		manifest.push({ id: 'css', href: 'Styles/style.css', mediaType: 'text/css' });

		// Front matter pages
		if (params.includeTitlePage) {
			const inner =
				`<section class="front-matter">\n` +
				`<h1>${escapeXml(bookTitle)}</h1>\n` +
				(subtitle ? `<h2>${escapeXml(subtitle)}</h2>\n` : '') +
				(author ? `<p>${escapeXml(author)}</p>\n` : '') +
				`</section>`;
			const xhtml = xhtmlDocument('Title', inner);
			textFolder.file('title.xhtml', xhtml);
			manifest.push({ id: 'title', href: 'Text/title.xhtml', mediaType: 'application/xhtml+xml' });
			spine.push('title');
		}

		if (params.includeCopyrightPage) {
			const template = getLicenseTemplate(params.licenseTemplateId);
			const xhtml = template.renderXhtml({
				title: bookTitle,
				author,
				year: params.copyrightYear || '',
				holder: params.copyrightHolder || ''
			});
			textFolder.file('copyright.xhtml', xhtml);
			manifest.push({ id: 'copyright', href: 'Text/copyright.xhtml', mediaType: 'application/xhtml+xml' });
			spine.push('copyright');
		}

		// Chapters
		const navChapters: Array<{ title: string; href: string }> = [];
		for (let i = 0; i < params.chapters.length; i++) {
			const ch = params.chapters[i];
			const html = this.md.render(ch.markdown || '');
			const inner =
				`<section class="chapter">\n` +
				`<h1 class="chapter-title">${escapeXml(ch.title || `Chapter ${i + 1}`)}</h1>\n` +
				html +
				`\n</section>`;
			const xhtml = xhtmlDocument(ch.title || `Chapter ${i + 1}`, inner);
			const file = `chapter-${String(i + 1).padStart(3, '0')}.xhtml`;
			textFolder.file(file, xhtml);
			const id = `ch${i + 1}`;
			manifest.push({ id, href: `Text/${file}`, mediaType: 'application/xhtml+xml' });
			spine.push(id);
			navChapters.push({ title: ch.title || `Chapter ${i + 1}`, href: `Text/${file}` });
		}

		// nav.xhtml + toc.ncx
		oebps.file('nav.xhtml', buildNavXhtml(navChapters, bookTitle));
		oebps.file('toc.ncx', buildTocNcx(uuid, navChapters, bookTitle));

		// Fonts
		if (params.embedCustomFonts && params.customFonts?.regularPath) {
			const fontPaths: Array<[keyof ExportFontFiles, string | undefined]> = [
				['regularPath', params.customFonts.regularPath],
				['boldPath', params.customFonts.boldPath],
				['italicPath', params.customFonts.italicPath],
				['boldItalicPath', params.customFonts.boldItalicPath]
			];

			for (const [, p] of fontPaths) {
				if (!p) continue;
				const data = await this.vault.adapter.readBinary(p);
				const name = this.basename(p);
				fontsFolder.file(name, data);
				manifest.push({ id: `font-${sanitizeFileName(name)}`, href: `Fonts/${name}`, mediaType: inferMediaType(name) });
			}
		}

		const opf = this.buildOpf({
			uuid,
			title: bookTitle,
			author,
			language,
			modified,
			manifest,
			spine
		});
		oebps.file('content.opf', opf);

		const bytes = await zip.generateAsync({
			type: 'uint8array',
			compression: 'DEFLATE',
			compressionOptions: { level: 9 }
		});

		const out = this.toArrayBuffer(bytes);
		await this.vault.adapter.writeBinary(outputPath, out);
		return { outputPath };
	}

	private buildOpf(params: {
		uuid: string;
		title: string;
		author: string;
		language: string;
		modified: string;
		manifest: ManifestItem[];
		spine: string[];
	}): string {
		const manifestXml = params.manifest
			.map((m) => {
				const props = m.properties ? ` properties="${escapeXml(m.properties)}"` : '';
				return `<item id="${escapeXml(m.id)}" href="${escapeXml(m.href)}" media-type="${escapeXml(m.mediaType)}"${props}/>`;
			})
			.join('\n    ');

		const spineXml = params.spine.map((idref) => `<itemref idref="${escapeXml(idref)}"/>`).join('\n    ');

		return `<?xml version="1.0" encoding="utf-8"?>\n` +
			`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">\n` +
			`  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
			`    <dc:identifier id="pub-id">urn:uuid:${escapeXml(params.uuid)}</dc:identifier>\n` +
			`    <dc:title>${escapeXml(params.title)}</dc:title>\n` +
			(params.author ? `    <dc:creator>${escapeXml(params.author)}</dc:creator>\n` : '') +
			`    <dc:language>${escapeXml(params.language)}</dc:language>\n` +
			`    <meta property="dcterms:modified">${escapeXml(params.modified)}</meta>\n` +
			`  </metadata>\n` +
			`  <manifest>\n` +
			`    ${manifestXml}\n` +
			`  </manifest>\n` +
			`  <spine toc="toc">\n` +
			`    ${spineXml}\n` +
			`  </spine>\n` +
			`</package>\n`;
	}

	private basename(path: string): string {
		const normalized = path.replace(/\\/g, '/');
		return normalized.split('/').pop() || normalized;
	}

	private async ensureFolder(folder: string): Promise<void> {
		const parts = normalizeFolder(folder).split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const exists = await this.vault.adapter.exists(current);
			if (!exists) await this.vault.adapter.mkdir(current);
		}
	}

	private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
		// Some TS lib defs represent Uint8Array.buffer as ArrayBufferLike; normalize to ArrayBuffer for Obsidian adapter.
		const out = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(out).set(bytes);
		return out;
	}
}


