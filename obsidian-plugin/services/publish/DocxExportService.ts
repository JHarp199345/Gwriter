import type { Vault } from 'obsidian';
import JSZip from 'jszip';
import { markdownToPlainText } from './ExportTextUtils';

export interface ExportDocxParams {
	title: string;
	author: string;
	chapters: Array<{ title: string; markdown: string; sourcePath: string }>;
	outputFolder: string;
	outputFileName: string; // should end with .docx
}

function escapeXml(value: string): string {
	return (value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function normalizeFolder(folder: string): string {
	const f = folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	return f.length ? f : 'Exports';
}

function ensureDocxExt(name: string): string {
	return name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
}

function wPara(text: string, opts?: { heading?: boolean; center?: boolean }): string {
	const runs = escapeXml(text || '')
		.split(/\r?\n/)
		.map((line) => {
			const t = line || '';
			return `<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`;
		})
		.join('');

	const pPr: string[] = [];
	if (opts?.heading) pPr.push('<w:pStyle w:val="Heading1"/>');
	if (opts?.center) pPr.push('<w:jc w:val="center"/>');
	const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
	return `<w:p>${pPrXml}${runs}</w:p>`;
}

function wBlankPara(): string {
	return '<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>';
}

export class DocxExportService {
	private readonly vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async export(params: ExportDocxParams): Promise<string> {
		const folder = normalizeFolder(params.outputFolder);
		const fileName = ensureDocxExt(params.outputFileName);
		const outPath = `${folder}/${fileName}`.replace(/\/+/g, '/');

		const zip = new JSZip();

		// Minimal required parts for Word to open.
		zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

		zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

		const coreTitle = escapeXml(params.title || 'Untitled');
		const coreCreator = escapeXml(params.author || '');
		zip.folder('docProps')?.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${coreTitle}</dc:title>
  ${coreCreator ? `<dc:creator>${coreCreator}</dc:creator>` : ''}
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);

		zip.folder('docProps')?.file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Gwriter</Application>
</Properties>`);

		zip.folder('word')?.file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="9"/>
    <w:qFormat/>
    <w:pPr><w:keepNext/><w:keepLines/></w:pPr>
  </w:style>
</w:styles>`);

		const bodyParts: string[] = [];
		bodyParts.push(wPara(params.title || 'Untitled', { center: true, heading: true }));
		if (params.author) bodyParts.push(wPara(params.author, { center: true }));
		bodyParts.push(wBlankPara());

		for (const ch of params.chapters) {
			bodyParts.push(wPara(ch.title || 'Chapter', { heading: true }));
			bodyParts.push(wBlankPara());
			const plain = markdownToPlainText(ch.markdown || '');
			for (const p of plain.split(/\n{2,}/g)) {
				const trimmed = p.trim();
				if (!trimmed) continue;
				bodyParts.push(wPara(trimmed));
				bodyParts.push(wBlankPara());
			}
		}

		const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParts.join('\n')}
    <w:sectPr/>
  </w:body>
</w:document>`;
		zip.folder('word')?.file('document.xml', documentXml);

		const ab = await zip.generateAsync({ type: 'arraybuffer' });
		await this.vault.adapter.mkdir(folder).catch(() => {});
		await this.vault.adapter.writeBinary(outPath, ab as ArrayBuffer);
		return outPath;
	}
}


