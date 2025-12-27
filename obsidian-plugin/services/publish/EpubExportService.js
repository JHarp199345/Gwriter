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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXB1YkV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFcHViRXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxVQUFVLE1BQU0sYUFBYSxDQUFDO0FBRXJDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLG9CQUFvQixDQUFDO0FBMEN4RCxTQUFTLFNBQVMsQ0FBQyxLQUFhO0lBQy9CLE9BQU8sS0FBSztTQUNWLE9BQU8sQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDO1NBQ3RCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO1NBQ3JCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDO1NBQ3ZCLE9BQU8sQ0FBQyxJQUFJLEVBQUUsUUFBUSxDQUFDLENBQUM7QUFDM0IsQ0FBQztBQUVELFNBQVMsZ0JBQWdCLENBQUMsSUFBWTtJQUNyQyxNQUFNLE9BQU8sR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDNUIsSUFBSSxDQUFDLE9BQU87UUFBRSxPQUFPLE1BQU0sQ0FBQztJQUM1QixNQUFNLFNBQVMsR0FBRyxjQUFjLENBQUM7SUFDakMsSUFBSSxHQUFHLEdBQUcsRUFBRSxDQUFDO0lBQ2IsS0FBSyxNQUFNLEVBQUUsSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUMxQixNQUFNLElBQUksR0FBRyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzlCLElBQUksSUFBSSxHQUFHLEVBQUUsRUFBRSxDQUFDO1lBQ2YsR0FBRyxJQUFJLEdBQUcsQ0FBQztZQUNYLFNBQVM7UUFDVixDQUFDO1FBQ0QsR0FBRyxJQUFJLFNBQVMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxD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QUksQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQzVDLE9BQU8sVUFBVSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsSUFBSSxVQUFVLENBQUM7SUFDbEQsQ0FBQztJQUVPLEtBQUssQ0FBQyxZQUFZLENBQUMsTUFBYztRQUN4QyxNQUFNLEtBQUssR0FBRyxlQUFlLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2pELElBQUksT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNqQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQzFCLE9BQU8sR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7WUFDaEQsTUFBTSxNQUFNLEdBQUcsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLENBQUM7WUFDeEQsSUFBSSxDQUFDLE1BQU07Z0JBQUUsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUM7UUFDdEQsQ0FBQztJQUNGLENBQUM7SUFFTyxhQUFhLENBQUMsS0FBaUI7UUFDdEMsa0hBQWtIO1FBQ2xILE1BQU0sR0FBRyxHQUFHLElBQUksV0FBVyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUM5QyxJQUFJLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDL0IsT0FBTyxHQUFHLENBQUM7SUFDWixDQUFDO0NBQ0QiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IEpTWmlwIGZyb20gJ2pzemlwJztcclxuaW1wb3J0IE1hcmtkb3duSXQgZnJvbSAnbWFya2Rvd24taXQnO1xyXG5pbXBvcnQgdHlwZSB7IExpY2Vuc2VUZW1wbGF0ZUlkIH0gZnJvbSAnLi9MaWNlbnNlVGVtcGxhdGVzJztcclxuaW1wb3J0IHsgZ2V0TGljZW5zZVRlbXBsYXRlIH0gZnJvbSAnLi9MaWNlbnNlVGVtcGxhdGVzJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXhwb3J0Rm9udEZpbGVzIHtcclxuXHRyZWd1bGFyUGF0aDogc3RyaW5nO1xyXG5cdGJvbGRQYXRoPzogc3RyaW5nO1xyXG5cdGl0YWxpY1BhdGg/OiBzdHJpbmc7XHJcblx0Ym9sZEl0YWxpY1BhdGg/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXhwb3J0RXB1YlBhcmFtcyB7XHJcblx0Ly8gU291cmNlXHJcblx0Ym9va1RpdGxlOiBzdHJpbmc7XHJcblx0YXV0aG9yOiBzdHJpbmc7XHJcblx0bGFuZ3VhZ2U6IHN0cmluZztcclxuXHRzdWJ0aXRsZT86IHN0cmluZztcclxuXHJcblx0Ly8gQ2hhcHRlcnMgKGFscmVhZHkgb3JkZXJlZClcclxuXHRjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBtYXJrZG93bjogc3RyaW5nOyBzb3VyY2VQYXRoOiBzdHJpbmcgfT47XHJcblxyXG5cdC8vIEZyb250IG1hdHRlclxyXG5cdGluY2x1ZGVUaXRsZVBhZ2U6IGJvb2xlYW47XHJcblx0aW5jbHVkZUNvcHlyaWdodFBhZ2U6IGJvb2xlYW47XHJcblx0bGljZW5zZVRlbXBsYXRlSWQ6IExpY2Vuc2VUZW1wbGF0ZUlkO1xyXG5cdGNvcHlyaWdodFllYXI6IHN0cmluZztcclxuXHRjb3B5cmlnaHRIb2xkZXI6IHN0cmluZztcclxuXHJcblx0Ly8gVHlwb2dyYXBoeVxyXG5cdGVtYmVkQ3VzdG9tRm9udHM6IGJvb2xlYW47XHJcblx0Y3VzdG9tRm9udHM/OiBFeHBvcnRGb250RmlsZXM7XHJcblxyXG5cdC8vIE91dHB1dFxyXG5cdG91dHB1dEZvbGRlcjogc3RyaW5nOyAvLyB2YXVsdC1yZWxhdGl2ZSBmb2xkZXJcclxuXHRvdXRwdXRGaWxlTmFtZTogc3RyaW5nOyAvLyBzaG91bGQgZW5kIHdpdGggLmVwdWJcclxufVxyXG5cclxuaW50ZXJmYWNlIE1hbmlmZXN0SXRlbSB7XHJcblx0aWQ6IHN0cmluZztcclxuXHRocmVmOiBzdHJpbmc7XHJcblx0bWVkaWFUeXBlOiBzdHJpbmc7XHJcblx0cHJvcGVydGllcz86IHN0cmluZztcclxufVxyXG5cclxuZnVuY3Rpb24gZXNjYXBlWG1sKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiB2YWx1ZVxyXG5cdFx0LnJlcGxhY2UoLyYvZywgJyZhbXA7JylcclxuXHRcdC5yZXBsYWNlKC88L2csICcmbHQ7JylcclxuXHRcdC5yZXBsYWNlKC8+L2csICcmZ3Q7JylcclxuXHRcdC5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JylcclxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FuaXRpemVGaWxlTmFtZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IHRyaW1tZWQgPSBuYW1lLnRyaW0oKTtcclxuXHRpZiAoIXRyaW1tZWQpIHJldHVybiAnYm9vayc7XHJcblx0Y29uc3QgZm9yYmlkZGVuID0gJzw+OlwiL1xcXFxcXFxcfD8qJztcclxuXHRsZXQgb3V0ID0gJyc7XHJcblx0Zm9yIChjb25zdCBjaCBvZiB0cmltbWVkKSB7XHJcblx0XHRjb25zdCBjb2RlID0gY2guY2hhckNvZGVBdCgwKTtcclxuXHRcdGlmIChjb2RlIDwgMzIpIHtcclxuXHRcdFx0b3V0ICs9ICdfJztcclxuXHRcdFx0Y29udGludWU7XHJcblx0XHR9XHJcblx0XHRvdXQgKz0gZm9yYmlkZGVuLmluY2x1ZGVzKGNoKSA/ICdfJyA6IGNoO1xyXG5cdH1cclxuXHRyZXR1cm4gb3V0Lmxlbmd0aCA/IG91dCA6ICdib29rJztcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplRm9sZGVyKGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCBmID0gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eXFwvKy8sICcnKS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcclxuXHRyZXR1cm4gZi5sZW5ndGggPyBmIDogJ0V4cG9ydHMnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVFcHViRXh0KG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0cmV0dXJuIG5hbWUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCgnLmVwdWInKSA/IG5hbWUgOiBgJHtuYW1lfS5lcHViYDtcclxufVxyXG5cclxuZnVuY3Rpb24gbm93SXNvVXRjKCk6IHN0cmluZyB7XHJcblx0Ly8gRVBVQiByZXF1aXJlcyBVVEMtaXNoIG1vZGlmaWVkIHRpbWVzdGFtcFxyXG5cdHJldHVybiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHV1aWRMaWtlKCk6IHN0cmluZyB7XHJcblx0Ly8gUHJlZmVyIGNyeXB0by5yYW5kb21VVUlEIGlmIHByZXNlbnQuXHJcblx0dHJ5IHtcclxuXHRcdGNvbnN0IGMgPSBnbG9iYWxUaGlzLmNyeXB0byBhcyB1bmtub3duIGFzIHsgcmFuZG9tVVVJRD86ICgpID0+IHN0cmluZyB9IHwgdW5kZWZpbmVkO1xyXG5cdFx0aWYgKGM/LnJhbmRvbVVVSUQpIHJldHVybiBjLnJhbmRvbVVVSUQoKTtcclxuXHR9IGNhdGNoIHtcclxuXHRcdC8vIGlnbm9yZVxyXG5cdH1cclxuXHQvLyBGYWxsYmFjazogbm90IGNyeXB0b2dyYXBoaWNhbGx5IHN0cm9uZywgYnV0IE9LIGZvciBhbiBpZGVudGlmaWVyLlxyXG5cdHJldHVybiBgd2QtJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDE2KS5zbGljZSgyKX0tJHtEYXRlLm5vdygpLnRvU3RyaW5nKDE2KX1gO1xyXG59XHJcblxyXG5mdW5jdGlvbiB4aHRtbERvY3VtZW50KHRpdGxlOiBzdHJpbmcsIGJvZHlJbm5lcjogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cInV0Zi04XCI/PlxcbmAgK1xyXG5cdFx0YDwhRE9DVFlQRSBodG1sPlxcbmAgK1xyXG5cdFx0YDxodG1sIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiIHhtbDpsYW5nPVwiZW5cIj5cXG5gICtcclxuXHRcdGA8aGVhZD5cXG5gICtcclxuXHRcdGAgIDx0aXRsZT4ke2VzY2FwZVhtbCh0aXRsZSl9PC90aXRsZT5cXG5gICtcclxuXHRcdGAgIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiIC8+XFxuYCArXHJcblx0XHRgICA8bGluayByZWw9XCJzdHlsZXNoZWV0XCIgdHlwZT1cInRleHQvY3NzXCIgaHJlZj1cIi4uL1N0eWxlcy9zdHlsZS5jc3NcIiAvPlxcbmAgK1xyXG5cdFx0YDwvaGVhZD5cXG5gICtcclxuXHRcdGA8Ym9keT5cXG5gICtcclxuXHRcdGJvZHlJbm5lciArXHJcblx0XHRgXFxuPC9ib2R5PlxcbmAgK1xyXG5cdFx0YDwvaHRtbD5cXG5gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZE5hdlhodG1sKGNoYXB0ZXJzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IGhyZWY6IHN0cmluZyB9PiwgYm9va1RpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IGl0ZW1zID0gY2hhcHRlcnNcclxuXHRcdC5tYXAoKGMpID0+IGA8bGk+PGEgaHJlZj1cIiR7ZXNjYXBlWG1sKGMuaHJlZil9XCI+JHtlc2NhcGVYbWwoYy50aXRsZSl9PC9hPjwvbGk+YClcclxuXHRcdC5qb2luKCdcXG4nKTtcclxuXHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cInV0Zi04XCI/PlxcbmAgK1xyXG5cdFx0YDwhRE9DVFlQRSBodG1sPlxcbmAgK1xyXG5cdFx0YDxodG1sIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiIHhtbG5zOmVwdWI9XCJodHRwOi8vd3d3LmlkcGYub3JnLzIwMDcvb3BzXCIgeG1sOmxhbmc9XCJlblwiPlxcbmAgK1xyXG5cdFx0YDxoZWFkPlxcbmAgK1xyXG5cdFx0YCAgPHRpdGxlPiR7ZXNjYXBlWG1sKGJvb2tUaXRsZSl9PC90aXRsZT5cXG5gICtcclxuXHRcdGAgIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiIC8+XFxuYCArXHJcblx0XHRgICA8bGluayByZWw9XCJzdHlsZXNoZWV0XCIgdHlwZT1cInRleHQvY3NzXCIgaHJlZj1cIlN0eWxlcy9zdHlsZS5jc3NcIiAvPlxcbmAgK1xyXG5cdFx0YDwvaGVhZD5cXG5gICtcclxuXHRcdGA8Ym9keT5cXG5gICtcclxuXHRcdGAgIDxuYXYgZXB1Yjp0eXBlPVwidG9jXCIgaWQ9XCJ0b2NcIj5cXG5gICtcclxuXHRcdGAgICAgPGgxPkNvbnRlbnRzPC9oMT5cXG5gICtcclxuXHRcdGAgICAgPG9sPlxcbmAgK1xyXG5cdFx0aXRlbXMgK1xyXG5cdFx0YFxcbiAgICA8L29sPlxcbmAgK1xyXG5cdFx0YCAgPC9uYXY+XFxuYCArXHJcblx0XHRgPC9ib2R5PlxcbmAgK1xyXG5cdFx0YDwvaHRtbD5cXG5gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZFRvY05jeCh1dWlkOiBzdHJpbmcsIGNoYXB0ZXJzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IGhyZWY6IHN0cmluZyB9PiwgYm9va1RpdGxlOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IG5hdlBvaW50cyA9IGNoYXB0ZXJzXHJcblx0XHQubWFwKChjLCBpZHgpID0+IHtcclxuXHRcdFx0Y29uc3Qgb3JkZXIgPSBpZHggKyAxO1xyXG5cdFx0XHRyZXR1cm4gKFxyXG5cdFx0XHRcdGA8bmF2UG9pbnQgaWQ9XCJuYXZQb2ludC0ke29yZGVyfVwiIHBsYXlPcmRlcj1cIiR7b3JkZXJ9XCI+XFxuYCArXHJcblx0XHRcdFx0YCAgPG5hdkxhYmVsPjx0ZXh0PiR7ZXNjYXBlWG1sKGMudGl0bGUpfTwvdGV4dD48L25hdkxhYmVsPlxcbmAgK1xyXG5cdFx0XHRcdGAgIDxjb250ZW50IHNyYz1cIiR7ZXNjYXBlWG1sKGMuaHJlZil9XCIvPlxcbmAgK1xyXG5cdFx0XHRcdGA8L25hdlBvaW50PmBcclxuXHRcdFx0KTtcclxuXHRcdH0pXHJcblx0XHQuam9pbignXFxuJyk7XHJcblxyXG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIj8+XFxuYCArXHJcblx0XHRgPCFET0NUWVBFIG5jeCBQVUJMSUMgXCItLy9OSVNPLy9EVEQgbmN4IDIwMDUtMS8vRU5cIiBcImh0dHA6Ly93d3cuZGFpc3kub3JnL3ozOTg2LzIwMDUvbmN4LTIwMDUtMS5kdGRcIj5cXG5gICtcclxuXHRcdGA8bmN4IHhtbG5zPVwiaHR0cDovL3d3dy5kYWlzeS5vcmcvejM5ODYvMjAwNS9uY3gvXCIgdmVyc2lvbj1cIjIwMDUtMVwiPlxcbmAgK1xyXG5cdFx0YDxoZWFkPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgbmFtZT1cImR0Yjp1aWRcIiBjb250ZW50PVwiJHtlc2NhcGVYbWwodXVpZCl9XCIvPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgbmFtZT1cImR0YjpkZXB0aFwiIGNvbnRlbnQ9XCIxXCIvPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgbmFtZT1cImR0Yjp0b3RhbFBhZ2VDb3VudFwiIGNvbnRlbnQ9XCIwXCIvPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgbmFtZT1cImR0YjptYXhQYWdlTnVtYmVyXCIgY29udGVudD1cIjBcIi8+XFxuYCArXHJcblx0XHRgPC9oZWFkPlxcbmAgK1xyXG5cdFx0YDxkb2NUaXRsZT48dGV4dD4ke2VzY2FwZVhtbChib29rVGl0bGUpfTwvdGV4dD48L2RvY1RpdGxlPlxcbmAgK1xyXG5cdFx0YDxuYXZNYXA+XFxuYCArXHJcblx0XHRuYXZQb2ludHMgK1xyXG5cdFx0YFxcbjwvbmF2TWFwPlxcbmAgK1xyXG5cdFx0YDwvbmN4PlxcbmA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluZmVyTWVkaWFUeXBlKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0Y29uc3QgZXh0ID0gcGF0aC5zcGxpdCgnLicpLnBvcCgpPy50b0xvd2VyQ2FzZSgpO1xyXG5cdHN3aXRjaCAoZXh0KSB7XHJcblx0XHRjYXNlICd4aHRtbCc6XHJcblx0XHRjYXNlICdodG1sJzpcclxuXHRcdFx0cmV0dXJuICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnO1xyXG5cdFx0Y2FzZSAnY3NzJzpcclxuXHRcdFx0cmV0dXJuICd0ZXh0L2Nzcyc7XHJcblx0XHRjYXNlICduY3gnOlxyXG5cdFx0XHRyZXR1cm4gJ2FwcGxpY2F0aW9uL3gtZHRibmN4K3htbCc7XHJcblx0XHRjYXNlICd0dGYnOlxyXG5cdFx0XHRyZXR1cm4gJ2ZvbnQvdHRmJztcclxuXHRcdGNhc2UgJ290Zic6XHJcblx0XHRcdHJldHVybiAnZm9udC9vdGYnO1xyXG5cdFx0Y2FzZSAnd29mZic6XHJcblx0XHRcdHJldHVybiAnZm9udC93b2ZmJztcclxuXHRcdGNhc2UgJ3dvZmYyJzpcclxuXHRcdFx0cmV0dXJuICdmb250L3dvZmYyJztcclxuXHRcdGRlZmF1bHQ6XHJcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtJztcclxuXHR9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJ1aWxkRGVmYXVsdENzcyhmb250RmFtaWx5OiBzdHJpbmcsIGVtYmVkRm9udHM6IGJvb2xlYW4sIGZvbnRGaWxlTmFtZXM/OiBQYXJ0aWFsPFJlY29yZDxrZXlvZiBFeHBvcnRGb250RmlsZXMsIHN0cmluZz4+KTogc3RyaW5nIHtcclxuXHRjb25zdCBiYXNlID0gW1xyXG5cdFx0YGh0bWwsIGJvZHkgeyBtYXJnaW46IDA7IHBhZGRpbmc6IDA7IH1gLFxyXG5cdFx0YGJvZHkgeyBmb250LWZhbWlseTogJHtmb250RmFtaWx5fTsgZm9udC1zaXplOiAxZW07IGxpbmUtaGVpZ2h0OiAxLjU1OyBwYWRkaW5nOiAwIDAuOGVtOyB9YCxcclxuXHRcdGBoMSwgaDIsIGgzIHsgZm9udC1mYW1pbHk6ICR7Zm9udEZhbWlseX07IGxpbmUtaGVpZ2h0OiAxLjI7IH1gLFxyXG5cdFx0YGgxIHsgZm9udC1zaXplOiAxLjZlbTsgbWFyZ2luOiAxLjFlbSAwIDAuNmVtOyB9YCxcclxuXHRcdGBwIHsgbWFyZ2luOiAwLjllbSAwOyB9YCxcclxuXHRcdGAuY2hhcHRlci10aXRsZSB7IHBhZ2UtYnJlYWstYmVmb3JlOiBhbHdheXM7IH1gLFxyXG5cdFx0YC5mcm9udC1tYXR0ZXIgeyBwYWdlLWJyZWFrLWJlZm9yZTogYWx3YXlzOyB9YCxcclxuXHRcdGBhIHsgY29sb3I6IGluaGVyaXQ7IH1gXHJcblx0XTtcclxuXHJcblx0aWYgKCFlbWJlZEZvbnRzIHx8ICFmb250RmlsZU5hbWVzPy5yZWd1bGFyUGF0aCkgcmV0dXJuIGJhc2Uuam9pbignXFxuJyk7XHJcblxyXG5cdGNvbnN0IGZhY2VzOiBzdHJpbmdbXSA9IFtdO1xyXG5cdGNvbnN0IGFkZEZhY2UgPSAoa2V5OiBrZXlvZiBFeHBvcnRGb250RmlsZXMsIHdlaWdodDogbnVtYmVyLCBzdHlsZTogJ25vcm1hbCcgfCAnaXRhbGljJykgPT4ge1xyXG5cdFx0Y29uc3QgZmlsZSA9IGZvbnRGaWxlTmFtZXNba2V5XTtcclxuXHRcdGlmICghZmlsZSkgcmV0dXJuO1xyXG5cdFx0ZmFjZXMucHVzaChcclxuXHRcdFx0YEBmb250LWZhY2UgeyBmb250LWZhbWlseTogXCJDdXN0b21TZXJpZlwiOyBzcmM6IHVybChcIi4uL0ZvbnRzLyR7ZmlsZX1cIik7IGZvbnQtd2VpZ2h0OiAke3dlaWdodH07IGZvbnQtc3R5bGU6ICR7c3R5bGV9OyB9YFxyXG5cdFx0KTtcclxuXHR9O1xyXG5cclxuXHRhZGRGYWNlKCdyZWd1bGFyUGF0aCcsIDQwMCwgJ25vcm1hbCcpO1xyXG5cdGFkZEZhY2UoJ2JvbGRQYXRoJywgNzAwLCAnbm9ybWFsJyk7XHJcblx0YWRkRmFjZSgnaXRhbGljUGF0aCcsIDQwMCwgJ2l0YWxpYycpO1xyXG5cdGFkZEZhY2UoJ2JvbGRJdGFsaWNQYXRoJywgNzAwLCAnaXRhbGljJyk7XHJcblxyXG5cdHJldHVybiBbLi4uZmFjZXMsIGBgLCAuLi5iYXNlLm1hcCgobCkgPT4gbC5yZXBsYWNlKGZvbnRGYW1pbHksIGBcIkN1c3RvbVNlcmlmXCIsIHNlcmlmYCkpXS5qb2luKCdcXG4nKTtcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIEVwdWJFeHBvcnRTZXJ2aWNlIHtcclxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcclxuXHRwcml2YXRlIHJlYWRvbmx5IG1kOiBNYXJrZG93bkl0O1xyXG5cclxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQpIHtcclxuXHRcdHRoaXMudmF1bHQgPSB2YXVsdDtcclxuXHRcdHRoaXMubWQgPSBuZXcgTWFya2Rvd25JdCh7XHJcblx0XHRcdGh0bWw6IGZhbHNlLFxyXG5cdFx0XHRsaW5raWZ5OiB0cnVlLFxyXG5cdFx0XHR0eXBvZ3JhcGhlcjogdHJ1ZVxyXG5cdFx0fSk7XHJcblx0fVxyXG5cclxuXHRhc3luYyBleHBvcnRFcHViKHBhcmFtczogRXhwb3J0RXB1YlBhcmFtcyk6IFByb21pc2U8eyBvdXRwdXRQYXRoOiBzdHJpbmcgfT4ge1xyXG5cdFx0Y29uc3QgYm9va1RpdGxlID0gcGFyYW1zLmJvb2tUaXRsZS50cmltKCkgfHwgJ1VudGl0bGVkJztcclxuXHRcdGNvbnN0IGF1dGhvciA9IHBhcmFtcy5hdXRob3IudHJpbSgpO1xyXG5cdFx0Y29uc3QgbGFuZ3VhZ2UgPSBwYXJhbXMubGFuZ3VhZ2UudHJpbSgpIHx8ICdlbic7XHJcblx0XHRjb25zdCBzdWJ0aXRsZSA9IChwYXJhbXMuc3VidGl0bGUgfHwgJycpLnRyaW0oKTtcclxuXHJcblx0XHRjb25zdCBmb2xkZXIgPSBub3JtYWxpemVGb2xkZXIocGFyYW1zLm91dHB1dEZvbGRlcik7XHJcblx0XHRjb25zdCBmaWxlTmFtZSA9IGVuc3VyZUVwdWJFeHQoc2FuaXRpemVGaWxlTmFtZShwYXJhbXMub3V0cHV0RmlsZU5hbWUgfHwgYm9va1RpdGxlKSk7XHJcblx0XHRjb25zdCBvdXRwdXRQYXRoID0gYCR7Zm9sZGVyfS8ke2ZpbGVOYW1lfWAucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG5cclxuXHRcdGF3YWl0IHRoaXMuZW5zdXJlRm9sZGVyKGZvbGRlcik7XHJcblxyXG5cdFx0Y29uc3QgdXVpZCA9IHV1aWRMaWtlKCk7XHJcblx0XHRjb25zdCBtb2RpZmllZCA9IG5vd0lzb1V0YygpO1xyXG5cclxuXHRcdGNvbnN0IHppcCA9IG5ldyBKU1ppcCgpO1xyXG5cdFx0Ly8gbWltZXR5cGUgbXVzdCBiZSBmaXJzdCBhbmQgdW5jb21wcmVzc2VkXHJcblx0XHR6aXAuZmlsZSgnbWltZXR5cGUnLCAnYXBwbGljYXRpb24vZXB1Yit6aXAnLCB7IGNvbXByZXNzaW9uOiAnU1RPUkUnIH0pO1xyXG5cclxuXHRcdHppcC5mb2xkZXIoJ01FVEEtSU5GJyk/LmZpbGUoXHJcblx0XHRcdCdjb250YWluZXIueG1sJyxcclxuXHRcdFx0YDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxcbmAgK1xyXG5cdFx0XHRcdGA8Y29udGFpbmVyIHZlcnNpb249XCIxLjBcIiB4bWxucz1cInVybjpvYXNpczpuYW1lczp0YzpvcGVuZG9jdW1lbnQ6eG1sbnM6Y29udGFpbmVyXCI+XFxuYCArXHJcblx0XHRcdFx0YCAgPHJvb3RmaWxlcz5cXG5gICtcclxuXHRcdFx0XHRgICAgIDxyb290ZmlsZSBmdWxsLXBhdGg9XCJPRUJQUy9jb250ZW50Lm9wZlwiIG1lZGlhLXR5cGU9XCJhcHBsaWNhdGlvbi9vZWJwcy1wYWNrYWdlK3htbFwiLz5cXG5gICtcclxuXHRcdFx0XHRgICA8L3Jvb3RmaWxlcz5cXG5gICtcclxuXHRcdFx0XHRgPC9jb250YWluZXI+XFxuYFxyXG5cdFx0KTtcclxuXHJcblx0XHRjb25zdCBvZWJwcyA9IHppcC5mb2xkZXIoJ09FQlBTJyk7XHJcblx0XHRpZiAoIW9lYnBzKSB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBpbml0aWFsaXplIEVQVUIgY29udGFpbmVyLicpO1xyXG5cclxuXHRcdGNvbnN0IHRleHRGb2xkZXIgPSBvZWJwcy5mb2xkZXIoJ1RleHQnKTtcclxuXHRcdGNvbnN0IHN0eWxlc0ZvbGRlciA9IG9lYnBzLmZvbGRlcignU3R5bGVzJyk7XHJcblx0XHRjb25zdCBmb250c0ZvbGRlciA9IG9lYnBzLmZvbGRlcignRm9udHMnKTtcclxuXHRcdGlmICghdGV4dEZvbGRlciB8fCAhc3R5bGVzRm9sZGVyIHx8ICFmb250c0ZvbGRlcikgdGhyb3cgbmV3IEVycm9yKCdGYWlsZWQgdG8gaW5pdGlhbGl6ZSBFUFVCIGZvbGRlcnMuJyk7XHJcblxyXG5cdFx0Y29uc3QgbWFuaWZlc3Q6IE1hbmlmZXN0SXRlbVtdID0gW107XHJcblx0XHRjb25zdCBzcGluZTogc3RyaW5nW10gPSBbXTtcclxuXHJcblx0XHQvLyBOYXZpZ2F0aW9uXHJcblx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICduYXYnLCBocmVmOiAnbmF2LnhodG1sJywgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24veGh0bWwreG1sJywgcHJvcGVydGllczogJ25hdicgfSk7XHJcblx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICd0b2MnLCBocmVmOiAndG9jLm5jeCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3gtZHRibmN4K3htbCcgfSk7XHJcblxyXG5cdFx0Ly8gU3R5bGVzXHJcblx0XHRjb25zdCBmb250RmFtaWx5ID0gYFwiTGl0ZXJhdGFcIiwgXCJHZW9yZ2lhXCIsIHNlcmlmYDtcclxuXHRcdGNvbnN0IGZvbnRGaWxlTmFtZXM6IFBhcnRpYWw8UmVjb3JkPGtleW9mIEV4cG9ydEZvbnRGaWxlcywgc3RyaW5nPj4gPSB7fTtcclxuXHRcdGlmIChwYXJhbXMuZW1iZWRDdXN0b21Gb250cyAmJiBwYXJhbXMuY3VzdG9tRm9udHM/LnJlZ3VsYXJQYXRoKSB7XHJcblx0XHRcdGZvbnRGaWxlTmFtZXMucmVndWxhclBhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5yZWd1bGFyUGF0aCk7XHJcblx0XHRcdGlmIChwYXJhbXMuY3VzdG9tRm9udHMuYm9sZFBhdGgpIGZvbnRGaWxlTmFtZXMuYm9sZFBhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5ib2xkUGF0aCk7XHJcblx0XHRcdGlmIChwYXJhbXMuY3VzdG9tRm9udHMuaXRhbGljUGF0aCkgZm9udEZpbGVOYW1lcy5pdGFsaWNQYXRoID0gdGhpcy5iYXNlbmFtZShwYXJhbXMuY3VzdG9tRm9udHMuaXRhbGljUGF0aCk7XHJcblx0XHRcdGlmIChwYXJhbXMuY3VzdG9tRm9udHMuYm9sZEl0YWxpY1BhdGgpIGZvbnRGaWxlTmFtZXMuYm9sZEl0YWxpY1BhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5ib2xkSXRhbGljUGF0aCk7XHJcblx0XHR9XHJcblx0XHRjb25zdCBjc3MgPSBidWlsZERlZmF1bHRDc3MoZm9udEZhbWlseSwgcGFyYW1zLmVtYmVkQ3VzdG9tRm9udHMsIGZvbnRGaWxlTmFtZXMpO1xyXG5cdFx0c3R5bGVzRm9sZGVyLmZpbGUoJ3N0eWxlLmNzcycsIGNzcyk7XHJcblx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICdjc3MnLCBocmVmOiAnU3R5bGVzL3N0eWxlLmNzcycsIG1lZGlhVHlwZTogJ3RleHQvY3NzJyB9KTtcclxuXHJcblx0XHQvLyBGcm9udCBtYXR0ZXIgcGFnZXNcclxuXHRcdGlmIChwYXJhbXMuaW5jbHVkZVRpdGxlUGFnZSkge1xyXG5cdFx0XHRjb25zdCBpbm5lciA9XHJcblx0XHRcdFx0YDxzZWN0aW9uIGNsYXNzPVwiZnJvbnQtbWF0dGVyXCI+XFxuYCArXHJcblx0XHRcdFx0YDxoMT4ke2VzY2FwZVhtbChib29rVGl0bGUpfTwvaDE+XFxuYCArXHJcblx0XHRcdFx0KHN1YnRpdGxlID8gYDxoMj4ke2VzY2FwZVhtbChzdWJ0aXRsZSl9PC9oMj5cXG5gIDogJycpICtcclxuXHRcdFx0XHQoYXV0aG9yID8gYDxwPiR7ZXNjYXBlWG1sKGF1dGhvcil9PC9wPlxcbmAgOiAnJykgK1xyXG5cdFx0XHRcdGA8L3NlY3Rpb24+YDtcclxuXHRcdFx0Y29uc3QgeGh0bWwgPSB4aHRtbERvY3VtZW50KCdUaXRsZScsIGlubmVyKTtcclxuXHRcdFx0dGV4dEZvbGRlci5maWxlKCd0aXRsZS54aHRtbCcsIHhodG1sKTtcclxuXHRcdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAndGl0bGUnLCBocmVmOiAnVGV4dC90aXRsZS54aHRtbCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcgfSk7XHJcblx0XHRcdHNwaW5lLnB1c2goJ3RpdGxlJyk7XHJcblx0XHR9XHJcblxyXG5cdFx0aWYgKHBhcmFtcy5pbmNsdWRlQ29weXJpZ2h0UGFnZSkge1xyXG5cdFx0XHRjb25zdCB0ZW1wbGF0ZSA9IGdldExpY2Vuc2VUZW1wbGF0ZShwYXJhbXMubGljZW5zZVRlbXBsYXRlSWQpO1xyXG5cdFx0XHRjb25zdCB4aHRtbCA9IHRlbXBsYXRlLnJlbmRlclhodG1sKHtcclxuXHRcdFx0XHR0aXRsZTogYm9va1RpdGxlLFxyXG5cdFx0XHRcdGF1dGhvcixcclxuXHRcdFx0XHR5ZWFyOiBwYXJhbXMuY29weXJpZ2h0WWVhciB8fCAnJyxcclxuXHRcdFx0XHRob2xkZXI6IHBhcmFtcy5jb3B5cmlnaHRIb2xkZXIgfHwgJydcclxuXHRcdFx0fSk7XHJcblx0XHRcdHRleHRGb2xkZXIuZmlsZSgnY29weXJpZ2h0LnhodG1sJywgeGh0bWwpO1xyXG5cdFx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICdjb3B5cmlnaHQnLCBocmVmOiAnVGV4dC9jb3B5cmlnaHQueGh0bWwnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnIH0pO1xyXG5cdFx0XHRzcGluZS5wdXNoKCdjb3B5cmlnaHQnKTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBDaGFwdGVyc1xyXG5cdFx0Y29uc3QgbmF2Q2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgaHJlZjogc3RyaW5nIH0+ID0gW107XHJcblx0XHRmb3IgKGxldCBpID0gMDsgaSA8IHBhcmFtcy5jaGFwdGVycy5sZW5ndGg7IGkrKykge1xyXG5cdFx0XHRjb25zdCBjaCA9IHBhcmFtcy5jaGFwdGVyc1tpXTtcclxuXHRcdFx0Y29uc3QgaHRtbCA9IHRoaXMubWQucmVuZGVyKGNoLm1hcmtkb3duIHx8ICcnKTtcclxuXHRcdFx0Y29uc3QgaW5uZXIgPVxyXG5cdFx0XHRcdGA8c2VjdGlvbiBjbGFzcz1cImNoYXB0ZXJcIj5cXG5gICtcclxuXHRcdFx0XHRgPGgxIGNsYXNzPVwiY2hhcHRlci10aXRsZVwiPiR7ZXNjYXBlWG1sKGNoLnRpdGxlIHx8IGBDaGFwdGVyICR7aSArIDF9YCl9PC9oMT5cXG5gICtcclxuXHRcdFx0XHRodG1sICtcclxuXHRcdFx0XHRgXFxuPC9zZWN0aW9uPmA7XHJcblx0XHRcdGNvbnN0IHhodG1sID0geGh0bWxEb2N1bWVudChjaC50aXRsZSB8fCBgQ2hhcHRlciAke2kgKyAxfWAsIGlubmVyKTtcclxuXHRcdFx0Y29uc3QgZmlsZSA9IGBjaGFwdGVyLSR7U3RyaW5nKGkgKyAxKS5wYWRTdGFydCgzLCAnMCcpfS54aHRtbGA7XHJcblx0XHRcdHRleHRGb2xkZXIuZmlsZShmaWxlLCB4aHRtbCk7XHJcblx0XHRcdGNvbnN0IGlkID0gYGNoJHtpICsgMX1gO1xyXG5cdFx0XHRtYW5pZmVzdC5wdXNoKHsgaWQsIGhyZWY6IGBUZXh0LyR7ZmlsZX1gLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnIH0pO1xyXG5cdFx0XHRzcGluZS5wdXNoKGlkKTtcclxuXHRcdFx0bmF2Q2hhcHRlcnMucHVzaCh7IHRpdGxlOiBjaC50aXRsZSB8fCBgQ2hhcHRlciAke2kgKyAxfWAsIGhyZWY6IGBUZXh0LyR7ZmlsZX1gIH0pO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIG5hdi54aHRtbCArIHRvYy5uY3hcclxuXHRcdG9lYnBzLmZpbGUoJ25hdi54aHRtbCcsIGJ1aWxkTmF2WGh0bWwobmF2Q2hhcHRlcnMsIGJvb2tUaXRsZSkpO1xyXG5cdFx0b2VicHMuZmlsZSgndG9jLm5jeCcsIGJ1aWxkVG9jTmN4KHV1aWQsIG5hdkNoYXB0ZXJzLCBib29rVGl0bGUpKTtcclxuXHJcblx0XHQvLyBGb250c1xyXG5cdFx0aWYgKHBhcmFtcy5lbWJlZEN1c3RvbUZvbnRzICYmIHBhcmFtcy5jdXN0b21Gb250cz8ucmVndWxhclBhdGgpIHtcclxuXHRcdFx0Y29uc3QgZm9udFBhdGhzOiBBcnJheTxba2V5b2YgRXhwb3J0Rm9udEZpbGVzLCBzdHJpbmcgfCB1bmRlZmluZWRdPiA9IFtcclxuXHRcdFx0XHRbJ3JlZ3VsYXJQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLnJlZ3VsYXJQYXRoXSxcclxuXHRcdFx0XHRbJ2JvbGRQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRQYXRoXSxcclxuXHRcdFx0XHRbJ2l0YWxpY1BhdGgnLCBwYXJhbXMuY3VzdG9tRm9udHMuaXRhbGljUGF0aF0sXHJcblx0XHRcdFx0Wydib2xkSXRhbGljUGF0aCcsIHBhcmFtcy5jdXN0b21Gb250cy5ib2xkSXRhbGljUGF0aF1cclxuXHRcdFx0XTtcclxuXHJcblx0XHRcdGZvciAoY29uc3QgWywgcF0gb2YgZm9udFBhdGhzKSB7XHJcblx0XHRcdFx0aWYgKCFwKSBjb250aW51ZTtcclxuXHRcdFx0XHRjb25zdCBkYXRhID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLnJlYWRCaW5hcnkocCk7XHJcblx0XHRcdFx0Y29uc3QgbmFtZSA9IHRoaXMuYmFzZW5hbWUocCk7XHJcblx0XHRcdFx0Zm9udHNGb2xkZXIuZmlsZShuYW1lLCBkYXRhKTtcclxuXHRcdFx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6IGBmb250LSR7c2FuaXRpemVGaWxlTmFtZShuYW1lKX1gLCBocmVmOiBgRm9udHMvJHtuYW1lfWAsIG1lZGlhVHlwZTogaW5mZXJNZWRpYVR5cGUobmFtZSkgfSk7XHJcblx0XHRcdH1cclxuXHRcdH1cclxuXHJcblx0XHRjb25zdCBvcGYgPSB0aGlzLmJ1aWxkT3BmKHtcclxuXHRcdFx0dXVpZCxcclxuXHRcdFx0dGl0bGU6IGJvb2tUaXRsZSxcclxuXHRcdFx0YXV0aG9yLFxyXG5cdFx0XHRsYW5ndWFnZSxcclxuXHRcdFx0bW9kaWZpZWQsXHJcblx0XHRcdG1hbmlmZXN0LFxyXG5cdFx0XHRzcGluZVxyXG5cdFx0fSk7XHJcblx0XHRvZWJwcy5maWxlKCdjb250ZW50Lm9wZicsIG9wZik7XHJcblxyXG5cdFx0Y29uc3QgYnl0ZXMgPSBhd2FpdCB6aXAuZ2VuZXJhdGVBc3luYyh7XHJcblx0XHRcdHR5cGU6ICd1aW50OGFycmF5JyxcclxuXHRcdFx0Y29tcHJlc3Npb246ICdERUZMQVRFJyxcclxuXHRcdFx0Y29tcHJlc3Npb25PcHRpb25zOiB7IGxldmVsOiA5IH1cclxuXHRcdH0pO1xyXG5cclxuXHRcdGNvbnN0IG91dCA9IHRoaXMudG9BcnJheUJ1ZmZlcihieXRlcyk7XHJcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGVCaW5hcnkob3V0cHV0UGF0aCwgb3V0KTtcclxuXHRcdHJldHVybiB7IG91dHB1dFBhdGggfTtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYnVpbGRPcGYocGFyYW1zOiB7XHJcblx0XHR1dWlkOiBzdHJpbmc7XHJcblx0XHR0aXRsZTogc3RyaW5nO1xyXG5cdFx0YXV0aG9yOiBzdHJpbmc7XHJcblx0XHRsYW5ndWFnZTogc3RyaW5nO1xyXG5cdFx0bW9kaWZpZWQ6IHN0cmluZztcclxuXHRcdG1hbmlmZXN0OiBNYW5pZmVzdEl0ZW1bXTtcclxuXHRcdHNwaW5lOiBzdHJpbmdbXTtcclxuXHR9KTogc3RyaW5nIHtcclxuXHRcdGNvbnN0IG1hbmlmZXN0WG1sID0gcGFyYW1zLm1hbmlmZXN0XHJcblx0XHRcdC5tYXAoKG0pID0+IHtcclxuXHRcdFx0XHRjb25zdCBwcm9wcyA9IG0ucHJvcGVydGllcyA/IGAgcHJvcGVydGllcz1cIiR7ZXNjYXBlWG1sKG0ucHJvcGVydGllcyl9XCJgIDogJyc7XHJcblx0XHRcdFx0cmV0dXJuIGA8aXRlbSBpZD1cIiR7ZXNjYXBlWG1sKG0uaWQpfVwiIGhyZWY9XCIke2VzY2FwZVhtbChtLmhyZWYpfVwiIG1lZGlhLXR5cGU9XCIke2VzY2FwZVhtbChtLm1lZGlhVHlwZSl9XCIke3Byb3BzfS8+YDtcclxuXHRcdFx0fSlcclxuXHRcdFx0LmpvaW4oJ1xcbiAgICAnKTtcclxuXHJcblx0XHRjb25zdCBzcGluZVhtbCA9IHBhcmFtcy5zcGluZS5tYXAoKGlkcmVmKSA9PiBgPGl0ZW1yZWYgaWRyZWY9XCIke2VzY2FwZVhtbChpZHJlZil9XCIvPmApLmpvaW4oJ1xcbiAgICAnKTtcclxuXHJcblx0XHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cInV0Zi04XCI/PlxcbmAgK1xyXG5cdFx0XHRgPHBhY2thZ2UgeG1sbnM9XCJodHRwOi8vd3d3LmlkcGYub3JnLzIwMDcvb3BmXCIgdmVyc2lvbj1cIjMuMFwiIHVuaXF1ZS1pZGVudGlmaWVyPVwicHViLWlkXCI+XFxuYCArXHJcblx0XHRcdGAgIDxtZXRhZGF0YSB4bWxuczpkYz1cImh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvXCI+XFxuYCArXHJcblx0XHRcdGAgICAgPGRjOmlkZW50aWZpZXIgaWQ9XCJwdWItaWRcIj51cm46dXVpZDoke2VzY2FwZVhtbChwYXJhbXMudXVpZCl9PC9kYzppZGVudGlmaWVyPlxcbmAgK1xyXG5cdFx0XHRgICAgIDxkYzp0aXRsZT4ke2VzY2FwZVhtbChwYXJhbXMudGl0bGUpfTwvZGM6dGl0bGU+XFxuYCArXHJcblx0XHRcdChwYXJhbXMuYXV0aG9yID8gYCAgICA8ZGM6Y3JlYXRvcj4ke2VzY2FwZVhtbChwYXJhbXMuYXV0aG9yKX08L2RjOmNyZWF0b3I+XFxuYCA6ICcnKSArXHJcblx0XHRcdGAgICAgPGRjOmxhbmd1YWdlPiR7ZXNjYXBlWG1sKHBhcmFtcy5sYW5ndWFnZSl9PC9kYzpsYW5ndWFnZT5cXG5gICtcclxuXHRcdFx0YCAgICA8bWV0YSBwcm9wZXJ0eT1cImRjdGVybXM6bW9kaWZpZWRcIj4ke2VzY2FwZVhtbChwYXJhbXMubW9kaWZpZWQpfTwvbWV0YT5cXG5gICtcclxuXHRcdFx0YCAgPC9tZXRhZGF0YT5cXG5gICtcclxuXHRcdFx0YCAgPG1hbmlmZXN0PlxcbmAgK1xyXG5cdFx0XHRgICAgICR7bWFuaWZlc3RYbWx9XFxuYCArXHJcblx0XHRcdGAgIDwvbWFuaWZlc3Q+XFxuYCArXHJcblx0XHRcdGAgIDxzcGluZSB0b2M9XCJ0b2NcIj5cXG5gICtcclxuXHRcdFx0YCAgICAke3NwaW5lWG1sfVxcbmAgK1xyXG5cdFx0XHRgICA8L3NwaW5lPlxcbmAgK1xyXG5cdFx0XHRgPC9wYWNrYWdlPlxcbmA7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGJhc2VuYW1lKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0XHRjb25zdCBub3JtYWxpemVkID0gcGF0aC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcblx0XHRyZXR1cm4gbm9ybWFsaXplZC5zcGxpdCgnLycpLnBvcCgpIHx8IG5vcm1hbGl6ZWQ7XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGFzeW5jIGVuc3VyZUZvbGRlcihmb2xkZXI6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG5cdFx0Y29uc3QgcGFydHMgPSBub3JtYWxpemVGb2xkZXIoZm9sZGVyKS5zcGxpdCgnLycpO1xyXG5cdFx0bGV0IGN1cnJlbnQgPSAnJztcclxuXHRcdGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xyXG5cdFx0XHRjdXJyZW50ID0gY3VycmVudCA/IGAke2N1cnJlbnR9LyR7cGFydH1gIDogcGFydDtcclxuXHRcdFx0Y29uc3QgZXhpc3RzID0gYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLmV4aXN0cyhjdXJyZW50KTtcclxuXHRcdFx0aWYgKCFleGlzdHMpIGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5ta2RpcihjdXJyZW50KTtcclxuXHRcdH1cclxuXHR9XHJcblxyXG5cdHByaXZhdGUgdG9BcnJheUJ1ZmZlcihieXRlczogVWludDhBcnJheSk6IEFycmF5QnVmZmVyIHtcclxuXHRcdC8vIFNvbWUgVFMgbGliIGRlZnMgcmVwcmVzZW50IFVpbnQ4QXJyYXkuYnVmZmVyIGFzIEFycmF5QnVmZmVyTGlrZTsgbm9ybWFsaXplIHRvIEFycmF5QnVmZmVyIGZvciBPYnNpZGlhbiBhZGFwdGVyLlxyXG5cdFx0Y29uc3Qgb3V0ID0gbmV3IEFycmF5QnVmZmVyKGJ5dGVzLmJ5dGVMZW5ndGgpO1xyXG5cdFx0bmV3IFVpbnQ4QXJyYXkob3V0KS5zZXQoYnl0ZXMpO1xyXG5cdFx0cmV0dXJuIG91dDtcclxuXHR9XHJcbn1cclxuXHJcblxyXG4iXX0=