import { __awaiter } from "tslib";
import JSZip from 'jszip';
import MarkdownIt from 'markdown-it';
import { getLicenseTemplate } from './LicenseTemplates';
function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function sanitizeFileName(name) {
    const trimmed = name.trim();
    const safe = trimmed.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
    return safe.length ? safe : 'book';
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
        if (c === null || c === void 0 ? void 0 : c.randomUUID)
            return c.randomUUID();
    }
    catch (_a) {
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
    var _a;
    const ext = (_a = path.split('.').pop()) === null || _a === void 0 ? void 0 : _a.toLowerCase();
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
    if (!embedFonts || !(fontFileNames === null || fontFileNames === void 0 ? void 0 : fontFileNames.regularPath))
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
    exportEpub(params) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const bookTitle = params.bookTitle.trim() || 'Untitled';
            const author = params.author.trim();
            const language = params.language.trim() || 'en';
            const subtitle = (params.subtitle || '').trim();
            const folder = normalizeFolder(params.outputFolder);
            const fileName = ensureEpubExt(sanitizeFileName(params.outputFileName || bookTitle));
            const outputPath = `${folder}/${fileName}`.replace(/\\/g, '/');
            yield this.ensureFolder(folder);
            const uuid = uuidLike();
            const modified = nowIsoUtc();
            const zip = new JSZip();
            // mimetype must be first and uncompressed
            zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
            (_a = zip.folder('META-INF')) === null || _a === void 0 ? void 0 : _a.file('container.xml', `<?xml version="1.0" encoding="UTF-8"?>\n` +
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
            if (params.embedCustomFonts && ((_b = params.customFonts) === null || _b === void 0 ? void 0 : _b.regularPath)) {
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
            if (params.embedCustomFonts && ((_c = params.customFonts) === null || _c === void 0 ? void 0 : _c.regularPath)) {
                const fontPaths = [
                    ['regularPath', params.customFonts.regularPath],
                    ['boldPath', params.customFonts.boldPath],
                    ['italicPath', params.customFonts.italicPath],
                    ['boldItalicPath', params.customFonts.boldItalicPath]
                ];
                for (const [, p] of fontPaths) {
                    if (!p)
                        continue;
                    const data = yield this.vault.adapter.readBinary(p);
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
            const bytes = yield zip.generateAsync({
                type: 'uint8array',
                compression: 'DEFLATE',
                compressionOptions: { level: 9 }
            });
            const out = this.toArrayBuffer(bytes);
            yield this.vault.adapter.writeBinary(outputPath, out);
            return { outputPath };
        });
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
    ensureFolder(folder) {
        return __awaiter(this, void 0, void 0, function* () {
            const parts = normalizeFolder(folder).split('/');
            let current = '';
            for (const part of parts) {
                current = current ? `${current}/${part}` : part;
                const exists = yield this.vault.adapter.exists(current);
                if (!exists)
                    yield this.vault.adapter.mkdir(current);
            }
        });
    }
    toArrayBuffer(bytes) {
        // Some TS lib defs represent Uint8Array.buffer as ArrayBufferLike; normalize to ArrayBuffer for Obsidian adapter.
        const out = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(out).set(bytes);
        return out;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXB1YkV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFcHViRXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQ0EsT0FBTyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQzFCLE9BQU8sVUFBVSxNQUFNLGFBQWEsQ0FBQztBQUVyQyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQTBDeEQsU0FBUyxTQUFTLENBQUMsS0FBYTtJQUMvQixPQUFPLEtBQUs7U0FDVixPQUFPLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztTQUN0QixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsS0FBSyxFQUFFLFFBQVEsQ0FBQztTQUN4QixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLElBQVk7SUFDckMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzVCLE1BQU0sSUFBSSxHQUFHLE9BQU8sQ0FBQyxPQUFPLENBQUMsNEJBQTRCLEVBQUUsR0FBRyxDQUFDLENBQUM7SUFDaEUsT0FBTyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUNwQyxDQUFDO0FBRUQsU0FBUyxlQUFlLENBQUMsTUFBYztJQUN0QyxNQUFNLENBQUMsR0FBRyxNQUFNLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDN0UsT0FBTyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FB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LENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDakQsSUFBSSxPQUFPLEdBQUcsRUFBRSxDQUFDO1lBQ2pCLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7Z0JBQzFCLE9BQU8sR0FBRyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsT0FBTyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7Z0JBQ2hELE1BQU0sTUFBTSxHQUFHLE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQyxDQUFDO2dCQUN4RCxJQUFJLENBQUMsTUFBTTtvQkFBRSxNQUFNLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUN0RCxDQUFDO1FBQ0YsQ0FBQztLQUFBO0lBRU8sYUFBYSxDQUFDLEtBQWlCO1FBQ3RDLGtIQUFrSDtRQUNsSCxNQUFNLEdBQUcsR0FBRyxJQUFJLFdBQVcsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7UUFDOUMsSUFBSSxVQUFVLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQy9CLE9BQU8sR0FBRyxDQUFDO0lBQ1osQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCBKU1ppcCBmcm9tICdqc3ppcCc7XHJcbmltcG9ydCBNYXJrZG93bkl0IGZyb20gJ21hcmtkb3duLWl0JztcclxuaW1wb3J0IHR5cGUgeyBMaWNlbnNlVGVtcGxhdGVJZCB9IGZyb20gJy4vTGljZW5zZVRlbXBsYXRlcyc7XHJcbmltcG9ydCB7IGdldExpY2Vuc2VUZW1wbGF0ZSB9IGZyb20gJy4vTGljZW5zZVRlbXBsYXRlcyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydEZvbnRGaWxlcyB7XHJcblx0cmVndWxhclBhdGg6IHN0cmluZztcclxuXHRib2xkUGF0aD86IHN0cmluZztcclxuXHRpdGFsaWNQYXRoPzogc3RyaW5nO1xyXG5cdGJvbGRJdGFsaWNQYXRoPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydEVwdWJQYXJhbXMge1xyXG5cdC8vIFNvdXJjZVxyXG5cdGJvb2tUaXRsZTogc3RyaW5nO1xyXG5cdGF1dGhvcjogc3RyaW5nO1xyXG5cdGxhbmd1YWdlOiBzdHJpbmc7XHJcblx0c3VidGl0bGU/OiBzdHJpbmc7XHJcblxyXG5cdC8vIENoYXB0ZXJzIChhbHJlYWR5IG9yZGVyZWQpXHJcblx0Y2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgbWFya2Rvd246IHN0cmluZzsgc291cmNlUGF0aDogc3RyaW5nIH0+O1xyXG5cclxuXHQvLyBGcm9udCBtYXR0ZXJcclxuXHRpbmNsdWRlVGl0bGVQYWdlOiBib29sZWFuO1xyXG5cdGluY2x1ZGVDb3B5cmlnaHRQYWdlOiBib29sZWFuO1xyXG5cdGxpY2Vuc2VUZW1wbGF0ZUlkOiBMaWNlbnNlVGVtcGxhdGVJZDtcclxuXHRjb3B5cmlnaHRZZWFyOiBzdHJpbmc7XHJcblx0Y29weXJpZ2h0SG9sZGVyOiBzdHJpbmc7XHJcblxyXG5cdC8vIFR5cG9ncmFwaHlcclxuXHRlbWJlZEN1c3RvbUZvbnRzOiBib29sZWFuO1xyXG5cdGN1c3RvbUZvbnRzPzogRXhwb3J0Rm9udEZpbGVzO1xyXG5cclxuXHQvLyBPdXRwdXRcclxuXHRvdXRwdXRGb2xkZXI6IHN0cmluZzsgLy8gdmF1bHQtcmVsYXRpdmUgZm9sZGVyXHJcblx0b3V0cHV0RmlsZU5hbWU6IHN0cmluZzsgLy8gc2hvdWxkIGVuZCB3aXRoIC5lcHViXHJcbn1cclxuXHJcbmludGVyZmFjZSBNYW5pZmVzdEl0ZW0ge1xyXG5cdGlkOiBzdHJpbmc7XHJcblx0aHJlZjogc3RyaW5nO1xyXG5cdG1lZGlhVHlwZTogc3RyaW5nO1xyXG5cdHByb3BlcnRpZXM/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVzY2FwZVhtbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gdmFsdWVcclxuXHRcdC5yZXBsYWNlKC8mL2csICcmYW1wOycpXHJcblx0XHQucmVwbGFjZSgvPC9nLCAnJmx0OycpXHJcblx0XHQucmVwbGFjZSgvPi9nLCAnJmd0OycpXHJcblx0XHQucmVwbGFjZSgvXFxcIi9nLCAnJnF1b3Q7JylcclxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gc2FuaXRpemVGaWxlTmFtZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IHRyaW1tZWQgPSBuYW1lLnRyaW0oKTtcclxuXHRjb25zdCBzYWZlID0gdHJpbW1lZC5yZXBsYWNlKC9bPD46XCIvXFxcXHw/KlxcdTAwMDAtXFx1MDAxRl0vZywgJ18nKTtcclxuXHRyZXR1cm4gc2FmZS5sZW5ndGggPyBzYWZlIDogJ2Jvb2snO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3JtYWxpemVGb2xkZXIoZm9sZGVyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IGYgPSBmb2xkZXIucmVwbGFjZSgvXFxcXC9nLCAnLycpLnJlcGxhY2UoL15cXC8rLywgJycpLnJlcGxhY2UoL1xcLyskLywgJycpO1xyXG5cdHJldHVybiBmLmxlbmd0aCA/IGYgOiAnRXhwb3J0cyc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUVwdWJFeHQobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gbmFtZS50b0xvd2VyQ2FzZSgpLmVuZHNXaXRoKCcuZXB1YicpID8gbmFtZSA6IGAke25hbWV9LmVwdWJgO1xyXG59XHJcblxyXG5mdW5jdGlvbiBub3dJc29VdGMoKTogc3RyaW5nIHtcclxuXHQvLyBFUFVCIHJlcXVpcmVzIFVUQy1pc2ggbW9kaWZpZWQgdGltZXN0YW1wXHJcblx0cmV0dXJuIG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdXVpZExpa2UoKTogc3RyaW5nIHtcclxuXHQvLyBQcmVmZXIgY3J5cHRvLnJhbmRvbVVVSUQgaWYgcHJlc2VudC5cclxuXHR0cnkge1xyXG5cdFx0Y29uc3QgYyA9IGdsb2JhbFRoaXMuY3J5cHRvIGFzIHVua25vd24gYXMgeyByYW5kb21VVUlEPzogKCkgPT4gc3RyaW5nIH0gfCB1bmRlZmluZWQ7XHJcblx0XHRpZiAoYz8ucmFuZG9tVVVJRCkgcmV0dXJuIGMucmFuZG9tVVVJRCgpO1xyXG5cdH0gY2F0Y2gge1xyXG5cdFx0Ly8gaWdub3JlXHJcblx0fVxyXG5cdC8vIEZhbGxiYWNrOiBub3QgY3J5cHRvZ3JhcGhpY2FsbHkgc3Ryb25nLCBidXQgT0sgZm9yIGFuIGlkZW50aWZpZXIuXHJcblx0cmV0dXJuIGB3ZC0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMTYpLnNsaWNlKDIpfS0ke0RhdGUubm93KCkudG9TdHJpbmcoMTYpfWA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHhodG1sRG9jdW1lbnQodGl0bGU6IHN0cmluZywgYm9keUlubmVyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXHJcblx0XHRgPCFET0NUWVBFIGh0bWw+XFxuYCArXHJcblx0XHRgPGh0bWwgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIgeG1sOmxhbmc9XCJlblwiPlxcbmAgK1xyXG5cdFx0YDxoZWFkPlxcbmAgK1xyXG5cdFx0YCAgPHRpdGxlPiR7ZXNjYXBlWG1sKHRpdGxlKX08L3RpdGxlPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgY2hhcnNldD1cInV0Zi04XCIgLz5cXG5gICtcclxuXHRcdGAgIDxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwiLi4vU3R5bGVzL3N0eWxlLmNzc1wiIC8+XFxuYCArXHJcblx0XHRgPC9oZWFkPlxcbmAgK1xyXG5cdFx0YDxib2R5PlxcbmAgK1xyXG5cdFx0Ym9keUlubmVyICtcclxuXHRcdGBcXG48L2JvZHk+XFxuYCArXHJcblx0XHRgPC9odG1sPlxcbmA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJ1aWxkTmF2WGh0bWwoY2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgaHJlZjogc3RyaW5nIH0+LCBib29rVGl0bGU6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0Y29uc3QgaXRlbXMgPSBjaGFwdGVyc1xyXG5cdFx0Lm1hcCgoYykgPT4gYDxsaT48YSBocmVmPVwiJHtlc2NhcGVYbWwoYy5ocmVmKX1cIj4ke2VzY2FwZVhtbChjLnRpdGxlKX08L2E+PC9saT5gKVxyXG5cdFx0LmpvaW4oJ1xcbicpO1xyXG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXHJcblx0XHRgPCFET0NUWVBFIGh0bWw+XFxuYCArXHJcblx0XHRgPGh0bWwgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIgeG1sbnM6ZXB1Yj1cImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcHNcIiB4bWw6bGFuZz1cImVuXCI+XFxuYCArXHJcblx0XHRgPGhlYWQ+XFxuYCArXHJcblx0XHRgICA8dGl0bGU+JHtlc2NhcGVYbWwoYm9va1RpdGxlKX08L3RpdGxlPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgY2hhcnNldD1cInV0Zi04XCIgLz5cXG5gICtcclxuXHRcdGAgIDxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwiU3R5bGVzL3N0eWxlLmNzc1wiIC8+XFxuYCArXHJcblx0XHRgPC9oZWFkPlxcbmAgK1xyXG5cdFx0YDxib2R5PlxcbmAgK1xyXG5cdFx0YCAgPG5hdiBlcHViOnR5cGU9XCJ0b2NcIiBpZD1cInRvY1wiPlxcbmAgK1xyXG5cdFx0YCAgICA8aDE+Q29udGVudHM8L2gxPlxcbmAgK1xyXG5cdFx0YCAgICA8b2w+XFxuYCArXHJcblx0XHRpdGVtcyArXHJcblx0XHRgXFxuICAgIDwvb2w+XFxuYCArXHJcblx0XHRgICA8L25hdj5cXG5gICtcclxuXHRcdGA8L2JvZHk+XFxuYCArXHJcblx0XHRgPC9odG1sPlxcbmA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJ1aWxkVG9jTmN4KHV1aWQ6IHN0cmluZywgY2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgaHJlZjogc3RyaW5nIH0+LCBib29rVGl0bGU6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0Y29uc3QgbmF2UG9pbnRzID0gY2hhcHRlcnNcclxuXHRcdC5tYXAoKGMsIGlkeCkgPT4ge1xyXG5cdFx0XHRjb25zdCBvcmRlciA9IGlkeCArIDE7XHJcblx0XHRcdHJldHVybiAoXHJcblx0XHRcdFx0YDxuYXZQb2ludCBpZD1cIm5hdlBvaW50LSR7b3JkZXJ9XCIgcGxheU9yZGVyPVwiJHtvcmRlcn1cIj5cXG5gICtcclxuXHRcdFx0XHRgICA8bmF2TGFiZWw+PHRleHQ+JHtlc2NhcGVYbWwoYy50aXRsZSl9PC90ZXh0PjwvbmF2TGFiZWw+XFxuYCArXHJcblx0XHRcdFx0YCAgPGNvbnRlbnQgc3JjPVwiJHtlc2NhcGVYbWwoYy5ocmVmKX1cIi8+XFxuYCArXHJcblx0XHRcdFx0YDwvbmF2UG9pbnQ+YFxyXG5cdFx0XHQpO1xyXG5cdFx0fSlcclxuXHRcdC5qb2luKCdcXG4nKTtcclxuXHJcblx0cmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiPz5cXG5gICtcclxuXHRcdGA8IURPQ1RZUEUgbmN4IFBVQkxJQyBcIi0vL05JU08vL0RURCBuY3ggMjAwNS0xLy9FTlwiIFwiaHR0cDovL3d3dy5kYWlzeS5vcmcvejM5ODYvMjAwNS9uY3gtMjAwNS0xLmR0ZFwiPlxcbmAgK1xyXG5cdFx0YDxuY3ggeG1sbnM9XCJodHRwOi8vd3d3LmRhaXN5Lm9yZy96Mzk4Ni8yMDA1L25jeC9cIiB2ZXJzaW9uPVwiMjAwNS0xXCI+XFxuYCArXHJcblx0XHRgPGhlYWQ+XFxuYCArXHJcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOnVpZFwiIGNvbnRlbnQ9XCIke2VzY2FwZVhtbCh1dWlkKX1cIi8+XFxuYCArXHJcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOmRlcHRoXCIgY29udGVudD1cIjFcIi8+XFxuYCArXHJcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOnRvdGFsUGFnZUNvdW50XCIgY29udGVudD1cIjBcIi8+XFxuYCArXHJcblx0XHRgICA8bWV0YSBuYW1lPVwiZHRiOm1heFBhZ2VOdW1iZXJcIiBjb250ZW50PVwiMFwiLz5cXG5gICtcclxuXHRcdGA8L2hlYWQ+XFxuYCArXHJcblx0XHRgPGRvY1RpdGxlPjx0ZXh0PiR7ZXNjYXBlWG1sKGJvb2tUaXRsZSl9PC90ZXh0PjwvZG9jVGl0bGU+XFxuYCArXHJcblx0XHRgPG5hdk1hcD5cXG5gICtcclxuXHRcdG5hdlBvaW50cyArXHJcblx0XHRgXFxuPC9uYXZNYXA+XFxuYCArXHJcblx0XHRgPC9uY3g+XFxuYDtcclxufVxyXG5cclxuZnVuY3Rpb24gaW5mZXJNZWRpYVR5cGUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCBleHQgPSBwYXRoLnNwbGl0KCcuJykucG9wKCk/LnRvTG93ZXJDYXNlKCk7XHJcblx0c3dpdGNoIChleHQpIHtcclxuXHRcdGNhc2UgJ3hodG1sJzpcclxuXHRcdGNhc2UgJ2h0bWwnOlxyXG5cdFx0XHRyZXR1cm4gJ2FwcGxpY2F0aW9uL3hodG1sK3htbCc7XHJcblx0XHRjYXNlICdjc3MnOlxyXG5cdFx0XHRyZXR1cm4gJ3RleHQvY3NzJztcclxuXHRcdGNhc2UgJ25jeCc6XHJcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24veC1kdGJuY3greG1sJztcclxuXHRcdGNhc2UgJ3R0Zic6XHJcblx0XHRcdHJldHVybiAnZm9udC90dGYnO1xyXG5cdFx0Y2FzZSAnb3RmJzpcclxuXHRcdFx0cmV0dXJuICdmb250L290Zic7XHJcblx0XHRjYXNlICd3b2ZmJzpcclxuXHRcdFx0cmV0dXJuICdmb250L3dvZmYnO1xyXG5cdFx0Y2FzZSAnd29mZjInOlxyXG5cdFx0XHRyZXR1cm4gJ2ZvbnQvd29mZjInO1xyXG5cdFx0ZGVmYXVsdDpcclxuXHRcdFx0cmV0dXJuICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nO1xyXG5cdH1cclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGREZWZhdWx0Q3NzKGZvbnRGYW1pbHk6IHN0cmluZywgZW1iZWRGb250czogYm9vbGVhbiwgZm9udEZpbGVOYW1lcz86IFBhcnRpYWw8UmVjb3JkPGtleW9mIEV4cG9ydEZvbnRGaWxlcywgc3RyaW5nPj4pOiBzdHJpbmcge1xyXG5cdGNvbnN0IGJhc2UgPSBbXHJcblx0XHRgaHRtbCwgYm9keSB7IG1hcmdpbjogMDsgcGFkZGluZzogMDsgfWAsXHJcblx0XHRgYm9keSB7IGZvbnQtZmFtaWx5OiAke2ZvbnRGYW1pbHl9OyBmb250LXNpemU6IDFlbTsgbGluZS1oZWlnaHQ6IDEuNTU7IHBhZGRpbmc6IDAgMC44ZW07IH1gLFxyXG5cdFx0YGgxLCBoMiwgaDMgeyBmb250LWZhbWlseTogJHtmb250RmFtaWx5fTsgbGluZS1oZWlnaHQ6IDEuMjsgfWAsXHJcblx0XHRgaDEgeyBmb250LXNpemU6IDEuNmVtOyBtYXJnaW46IDEuMWVtIDAgMC42ZW07IH1gLFxyXG5cdFx0YHAgeyBtYXJnaW46IDAuOWVtIDA7IH1gLFxyXG5cdFx0YC5jaGFwdGVyLXRpdGxlIHsgcGFnZS1icmVhay1iZWZvcmU6IGFsd2F5czsgfWAsXHJcblx0XHRgLmZyb250LW1hdHRlciB7IHBhZ2UtYnJlYWstYmVmb3JlOiBhbHdheXM7IH1gLFxyXG5cdFx0YGEgeyBjb2xvcjogaW5oZXJpdDsgfWBcclxuXHRdO1xyXG5cclxuXHRpZiAoIWVtYmVkRm9udHMgfHwgIWZvbnRGaWxlTmFtZXM/LnJlZ3VsYXJQYXRoKSByZXR1cm4gYmFzZS5qb2luKCdcXG4nKTtcclxuXHJcblx0Y29uc3QgZmFjZXM6IHN0cmluZ1tdID0gW107XHJcblx0Y29uc3QgYWRkRmFjZSA9IChrZXk6IGtleW9mIEV4cG9ydEZvbnRGaWxlcywgd2VpZ2h0OiBudW1iZXIsIHN0eWxlOiAnbm9ybWFsJyB8ICdpdGFsaWMnKSA9PiB7XHJcblx0XHRjb25zdCBmaWxlID0gZm9udEZpbGVOYW1lc1trZXldO1xyXG5cdFx0aWYgKCFmaWxlKSByZXR1cm47XHJcblx0XHRmYWNlcy5wdXNoKFxyXG5cdFx0XHRgQGZvbnQtZmFjZSB7IGZvbnQtZmFtaWx5OiBcIkN1c3RvbVNlcmlmXCI7IHNyYzogdXJsKFwiLi4vRm9udHMvJHtmaWxlfVwiKTsgZm9udC13ZWlnaHQ6ICR7d2VpZ2h0fTsgZm9udC1zdHlsZTogJHtzdHlsZX07IH1gXHJcblx0XHQpO1xyXG5cdH07XHJcblxyXG5cdGFkZEZhY2UoJ3JlZ3VsYXJQYXRoJywgNDAwLCAnbm9ybWFsJyk7XHJcblx0YWRkRmFjZSgnYm9sZFBhdGgnLCA3MDAsICdub3JtYWwnKTtcclxuXHRhZGRGYWNlKCdpdGFsaWNQYXRoJywgNDAwLCAnaXRhbGljJyk7XHJcblx0YWRkRmFjZSgnYm9sZEl0YWxpY1BhdGgnLCA3MDAsICdpdGFsaWMnKTtcclxuXHJcblx0cmV0dXJuIFsuLi5mYWNlcywgYGAsIC4uLmJhc2UubWFwKChsKSA9PiBsLnJlcGxhY2UoZm9udEZhbWlseSwgYFwiQ3VzdG9tU2VyaWZcIiwgc2VyaWZgKSldLmpvaW4oJ1xcbicpO1xyXG59XHJcblxyXG5leHBvcnQgY2xhc3MgRXB1YkV4cG9ydFNlcnZpY2Uge1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgdmF1bHQ6IFZhdWx0O1xyXG5cdHByaXZhdGUgcmVhZG9ubHkgbWQ6IE1hcmtkb3duSXQ7XHJcblxyXG5cdGNvbnN0cnVjdG9yKHZhdWx0OiBWYXVsdCkge1xyXG5cdFx0dGhpcy52YXVsdCA9IHZhdWx0O1xyXG5cdFx0dGhpcy5tZCA9IG5ldyBNYXJrZG93bkl0KHtcclxuXHRcdFx0aHRtbDogZmFsc2UsXHJcblx0XHRcdGxpbmtpZnk6IHRydWUsXHJcblx0XHRcdHR5cG9ncmFwaGVyOiB0cnVlXHJcblx0XHR9KTtcclxuXHR9XHJcblxyXG5cdGFzeW5jIGV4cG9ydEVwdWIocGFyYW1zOiBFeHBvcnRFcHViUGFyYW1zKTogUHJvbWlzZTx7IG91dHB1dFBhdGg6IHN0cmluZyB9PiB7XHJcblx0XHRjb25zdCBib29rVGl0bGUgPSBwYXJhbXMuYm9va1RpdGxlLnRyaW0oKSB8fCAnVW50aXRsZWQnO1xyXG5cdFx0Y29uc3QgYXV0aG9yID0gcGFyYW1zLmF1dGhvci50cmltKCk7XHJcblx0XHRjb25zdCBsYW5ndWFnZSA9IHBhcmFtcy5sYW5ndWFnZS50cmltKCkgfHwgJ2VuJztcclxuXHRcdGNvbnN0IHN1YnRpdGxlID0gKHBhcmFtcy5zdWJ0aXRsZSB8fCAnJykudHJpbSgpO1xyXG5cclxuXHRcdGNvbnN0IGZvbGRlciA9IG5vcm1hbGl6ZUZvbGRlcihwYXJhbXMub3V0cHV0Rm9sZGVyKTtcclxuXHRcdGNvbnN0IGZpbGVOYW1lID0gZW5zdXJlRXB1YkV4dChzYW5pdGl6ZUZpbGVOYW1lKHBhcmFtcy5vdXRwdXRGaWxlTmFtZSB8fCBib29rVGl0bGUpKTtcclxuXHRcdGNvbnN0IG91dHB1dFBhdGggPSBgJHtmb2xkZXJ9LyR7ZmlsZU5hbWV9YC5yZXBsYWNlKC9cXFxcL2csICcvJyk7XHJcblxyXG5cdFx0YXdhaXQgdGhpcy5lbnN1cmVGb2xkZXIoZm9sZGVyKTtcclxuXHJcblx0XHRjb25zdCB1dWlkID0gdXVpZExpa2UoKTtcclxuXHRcdGNvbnN0IG1vZGlmaWVkID0gbm93SXNvVXRjKCk7XHJcblxyXG5cdFx0Y29uc3QgemlwID0gbmV3IEpTWmlwKCk7XHJcblx0XHQvLyBtaW1ldHlwZSBtdXN0IGJlIGZpcnN0IGFuZCB1bmNvbXByZXNzZWRcclxuXHRcdHppcC5maWxlKCdtaW1ldHlwZScsICdhcHBsaWNhdGlvbi9lcHViK3ppcCcsIHsgY29tcHJlc3Npb246ICdTVE9SRScgfSk7XHJcblxyXG5cdFx0emlwLmZvbGRlcignTUVUQS1JTkYnKT8uZmlsZShcclxuXHRcdFx0J2NvbnRhaW5lci54bWwnLFxyXG5cdFx0XHRgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIj8+XFxuYCArXHJcblx0XHRcdFx0YDxjb250YWluZXIgdmVyc2lvbj1cIjEuMFwiIHhtbG5zPVwidXJuOm9hc2lzOm5hbWVzOnRjOm9wZW5kb2N1bWVudDp4bWxuczpjb250YWluZXJcIj5cXG5gICtcclxuXHRcdFx0XHRgICA8cm9vdGZpbGVzPlxcbmAgK1xyXG5cdFx0XHRcdGAgICAgPHJvb3RmaWxlIGZ1bGwtcGF0aD1cIk9FQlBTL2NvbnRlbnQub3BmXCIgbWVkaWEtdHlwZT1cImFwcGxpY2F0aW9uL29lYnBzLXBhY2thZ2UreG1sXCIvPlxcbmAgK1xyXG5cdFx0XHRcdGAgIDwvcm9vdGZpbGVzPlxcbmAgK1xyXG5cdFx0XHRcdGA8L2NvbnRhaW5lcj5cXG5gXHJcblx0XHQpO1xyXG5cclxuXHRcdGNvbnN0IG9lYnBzID0gemlwLmZvbGRlcignT0VCUFMnKTtcclxuXHRcdGlmICghb2VicHMpIHRocm93IG5ldyBFcnJvcignRmFpbGVkIHRvIGluaXRpYWxpemUgRVBVQiBjb250YWluZXIuJyk7XHJcblxyXG5cdFx0Y29uc3QgdGV4dEZvbGRlciA9IG9lYnBzLmZvbGRlcignVGV4dCcpO1xyXG5cdFx0Y29uc3Qgc3R5bGVzRm9sZGVyID0gb2VicHMuZm9sZGVyKCdTdHlsZXMnKTtcclxuXHRcdGNvbnN0IGZvbnRzRm9sZGVyID0gb2VicHMuZm9sZGVyKCdGb250cycpO1xyXG5cdFx0aWYgKCF0ZXh0Rm9sZGVyIHx8ICFzdHlsZXNGb2xkZXIgfHwgIWZvbnRzRm9sZGVyKSB0aHJvdyBuZXcgRXJyb3IoJ0ZhaWxlZCB0byBpbml0aWFsaXplIEVQVUIgZm9sZGVycy4nKTtcclxuXHJcblx0XHRjb25zdCBtYW5pZmVzdDogTWFuaWZlc3RJdGVtW10gPSBbXTtcclxuXHRcdGNvbnN0IHNwaW5lOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuXHRcdC8vIE5hdmlnYXRpb25cclxuXHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ25hdicsIGhyZWY6ICduYXYueGh0bWwnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnLCBwcm9wZXJ0aWVzOiAnbmF2JyB9KTtcclxuXHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ3RvYycsIGhyZWY6ICd0b2MubmN4JywgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24veC1kdGJuY3greG1sJyB9KTtcclxuXHJcblx0XHQvLyBTdHlsZXNcclxuXHRcdGNvbnN0IGZvbnRGYW1pbHkgPSBgXCJMaXRlcmF0YVwiLCBcIkdlb3JnaWFcIiwgc2VyaWZgO1xyXG5cdFx0Y29uc3QgZm9udEZpbGVOYW1lczogUGFydGlhbDxSZWNvcmQ8a2V5b2YgRXhwb3J0Rm9udEZpbGVzLCBzdHJpbmc+PiA9IHt9O1xyXG5cdFx0aWYgKHBhcmFtcy5lbWJlZEN1c3RvbUZvbnRzICYmIHBhcmFtcy5jdXN0b21Gb250cz8ucmVndWxhclBhdGgpIHtcclxuXHRcdFx0Zm9udEZpbGVOYW1lcy5yZWd1bGFyUGF0aCA9IHRoaXMuYmFzZW5hbWUocGFyYW1zLmN1c3RvbUZvbnRzLnJlZ3VsYXJQYXRoKTtcclxuXHRcdFx0aWYgKHBhcmFtcy5jdXN0b21Gb250cy5ib2xkUGF0aCkgZm9udEZpbGVOYW1lcy5ib2xkUGF0aCA9IHRoaXMuYmFzZW5hbWUocGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRQYXRoKTtcclxuXHRcdFx0aWYgKHBhcmFtcy5jdXN0b21Gb250cy5pdGFsaWNQYXRoKSBmb250RmlsZU5hbWVzLml0YWxpY1BhdGggPSB0aGlzLmJhc2VuYW1lKHBhcmFtcy5jdXN0b21Gb250cy5pdGFsaWNQYXRoKTtcclxuXHRcdFx0aWYgKHBhcmFtcy5jdXN0b21Gb250cy5ib2xkSXRhbGljUGF0aCkgZm9udEZpbGVOYW1lcy5ib2xkSXRhbGljUGF0aCA9IHRoaXMuYmFzZW5hbWUocGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRJdGFsaWNQYXRoKTtcclxuXHRcdH1cclxuXHRcdGNvbnN0IGNzcyA9IGJ1aWxkRGVmYXVsdENzcyhmb250RmFtaWx5LCBwYXJhbXMuZW1iZWRDdXN0b21Gb250cywgZm9udEZpbGVOYW1lcyk7XHJcblx0XHRzdHlsZXNGb2xkZXIuZmlsZSgnc3R5bGUuY3NzJywgY3NzKTtcclxuXHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ2NzcycsIGhyZWY6ICdTdHlsZXMvc3R5bGUuY3NzJywgbWVkaWFUeXBlOiAndGV4dC9jc3MnIH0pO1xyXG5cclxuXHRcdC8vIEZyb250IG1hdHRlciBwYWdlc1xyXG5cdFx0aWYgKHBhcmFtcy5pbmNsdWRlVGl0bGVQYWdlKSB7XHJcblx0XHRcdGNvbnN0IGlubmVyID1cclxuXHRcdFx0XHRgPHNlY3Rpb24gY2xhc3M9XCJmcm9udC1tYXR0ZXJcIj5cXG5gICtcclxuXHRcdFx0XHRgPGgxPiR7ZXNjYXBlWG1sKGJvb2tUaXRsZSl9PC9oMT5cXG5gICtcclxuXHRcdFx0XHQoc3VidGl0bGUgPyBgPGgyPiR7ZXNjYXBlWG1sKHN1YnRpdGxlKX08L2gyPlxcbmAgOiAnJykgK1xyXG5cdFx0XHRcdChhdXRob3IgPyBgPHA+JHtlc2NhcGVYbWwoYXV0aG9yKX08L3A+XFxuYCA6ICcnKSArXHJcblx0XHRcdFx0YDwvc2VjdGlvbj5gO1xyXG5cdFx0XHRjb25zdCB4aHRtbCA9IHhodG1sRG9jdW1lbnQoJ1RpdGxlJywgaW5uZXIpO1xyXG5cdFx0XHR0ZXh0Rm9sZGVyLmZpbGUoJ3RpdGxlLnhodG1sJywgeGh0bWwpO1xyXG5cdFx0XHRtYW5pZmVzdC5wdXNoKHsgaWQ6ICd0aXRsZScsIGhyZWY6ICdUZXh0L3RpdGxlLnhodG1sJywgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24veGh0bWwreG1sJyB9KTtcclxuXHRcdFx0c3BpbmUucHVzaCgndGl0bGUnKTtcclxuXHRcdH1cclxuXHJcblx0XHRpZiAocGFyYW1zLmluY2x1ZGVDb3B5cmlnaHRQYWdlKSB7XHJcblx0XHRcdGNvbnN0IHRlbXBsYXRlID0gZ2V0TGljZW5zZVRlbXBsYXRlKHBhcmFtcy5saWNlbnNlVGVtcGxhdGVJZCk7XHJcblx0XHRcdGNvbnN0IHhodG1sID0gdGVtcGxhdGUucmVuZGVyWGh0bWwoe1xyXG5cdFx0XHRcdHRpdGxlOiBib29rVGl0bGUsXHJcblx0XHRcdFx0YXV0aG9yLFxyXG5cdFx0XHRcdHllYXI6IHBhcmFtcy5jb3B5cmlnaHRZZWFyIHx8ICcnLFxyXG5cdFx0XHRcdGhvbGRlcjogcGFyYW1zLmNvcHlyaWdodEhvbGRlciB8fCAnJ1xyXG5cdFx0XHR9KTtcclxuXHRcdFx0dGV4dEZvbGRlci5maWxlKCdjb3B5cmlnaHQueGh0bWwnLCB4aHRtbCk7XHJcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ2NvcHlyaWdodCcsIGhyZWY6ICdUZXh0L2NvcHlyaWdodC54aHRtbCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcgfSk7XHJcblx0XHRcdHNwaW5lLnB1c2goJ2NvcHlyaWdodCcpO1xyXG5cdFx0fVxyXG5cclxuXHRcdC8vIENoYXB0ZXJzXHJcblx0XHRjb25zdCBuYXZDaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBocmVmOiBzdHJpbmcgfT4gPSBbXTtcclxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgcGFyYW1zLmNoYXB0ZXJzLmxlbmd0aDsgaSsrKSB7XHJcblx0XHRcdGNvbnN0IGNoID0gcGFyYW1zLmNoYXB0ZXJzW2ldO1xyXG5cdFx0XHRjb25zdCBodG1sID0gdGhpcy5tZC5yZW5kZXIoY2gubWFya2Rvd24gfHwgJycpO1xyXG5cdFx0XHRjb25zdCBpbm5lciA9XHJcblx0XHRcdFx0YDxzZWN0aW9uIGNsYXNzPVwiY2hhcHRlclwiPlxcbmAgK1xyXG5cdFx0XHRcdGA8aDEgY2xhc3M9XCJjaGFwdGVyLXRpdGxlXCI+JHtlc2NhcGVYbWwoY2gudGl0bGUgfHwgYENoYXB0ZXIgJHtpICsgMX1gKX08L2gxPlxcbmAgK1xyXG5cdFx0XHRcdGh0bWwgK1xyXG5cdFx0XHRcdGBcXG48L3NlY3Rpb24+YDtcclxuXHRcdFx0Y29uc3QgeGh0bWwgPSB4aHRtbERvY3VtZW50KGNoLnRpdGxlIHx8IGBDaGFwdGVyICR7aSArIDF9YCwgaW5uZXIpO1xyXG5cdFx0XHRjb25zdCBmaWxlID0gYGNoYXB0ZXItJHtTdHJpbmcoaSArIDEpLnBhZFN0YXJ0KDMsICcwJyl9LnhodG1sYDtcclxuXHRcdFx0dGV4dEZvbGRlci5maWxlKGZpbGUsIHhodG1sKTtcclxuXHRcdFx0Y29uc3QgaWQgPSBgY2gke2kgKyAxfWA7XHJcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZCwgaHJlZjogYFRleHQvJHtmaWxlfWAsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcgfSk7XHJcblx0XHRcdHNwaW5lLnB1c2goaWQpO1xyXG5cdFx0XHRuYXZDaGFwdGVycy5wdXNoKHsgdGl0bGU6IGNoLnRpdGxlIHx8IGBDaGFwdGVyICR7aSArIDF9YCwgaHJlZjogYFRleHQvJHtmaWxlfWAgfSk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gbmF2LnhodG1sICsgdG9jLm5jeFxyXG5cdFx0b2VicHMuZmlsZSgnbmF2LnhodG1sJywgYnVpbGROYXZYaHRtbChuYXZDaGFwdGVycywgYm9va1RpdGxlKSk7XHJcblx0XHRvZWJwcy5maWxlKCd0b2MubmN4JywgYnVpbGRUb2NOY3godXVpZCwgbmF2Q2hhcHRlcnMsIGJvb2tUaXRsZSkpO1xyXG5cclxuXHRcdC8vIEZvbnRzXHJcblx0XHRpZiAocGFyYW1zLmVtYmVkQ3VzdG9tRm9udHMgJiYgcGFyYW1zLmN1c3RvbUZvbnRzPy5yZWd1bGFyUGF0aCkge1xyXG5cdFx0XHRjb25zdCBmb250UGF0aHM6IEFycmF5PFtrZXlvZiBFeHBvcnRGb250RmlsZXMsIHN0cmluZyB8IHVuZGVmaW5lZF0+ID0gW1xyXG5cdFx0XHRcdFsncmVndWxhclBhdGgnLCBwYXJhbXMuY3VzdG9tRm9udHMucmVndWxhclBhdGhdLFxyXG5cdFx0XHRcdFsnYm9sZFBhdGgnLCBwYXJhbXMuY3VzdG9tRm9udHMuYm9sZFBhdGhdLFxyXG5cdFx0XHRcdFsnaXRhbGljUGF0aCcsIHBhcmFtcy5jdXN0b21Gb250cy5pdGFsaWNQYXRoXSxcclxuXHRcdFx0XHRbJ2JvbGRJdGFsaWNQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRJdGFsaWNQYXRoXVxyXG5cdFx0XHRdO1xyXG5cclxuXHRcdFx0Zm9yIChjb25zdCBbLCBwXSBvZiBmb250UGF0aHMpIHtcclxuXHRcdFx0XHRpZiAoIXApIGNvbnRpbnVlO1xyXG5cdFx0XHRcdGNvbnN0IGRhdGEgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIucmVhZEJpbmFyeShwKTtcclxuXHRcdFx0XHRjb25zdCBuYW1lID0gdGhpcy5iYXNlbmFtZShwKTtcclxuXHRcdFx0XHRmb250c0ZvbGRlci5maWxlKG5hbWUsIGRhdGEpO1xyXG5cdFx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZDogYGZvbnQtJHtzYW5pdGl6ZUZpbGVOYW1lKG5hbWUpfWAsIGhyZWY6IGBGb250cy8ke25hbWV9YCwgbWVkaWFUeXBlOiBpbmZlck1lZGlhVHlwZShuYW1lKSB9KTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IG9wZiA9IHRoaXMuYnVpbGRPcGYoe1xyXG5cdFx0XHR1dWlkLFxyXG5cdFx0XHR0aXRsZTogYm9va1RpdGxlLFxyXG5cdFx0XHRhdXRob3IsXHJcblx0XHRcdGxhbmd1YWdlLFxyXG5cdFx0XHRtb2RpZmllZCxcclxuXHRcdFx0bWFuaWZlc3QsXHJcblx0XHRcdHNwaW5lXHJcblx0XHR9KTtcclxuXHRcdG9lYnBzLmZpbGUoJ2NvbnRlbnQub3BmJywgb3BmKTtcclxuXHJcblx0XHRjb25zdCBieXRlcyA9IGF3YWl0IHppcC5nZW5lcmF0ZUFzeW5jKHtcclxuXHRcdFx0dHlwZTogJ3VpbnQ4YXJyYXknLFxyXG5cdFx0XHRjb21wcmVzc2lvbjogJ0RFRkxBVEUnLFxyXG5cdFx0XHRjb21wcmVzc2lvbk9wdGlvbnM6IHsgbGV2ZWw6IDkgfVxyXG5cdFx0fSk7XHJcblxyXG5cdFx0Y29uc3Qgb3V0ID0gdGhpcy50b0FycmF5QnVmZmVyKGJ5dGVzKTtcclxuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZUJpbmFyeShvdXRwdXRQYXRoLCBvdXQpO1xyXG5cdFx0cmV0dXJuIHsgb3V0cHV0UGF0aCB9O1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBidWlsZE9wZihwYXJhbXM6IHtcclxuXHRcdHV1aWQ6IHN0cmluZztcclxuXHRcdHRpdGxlOiBzdHJpbmc7XHJcblx0XHRhdXRob3I6IHN0cmluZztcclxuXHRcdGxhbmd1YWdlOiBzdHJpbmc7XHJcblx0XHRtb2RpZmllZDogc3RyaW5nO1xyXG5cdFx0bWFuaWZlc3Q6IE1hbmlmZXN0SXRlbVtdO1xyXG5cdFx0c3BpbmU6IHN0cmluZ1tdO1xyXG5cdH0pOiBzdHJpbmcge1xyXG5cdFx0Y29uc3QgbWFuaWZlc3RYbWwgPSBwYXJhbXMubWFuaWZlc3RcclxuXHRcdFx0Lm1hcCgobSkgPT4ge1xyXG5cdFx0XHRcdGNvbnN0IHByb3BzID0gbS5wcm9wZXJ0aWVzID8gYCBwcm9wZXJ0aWVzPVwiJHtlc2NhcGVYbWwobS5wcm9wZXJ0aWVzKX1cImAgOiAnJztcclxuXHRcdFx0XHRyZXR1cm4gYDxpdGVtIGlkPVwiJHtlc2NhcGVYbWwobS5pZCl9XCIgaHJlZj1cIiR7ZXNjYXBlWG1sKG0uaHJlZil9XCIgbWVkaWEtdHlwZT1cIiR7ZXNjYXBlWG1sKG0ubWVkaWFUeXBlKX1cIiR7cHJvcHN9Lz5gO1xyXG5cdFx0XHR9KVxyXG5cdFx0XHQuam9pbignXFxuICAgICcpO1xyXG5cclxuXHRcdGNvbnN0IHNwaW5lWG1sID0gcGFyYW1zLnNwaW5lLm1hcCgoaWRyZWYpID0+IGA8aXRlbXJlZiBpZHJlZj1cIiR7ZXNjYXBlWG1sKGlkcmVmKX1cIi8+YCkuam9pbignXFxuICAgICcpO1xyXG5cclxuXHRcdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXHJcblx0XHRcdGA8cGFja2FnZSB4bWxucz1cImh0dHA6Ly93d3cuaWRwZi5vcmcvMjAwNy9vcGZcIiB2ZXJzaW9uPVwiMy4wXCIgdW5pcXVlLWlkZW50aWZpZXI9XCJwdWItaWRcIj5cXG5gICtcclxuXHRcdFx0YCAgPG1ldGFkYXRhIHhtbG5zOmRjPVwiaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS9cIj5cXG5gICtcclxuXHRcdFx0YCAgICA8ZGM6aWRlbnRpZmllciBpZD1cInB1Yi1pZFwiPnVybjp1dWlkOiR7ZXNjYXBlWG1sKHBhcmFtcy51dWlkKX08L2RjOmlkZW50aWZpZXI+XFxuYCArXHJcblx0XHRcdGAgICAgPGRjOnRpdGxlPiR7ZXNjYXBlWG1sKHBhcmFtcy50aXRsZSl9PC9kYzp0aXRsZT5cXG5gICtcclxuXHRcdFx0KHBhcmFtcy5hdXRob3IgPyBgICAgIDxkYzpjcmVhdG9yPiR7ZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpfTwvZGM6Y3JlYXRvcj5cXG5gIDogJycpICtcclxuXHRcdFx0YCAgICA8ZGM6bGFuZ3VhZ2U+JHtlc2NhcGVYbWwocGFyYW1zLmxhbmd1YWdlKX08L2RjOmxhbmd1YWdlPlxcbmAgK1xyXG5cdFx0XHRgICAgIDxtZXRhIHByb3BlcnR5PVwiZGN0ZXJtczptb2RpZmllZFwiPiR7ZXNjYXBlWG1sKHBhcmFtcy5tb2RpZmllZCl9PC9tZXRhPlxcbmAgK1xyXG5cdFx0XHRgICA8L21ldGFkYXRhPlxcbmAgK1xyXG5cdFx0XHRgICA8bWFuaWZlc3Q+XFxuYCArXHJcblx0XHRcdGAgICAgJHttYW5pZmVzdFhtbH1cXG5gICtcclxuXHRcdFx0YCAgPC9tYW5pZmVzdD5cXG5gICtcclxuXHRcdFx0YCAgPHNwaW5lIHRvYz1cInRvY1wiPlxcbmAgK1xyXG5cdFx0XHRgICAgICR7c3BpbmVYbWx9XFxuYCArXHJcblx0XHRcdGAgIDwvc3BpbmU+XFxuYCArXHJcblx0XHRcdGA8L3BhY2thZ2U+XFxuYDtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYmFzZW5hbWUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRcdGNvbnN0IG5vcm1hbGl6ZWQgPSBwYXRoLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuXHRcdHJldHVybiBub3JtYWxpemVkLnNwbGl0KCcvJykucG9wKCkgfHwgbm9ybWFsaXplZDtcclxuXHR9XHJcblxyXG5cdHByaXZhdGUgYXN5bmMgZW5zdXJlRm9sZGVyKGZvbGRlcjogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcblx0XHRjb25zdCBwYXJ0cyA9IG5vcm1hbGl6ZUZvbGRlcihmb2xkZXIpLnNwbGl0KCcvJyk7XHJcblx0XHRsZXQgY3VycmVudCA9ICcnO1xyXG5cdFx0Zm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XHJcblx0XHRcdGN1cnJlbnQgPSBjdXJyZW50ID8gYCR7Y3VycmVudH0vJHtwYXJ0fWAgOiBwYXJ0O1xyXG5cdFx0XHRjb25zdCBleGlzdHMgPSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIuZXhpc3RzKGN1cnJlbnQpO1xyXG5cdFx0XHRpZiAoIWV4aXN0cykgYXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGN1cnJlbnQpO1xyXG5cdFx0fVxyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSB0b0FycmF5QnVmZmVyKGJ5dGVzOiBVaW50OEFycmF5KTogQXJyYXlCdWZmZXIge1xyXG5cdFx0Ly8gU29tZSBUUyBsaWIgZGVmcyByZXByZXNlbnQgVWludDhBcnJheS5idWZmZXIgYXMgQXJyYXlCdWZmZXJMaWtlOyBub3JtYWxpemUgdG8gQXJyYXlCdWZmZXIgZm9yIE9ic2lkaWFuIGFkYXB0ZXIuXHJcblx0XHRjb25zdCBvdXQgPSBuZXcgQXJyYXlCdWZmZXIoYnl0ZXMuYnl0ZUxlbmd0aCk7XHJcblx0XHRuZXcgVWludDhBcnJheShvdXQpLnNldChieXRlcyk7XHJcblx0XHRyZXR1cm4gb3V0O1xyXG5cdH1cclxufVxyXG5cclxuXHJcbiJdfQ==