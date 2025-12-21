import { __awaiter } from "tslib";
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXB1YkV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJFcHViRXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQ0EsT0FBTyxLQUFLLE1BQU0sT0FBTyxDQUFDO0FBQzFCLE9BQU8sVUFBVSxNQUFNLGFBQWEsQ0FBQztBQUVyQyxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQTBDeEQsU0FBUyxTQUFTLENBQUMsS0FBYTtJQUMvQixPQUFPLEtBQUs7U0FDVixPQUFPLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztTQUN0QixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQztTQUN2QixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLElBQVk7SUFDckMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzVCLElBQUksQ0FBQyxPQUFPO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDNUIsTUFBTSxTQUFTLEdBQUcsY0FBYyxDQUFDO0lBQ2pDLElBQUksR0FBRyxHQUFHLEVBQUUsQ0FBQztJQUNiLEtBQUssTUFBTSxFQUFFLElBQUksT0FBTyxFQUFFLENBQUM7UUFDMUIsTUFBTSxJQUFJLEdBQUcsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQztRQUM5QixJQUFJLElBQUksR0FBRyxFQUFFLEVBQUUsQ0FBQztZQUNmLEdBQUcsSUFBSSxHQUFHLENBQUM7WUFDWCxTQUFTO1FBQ1YsQ0FBQztRQUNELEdBQUcsSUFBSSxTQUFTLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUs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cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgVmF1bHQgfSBmcm9tICdvYnNpZGlhbic7XHJcbmltcG9ydCBKU1ppcCBmcm9tICdqc3ppcCc7XHJcbmltcG9ydCBNYXJrZG93bkl0IGZyb20gJ21hcmtkb3duLWl0JztcclxuaW1wb3J0IHR5cGUgeyBMaWNlbnNlVGVtcGxhdGVJZCB9IGZyb20gJy4vTGljZW5zZVRlbXBsYXRlcyc7XHJcbmltcG9ydCB7IGdldExpY2Vuc2VUZW1wbGF0ZSB9IGZyb20gJy4vTGljZW5zZVRlbXBsYXRlcyc7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydEZvbnRGaWxlcyB7XHJcblx0cmVndWxhclBhdGg6IHN0cmluZztcclxuXHRib2xkUGF0aD86IHN0cmluZztcclxuXHRpdGFsaWNQYXRoPzogc3RyaW5nO1xyXG5cdGJvbGRJdGFsaWNQYXRoPzogc3RyaW5nO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydEVwdWJQYXJhbXMge1xyXG5cdC8vIFNvdXJjZVxyXG5cdGJvb2tUaXRsZTogc3RyaW5nO1xyXG5cdGF1dGhvcjogc3RyaW5nO1xyXG5cdGxhbmd1YWdlOiBzdHJpbmc7XHJcblx0c3VidGl0bGU/OiBzdHJpbmc7XHJcblxyXG5cdC8vIENoYXB0ZXJzIChhbHJlYWR5IG9yZGVyZWQpXHJcblx0Y2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgbWFya2Rvd246IHN0cmluZzsgc291cmNlUGF0aDogc3RyaW5nIH0+O1xyXG5cclxuXHQvLyBGcm9udCBtYXR0ZXJcclxuXHRpbmNsdWRlVGl0bGVQYWdlOiBib29sZWFuO1xyXG5cdGluY2x1ZGVDb3B5cmlnaHRQYWdlOiBib29sZWFuO1xyXG5cdGxpY2Vuc2VUZW1wbGF0ZUlkOiBMaWNlbnNlVGVtcGxhdGVJZDtcclxuXHRjb3B5cmlnaHRZZWFyOiBzdHJpbmc7XHJcblx0Y29weXJpZ2h0SG9sZGVyOiBzdHJpbmc7XHJcblxyXG5cdC8vIFR5cG9ncmFwaHlcclxuXHRlbWJlZEN1c3RvbUZvbnRzOiBib29sZWFuO1xyXG5cdGN1c3RvbUZvbnRzPzogRXhwb3J0Rm9udEZpbGVzO1xyXG5cclxuXHQvLyBPdXRwdXRcclxuXHRvdXRwdXRGb2xkZXI6IHN0cmluZzsgLy8gdmF1bHQtcmVsYXRpdmUgZm9sZGVyXHJcblx0b3V0cHV0RmlsZU5hbWU6IHN0cmluZzsgLy8gc2hvdWxkIGVuZCB3aXRoIC5lcHViXHJcbn1cclxuXHJcbmludGVyZmFjZSBNYW5pZmVzdEl0ZW0ge1xyXG5cdGlkOiBzdHJpbmc7XHJcblx0aHJlZjogc3RyaW5nO1xyXG5cdG1lZGlhVHlwZTogc3RyaW5nO1xyXG5cdHByb3BlcnRpZXM/OiBzdHJpbmc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVzY2FwZVhtbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gdmFsdWVcclxuXHRcdC5yZXBsYWNlKC8mL2csICcmYW1wOycpXHJcblx0XHQucmVwbGFjZSgvPC9nLCAnJmx0OycpXHJcblx0XHQucmVwbGFjZSgvPi9nLCAnJmd0OycpXHJcblx0XHQucmVwbGFjZSgvXCIvZywgJyZxdW90OycpXHJcblx0XHQucmVwbGFjZSgvJy9nLCAnJmFwb3M7Jyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNhbml0aXplRmlsZU5hbWUobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCB0cmltbWVkID0gbmFtZS50cmltKCk7XHJcblx0aWYgKCF0cmltbWVkKSByZXR1cm4gJ2Jvb2snO1xyXG5cdGNvbnN0IGZvcmJpZGRlbiA9ICc8PjpcIi9cXFxcXFxcXHw/Kic7XHJcblx0bGV0IG91dCA9ICcnO1xyXG5cdGZvciAoY29uc3QgY2ggb2YgdHJpbW1lZCkge1xyXG5cdFx0Y29uc3QgY29kZSA9IGNoLmNoYXJDb2RlQXQoMCk7XHJcblx0XHRpZiAoY29kZSA8IDMyKSB7XHJcblx0XHRcdG91dCArPSAnXyc7XHJcblx0XHRcdGNvbnRpbnVlO1xyXG5cdFx0fVxyXG5cdFx0b3V0ICs9IGZvcmJpZGRlbi5pbmNsdWRlcyhjaCkgPyAnXycgOiBjaDtcclxuXHR9XHJcblx0cmV0dXJuIG91dC5sZW5ndGggPyBvdXQgOiAnYm9vayc7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZUZvbGRlcihmb2xkZXI6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0Y29uc3QgZiA9IGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXlxcLysvLCAnJykucmVwbGFjZSgvXFwvKyQvLCAnJyk7XHJcblx0cmV0dXJuIGYubGVuZ3RoID8gZiA6ICdFeHBvcnRzJztcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlRXB1YkV4dChuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiBuYW1lLnRvTG93ZXJDYXNlKCkuZW5kc1dpdGgoJy5lcHViJykgPyBuYW1lIDogYCR7bmFtZX0uZXB1YmA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG5vd0lzb1V0YygpOiBzdHJpbmcge1xyXG5cdC8vIEVQVUIgcmVxdWlyZXMgVVRDLWlzaCBtb2RpZmllZCB0aW1lc3RhbXBcclxuXHRyZXR1cm4gbmV3IERhdGUoKS50b0lTT1N0cmluZygpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1dWlkTGlrZSgpOiBzdHJpbmcge1xyXG5cdC8vIFByZWZlciBjcnlwdG8ucmFuZG9tVVVJRCBpZiBwcmVzZW50LlxyXG5cdHRyeSB7XHJcblx0XHRjb25zdCBjID0gZ2xvYmFsVGhpcy5jcnlwdG8gYXMgdW5rbm93biBhcyB7IHJhbmRvbVVVSUQ/OiAoKSA9PiBzdHJpbmcgfSB8IHVuZGVmaW5lZDtcclxuXHRcdGlmIChjPy5yYW5kb21VVUlEKSByZXR1cm4gYy5yYW5kb21VVUlEKCk7XHJcblx0fSBjYXRjaCB7XHJcblx0XHQvLyBpZ25vcmVcclxuXHR9XHJcblx0Ly8gRmFsbGJhY2s6IG5vdCBjcnlwdG9ncmFwaGljYWxseSBzdHJvbmcsIGJ1dCBPSyBmb3IgYW4gaWRlbnRpZmllci5cclxuXHRyZXR1cm4gYHdkLSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygxNikuc2xpY2UoMil9LSR7RGF0ZS5ub3coKS50b1N0cmluZygxNil9YDtcclxufVxyXG5cclxuZnVuY3Rpb24geGh0bWxEb2N1bWVudCh0aXRsZTogc3RyaW5nLCBib2R5SW5uZXI6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0cmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJ1dGYtOFwiPz5cXG5gICtcclxuXHRcdGA8IURPQ1RZUEUgaHRtbD5cXG5gICtcclxuXHRcdGA8aHRtbCB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIiB4bWw6bGFuZz1cImVuXCI+XFxuYCArXHJcblx0XHRgPGhlYWQ+XFxuYCArXHJcblx0XHRgICA8dGl0bGU+JHtlc2NhcGVYbWwodGl0bGUpfTwvdGl0bGU+XFxuYCArXHJcblx0XHRgICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIiAvPlxcbmAgK1xyXG5cdFx0YCAgPGxpbmsgcmVsPVwic3R5bGVzaGVldFwiIHR5cGU9XCJ0ZXh0L2Nzc1wiIGhyZWY9XCIuLi9TdHlsZXMvc3R5bGUuY3NzXCIgLz5cXG5gICtcclxuXHRcdGA8L2hlYWQ+XFxuYCArXHJcblx0XHRgPGJvZHk+XFxuYCArXHJcblx0XHRib2R5SW5uZXIgK1xyXG5cdFx0YFxcbjwvYm9keT5cXG5gICtcclxuXHRcdGA8L2h0bWw+XFxuYDtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGROYXZYaHRtbChjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBocmVmOiBzdHJpbmcgfT4sIGJvb2tUaXRsZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCBpdGVtcyA9IGNoYXB0ZXJzXHJcblx0XHQubWFwKChjKSA9PiBgPGxpPjxhIGhyZWY9XCIke2VzY2FwZVhtbChjLmhyZWYpfVwiPiR7ZXNjYXBlWG1sKGMudGl0bGUpfTwvYT48L2xpPmApXHJcblx0XHQuam9pbignXFxuJyk7XHJcblx0cmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJ1dGYtOFwiPz5cXG5gICtcclxuXHRcdGA8IURPQ1RZUEUgaHRtbD5cXG5gICtcclxuXHRcdGA8aHRtbCB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzE5OTkveGh0bWxcIiB4bWxuczplcHViPVwiaHR0cDovL3d3dy5pZHBmLm9yZy8yMDA3L29wc1wiIHhtbDpsYW5nPVwiZW5cIj5cXG5gICtcclxuXHRcdGA8aGVhZD5cXG5gICtcclxuXHRcdGAgIDx0aXRsZT4ke2VzY2FwZVhtbChib29rVGl0bGUpfTwvdGl0bGU+XFxuYCArXHJcblx0XHRgICA8bWV0YSBjaGFyc2V0PVwidXRmLThcIiAvPlxcbmAgK1xyXG5cdFx0YCAgPGxpbmsgcmVsPVwic3R5bGVzaGVldFwiIHR5cGU9XCJ0ZXh0L2Nzc1wiIGhyZWY9XCJTdHlsZXMvc3R5bGUuY3NzXCIgLz5cXG5gICtcclxuXHRcdGA8L2hlYWQ+XFxuYCArXHJcblx0XHRgPGJvZHk+XFxuYCArXHJcblx0XHRgICA8bmF2IGVwdWI6dHlwZT1cInRvY1wiIGlkPVwidG9jXCI+XFxuYCArXHJcblx0XHRgICAgIDxoMT5Db250ZW50czwvaDE+XFxuYCArXHJcblx0XHRgICAgIDxvbD5cXG5gICtcclxuXHRcdGl0ZW1zICtcclxuXHRcdGBcXG4gICAgPC9vbD5cXG5gICtcclxuXHRcdGAgIDwvbmF2PlxcbmAgK1xyXG5cdFx0YDwvYm9keT5cXG5gICtcclxuXHRcdGA8L2h0bWw+XFxuYDtcclxufVxyXG5cclxuZnVuY3Rpb24gYnVpbGRUb2NOY3godXVpZDogc3RyaW5nLCBjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBocmVmOiBzdHJpbmcgfT4sIGJvb2tUaXRsZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCBuYXZQb2ludHMgPSBjaGFwdGVyc1xyXG5cdFx0Lm1hcCgoYywgaWR4KSA9PiB7XHJcblx0XHRcdGNvbnN0IG9yZGVyID0gaWR4ICsgMTtcclxuXHRcdFx0cmV0dXJuIChcclxuXHRcdFx0XHRgPG5hdlBvaW50IGlkPVwibmF2UG9pbnQtJHtvcmRlcn1cIiBwbGF5T3JkZXI9XCIke29yZGVyfVwiPlxcbmAgK1xyXG5cdFx0XHRcdGAgIDxuYXZMYWJlbD48dGV4dD4ke2VzY2FwZVhtbChjLnRpdGxlKX08L3RleHQ+PC9uYXZMYWJlbD5cXG5gICtcclxuXHRcdFx0XHRgICA8Y29udGVudCBzcmM9XCIke2VzY2FwZVhtbChjLmhyZWYpfVwiLz5cXG5gICtcclxuXHRcdFx0XHRgPC9uYXZQb2ludD5gXHJcblx0XHRcdCk7XHJcblx0XHR9KVxyXG5cdFx0LmpvaW4oJ1xcbicpO1xyXG5cclxuXHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCI/PlxcbmAgK1xyXG5cdFx0YDwhRE9DVFlQRSBuY3ggUFVCTElDIFwiLS8vTklTTy8vRFREIG5jeCAyMDA1LTEvL0VOXCIgXCJodHRwOi8vd3d3LmRhaXN5Lm9yZy96Mzk4Ni8yMDA1L25jeC0yMDA1LTEuZHRkXCI+XFxuYCArXHJcblx0XHRgPG5jeCB4bWxucz1cImh0dHA6Ly93d3cuZGFpc3kub3JnL3ozOTg2LzIwMDUvbmN4L1wiIHZlcnNpb249XCIyMDA1LTFcIj5cXG5gICtcclxuXHRcdGA8aGVhZD5cXG5gICtcclxuXHRcdGAgIDxtZXRhIG5hbWU9XCJkdGI6dWlkXCIgY29udGVudD1cIiR7ZXNjYXBlWG1sKHV1aWQpfVwiLz5cXG5gICtcclxuXHRcdGAgIDxtZXRhIG5hbWU9XCJkdGI6ZGVwdGhcIiBjb250ZW50PVwiMVwiLz5cXG5gICtcclxuXHRcdGAgIDxtZXRhIG5hbWU9XCJkdGI6dG90YWxQYWdlQ291bnRcIiBjb250ZW50PVwiMFwiLz5cXG5gICtcclxuXHRcdGAgIDxtZXRhIG5hbWU9XCJkdGI6bWF4UGFnZU51bWJlclwiIGNvbnRlbnQ9XCIwXCIvPlxcbmAgK1xyXG5cdFx0YDwvaGVhZD5cXG5gICtcclxuXHRcdGA8ZG9jVGl0bGU+PHRleHQ+JHtlc2NhcGVYbWwoYm9va1RpdGxlKX08L3RleHQ+PC9kb2NUaXRsZT5cXG5gICtcclxuXHRcdGA8bmF2TWFwPlxcbmAgK1xyXG5cdFx0bmF2UG9pbnRzICtcclxuXHRcdGBcXG48L25hdk1hcD5cXG5gICtcclxuXHRcdGA8L25jeD5cXG5gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmZlck1lZGlhVHlwZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IGV4dCA9IHBhdGguc3BsaXQoJy4nKS5wb3AoKT8udG9Mb3dlckNhc2UoKTtcclxuXHRzd2l0Y2ggKGV4dCkge1xyXG5cdFx0Y2FzZSAneGh0bWwnOlxyXG5cdFx0Y2FzZSAnaHRtbCc6XHJcblx0XHRcdHJldHVybiAnYXBwbGljYXRpb24veGh0bWwreG1sJztcclxuXHRcdGNhc2UgJ2Nzcyc6XHJcblx0XHRcdHJldHVybiAndGV4dC9jc3MnO1xyXG5cdFx0Y2FzZSAnbmN4JzpcclxuXHRcdFx0cmV0dXJuICdhcHBsaWNhdGlvbi94LWR0Ym5jeCt4bWwnO1xyXG5cdFx0Y2FzZSAndHRmJzpcclxuXHRcdFx0cmV0dXJuICdmb250L3R0Zic7XHJcblx0XHRjYXNlICdvdGYnOlxyXG5cdFx0XHRyZXR1cm4gJ2ZvbnQvb3RmJztcclxuXHRcdGNhc2UgJ3dvZmYnOlxyXG5cdFx0XHRyZXR1cm4gJ2ZvbnQvd29mZic7XHJcblx0XHRjYXNlICd3b2ZmMic6XHJcblx0XHRcdHJldHVybiAnZm9udC93b2ZmMic7XHJcblx0XHRkZWZhdWx0OlxyXG5cdFx0XHRyZXR1cm4gJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbSc7XHJcblx0fVxyXG59XHJcblxyXG5mdW5jdGlvbiBidWlsZERlZmF1bHRDc3MoZm9udEZhbWlseTogc3RyaW5nLCBlbWJlZEZvbnRzOiBib29sZWFuLCBmb250RmlsZU5hbWVzPzogUGFydGlhbDxSZWNvcmQ8a2V5b2YgRXhwb3J0Rm9udEZpbGVzLCBzdHJpbmc+Pik6IHN0cmluZyB7XHJcblx0Y29uc3QgYmFzZSA9IFtcclxuXHRcdGBodG1sLCBib2R5IHsgbWFyZ2luOiAwOyBwYWRkaW5nOiAwOyB9YCxcclxuXHRcdGBib2R5IHsgZm9udC1mYW1pbHk6ICR7Zm9udEZhbWlseX07IGZvbnQtc2l6ZTogMWVtOyBsaW5lLWhlaWdodDogMS41NTsgcGFkZGluZzogMCAwLjhlbTsgfWAsXHJcblx0XHRgaDEsIGgyLCBoMyB7IGZvbnQtZmFtaWx5OiAke2ZvbnRGYW1pbHl9OyBsaW5lLWhlaWdodDogMS4yOyB9YCxcclxuXHRcdGBoMSB7IGZvbnQtc2l6ZTogMS42ZW07IG1hcmdpbjogMS4xZW0gMCAwLjZlbTsgfWAsXHJcblx0XHRgcCB7IG1hcmdpbjogMC45ZW0gMDsgfWAsXHJcblx0XHRgLmNoYXB0ZXItdGl0bGUgeyBwYWdlLWJyZWFrLWJlZm9yZTogYWx3YXlzOyB9YCxcclxuXHRcdGAuZnJvbnQtbWF0dGVyIHsgcGFnZS1icmVhay1iZWZvcmU6IGFsd2F5czsgfWAsXHJcblx0XHRgYSB7IGNvbG9yOiBpbmhlcml0OyB9YFxyXG5cdF07XHJcblxyXG5cdGlmICghZW1iZWRGb250cyB8fCAhZm9udEZpbGVOYW1lcz8ucmVndWxhclBhdGgpIHJldHVybiBiYXNlLmpvaW4oJ1xcbicpO1xyXG5cclxuXHRjb25zdCBmYWNlczogc3RyaW5nW10gPSBbXTtcclxuXHRjb25zdCBhZGRGYWNlID0gKGtleToga2V5b2YgRXhwb3J0Rm9udEZpbGVzLCB3ZWlnaHQ6IG51bWJlciwgc3R5bGU6ICdub3JtYWwnIHwgJ2l0YWxpYycpID0+IHtcclxuXHRcdGNvbnN0IGZpbGUgPSBmb250RmlsZU5hbWVzW2tleV07XHJcblx0XHRpZiAoIWZpbGUpIHJldHVybjtcclxuXHRcdGZhY2VzLnB1c2goXHJcblx0XHRcdGBAZm9udC1mYWNlIHsgZm9udC1mYW1pbHk6IFwiQ3VzdG9tU2VyaWZcIjsgc3JjOiB1cmwoXCIuLi9Gb250cy8ke2ZpbGV9XCIpOyBmb250LXdlaWdodDogJHt3ZWlnaHR9OyBmb250LXN0eWxlOiAke3N0eWxlfTsgfWBcclxuXHRcdCk7XHJcblx0fTtcclxuXHJcblx0YWRkRmFjZSgncmVndWxhclBhdGgnLCA0MDAsICdub3JtYWwnKTtcclxuXHRhZGRGYWNlKCdib2xkUGF0aCcsIDcwMCwgJ25vcm1hbCcpO1xyXG5cdGFkZEZhY2UoJ2l0YWxpY1BhdGgnLCA0MDAsICdpdGFsaWMnKTtcclxuXHRhZGRGYWNlKCdib2xkSXRhbGljUGF0aCcsIDcwMCwgJ2l0YWxpYycpO1xyXG5cclxuXHRyZXR1cm4gWy4uLmZhY2VzLCBgYCwgLi4uYmFzZS5tYXAoKGwpID0+IGwucmVwbGFjZShmb250RmFtaWx5LCBgXCJDdXN0b21TZXJpZlwiLCBzZXJpZmApKV0uam9pbignXFxuJyk7XHJcbn1cclxuXHJcbmV4cG9ydCBjbGFzcyBFcHViRXhwb3J0U2VydmljZSB7XHJcblx0cHJpdmF0ZSByZWFkb25seSB2YXVsdDogVmF1bHQ7XHJcblx0cHJpdmF0ZSByZWFkb25seSBtZDogTWFya2Rvd25JdDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0KSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0XHR0aGlzLm1kID0gbmV3IE1hcmtkb3duSXQoe1xyXG5cdFx0XHRodG1sOiBmYWxzZSxcclxuXHRcdFx0bGlua2lmeTogdHJ1ZSxcclxuXHRcdFx0dHlwb2dyYXBoZXI6IHRydWVcclxuXHRcdH0pO1xyXG5cdH1cclxuXHJcblx0YXN5bmMgZXhwb3J0RXB1YihwYXJhbXM6IEV4cG9ydEVwdWJQYXJhbXMpOiBQcm9taXNlPHsgb3V0cHV0UGF0aDogc3RyaW5nIH0+IHtcclxuXHRcdGNvbnN0IGJvb2tUaXRsZSA9IHBhcmFtcy5ib29rVGl0bGUudHJpbSgpIHx8ICdVbnRpdGxlZCc7XHJcblx0XHRjb25zdCBhdXRob3IgPSBwYXJhbXMuYXV0aG9yLnRyaW0oKTtcclxuXHRcdGNvbnN0IGxhbmd1YWdlID0gcGFyYW1zLmxhbmd1YWdlLnRyaW0oKSB8fCAnZW4nO1xyXG5cdFx0Y29uc3Qgc3VidGl0bGUgPSAocGFyYW1zLnN1YnRpdGxlIHx8ICcnKS50cmltKCk7XHJcblxyXG5cdFx0Y29uc3QgZm9sZGVyID0gbm9ybWFsaXplRm9sZGVyKHBhcmFtcy5vdXRwdXRGb2xkZXIpO1xyXG5cdFx0Y29uc3QgZmlsZU5hbWUgPSBlbnN1cmVFcHViRXh0KHNhbml0aXplRmlsZU5hbWUocGFyYW1zLm91dHB1dEZpbGVOYW1lIHx8IGJvb2tUaXRsZSkpO1xyXG5cdFx0Y29uc3Qgb3V0cHV0UGF0aCA9IGAke2ZvbGRlcn0vJHtmaWxlTmFtZX1gLnJlcGxhY2UoL1xcXFwvZywgJy8nKTtcclxuXHJcblx0XHRhd2FpdCB0aGlzLmVuc3VyZUZvbGRlcihmb2xkZXIpO1xyXG5cclxuXHRcdGNvbnN0IHV1aWQgPSB1dWlkTGlrZSgpO1xyXG5cdFx0Y29uc3QgbW9kaWZpZWQgPSBub3dJc29VdGMoKTtcclxuXHJcblx0XHRjb25zdCB6aXAgPSBuZXcgSlNaaXAoKTtcclxuXHRcdC8vIG1pbWV0eXBlIG11c3QgYmUgZmlyc3QgYW5kIHVuY29tcHJlc3NlZFxyXG5cdFx0emlwLmZpbGUoJ21pbWV0eXBlJywgJ2FwcGxpY2F0aW9uL2VwdWIremlwJywgeyBjb21wcmVzc2lvbjogJ1NUT1JFJyB9KTtcclxuXHJcblx0XHR6aXAuZm9sZGVyKCdNRVRBLUlORicpPy5maWxlKFxyXG5cdFx0XHQnY29udGFpbmVyLnhtbCcsXHJcblx0XHRcdGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiPz5cXG5gICtcclxuXHRcdFx0XHRgPGNvbnRhaW5lciB2ZXJzaW9uPVwiMS4wXCIgeG1sbnM9XCJ1cm46b2FzaXM6bmFtZXM6dGM6b3BlbmRvY3VtZW50OnhtbG5zOmNvbnRhaW5lclwiPlxcbmAgK1xyXG5cdFx0XHRcdGAgIDxyb290ZmlsZXM+XFxuYCArXHJcblx0XHRcdFx0YCAgICA8cm9vdGZpbGUgZnVsbC1wYXRoPVwiT0VCUFMvY29udGVudC5vcGZcIiBtZWRpYS10eXBlPVwiYXBwbGljYXRpb24vb2VicHMtcGFja2FnZSt4bWxcIi8+XFxuYCArXHJcblx0XHRcdFx0YCAgPC9yb290ZmlsZXM+XFxuYCArXHJcblx0XHRcdFx0YDwvY29udGFpbmVyPlxcbmBcclxuXHRcdCk7XHJcblxyXG5cdFx0Y29uc3Qgb2VicHMgPSB6aXAuZm9sZGVyKCdPRUJQUycpO1xyXG5cdFx0aWYgKCFvZWJwcykgdGhyb3cgbmV3IEVycm9yKCdGYWlsZWQgdG8gaW5pdGlhbGl6ZSBFUFVCIGNvbnRhaW5lci4nKTtcclxuXHJcblx0XHRjb25zdCB0ZXh0Rm9sZGVyID0gb2VicHMuZm9sZGVyKCdUZXh0Jyk7XHJcblx0XHRjb25zdCBzdHlsZXNGb2xkZXIgPSBvZWJwcy5mb2xkZXIoJ1N0eWxlcycpO1xyXG5cdFx0Y29uc3QgZm9udHNGb2xkZXIgPSBvZWJwcy5mb2xkZXIoJ0ZvbnRzJyk7XHJcblx0XHRpZiAoIXRleHRGb2xkZXIgfHwgIXN0eWxlc0ZvbGRlciB8fCAhZm9udHNGb2xkZXIpIHRocm93IG5ldyBFcnJvcignRmFpbGVkIHRvIGluaXRpYWxpemUgRVBVQiBmb2xkZXJzLicpO1xyXG5cclxuXHRcdGNvbnN0IG1hbmlmZXN0OiBNYW5pZmVzdEl0ZW1bXSA9IFtdO1xyXG5cdFx0Y29uc3Qgc3BpbmU6IHN0cmluZ1tdID0gW107XHJcblxyXG5cdFx0Ly8gTmF2aWdhdGlvblxyXG5cdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAnbmF2JywgaHJlZjogJ25hdi54aHRtbCcsIG1lZGlhVHlwZTogJ2FwcGxpY2F0aW9uL3hodG1sK3htbCcsIHByb3BlcnRpZXM6ICduYXYnIH0pO1xyXG5cdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAndG9jJywgaHJlZjogJ3RvYy5uY3gnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94LWR0Ym5jeCt4bWwnIH0pO1xyXG5cclxuXHRcdC8vIFN0eWxlc1xyXG5cdFx0Y29uc3QgZm9udEZhbWlseSA9IGBcIkxpdGVyYXRhXCIsIFwiR2VvcmdpYVwiLCBzZXJpZmA7XHJcblx0XHRjb25zdCBmb250RmlsZU5hbWVzOiBQYXJ0aWFsPFJlY29yZDxrZXlvZiBFeHBvcnRGb250RmlsZXMsIHN0cmluZz4+ID0ge307XHJcblx0XHRpZiAocGFyYW1zLmVtYmVkQ3VzdG9tRm9udHMgJiYgcGFyYW1zLmN1c3RvbUZvbnRzPy5yZWd1bGFyUGF0aCkge1xyXG5cdFx0XHRmb250RmlsZU5hbWVzLnJlZ3VsYXJQYXRoID0gdGhpcy5iYXNlbmFtZShwYXJhbXMuY3VzdG9tRm9udHMucmVndWxhclBhdGgpO1xyXG5cdFx0XHRpZiAocGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRQYXRoKSBmb250RmlsZU5hbWVzLmJvbGRQYXRoID0gdGhpcy5iYXNlbmFtZShwYXJhbXMuY3VzdG9tRm9udHMuYm9sZFBhdGgpO1xyXG5cdFx0XHRpZiAocGFyYW1zLmN1c3RvbUZvbnRzLml0YWxpY1BhdGgpIGZvbnRGaWxlTmFtZXMuaXRhbGljUGF0aCA9IHRoaXMuYmFzZW5hbWUocGFyYW1zLmN1c3RvbUZvbnRzLml0YWxpY1BhdGgpO1xyXG5cdFx0XHRpZiAocGFyYW1zLmN1c3RvbUZvbnRzLmJvbGRJdGFsaWNQYXRoKSBmb250RmlsZU5hbWVzLmJvbGRJdGFsaWNQYXRoID0gdGhpcy5iYXNlbmFtZShwYXJhbXMuY3VzdG9tRm9udHMuYm9sZEl0YWxpY1BhdGgpO1xyXG5cdFx0fVxyXG5cdFx0Y29uc3QgY3NzID0gYnVpbGREZWZhdWx0Q3NzKGZvbnRGYW1pbHksIHBhcmFtcy5lbWJlZEN1c3RvbUZvbnRzLCBmb250RmlsZU5hbWVzKTtcclxuXHRcdHN0eWxlc0ZvbGRlci5maWxlKCdzdHlsZS5jc3MnLCBjc3MpO1xyXG5cdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAnY3NzJywgaHJlZjogJ1N0eWxlcy9zdHlsZS5jc3MnLCBtZWRpYVR5cGU6ICd0ZXh0L2NzcycgfSk7XHJcblxyXG5cdFx0Ly8gRnJvbnQgbWF0dGVyIHBhZ2VzXHJcblx0XHRpZiAocGFyYW1zLmluY2x1ZGVUaXRsZVBhZ2UpIHtcclxuXHRcdFx0Y29uc3QgaW5uZXIgPVxyXG5cdFx0XHRcdGA8c2VjdGlvbiBjbGFzcz1cImZyb250LW1hdHRlclwiPlxcbmAgK1xyXG5cdFx0XHRcdGA8aDE+JHtlc2NhcGVYbWwoYm9va1RpdGxlKX08L2gxPlxcbmAgK1xyXG5cdFx0XHRcdChzdWJ0aXRsZSA/IGA8aDI+JHtlc2NhcGVYbWwoc3VidGl0bGUpfTwvaDI+XFxuYCA6ICcnKSArXHJcblx0XHRcdFx0KGF1dGhvciA/IGA8cD4ke2VzY2FwZVhtbChhdXRob3IpfTwvcD5cXG5gIDogJycpICtcclxuXHRcdFx0XHRgPC9zZWN0aW9uPmA7XHJcblx0XHRcdGNvbnN0IHhodG1sID0geGh0bWxEb2N1bWVudCgnVGl0bGUnLCBpbm5lcik7XHJcblx0XHRcdHRleHRGb2xkZXIuZmlsZSgndGl0bGUueGh0bWwnLCB4aHRtbCk7XHJcblx0XHRcdG1hbmlmZXN0LnB1c2goeyBpZDogJ3RpdGxlJywgaHJlZjogJ1RleHQvdGl0bGUueGh0bWwnLCBtZWRpYVR5cGU6ICdhcHBsaWNhdGlvbi94aHRtbCt4bWwnIH0pO1xyXG5cdFx0XHRzcGluZS5wdXNoKCd0aXRsZScpO1xyXG5cdFx0fVxyXG5cclxuXHRcdGlmIChwYXJhbXMuaW5jbHVkZUNvcHlyaWdodFBhZ2UpIHtcclxuXHRcdFx0Y29uc3QgdGVtcGxhdGUgPSBnZXRMaWNlbnNlVGVtcGxhdGUocGFyYW1zLmxpY2Vuc2VUZW1wbGF0ZUlkKTtcclxuXHRcdFx0Y29uc3QgeGh0bWwgPSB0ZW1wbGF0ZS5yZW5kZXJYaHRtbCh7XHJcblx0XHRcdFx0dGl0bGU6IGJvb2tUaXRsZSxcclxuXHRcdFx0XHRhdXRob3IsXHJcblx0XHRcdFx0eWVhcjogcGFyYW1zLmNvcHlyaWdodFllYXIgfHwgJycsXHJcblx0XHRcdFx0aG9sZGVyOiBwYXJhbXMuY29weXJpZ2h0SG9sZGVyIHx8ICcnXHJcblx0XHRcdH0pO1xyXG5cdFx0XHR0ZXh0Rm9sZGVyLmZpbGUoJ2NvcHlyaWdodC54aHRtbCcsIHhodG1sKTtcclxuXHRcdFx0bWFuaWZlc3QucHVzaCh7IGlkOiAnY29weXJpZ2h0JywgaHJlZjogJ1RleHQvY29weXJpZ2h0LnhodG1sJywgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24veGh0bWwreG1sJyB9KTtcclxuXHRcdFx0c3BpbmUucHVzaCgnY29weXJpZ2h0Jyk7XHJcblx0XHR9XHJcblxyXG5cdFx0Ly8gQ2hhcHRlcnNcclxuXHRcdGNvbnN0IG5hdkNoYXB0ZXJzOiBBcnJheTx7IHRpdGxlOiBzdHJpbmc7IGhyZWY6IHN0cmluZyB9PiA9IFtdO1xyXG5cdFx0Zm9yIChsZXQgaSA9IDA7IGkgPCBwYXJhbXMuY2hhcHRlcnMubGVuZ3RoOyBpKyspIHtcclxuXHRcdFx0Y29uc3QgY2ggPSBwYXJhbXMuY2hhcHRlcnNbaV07XHJcblx0XHRcdGNvbnN0IGh0bWwgPSB0aGlzLm1kLnJlbmRlcihjaC5tYXJrZG93biB8fCAnJyk7XHJcblx0XHRcdGNvbnN0IGlubmVyID1cclxuXHRcdFx0XHRgPHNlY3Rpb24gY2xhc3M9XCJjaGFwdGVyXCI+XFxuYCArXHJcblx0XHRcdFx0YDxoMSBjbGFzcz1cImNoYXB0ZXItdGl0bGVcIj4ke2VzY2FwZVhtbChjaC50aXRsZSB8fCBgQ2hhcHRlciAke2kgKyAxfWApfTwvaDE+XFxuYCArXHJcblx0XHRcdFx0aHRtbCArXHJcblx0XHRcdFx0YFxcbjwvc2VjdGlvbj5gO1xyXG5cdFx0XHRjb25zdCB4aHRtbCA9IHhodG1sRG9jdW1lbnQoY2gudGl0bGUgfHwgYENoYXB0ZXIgJHtpICsgMX1gLCBpbm5lcik7XHJcblx0XHRcdGNvbnN0IGZpbGUgPSBgY2hhcHRlci0ke1N0cmluZyhpICsgMSkucGFkU3RhcnQoMywgJzAnKX0ueGh0bWxgO1xyXG5cdFx0XHR0ZXh0Rm9sZGVyLmZpbGUoZmlsZSwgeGh0bWwpO1xyXG5cdFx0XHRjb25zdCBpZCA9IGBjaCR7aSArIDF9YDtcclxuXHRcdFx0bWFuaWZlc3QucHVzaCh7IGlkLCBocmVmOiBgVGV4dC8ke2ZpbGV9YCwgbWVkaWFUeXBlOiAnYXBwbGljYXRpb24veGh0bWwreG1sJyB9KTtcclxuXHRcdFx0c3BpbmUucHVzaChpZCk7XHJcblx0XHRcdG5hdkNoYXB0ZXJzLnB1c2goeyB0aXRsZTogY2gudGl0bGUgfHwgYENoYXB0ZXIgJHtpICsgMX1gLCBocmVmOiBgVGV4dC8ke2ZpbGV9YCB9KTtcclxuXHRcdH1cclxuXHJcblx0XHQvLyBuYXYueGh0bWwgKyB0b2MubmN4XHJcblx0XHRvZWJwcy5maWxlKCduYXYueGh0bWwnLCBidWlsZE5hdlhodG1sKG5hdkNoYXB0ZXJzLCBib29rVGl0bGUpKTtcclxuXHRcdG9lYnBzLmZpbGUoJ3RvYy5uY3gnLCBidWlsZFRvY05jeCh1dWlkLCBuYXZDaGFwdGVycywgYm9va1RpdGxlKSk7XHJcblxyXG5cdFx0Ly8gRm9udHNcclxuXHRcdGlmIChwYXJhbXMuZW1iZWRDdXN0b21Gb250cyAmJiBwYXJhbXMuY3VzdG9tRm9udHM/LnJlZ3VsYXJQYXRoKSB7XHJcblx0XHRcdGNvbnN0IGZvbnRQYXRoczogQXJyYXk8W2tleW9mIEV4cG9ydEZvbnRGaWxlcywgc3RyaW5nIHwgdW5kZWZpbmVkXT4gPSBbXHJcblx0XHRcdFx0WydyZWd1bGFyUGF0aCcsIHBhcmFtcy5jdXN0b21Gb250cy5yZWd1bGFyUGF0aF0sXHJcblx0XHRcdFx0Wydib2xkUGF0aCcsIHBhcmFtcy5jdXN0b21Gb250cy5ib2xkUGF0aF0sXHJcblx0XHRcdFx0WydpdGFsaWNQYXRoJywgcGFyYW1zLmN1c3RvbUZvbnRzLml0YWxpY1BhdGhdLFxyXG5cdFx0XHRcdFsnYm9sZEl0YWxpY1BhdGgnLCBwYXJhbXMuY3VzdG9tRm9udHMuYm9sZEl0YWxpY1BhdGhdXHJcblx0XHRcdF07XHJcblxyXG5cdFx0XHRmb3IgKGNvbnN0IFssIHBdIG9mIGZvbnRQYXRocykge1xyXG5cdFx0XHRcdGlmICghcCkgY29udGludWU7XHJcblx0XHRcdFx0Y29uc3QgZGF0YSA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5yZWFkQmluYXJ5KHApO1xyXG5cdFx0XHRcdGNvbnN0IG5hbWUgPSB0aGlzLmJhc2VuYW1lKHApO1xyXG5cdFx0XHRcdGZvbnRzRm9sZGVyLmZpbGUobmFtZSwgZGF0YSk7XHJcblx0XHRcdFx0bWFuaWZlc3QucHVzaCh7IGlkOiBgZm9udC0ke3Nhbml0aXplRmlsZU5hbWUobmFtZSl9YCwgaHJlZjogYEZvbnRzLyR7bmFtZX1gLCBtZWRpYVR5cGU6IGluZmVyTWVkaWFUeXBlKG5hbWUpIH0pO1xyXG5cdFx0XHR9XHJcblx0XHR9XHJcblxyXG5cdFx0Y29uc3Qgb3BmID0gdGhpcy5idWlsZE9wZih7XHJcblx0XHRcdHV1aWQsXHJcblx0XHRcdHRpdGxlOiBib29rVGl0bGUsXHJcblx0XHRcdGF1dGhvcixcclxuXHRcdFx0bGFuZ3VhZ2UsXHJcblx0XHRcdG1vZGlmaWVkLFxyXG5cdFx0XHRtYW5pZmVzdCxcclxuXHRcdFx0c3BpbmVcclxuXHRcdH0pO1xyXG5cdFx0b2VicHMuZmlsZSgnY29udGVudC5vcGYnLCBvcGYpO1xyXG5cclxuXHRcdGNvbnN0IGJ5dGVzID0gYXdhaXQgemlwLmdlbmVyYXRlQXN5bmMoe1xyXG5cdFx0XHR0eXBlOiAndWludDhhcnJheScsXHJcblx0XHRcdGNvbXByZXNzaW9uOiAnREVGTEFURScsXHJcblx0XHRcdGNvbXByZXNzaW9uT3B0aW9uczogeyBsZXZlbDogOSB9XHJcblx0XHR9KTtcclxuXHJcblx0XHRjb25zdCBvdXQgPSB0aGlzLnRvQXJyYXlCdWZmZXIoYnl0ZXMpO1xyXG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLndyaXRlQmluYXJ5KG91dHB1dFBhdGgsIG91dCk7XHJcblx0XHRyZXR1cm4geyBvdXRwdXRQYXRoIH07XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIGJ1aWxkT3BmKHBhcmFtczoge1xyXG5cdFx0dXVpZDogc3RyaW5nO1xyXG5cdFx0dGl0bGU6IHN0cmluZztcclxuXHRcdGF1dGhvcjogc3RyaW5nO1xyXG5cdFx0bGFuZ3VhZ2U6IHN0cmluZztcclxuXHRcdG1vZGlmaWVkOiBzdHJpbmc7XHJcblx0XHRtYW5pZmVzdDogTWFuaWZlc3RJdGVtW107XHJcblx0XHRzcGluZTogc3RyaW5nW107XHJcblx0fSk6IHN0cmluZyB7XHJcblx0XHRjb25zdCBtYW5pZmVzdFhtbCA9IHBhcmFtcy5tYW5pZmVzdFxyXG5cdFx0XHQubWFwKChtKSA9PiB7XHJcblx0XHRcdFx0Y29uc3QgcHJvcHMgPSBtLnByb3BlcnRpZXMgPyBgIHByb3BlcnRpZXM9XCIke2VzY2FwZVhtbChtLnByb3BlcnRpZXMpfVwiYCA6ICcnO1xyXG5cdFx0XHRcdHJldHVybiBgPGl0ZW0gaWQ9XCIke2VzY2FwZVhtbChtLmlkKX1cIiBocmVmPVwiJHtlc2NhcGVYbWwobS5ocmVmKX1cIiBtZWRpYS10eXBlPVwiJHtlc2NhcGVYbWwobS5tZWRpYVR5cGUpfVwiJHtwcm9wc30vPmA7XHJcblx0XHRcdH0pXHJcblx0XHRcdC5qb2luKCdcXG4gICAgJyk7XHJcblxyXG5cdFx0Y29uc3Qgc3BpbmVYbWwgPSBwYXJhbXMuc3BpbmUubWFwKChpZHJlZikgPT4gYDxpdGVtcmVmIGlkcmVmPVwiJHtlc2NhcGVYbWwoaWRyZWYpfVwiLz5gKS5qb2luKCdcXG4gICAgJyk7XHJcblxyXG5cdFx0cmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJ1dGYtOFwiPz5cXG5gICtcclxuXHRcdFx0YDxwYWNrYWdlIHhtbG5zPVwiaHR0cDovL3d3dy5pZHBmLm9yZy8yMDA3L29wZlwiIHZlcnNpb249XCIzLjBcIiB1bmlxdWUtaWRlbnRpZmllcj1cInB1Yi1pZFwiPlxcbmAgK1xyXG5cdFx0XHRgICA8bWV0YWRhdGEgeG1sbnM6ZGM9XCJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xL1wiPlxcbmAgK1xyXG5cdFx0XHRgICAgIDxkYzppZGVudGlmaWVyIGlkPVwicHViLWlkXCI+dXJuOnV1aWQ6JHtlc2NhcGVYbWwocGFyYW1zLnV1aWQpfTwvZGM6aWRlbnRpZmllcj5cXG5gICtcclxuXHRcdFx0YCAgICA8ZGM6dGl0bGU+JHtlc2NhcGVYbWwocGFyYW1zLnRpdGxlKX08L2RjOnRpdGxlPlxcbmAgK1xyXG5cdFx0XHQocGFyYW1zLmF1dGhvciA/IGAgICAgPGRjOmNyZWF0b3I+JHtlc2NhcGVYbWwocGFyYW1zLmF1dGhvcil9PC9kYzpjcmVhdG9yPlxcbmAgOiAnJykgK1xyXG5cdFx0XHRgICAgIDxkYzpsYW5ndWFnZT4ke2VzY2FwZVhtbChwYXJhbXMubGFuZ3VhZ2UpfTwvZGM6bGFuZ3VhZ2U+XFxuYCArXHJcblx0XHRcdGAgICAgPG1ldGEgcHJvcGVydHk9XCJkY3Rlcm1zOm1vZGlmaWVkXCI+JHtlc2NhcGVYbWwocGFyYW1zLm1vZGlmaWVkKX08L21ldGE+XFxuYCArXHJcblx0XHRcdGAgIDwvbWV0YWRhdGE+XFxuYCArXHJcblx0XHRcdGAgIDxtYW5pZmVzdD5cXG5gICtcclxuXHRcdFx0YCAgICAke21hbmlmZXN0WG1sfVxcbmAgK1xyXG5cdFx0XHRgICA8L21hbmlmZXN0PlxcbmAgK1xyXG5cdFx0XHRgICA8c3BpbmUgdG9jPVwidG9jXCI+XFxuYCArXHJcblx0XHRcdGAgICAgJHtzcGluZVhtbH1cXG5gICtcclxuXHRcdFx0YCAgPC9zcGluZT5cXG5gICtcclxuXHRcdFx0YDwvcGFja2FnZT5cXG5gO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBiYXNlbmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdFx0Y29uc3Qgbm9ybWFsaXplZCA9IHBhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xyXG5cdFx0cmV0dXJuIG5vcm1hbGl6ZWQuc3BsaXQoJy8nKS5wb3AoKSB8fCBub3JtYWxpemVkO1xyXG5cdH1cclxuXHJcblx0cHJpdmF0ZSBhc3luYyBlbnN1cmVGb2xkZXIoZm9sZGVyOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcclxuXHRcdGNvbnN0IHBhcnRzID0gbm9ybWFsaXplRm9sZGVyKGZvbGRlcikuc3BsaXQoJy8nKTtcclxuXHRcdGxldCBjdXJyZW50ID0gJyc7XHJcblx0XHRmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcclxuXHRcdFx0Y3VycmVudCA9IGN1cnJlbnQgPyBgJHtjdXJyZW50fS8ke3BhcnR9YCA6IHBhcnQ7XHJcblx0XHRcdGNvbnN0IGV4aXN0cyA9IGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci5leGlzdHMoY3VycmVudCk7XHJcblx0XHRcdGlmICghZXhpc3RzKSBhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoY3VycmVudCk7XHJcblx0XHR9XHJcblx0fVxyXG5cclxuXHRwcml2YXRlIHRvQXJyYXlCdWZmZXIoYnl0ZXM6IFVpbnQ4QXJyYXkpOiBBcnJheUJ1ZmZlciB7XHJcblx0XHQvLyBTb21lIFRTIGxpYiBkZWZzIHJlcHJlc2VudCBVaW50OEFycmF5LmJ1ZmZlciBhcyBBcnJheUJ1ZmZlckxpa2U7IG5vcm1hbGl6ZSB0byBBcnJheUJ1ZmZlciBmb3IgT2JzaWRpYW4gYWRhcHRlci5cclxuXHRcdGNvbnN0IG91dCA9IG5ldyBBcnJheUJ1ZmZlcihieXRlcy5ieXRlTGVuZ3RoKTtcclxuXHRcdG5ldyBVaW50OEFycmF5KG91dCkuc2V0KGJ5dGVzKTtcclxuXHRcdHJldHVybiBvdXQ7XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19