import JSZip from 'jszip';
import MarkdownIt from 'markdown-it';
import { getLicenseTemplate } from './LicenseTemplates';
function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function sanitizeFileName(name) {
    const trimmed = name.trim();
    if (!trimmed)
        return 'book';
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
function normalizeFolder(folder) {
    const f = folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return f.length ? f : 'Exports';
}
function ensureEpubExt(name) {
    return name.toLowerCase().endsWith('.epub') ? name : `${name}.epub`;
}
function nowIsoUtc() {
    // EPUB requires UTC-ish modified timestamp
    return new Date().toISOString();
}
function uuidLike() {
    // Prefer crypto.randomUUID if present.
    try {
        const c = globalThis.crypto;
        if (c?.randomUUID)
            return c.randomUUID();
    }
    catch {
        // ignore
    }
    // Fallback: not cryptographically strong, but OK for an identifier.
    return `wd-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
}
function xhtmlDocument(title, bodyInner) {
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
function buildNavXhtml(chapters, bookTitle) {
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
function buildTocNcx(uuid, chapters, bookTitle) {
    const navPoints = chapters
        .map((c, idx) => {
        const order = idx + 1;
        return (`<navPoint id="navPoint-${order}" playOrder="${order}">\n` +
            `  <navLabel><text>${escapeXml(c.title)}</text></navLabel>\n` +
            `  <content src="${escapeXml(c.href)}"/>\n` +
            `</navPoint>`);
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
function inferMediaType(path) {
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
function buildDefaultCss(fontFamily, embedFonts, fontFileNames) {
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
    if (!embedFonts || !fontFileNames?.regularPath)
        return base.join('\n');
    const faces = [];
    const addFace = (key, weight, style) => {
        const file = fontFileNames[key];
        if (!file)
            return;
        faces.push(`@font-face { font-family: "CustomSerif"; src: url("../Fonts/${file}"); font-weight: ${weight}; font-style: ${style}; }`);
    };
    addFace('regularPath', 400, 'normal');
    addFace('boldPath', 700, 'normal');
    addFace('italicPath', 400, 'italic');
    addFace('boldItalicPath', 700, 'italic');
    return [...faces, ``, ...base.map((l) => l.replace(fontFamily, `"CustomSerif", serif`))].join('\n');
}
export class EpubExportService {
    constructor(vault) {
        this.vault = vault;
        this.md = new MarkdownIt({
            html: false,
            linkify: true,
            typographer: true
        });
    }
    async exportEpub(params) {
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
        zip.folder('META-INF')?.file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
            `  <rootfiles>\n` +
            `    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n` +
            `  </rootfiles>\n` +
            `</container>\n`);
        const oebps = zip.folder('OEBPS');
        if (!oebps)
            throw new Error('Failed to initialize EPUB container.');
        const textFolder = oebps.folder('Text');
        const stylesFolder = oebps.folder('Styles');
        const fontsFolder = oebps.folder('Fonts');
        if (!textFolder || !stylesFolder || !fontsFolder)
            throw new Error('Failed to initialize EPUB folders.');
        const manifest = [];
        const spine = [];
        // Navigation
        manifest.push({ id: 'nav', href: 'nav.xhtml', mediaType: 'application/xhtml+xml', properties: 'nav' });
        manifest.push({ id: 'toc', href: 'toc.ncx', mediaType: 'application/x-dtbncx+xml' });
        // Styles
        const fontFamily = `"Literata", "Georgia", serif`;
        const fontFileNames = {};
        if (params.embedCustomFonts && params.customFonts?.regularPath) {
            fontFileNames.regularPath = this.basename(params.customFonts.regularPath);
            if (params.customFonts.boldPath)
                fontFileNames.boldPath = this.basename(params.customFonts.boldPath);
            if (params.customFonts.italicPath)
                fontFileNames.italicPath = this.basename(params.customFonts.italicPath);
            if (params.customFonts.boldItalicPath)
                fontFileNames.boldItalicPath = this.basename(params.customFonts.boldItalicPath);
        }
        const css = buildDefaultCss(fontFamily, params.embedCustomFonts, fontFileNames);
        stylesFolder.file('style.css', css);
        manifest.push({ id: 'css', href: 'Styles/style.css', mediaType: 'text/css' });
        // Front matter pages
        if (params.includeTitlePage) {
            const inner = `<section class="front-matter">\n` +
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
        const navChapters = [];
        for (let i = 0; i < params.chapters.length; i++) {
            const ch = params.chapters[i];
            const html = this.md.render(ch.markdown || '');
            const inner = `<section class="chapter">\n` +
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
            const fontPaths = [
                ['regularPath', params.customFonts.regularPath],
                ['boldPath', params.customFonts.boldPath],
                ['italicPath', params.customFonts.italicPath],
                ['boldItalicPath', params.customFonts.boldItalicPath]
            ];
            for (const [, p] of fontPaths) {
                if (!p)
                    continue;
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
    buildOpf(params) {
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
    basename(path) {
        const normalized = path.replace(/\\/g, '/');
        return normalized.split('/').pop() || normalized;
    }
    async ensureFolder(folder) {
        const parts = normalizeFolder(folder).split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const exists = await this.vault.adapter.exists(current);
            if (!exists)
                await this.vault.adapter.mkdir(current);
        }
    }
    toArrayBuffer(bytes) {
        // Some TS lib defs represent Uint8Array.buffer as ArrayBufferLike; normalize to ArrayBuffer for Obsidian adapter.
        const out = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(out).set(bytes);
        return out;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXB1YkV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFcHViRXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxVQUFVLE1BQU0sYUFBYSxDQUFDO0FBRXJDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBMEN4RCxTQUFTLFNBQVMsQ0FBQyxLQUFhO0lBQy9CLE9BQU8sS0FBSztTQUNWLE9BQU8sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDO1NBQ3RCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDO1NBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsSUFBWTtJQUNyQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDNUIsSUFBSSxDQUFDLE9BQU87UUFBRSxPQUFPLE1BQU0sQ0FBQztJQUM1QixNQUFNLFNBQVMsR0FBRyxjQUFjLENBQUM7SUFDakMsSUFBSSxHQUFHLEdBQUcsRUFBRSxDQUFDO0lBQ2IsS0FBSyxNQUFNLEVBQUUsSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUMxQixNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzlCLElBQUksSUFBSSxHQUFHLEVBQUUsRUFBRSxDQUFDO1lBQ2YsR0FBRyxJQUFJLEdBQUcsQ0FBQztZQUNYLFNBQVM7UUFDVixDQUFDO1FBQ0QsR0FBRyxJQUFJLFNBQVMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxD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QUksQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQzVDLE9BQU8sVUFBVSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxVQUFVLENBQUM7SUFDbEQsQ0FBQztJQUVPLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFBYztRQUN4QyxNQUFNLEtBQUssR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2pELElBQUksT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNqQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQzFCLE9BQU8sR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7WUFDaEQsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDeEQsSUFBSSxDQUFDLE1BQU07Z0JBQUUsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDdEQsQ0FBQztJQUNGLENBQUM7SUFFTyxhQUFhLENBQUMsS0FBaUI7UUFDdEMsa0hBQWtIO1FBQ2xILE1BQU0sR0FBRyxHQUFHLElBQUksV0FBVyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUM5QyxJQUFJLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDL0IsT0FBTyxHQUFHLENBQUM7SUFDWixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBKU1ppcCBmcm9tICdqc3ppcCc7XG5pbXBvcnQgTWFya2Rvd25JdCBmcm9tICdtYXJrZG93bi1pdCc7XG5pbXBvcnQgdHlwZSB7IExpY2Vuc2VUZW1wbGF0ZUlkIH0gZnJvbSAnLi9MaWNlbnNlVGVtcGxhdGVzJztcbmltcG9ydCB7IGdldExpY2Vuc2VUZW1wbGF0ZSB9IGZyb20gJy4vTGljZW5zZVRlbXBsYXRlcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRXhwb3J0Rm9udEZpbGVzIHtcblx0cmVndWxhclBhdGg6IHN0cmluZztcblx0Ym9sZFBhdGg/OiBzdHJpbmc7XG5cdGl0YWxpY1BhdGg/OiBzdHJpbmc7XG5cdGJvbGRJdGFsaWNQYXRoPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydEVwdWJQYXJhbXMge1xuXHQvLyBTb3VyY2Vcblx0Ym9va1RpdGxlOiBzdHJpbmc7XG5cdGF1dGhvcjogc3RyaW5nO1xuXHRsYW5ndWFnZTogc3RyaW5nO1xuXHRzdWJ0aXRsZT86IHN0cmluZztcblxuXHQvLyBDaGFwdGVycyAoYWxyZWFkeSBvcmRlcmVkKVxuXHRjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBtYXJrZG93bjogc3RyaW5nOyBzb3VyY2VQYXRoOiBzdHJpbmcgfT47XG5cblx0Ly8gRnJvbnQgbWF0dGVyXG5cdGluY2x1ZGVUaXRsZVBhZ2U6IGJvb2xlYW47XG5cdGluY2x1ZGVDb3B5cmlnaHRQYWdlOiBib29sZWFuO1xuXHRsaWNlbnNlVGVtcGxhdGVJZDogTGljZW5zZVRlbXBsYXRlSWQ7XG5cdGNvcHlyaWdodFllYXI6IHN0cmluZztcblx0Y29weXJpZ2h0SG9sZGVyOiBzdHJpbmc7XG5cblx0Ly8gVHlwb2dyYXBoeVxuXHRlbWJlZEN1c3RvbUZvbnRzOiBib29sZWFuO1xuXHRjdXN0b21Gb250cz86IEV4cG9ydEZvbnRGaWxlcztcblxuXHQvLyBPdXRwdXRcblx0b3V0cHV0Rm9sZGVyOiBzdHJpbmc7IC8vIHZhdWx0LXJlbGF0aXZlIGZvbGRlclxuXHRvdXRwdXRGaWxlTmFtZTogc3RyaW5nOyAvLyBzaG91bGQgZW5kIHdpdGggLmVwdWJcbn1cblxuaW50ZXJmYWNlIE1hbmlmZXN0SXRlbSB7XG5cdGlkOiBzdHJpbmc7XG5cdGhyZWY6IHN0cmluZztcblx0bWVkaWFUeXBlOiBzdHJpbmc7XG5cdHByb3BlcnRpZXM/OiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVhtbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIHZhbHVlXG5cdFx0LnJlcGxhY2UoLyYvZywgJyZhbXA7Jylcblx0XHQucmVwbGFjZSgvPC9nLCAnJmx0OycpXG5cdFx0LnJlcGxhY2UoLz4vZywgJyZndDsnKVxuXHRcdC5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7Jylcblx0XHQucmVwbGFjZSgvJy9nLCAnJmFwb3M7Jyk7XG59XG5cbmZ1bmN0aW9uIHNhbml0aXplRmlsZU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuXHRpZiAoIXRyaW1tZWQpIHJldHVybiAnYm9vayc7XG5cdGNvbnN0IGZvcmJpZGRlbiA9ICc8PjpcIi9cXFxcXFxcXHw/Kic7XG5cdGxldCBvdXQgPSAnJztcblx0Zm9yIChjb25zdCBjaCBvZiB0cmltbWVkKSB7XG5cdFx0Y29uc3QgY29kZSA9IGNoLmNoYXJDb2RlQXQoMCk7XG5cdFx0aWYgKGNvZGUgPCAzMikge1xuXHRcdFx0b3V0ICs9ICdfJztcblx0XHRcdGNvbnRpbnVlO1xuXHRcdH1cblx0XHRvdXQgKz0gZm9yYmlkZGVuLmluY2x1ZGVzKGNoKSA/ICdfJyA6IGNoO1xuXHR9XG5cdHJldHVybiBvdXQubGVuZ3RoID8gb3V0IDogJ2Jvb2snO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVGb2xkZXIoZm9sZGVyOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBmID0gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eXFwvKy8sICcnKS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcblx0cmV0dXJuIGYubGVuZ3RoID8gZiA6ICdFeHBvcnRzJztcbn1cblxuZnVuY3Rpb24gZW5zdXJlRXB1YkV4dChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gbmFtZS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcuZXB1YicpID8gbmFtZSA6IGAke25hbWV9LmVwdWJgO1xufVxuXG5mdW5jdGlvbiBub3dJc29VdGMoKTogc3RyaW5nIHtcblx0Ly8gRVBVQiByZXF1aXJlcyBVVEMtaXNoIG1vZGlmaWVkIHRpbWVzdGFtcFxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xufVxuXG5mdW5jdGlvbiB1dWlkTGlrZSgpOiBzdHJpbmcge1xuXHQvLyBQcmVmZXIgY3J5cHRvLnJhbmRvbVVVSUQgaWYgcHJlc2VudC5cblx0dHJ5IHtcblx0XHRjb25zdCBjID0gZ2xvYmFsVGhpcy5jcnlwdG8gYXMgdW5rbm93biBhcyB7IHJhbmRvbVVVSUQ/OiAoKSA9PiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcblx0XHRpZiAoYz8ucmFuZG9tVVVJRCkgcmV0dXJuIGMucmFuZG9tVVVJRCgpO1xuXHR9IGNhdGNoIHtcblx0XHQvLyBpZ25vcmVcblx0fVxuXHQvLyBGYWxsYmFjazogbm90IGNyeXB0b2dyYXBoaWNhbGx5IHN0cm9uZywgYnV0IE9LIGZvciBhbiBpZGVudGlmaWVyLlxuXHRyZXR1cm4gYHdkLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygxNikuc2xpY2UoMil9LSR7RGF0ZS5ub3coKS50b1N0cmluZygxNil9YDtcbn1cblxuZnVuY3Rpb24geGh0bWxEb2N1bWVudCh0aXRsZTogc3RyaW5nLCBib2R5SW5uZXI6IHN0cmluZyk6IHN0cmluZyB7XG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXG5cdFx0YDwhRE9DVFlQRSBodG1sPlxcbmAgK1xuXHRcdGA8aHRtbCB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIiB4bWw6bGFuZz1cImVuXCI+XFxuYCArXG5cdFx0YDxoZWFkPlxcbmAgK1xuXHRcdGAgIDx0aXRsZT4ke2VzY2FwZVhtbCh0aXRsZSl9PC90aXRsZT5cXG5gICtcblx0XHRgICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIiAvPlxcbmAgK1xuXHRcdGAgIDxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwiLi4vU3R5bGVzL3N0eWxlLmNzc1wiIC8+XFxuYCArXG5cdFx0YDwvaGVhZD5cXG5gICtcblx0XHRgPGJvZHk+XFxuYCArXG5cdFx0Ym9keUlubmVyICtcblx0XHRgXFxuPC9ib2R5PlxcbmAgK1xuXHRcdGA8L2h0bWw+XFxuYDtcbn1cblxuZnVuY3Rpb24gYnVpbGROYXZYaHRtbChjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBocmVmOiBzdHJpbmcgfT4sIGJvb2tUaXRsZTogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgaXRlbXMgPSBjaGFwdGVyc1xuXHRcdC5tYXAoKGMpID0+IGA8bGk+PGEgaHJlZj1cIiR7ZXNjYXBlWG1sKGMuaHJlZil9XCI+JHtlc2NhcGVYbWwoYy50aXRsZSl9PC9hPjwvbGk+YClcblx0XHQuam9pbignXFxuJyk7XG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXG5cdFx0YDwhRE9DVFlQRSBodG1sPlxcbmAgK1xuXHRcdGA8aHRtbCB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIiB4bWxuczplcHViPVwiaHR0cDovL3d3dy5pZHBmLm9yZy8yMDA3L29wc1wiIHhtbDpsYW5nPVwiZW5cIj5cXG5gICtcblx0XHRgPGhlYWQ+XFxuYCArXG5cdFx0YCAgPHRpdGxlPiR7ZXNjYXBlWG1sKGJvb2tUaXRsZSl9PC90aXRsZT5cXG5gICtcblx0XHRgICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIiAvPlxcbmAgK1xuXHRcdGAgIDxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwiU3R5bGVzL3N0eWxlLmNzc1wiIC8+XFxuYCArXG5cdFx0YDwvaGVhZD5cXG5gICtcblx0XHRgPGJvZHk+XFxuYCArXG5cdFx0YCAgPG5hdiBlcHViOnR5cGU9XCJ0b2NcIiBpZD1cInRvY1wiPlxcbmAgK1xuXHRcdGAgICAgPGgxPkNvbnRlbnRzPC9oMT5cXG5gICtcblx0XHRgICAgIDxvbD5cXG5gICtcblx0XHRpdGVtcyArXG5cdFx0YFxcbiAgICA8L29sPlxcbmAgK1xuXHRcdGAgIDwvbmF2PlxcbmAgK1xuXHRcdGA8L2JvZHk+XFxuYCArXG5cdFx0YDwvaHRtbD5cXG5gO1xufVxuXG5mdW5jdGlvbiBidWlsZFRvY05jeCh1dWlkOiBzdHJpbmcsIGNoYXB0ZXJzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IGhyZWY6IHN0cmluZyB9PiwgYm9va1RpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCBuYXZQb2ludHMgPSBjaGFwdGVyc1xuXHRcdC5tYXAoKGMsIGlkeCkgPT4ge1xuXHRcdFx0Y29uc3Qgb3JkZXIgPSBpZHggKyAxO1xuXHRcdFx0cmV0dXJuIChcblx0XHRcdFx0YDxuYXZQb2ludCBpZD1cIm5hdlBvaW50LSR7b3JkZXJ9XCIgcGxheU9yZGVyPVwiJHtvcmRlcn1cIj5cXG5gICtcblx0XHRcdFx0YCAgPG5hdkxhYmVsPjx0ZXh0PiR7ZXNjYXBlWG1sKGMudGl0bGUpfTwvdGV4dD48L25hdkxhYmVsPlxcbmAgK1xuXHRcdFx0XHRgICA8Y29udGVudCBzcmM9XCIke2VzY2FwZVhtbChjLmhyZWYpfVwiLz5cXG5gICtcblx0XHRcdFx0YDwvbmF2UG9pbnQ+YFxuXHRcdFx0KTtcblx0XHR9KVxuXHRcdC5qb2luKCdcXG4nKTtcblxuXHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxcbmAgK1xuXHRcdGA8IURPQ1RZUEUgbmN4IFBVQkxJQyBcIi0vL05JU08vL0RURCBuY3ggMjAwNS0xLy9FTlwiIFwiaHR0cDovL3d3dy5kYWlzeS5vcmcvejM5ODYvMjAwNS9uY3gtMjAwNS0xLmR0ZFwiPlxcbmAgK1xuXHRcdGA8bmN4IHhtbG5zPVwiaHR0cDovL3d3dy5kYWlzeS5vcmcvejM5ODYvMjAwNS9uY3gvXCIgdmVyc2lvbj1cIjIwMDUtMVwiPlxcbmAgK1xuXHRcdGA8aGVhZD5cXG5gICtcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOnVpZFwiIGNvbnRlbnQ9XCIke2VzY2FwZVhtbCh1dWlkKX1cIi8+XFxuYCArXG5cdFx0YCAgPG1ldGEgbmFtZT1cImR0YjpkZXB0aFwiIGNvbnRlbnQ9XCIxXCIvPlxcbmAgK1xuXHRcdGAgIDxtZXRhIG5hbWU9XCJkdGI6dG90YWxQYWdlQ291bnRcIiBjb250ZW50PVwiMFwiLz5cXG5gICtcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOm1heFBhZ2VOdW1iZXJcIiBjb250ZW50PVwiMFwiLz5cXG5gICtcblx0XHRgPC9oZWFkPlxcbmAgK1xuXHRcdGA8ZG9jVGl0bGU+PHRleHQ+JHtlc2NhcGVYbWwoYm9va1RpdGxlKX08L3RleHQ+PC9kb2NUaXRsZT5cXG5gICtcblx0XHRgPG5hdk1hcD5cXG5gICtcblx0XHRuYXZQb2ludHMgK1xuXHRcdGBcXG48L25hdk1hcD5cXG5gICtcblx0XHRgPC9uY3g+XFxuYDtcbn1cblxuZnVuY3Rpb24gaW5mZXJNZWRpYVR5cGUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZXh0ID0gcGF0aC5zcGxpdCgnLicpLnBvcCgpPy50b0xvd2VyQ2FzZSgpO1xuXHRzd2l0Y2ggKGV4dCkge1xuXHRcdGNhc2UgJ3hodG1sJzpcblx0XHRjYXNlICdodG1sJzpcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24veGh0bWwreG1sJztcblx0XHRjYXNlICdjc3MnOlxuXHRcdFx0cmV0dXJuICd0ZXh0L2Nzcyc7XG5cdFx0Y2FzZSAnbmN4Jzpcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24veC1kdGJuY3greG1sJztcblx0XHRjYXNlICd0dGYnOlxuXHRcdFx0cmV0dXJuICdmb250L3R0Zic7XG5cdFx0Y2FzZSAnb3RmJzpcblx0XHRcdHJldHVybiAnZm9udC9vdGYnO1xuXHRcdGNhc2UgJ3dvZmYnOlxuXHRcdFx0cmV0dXJuICdmb250L3dvZmYnO1xuXHRcdGNhc2UgJ3dvZmYyJzpcblx0XHRcdHJldHVybiAnZm9udC93b2ZmMic7XG5cdFx0ZGVmYXVsdDpcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtJztcblx0fVxufVxuXG5mdW5jdGlvbiBidWlsZERlZmF1bHRDc3MoZm9udEZhbWlseTogc3RyaW5nLCBlbWJlZEZvbnRzOiBib29sZWFuLCBmb250RmlsZU5hbWVzPzogUGFydGlhbDxSZWNvcmQ8a2V5b2YgRXhwb3J0Rm9udEZpbGVzLCBzdHJpbmc+Pik6IHN0cmluZyB7XG5cdGNvbnN0IGJhc2UgPSBbXG5cdFx0YGh0bWwsIGJvZHkgeyBtYXJnaW46IDA7IHBhZGRpbmc6IDA7IH1gLFxuXHRcdGBib2R5IHsgZm9udC1mYW1pbHk6ICR7Zm9udEZhbWlseX07IGZvbnQtc2l6ZTogMWVtOyBsaW5lLWhlaWdodDogMS41NTsgcGFkZGluZzogMCAwLjhlbTsgfWAsXG5cdFx0YGgxLCBoMiwgaDMgeyBmb250LWZhbWlseTogJHtmb250RmFtaWx5fTsgbGluZS1oZWlnaHQ6IDEuMjsgfWAsXG5cdFx0YGgxIHsgZm9udC1zaXplOiAxLjZlbTsgbWFyZ2luOiAxLjFlbSAwIDAuNmVtOyB9YCxcblx0XHRgcCB7IG1hcmdpbjogMC45ZW0gMDsgfWAsXG5cdFx0YC5jaGFwdGVyLXRpdGxlIHsgcGFnZS1icmVhay1iZWZvcmU6IGFsd2F5czsgfWAsXG5cdFx0YC5mcm9udC1tYXR0ZXIgeyBwYWdlLWJyZWFrLWJlZm9yZTogYWx3YXlzOyB9YCxcblx0XHRgYSB7IGNvbG9yOiBpbmhlcml0OyB9YFxuXHRdO1xuXG5cdGlmICghZW1iZWRGb250cyB8fCAhZm9udEZpbGVOYW1lcz8ucmVndWxhclBhdGgpIHJldHVybiBiYXNlLmpvaW4oJ1xcbicpO1xuXG5cdGNvbnN0IGZhY2VzOiBzdHJpbmdbXSA9IFtdO1xuXHRjb25zdCBhZGRGYWNlID0gKGtleToga2V5b2YgRXhwb3J0Rm9udEZpbGVzLCB3ZWlnaHQ6IG51bWJlciwgc3R5bGU6ICdub3JtYWwnIHwgJ2l0YWxpYycpID0+IHtcblx0XHRjb25zdCBmaWxlID0gZm9udEZpbGVOYW1lc1trZXldO1xuXHRcdGlmICghZmlsZSkgcmV0dXJuO1xuXHRcdGZhY2VzLnB1c2goXG5cdFx0XHRgQGZvbnQtZmFjZSB7IGZvbnQtZmFtaWx5OiBcIkN1c3RvbVNlcmlmXCI7IHNyYzogdXJsKFwiLi4vRm9udHMvJHtmaWxlfVwiKTsgZm9udC13ZWlnaHQ6ICR7d2VpZ2h0fTsgZm9udC1zdHlsZTogJHtzdHlsZX07IH1gXG5cdFx0KTtcblx0fTtcblxuXHRhZGRGYWNlKCdyZWd1bGFyUGF0aCcsIDQwMCwgJ25vcm1hbCcpO1xuXHRhZGRGYWNlKCdib2xkUGF0aCcsIDcwMCwgJ25vcm1hbCcpO1xuXHRhZGRGYWNlKCdpdGFsaWNQYXRoJywgNDAwLCAnaXRhbGljJyk7XG5cdGFkZEZhY2UoJ2JvbGRJdGFsaWNQYXRoJywgNzAwLCAnaXRhbGljJyk7XG5cblx0cmV0dXJuIFsuLi5mYWNlcywgYGAsIC4uLmJhc2UubWFwKChsKSA9PiBsLnJlcGxhY2UoZm9udEZhbWlseSwgYFwiQ3VzdG9tU2VyaWZcIiwgc2VyaWZgKSldLmpvaW4oJ1xcbicpO1xufVxuXG5leHBvcnQgY2xhc3MgRXB1YkV4cG9ydFNlcnZpY2Uge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblx0cHJpdmF0ZSByZWFkb25seSBtZDogTWFya2Rvd25JdDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQpIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdFx0dGhpcy5tZCA9IG5ldyBNYXJrZG93bkl0KHtcblx0XHRcdGh0bWw6IGZhbHNlLFxuXHRcdFx0bGlua2lmeTogdHJ1ZSxcblx0XHRcdHR5cG9ncmFwaGVyOiB0cnVlXG5cdFx0fSk7XG5cdH1cblxuXHRhc3luYyBleHBvcnRFcHViKHBhcmFtczogRXhwb3J0RXB1YlBhcmFtcyk6IFByb21pc2U8eyBvdXRwdXRQYXRoOiBzdHJpbmcgfT4ge1xuXHRcdGNvbnN0IGJvb2tUaXRsZSA9IHBhcmFtcy5ib29rVGl0bGUudHJpbSgpIHx8ICdVbnRpdGxlZCc7XG5cdFx0Y29uc3QgYXV0aG9yID0gcGFyYW1zLmF1dGhvci50cmltKCk7XG5cdFx0Y29uc3QgbGFuZ3VhZ2UgPSBwYXJhbXMubGFuZ3VhZ2UudHJpbSgpIHx8ICdlbic7XG5cdFx0Y29uc3Qgc3VidGl0bGUgPSAocGFyYW1zLnN1YnRpdGxlIHx8ICcnKS50cmltKCk7XG5cblx0XHRjb25zdCBmb2xkZXIgPSBub3JtYWxpemVGb2xkZXIocGFyYW1zLm91dHB1dEZvbGRlcik7XG5cdFx0Y29uc3QgZmlsZU5hbWUgPSBlbnN1cmVFcHViRXh0KHNhbml0aXplRmlsZU5hbWUocGFyYW1zLm91dHB1dEZpbGVOYW1lIHx8IGJvb2tUaXRsZSkpO1xuXHRcdGNvbnN0IG91dHB1dFBhdGggPSBgJHtmb2xkZXJ9LyR7ZmlsZU5hbWV9YC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XG5cblx0XHRhd2FpdCB0aGlzLmVuc3VyZUZvbGRlcihmb2xkZXIpO1xuXG5cdFx0Y29uc3QgdXVpZCA9IHV1aWRMaWtlKCk7XG5cdFx0Y29uc3QgbW9kaWZpZWQgPSBub3dJc29VdGMoKTtcblxuXHRcdGNvbnN0IHppcCA9IG5ldyBKU1ppcCgpO1xuXHRcdC8vIG1pbWV0eXBlIG11c3QgYmUgZmlyc3QgYW5kIHVuY29tcHJlc3NlZFxuXHRcdHppcC5maWxlKCdtaW1ldHlwZScsICdhcHBsaWNhdGlvbi9lcHViK3ppcCcsIHsgY29tcHJlc3Npb246ICdTVE9SRScgfSk7XG5cblx0XHR6aXAuZm9sZGVyKCdNRVRBLUlORicpPy5maWxlKFxuXHRcdFx0J2NvbnRhaW5lci54bWwnLFxuXHRcdFx0YDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxcbmAgK1xuXHRcdFx0XHRgPGNvbnRhaW5lciB2ZXJzaW9uPVwiMS4wXCIgeG1sbnM9XCJ1cm46b2FzaXM6bmFtZXM6dGM6b3BlbmRvY3VtZW50OnhtbG5zOmNvbnRhaW5lclwiPlxcbmAgK1xuXHRcdFx0XHRgICA8cm9vdGZpbGVzPlxcbmAgK1xuXHRcdFx0XHRgICAgIDxyb290ZmlsZSBmdWxsLXBhdGg9XCJPRUJQUy9jb250ZW50Lm9wZlwiIG1lZGlhLXR5cGU9XCJhcHBsaWNhdGlvbi9vZWJwcy1wYWNrYWdlK3htbFwiLz5cXG5gICtcblx0XHRcdFx0YCAgPC9yb290ZmlsZXM+XFxuYCArXG5cdFx0XHRcdGA8L2NvbnRhaW5lcj5cXG5gXG5cdFx0KTtcblxuXHRcdGNvbnN0IG9lYnBzID0gemlwLmZvbGRlcignT0VCUFMnKTtcblx0XHRpZiAoIW9lYnBzKSB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBpbml0aWFsaXplIEVQVUIgY29udGFpbmVyLicpO1xuXG5cdFx0Y29uc3QgdGV4dEZvbGRlciA9IG9lYnBzLmZvbGRlcignVGV4dCcpO1xuXHRcdGNvbnN0IHN0eWxlc0ZvbGRlciA9IG9lYnBzLmZvbGRlcignU3R5bGVzJyk7XG5cdFx0Y29uc3QgZm9udHNGb2xkZXIgPSBvZWJwcy5mb2xkZXIoJ0ZvbnRzJyk7XG5cdFx0aWYgKCF0ZXh0Rm9sZGVyIHx8ICFzdHlsZXNGb2xkZXIgfHwgIWZvbnRzRm9sZGVyKSB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBpbml0aWFsaXplIEVQVUIgZm9sZGVycy4nKTtcblxuXHRcdGNvbnN0IG1hbmlmZXN0OiBNYW5pZmVzdEl0ZW1bXSA9IFtdO1xuXHRcdGNvbnN0IHNwaW5lOiBzdHJpbmdbXSA9IFtdO1xuXG5cdFx0Ly8gTmF2aWdhdGlvblxuXHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ25hdicsIGhyZWY6ICduYXYueGh0bWwnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnLCBwcm9wZXJ0aWVzOiAnbmF2JyB9KTtcblx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICd0b2MnLCBocmVmOiAndG9jLm5jeCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3gtZHRibmN4K3htbCcgfSk7XG5cblx0XHQvLyBTdHlsZXNcblx0XHRjb25zdCBmb250RmFtaWx5ID0gYFwiTGl0ZXJhdGFcIiwgXCJHZW9yZ2lhXCIsIHNlcmlmYDtcblx0XHRjb25zdCBmb250RmlsZU5hbWVzOiBQYXJ0aWFsPFJlY29yZDxrZXlvZiBFeHBvcnRGb250RmlsZXMsIHN0cmluZz4+ID0ge307XG5cdFx0aWYgKHBhcmFtcy5lbWJlZEN1c3RvbUZvbnRzICYmIHBhcmFtcy5jdXN0b21Gb250cz8ucmVndWxhclBhdGgpIHtcblx0XHRcdGZvbnRGaWxlTmFtZXMucmVndWxhclBhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5yZWd1bGFyUGF0aCk7XG5cdFx0XHRpZiAocGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRQYXRoKSBmb250RmlsZU5hbWVzLmJvbGRQYXRoID0gdGhpcy5iYXNlbmFtZShwYXJhbXMuY3VzdG9tRm9udHMuYm9sZFBhdGgpO1xuXHRcdFx0aWYgKHBhcmFtcy5jdXN0b21Gb250cy5pdGFsaWNQYXRoKSBmb250RmlsZU5hbWVzLml0YWxpY1BhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5pdGFsaWNQYXRoKTtcblx0XHRcdGlmIChwYXJhbXMuY3VzdG9tRm9udHMuYm9sZEl0YWxpY1BhdGgpIGZvbnRGaWxlTmFtZXMuYm9sZEl0YWxpY1BhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5ib2xkSXRhbGljUGF0aCk7XG5cdFx0fVxuXHRcdGNvbnN0IGNzcyA9IGJ1aWxkRGVmYXVsdENzcyhmb250RmFtaWx5LCBwYXJhbXMuZW1iZWRDdXN0b21Gb250cywgZm9udEZpbGVOYW1lcyk7XG5cdFx0c3R5bGVzRm9sZGVyLmZpbGUoJ3N0eWxlLmNzcycsIGNzcyk7XG5cdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAnY3NzJywgaHJlZjogJ1N0eWxlcy9zdHlsZS5jc3MnLCBtZWRpYVR5cGU6ICd0ZXh0L2NzcycgfSk7XG5cblx0XHQvLyBGcm9udCBtYXR0ZXIgcGFnZXNcblx0XHRpZiAocGFyYW1zLmluY2x1ZGVUaXRsZVBhZ2UpIHtcblx0XHRcdGNvbnN0IGlubmVyID1cblx0XHRcdFx0YDxzZWN0aW9uIGNsYXNzPVwiZnJvbnQtbWF0dGVyXCI+XFxuYCArXG5cdFx0XHRcdGA8aDE+JHtlc2NhcGVYbWwoYm9va1RpdGxlKX08L2gxPlxcbmAgK1xuXHRcdFx0XHQoc3VidGl0bGUgPyBgPGgyPiR7ZXNjYXBlWG1sKHN1YnRpdGxlKX08L2gyPlxcbmAgOiAnJykgK1xuXHRcdFx0XHQoYXV0aG9yID8gYDxwPiR7ZXNjYXBlWG1sKGF1dGhvcil9PC9wPlxcbmAgOiAnJykgK1xuXHRcdFx0XHRgPC9zZWN0aW9uPmA7XG5cdFx0XHRjb25zdCB4aHRtbCA9IHhodG1sRG9jdW1lbnQoJ1RpdGxlJywgaW5uZXIpO1xuXHRcdFx0dGV4dEZvbGRlci5maWxlKCd0aXRsZS54aHRtbCcsIHhodG1sKTtcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ3RpdGxlJywgaHJlZjogJ1RleHQvdGl0bGUueGh0bWwnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnIH0pO1xuXHRcdFx0c3BpbmUucHVzaCgndGl0bGUnKTtcblx0XHR9XG5cblx0XHRpZiAocGFyYW1zLmluY2x1ZGVDb3B5cmlnaHRQYWdlKSB7XG5cdFx0XHRjb25zdCB0ZW1wbGF0ZSA9IGdldExpY2Vuc2VUZW1wbGF0ZShwYXJhbXMubGljZW5zZVRlbXBsYXRlSWQpO1xuXHRcdFx0Y29uc3QgeGh0bWwgPSB0ZW1wbGF0ZS5yZW5kZXJYaHRtbCh7XG5cdFx0XHRcdHRpdGxlOiBib29rVGl0bGUsXG5cdFx0XHRcdGF1dGhvcixcblx0XHRcdFx0eWVhcjogcGFyYW1zLmNvcHlyaWdodFllYXIgfHwgJycsXG5cdFx0XHRcdGhvbGRlcjogcGFyYW1zLmNvcHlyaWdodEhvbGRlciB8fCAnJ1xuXHRcdFx0fSk7XG5cdFx0XHR0ZXh0Rm9sZGVyLmZpbGUoJ2NvcHlyaWdodC54aHRtbCcsIHhodG1sKTtcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ2NvcHlyaWdodCcsIGhyZWY6ICdUZXh0L2NvcHlyaWdodC54aHRtbCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcgfSk7XG5cdFx0XHRzcGluZS5wdXNoKCdjb3B5cmlnaHQnKTtcblx0XHR9XG5cblx0XHQvLyBDaGFwdGVyc1xuXHRcdGNvbnN0IG5hdkNoYXB0ZXJzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IGhyZWY6IHN0cmluZyB9PiA9IFtdO1xuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcGFyYW1zLmNoYXB0ZXJzLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRjb25zdCBjaCA9IHBhcmFtcy5jaGFwdGVyc1tpXTtcblx0XHRcdGNvbnN0IGh0bWwgPSB0aGlzLm1kLnJlbmRlcihjaC5tYXJrZG93biB8fCAnJyk7XG5cdFx0XHRjb25zdCBpbm5lciA9XG5cdFx0XHRcdGA8c2VjdGlvbiBjbGFzcz1cImNoYXB0ZXJcIj5cXG5gICtcblx0XHRcdFx0YDxoMSBjbGFzcz1cImNoYXB0ZXItdGl0bGVcIj4ke2VzY2FwZVhtbChjaC50aXRsZSB8fCBgQ2hhcHRlciAke2kgKyAxfWApfTwvaDE+XFxuYCArXG5cdFx0XHRcdGh0bWwgK1xuXHRcdFx0XHRgXFxuPC9zZWN0aW9uPmA7XG5cdFx0XHRjb25zdCB4aHRtbCA9IHhodG1sRG9jdW1lbnQoY2gudGl0bGUgfHwgYENoYXB0ZXIgJHtpICsgMX1gLCBpbm5lcik7XG5cdFx0XHRjb25zdCBmaWxlID0gYGNoYXB0ZXItJHtTdHJpbmcoaSArIDEpLnBhZFN0YXJ0KDMsICcwJyl9LnhodG1sYDtcblx0XHRcdHRleHRGb2xkZXIuZmlsZShmaWxlLCB4aHRtbCk7XG5cdFx0XHRjb25zdCBpZCA9IGBjaCR7aSArIDF9YDtcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZCwgaHJlZjogYFRleHQvJHtmaWxlfWAsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcgfSk7XG5cdFx0XHRzcGluZS5wdXNoKGlkKTtcblx0XHRcdG5hdkNoYXB0ZXJzLnB1c2goeyB0aXRsZTogY2gudGl0bGUgfHwgYENoYXB0ZXIgJHtpICsgMX1gLCBocmVmOiBgVGV4dC8ke2ZpbGV9YCB9KTtcblx0XHR9XG5cblx0XHQvLyBuYXYueGh0bWwgKyB0b2MubmN4XG5cdFx0b2VicHMuZmlsZSgnbmF2LnhodG1sJywgYnVpbGROYXZYaHRtbChuYXZDaGFwdGVycywgYm9va1RpdGxlKSk7XG5cdFx0b2VicHMuZmlsZSgndG9jLm5jeCcsIGJ1aWxkVG9jTmN4KHV1aWQsIG5hdkNoYXB0ZXJzLCBib29rVGl0bGUpKTtcblxuXHRcdC8vIEZvbnRzXG5cdFx0aWYgKHBhcmFtcy5lbWJlZEN1c3RvbUZvbnRzICYmIHBhcmFtcy5jdXN0b21Gb250cz8ucmVndWxhclBhdGgpIHtcblx0XHRcdGNvbnN0IGZvbnRQYXRoczogQXJyYXk8W2tleW9mIEV4cG9ydEZvbnRGaWxlcywgc3RyaW5nIHwgdW5kZWZpbmVkXT4gPSBbXG5cdFx0XHRcdFsncmVndWxhclBhdGgnLCBwYXJhbXMuY3VzdG9tRm9udHMucmVndWxhclBhdGhdLFxuXHRcdFx0XHRbJ2JvbGRQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRQYXRoXSxcblx0XHRcdFx0WydpdGFsaWNQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLml0YWxpY1BhdGhdLFxuXHRcdFx0XHRbJ2JvbGRJdGFsaWNQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRJdGFsaWNQYXRoXVxuXHRcdFx0XTtcblxuXHRcdFx0Zm9yIChjb25zdCBbLCBwXSBvZiBmb250UGF0aHMpIHtcblx0XHRcdFx0aWYgKCFwKSBjb250aW51ZTtcblx0XHRcdFx0Y29uc3QgZGF0YSA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkQmluYXJ5KHApO1xuXHRcdFx0XHRjb25zdCBuYW1lID0gdGhpcy5iYXNlbmFtZShwKTtcblx0XHRcdFx0Zm9udHNGb2xkZXIuZmlsZShuYW1lLCBkYXRhKTtcblx0XHRcdFx0bWFuaWZlc3QucHVzaCh7IGlkOiBgZm9udC0ke3Nhbml0aXplRmlsZU5hbWUobmFtZSl9YCwgaHJlZjogYEZvbnRzLyR7bmFtZX1gLCBtZWRpYVR5cGU6IGluZmVyTWVkaWFUeXBlKG5hbWUpIH0pO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGNvbnN0IG9wZiA9IHRoaXMuYnVpbGRPcGYoe1xuXHRcdFx0dXVpZCxcblx0XHRcdHRpdGxlOiBib29rVGl0bGUsXG5cdFx0XHRhdXRob3IsXG5cdFx0XHRsYW5ndWFnZSxcblx0XHRcdG1vZGlmaWVkLFxuXHRcdFx0bWFuaWZlc3QsXG5cdFx0XHRzcGluZVxuXHRcdH0pO1xuXHRcdG9lYnBzLmZpbGUoJ2NvbnRlbnQub3BmJywgb3BmKTtcblxuXHRcdGNvbnN0IGJ5dGVzID0gYXdhaXQgemlwLmdlbmVyYXRlQXN5bmMoe1xuXHRcdFx0dHlwZTogJ3VpbnQ4YXJyYXknLFxuXHRcdFx0Y29tcHJlc3Npb246ICdERUZMQVRFJyxcblx0XHRcdGNvbXByZXNzaW9uT3B0aW9uczogeyBsZXZlbDogOSB9XG5cdFx0fSk7XG5cblx0XHRjb25zdCBvdXQgPSB0aGlzLnRvQXJyYXlCdWZmZXIoYnl0ZXMpO1xuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZUJpbmFyeShvdXRwdXRQYXRoLCBvdXQpO1xuXHRcdHJldHVybiB7IG91dHB1dFBhdGggfTtcblx0fVxuXG5cdHByaXZhdGUgYnVpbGRPcGYocGFyYW1zOiB7XG5cdFx0dXVpZDogc3RyaW5nO1xuXHRcdHRpdGxlOiBzdHJpbmc7XG5cdFx0YXV0aG9yOiBzdHJpbmc7XG5cdFx0bGFuZ3VhZ2U6IHN0cmluZztcblx0XHRtb2RpZmllZDogc3RyaW5nO1xuXHRcdG1hbmlmZXN0OiBNYW5pZmVzdEl0ZW1bXTtcblx0XHRzcGluZTogc3RyaW5nW107XG5cdH0pOiBzdHJpbmcge1xuXHRcdGNvbnN0IG1hbmlmZXN0WG1sID0gcGFyYW1zLm1hbmlmZXN0XG5cdFx0XHQubWFwKChtKSA9PiB7XG5cdFx0XHRcdGNvbnN0IHByb3BzID0gbS5wcm9wZXJ0aWVzID8gYCBwcm9wZXJ0aWVzPVwiJHtlc2NhcGVYbWwobS5wcm9wZXJ0aWVzKX1cImAgOiAnJztcblx0XHRcdFx0cmV0dXJuIGA8aXRlbSBpZD1cIiR7ZXNjYXBlWG1sKG0uaWQpfVwiIGhyZWY9XCIke2VzY2FwZVhtbChtLmhyZWYpfVwiIG1lZGlhLXR5cGU9XCIke2VzY2FwZVhtbChtLm1lZGlhVHlwZSl9XCIke3Byb3BzfS8+YDtcblx0XHRcdH0pXG5cdFx0XHQuam9pbignXFxuICAgICcpO1xuXG5cdFx0Y29uc3Qgc3BpbmVYbWwgPSBwYXJhbXMuc3BpbmUubWFwKChpZHJlZikgPT4gYDxpdGVtcmVmIGlkcmVmPVwiJHtlc2NhcGVYbWwoaWRyZWYpfVwiLz5gKS5qb2luKCdcXG4gICAgJyk7XG5cblx0XHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cInV0Zi04XCI/PlxcbmAgK1xuXHRcdFx0YDxwYWNrYWdlIHhtbG5zPVwiaHR0cDovL3d3dy5pZHBmLm9yZy8yMDA3L29wZlwiIHZlcnNpb249XCIzLjBcIiB1bmlxdWUtaWRlbnRpZmllcj1cInB1Yi1pZFwiPlxcbmAgK1xuXHRcdFx0YCAgPG1ldGFkYXRhIHhtbG5zOmRjPVwiaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS9cIj5cXG5gICtcblx0XHRcdGAgICAgPGRjOmlkZW50aWZpZXIgaWQ9XCJwdWItaWRcIj51cm46dXVpZDoke2VzY2FwZVhtbChwYXJhbXMudXVpZCl9PC9kYzppZGVudGlmaWVyPlxcbmAgK1xuXHRcdFx0YCAgICA8ZGM6dGl0bGU+JHtlc2NhcGVYbWwocGFyYW1zLnRpdGxlKX08L2RjOnRpdGxlPlxcbmAgK1xuXHRcdFx0KHBhcmFtcy5hdXRob3IgPyBgICAgIDxkYzpjcmVhdG9yPiR7ZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpfTwvZGM6Y3JlYXRvcj5cXG5gIDogJycpICtcblx0XHRcdGAgICAgPGRjOmxhbmd1YWdlPiR7ZXNjYXBlWG1sKHBhcmFtcy5sYW5ndWFnZSl9PC9kYzpsYW5ndWFnZT5cXG5gICtcblx0XHRcdGAgICAgPG1ldGEgcHJvcGVydHk9XCJkY3Rlcm1zOm1vZGlmaWVkXCI+JHtlc2NhcGVYbWwocGFyYW1zLm1vZGlmaWVkKX08L21ldGE+XFxuYCArXG5cdFx0XHRgICA8L21ldGFkYXRhPlxcbmAgK1xuXHRcdFx0YCAgPG1hbmlmZXN0PlxcbmAgK1xuXHRcdFx0YCAgICAke21hbmlmZXN0WG1sfVxcbmAgK1xuXHRcdFx0YCAgPC9tYW5pZmVzdD5cXG5gICtcblx0XHRcdGAgIDxzcGluZSB0b2M9XCJ0b2NcIj5cXG5gICtcblx0XHRcdGAgICAgJHtzcGluZVhtbH1cXG5gICtcblx0XHRcdGAgIDwvc3BpbmU+XFxuYCArXG5cdFx0XHRgPC9wYWNrYWdlPlxcbmA7XG5cdH1cblxuXHRwcml2YXRlIGJhc2VuYW1lKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG5cdFx0Y29uc3Qgbm9ybWFsaXplZCA9IHBhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xuXHRcdHJldHVybiBub3JtYWxpemVkLnNwbGl0KCcvJykucG9wKCkgfHwgbm9ybWFsaXplZDtcblx0fVxuXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlRm9sZGVyKGZvbGRlcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG5cdFx0Y29uc3QgcGFydHMgPSBub3JtYWxpemVGb2xkZXIoZm9sZGVyKS5zcGxpdCgnLycpO1xuXHRcdGxldCBjdXJyZW50ID0gJyc7XG5cdFx0Zm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG5cdFx0XHRjdXJyZW50ID0gY3VycmVudCA/IGAke2N1cnJlbnR9LyR7cGFydH1gIDogcGFydDtcblx0XHRcdGNvbnN0IGV4aXN0cyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCk7XG5cdFx0XHRpZiAoIWV4aXN0cykgYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xuXHRcdH1cblx0fVxuXG5cdHByaXZhdGUgdG9BcnJheUJ1ZmZlcihieXRlczogVWludDhBcnJheSk6IEFycmF5QnVmZmVyIHtcblx0XHQvLyBTb21lIFRTIGxpYiBkZWZzIHJlcHJlc2VudCBVaW50OEFycmF5LmJ1ZmZlciBhcyBBcnJheUJ1ZmZlckxpa2U7IG5vcm1hbGl6ZSB0byBBcnJheUJ1ZmZlciBmb3IgT2JzaWRpYW4gYWRhcHRlci5cblx0XHRjb25zdCBvdXQgPSBuZXcgQXJyYXlCdWZmZXIoYnl0ZXMuYnl0ZUxlbmd0aCk7XG5cdFx0bmV3IFVpbnQ4QXJyYXkob3V0KS5zZXQoYnl0ZXMpO1xuXHRcdHJldHVybiBvdXQ7XG5cdH1cbn1cblxuXG4iXX0=