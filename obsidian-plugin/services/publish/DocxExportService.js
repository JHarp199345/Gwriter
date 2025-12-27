import JSZip from 'jszip';
import { markdownToPlainText } from './ExportTextUtils';
function escapeXml(value) {
    return (value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function normalizeFolder(folder) {
    const f = folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return f.length ? f : 'Exports';
}
function ensureDocxExt(name) {
    return name.toLowerCase().endsWith('.docx') ? name : `${name}.docx`;
}
function wPara(text, opts) {
    const runs = escapeXml(text || '')
        .split(/\r?\n/)
        .map((line) => {
        const t = line || '';
        return `<w:r><w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r>`;
    })
        .join('');
    const pPr = [];
    if (opts?.heading)
        pPr.push('<w:pStyle w:val="Heading1"/>');
    if (opts?.center)
        pPr.push('<w:jc w:val="center"/>');
    const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
    return `<w:p>${pPrXml}${runs}</w:p>`;
}
function wBlankPara() {
    return '<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>';
}
export class DocxExportService {
    constructor(vault) {
        this.vault = vault;
    }
    async export(params) {
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
        const bodyParts = [];
        bodyParts.push(wPara(params.title || 'Untitled', { center: true, heading: true }));
        if (params.author)
            bodyParts.push(wPara(params.author, { center: true }));
        bodyParts.push(wBlankPara());
        for (const ch of params.chapters) {
            bodyParts.push(wPara(ch.title || 'Chapter', { heading: true }));
            bodyParts.push(wBlankPara());
            const plain = markdownToPlainText(ch.markdown || '');
            for (const p of plain.split(/\n{2,}/g)) {
                const trimmed = p.trim();
                if (!trimmed)
                    continue;
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
        await this.vault.adapter.mkdir(folder).catch(() => { });
        await this.vault.adapter.writeBinary(outPath, ab);
        return outPath;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRG9jeEV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEb2N4RXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFVeEQsU0FBUyxTQUFTLENBQUMsS0FBYTtJQUMvQixPQUFPLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztTQUNsQixPQUFPLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztTQUN0QixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQztTQUN2QixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFjO0lBQ3RDLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztJQUM3RSxPQUFPLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxJQUFZO0lBQ2xDLE9BQU8sSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksT0FBTyxDQUFDO0FBQ3JFLENBQUM7QUFFRCxTQUFTLEtBQUssQ0FBQyxJQUFZLEVBQUUsSUFBOEM7SUFDMUUsTUFBTSxJQUFJLEdBQUcsU0FBUyxDQUFDLElBQUksSUFBSSxFQUFFLENBQUM7U0FDaEMsS0FBSyxDQUFDLE9BQU8sQ0FBQztTQUNkLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFO1FBQ2IsTUFBTSxDQUFDLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztRQUNyQixPQUFPLGtDQUFrQyxTQUFTLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQztJQUNyRSxDQUFDLENBQUM7U0FDRCxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFFWCxNQUFNLEdBQUcsR0FBYSxFQUFFLENBQUM7SUFDekIsSUFBSSxJQUFJLEVBQUUsT0FBTztRQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsOEJBQThCLENBQUMsQ0FBQztJQUM1RCxJQUFJLElBQUksRUFBRSxNQUFNO1FBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQ3JELE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFVBQVUsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDbEUsT0FBTyxRQUFRLE1BQU0sR0FBRyxJQUFJLFFBQVEsQ0FBQztBQUN0QyxDQUFDO0FBRUQsU0FBUyxVQUFVO0lBQ2xCLE9BQU8seURBQXlELENBQUM7QUFDbEUsQ0FBQztBQUVELE1BQU0sT0FBTyxpQkFBaUI7SUFHN0IsWUFBWSxLQUFZO1FBQ3ZCLElBQUksQ0FBQyxLQUFLLEdBQUcsS0FBSyxDQUFDO0lBQ3BCLENBQUM7SUFFRCxLQUFLLENBQUMsTUFBTSxDQUFDLE1BQXdCO1FBQ3BDLE1BQU0sTUFBTSxHQUFHLGVBQWUsQ0FBQyxNQUFNLENBQUMsWUFBWSxDQUFDLENBQUM7UUFDcEQsTUFBTSxRQUFRLEdBQUcsYUFBYSxDQUFDLE1BQU0sQ0FBQyxjQUFjLENBQUMsQ0FBQztRQUN0RCxNQUFNLE9BQU8sR0FBRyxHQUFHLE1BQU0sSUFBSSxRQUFRLEVBQUUsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBRTdELE1BQU0sR0FBRyxHQUFHLElBQUksS0FBSyxFQUFFLENBQUM7UUFFeEIsMkNBQTJDO1FBQzNDLEdBQUcsQ0FBQyxJQUFJLENBQUMscUJBQXFCLEVBQUU7Ozs7Ozs7O1NBUXpCLENBQUMsQ0FBQztRQUVULEdBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDLEVBQUUsSUFBSSxDQUFDLE9BQU8sRUFBRTs7Ozs7aUJBS3BCLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLEtBQUssSUFBSSxVQUFVLENBQUMsQ0FBQztRQUN4RCxNQUFNLFdBQVcsR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUMsQ0FBQztRQUNuRCxHQUFHLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxFQUFFLElBQUksQ0FBQyxVQUFVLEVBQUU7Ozs7OztjQU03QixTQUFTO0lBQ25CLFdBQVcsQ0FBQyxDQUFDLENBQUMsZUFBZSxXQUFXLGVBQWUsQ0FBQyxDQUFDLENBQUMsRUFBRTsrQ0FDakIsSUFBSSxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUU7cUJBQ2xELENBQUMsQ0FBQztRQUVyQixHQUFHLENBQUMsTUFBTSxDQUFDLFVBQVUsQ0FBQyxFQUFFLElBQUksQ0FBQyxTQUFTLEVBQUU7Ozs7Y0FJNUIsQ0FBQyxDQUFDO1FBRWQsR0FBRyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsWUFBWSxFQUFFOzs7Ozs7Ozs7Ozs7WUFZN0IsQ0FBQyxDQUFDO1FBRVosTUFBTSxTQUFTLEdBQWEsRUFBRSxDQUFDO1FBQy9CLFNBQVMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLElBQUksVUFBVSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ25GLElBQUksTUFBTSxDQUFDLE1BQU07WUFBRSxTQUFTLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsTUFBTSxFQUFFLEVBQUUsTUFBTSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztRQUMxRSxTQUFTLENBQUMsSUFBSSxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFFN0IsS0FBSyxNQUFNLEVBQUUsSUFBSSxNQUFNLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDbEMsU0FBUyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssSUFBSSxTQUFTLEVBQUUsRUFBRSxPQUFPLEVBQUUsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1lBQ2hFLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztZQUM3QixNQUFNLEtBQUssR0FBRyxtQkFBbUIsQ0FBQyxFQUFFLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ3JELEtBQUssTUFBTSxDQUFDLElBQUksS0FBSyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO2dCQUN4QyxNQUFNLE9BQU8sR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7Z0JBQ3pCLElBQUksQ0FBQyxPQUFPO29CQUFFLFNBQVM7Z0JBQ3ZCLFNBQVMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7Z0JBQy9CLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUMsQ0FBQztZQUM5QixDQUFDO1FBQ0YsQ0FBQztRQUVELE1BQU0sV0FBVyxHQUFHOzs7TUFHaEIsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUM7OztjQUdaLENBQUM7UUFDYixHQUFHLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLElBQUksQ0FBQyxjQUFjLEVBQUUsV0FBVyxDQUFDLENBQUM7UUFFdEQsTUFBTSxFQUFFLEdBQUcsTUFBTSxHQUFHLENBQUMsYUFBYSxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsRUFBRSxDQUFDLENBQUM7UUFDNUQsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxHQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3ZELE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxFQUFpQixDQUFDLENBQUM7UUFDakUsT0FBTyxPQUFPLENBQUM7SUFDaEIsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcclxuaW1wb3J0IEpTWmlwIGZyb20gJ2pzemlwJztcclxuaW1wb3J0IHsgbWFya2Rvd25Ub1BsYWluVGV4dCB9IGZyb20gJy4vRXhwb3J0VGV4dFV0aWxzJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXhwb3J0RG9jeFBhcmFtcyB7XHJcblx0dGl0bGU6IHN0cmluZztcclxuXHRhdXRob3I6IHN0cmluZztcclxuXHRjaGFwdGVyczogQXJyYXk8eyB0aXRsZTogc3RyaW5nOyBtYXJrZG93bjogc3RyaW5nOyBzb3VyY2VQYXRoOiBzdHJpbmcgfT47XHJcblx0b3V0cHV0Rm9sZGVyOiBzdHJpbmc7XHJcblx0b3V0cHV0RmlsZU5hbWU6IHN0cmluZzsgLy8gc2hvdWxkIGVuZCB3aXRoIC5kb2N4XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVzY2FwZVhtbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gKHZhbHVlIHx8ICcnKVxyXG5cdFx0LnJlcGxhY2UoLyYvZywgJyZhbXA7JylcclxuXHRcdC5yZXBsYWNlKC88L2csICcmbHQ7JylcclxuXHRcdC5yZXBsYWNlKC8+L2csICcmZ3Q7JylcclxuXHRcdC5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JylcclxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbm9ybWFsaXplRm9sZGVyKGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCBmID0gZm9sZGVyLnJlcGxhY2UoL1xcXFwvZywgJy8nKS5yZXBsYWNlKC9eXFwvKy8sICcnKS5yZXBsYWNlKC9cXC8rJC8sICcnKTtcclxuXHRyZXR1cm4gZi5sZW5ndGggPyBmIDogJ0V4cG9ydHMnO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVEb2N4RXh0KG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0cmV0dXJuIG5hbWUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCgnLmRvY3gnKSA/IG5hbWUgOiBgJHtuYW1lfS5kb2N4YDtcclxufVxyXG5cclxuZnVuY3Rpb24gd1BhcmEodGV4dDogc3RyaW5nLCBvcHRzPzogeyBoZWFkaW5nPzogYm9vbGVhbjsgY2VudGVyPzogYm9vbGVhbiB9KTogc3RyaW5nIHtcclxuXHRjb25zdCBydW5zID0gZXNjYXBlWG1sKHRleHQgfHwgJycpXHJcblx0XHQuc3BsaXQoL1xccj9cXG4vKVxyXG5cdFx0Lm1hcCgobGluZSkgPT4ge1xyXG5cdFx0XHRjb25zdCB0ID0gbGluZSB8fCAnJztcclxuXHRcdFx0cmV0dXJuIGA8dzpyPjx3OnQgeG1sOnNwYWNlPVwicHJlc2VydmVcIj4ke2VzY2FwZVhtbCh0KX08L3c6dD48L3c6cj5gO1xyXG5cdFx0fSlcclxuXHRcdC5qb2luKCcnKTtcclxuXHJcblx0Y29uc3QgcFByOiBzdHJpbmdbXSA9IFtdO1xyXG5cdGlmIChvcHRzPy5oZWFkaW5nKSBwUHIucHVzaCgnPHc6cFN0eWxlIHc6dmFsPVwiSGVhZGluZzFcIi8+Jyk7XHJcblx0aWYgKG9wdHM/LmNlbnRlcikgcFByLnB1c2goJzx3OmpjIHc6dmFsPVwiY2VudGVyXCIvPicpO1xyXG5cdGNvbnN0IHBQclhtbCA9IHBQci5sZW5ndGggPyBgPHc6cFByPiR7cFByLmpvaW4oJycpfTwvdzpwUHI+YCA6ICcnO1xyXG5cdHJldHVybiBgPHc6cD4ke3BQclhtbH0ke3J1bnN9PC93OnA+YDtcclxufVxyXG5cclxuZnVuY3Rpb24gd0JsYW5rUGFyYSgpOiBzdHJpbmcge1xyXG5cdHJldHVybiAnPHc6cD48dzpyPjx3OnQgeG1sOnNwYWNlPVwicHJlc2VydmVcIj4gPC93OnQ+PC93OnI+PC93OnA+JztcclxufVxyXG5cclxuZXhwb3J0IGNsYXNzIERvY3hFeHBvcnRTZXJ2aWNlIHtcclxuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcclxuXHJcblx0Y29uc3RydWN0b3IodmF1bHQ6IFZhdWx0KSB7XHJcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XHJcblx0fVxyXG5cclxuXHRhc3luYyBleHBvcnQocGFyYW1zOiBFeHBvcnREb2N4UGFyYW1zKTogUHJvbWlzZTxzdHJpbmc+IHtcclxuXHRcdGNvbnN0IGZvbGRlciA9IG5vcm1hbGl6ZUZvbGRlcihwYXJhbXMub3V0cHV0Rm9sZGVyKTtcclxuXHRcdGNvbnN0IGZpbGVOYW1lID0gZW5zdXJlRG9jeEV4dChwYXJhbXMub3V0cHV0RmlsZU5hbWUpO1xyXG5cdFx0Y29uc3Qgb3V0UGF0aCA9IGAke2ZvbGRlcn0vJHtmaWxlTmFtZX1gLnJlcGxhY2UoL1xcLysvZywgJy8nKTtcclxuXHJcblx0XHRjb25zdCB6aXAgPSBuZXcgSlNaaXAoKTtcclxuXHJcblx0XHQvLyBNaW5pbWFsIHJlcXVpcmVkIHBhcnRzIGZvciBXb3JkIHRvIG9wZW4uXHJcblx0XHR6aXAuZmlsZSgnW0NvbnRlbnRfVHlwZXNdLnhtbCcsIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiIHN0YW5kYWxvbmU9XCJ5ZXNcIj8+XHJcbjxUeXBlcyB4bWxucz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlc1wiPlxyXG4gIDxEZWZhdWx0IEV4dGVuc2lvbj1cInJlbHNcIiBDb250ZW50VHlwZT1cImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sXCIvPlxyXG4gIDxEZWZhdWx0IEV4dGVuc2lvbj1cInhtbFwiIENvbnRlbnRUeXBlPVwiYXBwbGljYXRpb24veG1sXCIvPlxyXG4gIDxPdmVycmlkZSBQYXJ0TmFtZT1cIi93b3JkL2RvY3VtZW50LnhtbFwiIENvbnRlbnRUeXBlPVwiYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWxcIi8+XHJcbiAgPE92ZXJyaWRlIFBhcnROYW1lPVwiL3dvcmQvc3R5bGVzLnhtbFwiIENvbnRlbnRUeXBlPVwiYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuc3R5bGVzK3htbFwiLz5cclxuICA8T3ZlcnJpZGUgUGFydE5hbWU9XCIvZG9jUHJvcHMvY29yZS54bWxcIiBDb250ZW50VHlwZT1cImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLmNvcmUtcHJvcGVydGllcyt4bWxcIi8+XHJcbiAgPE92ZXJyaWRlIFBhcnROYW1lPVwiL2RvY1Byb3BzL2FwcC54bWxcIiBDb250ZW50VHlwZT1cImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbFwiLz5cclxuPC9UeXBlcz5gKTtcclxuXHJcblx0XHR6aXAuZm9sZGVyKCdfcmVscycpPy5maWxlKCcucmVscycsIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiIHN0YW5kYWxvbmU9XCJ5ZXNcIj8+XHJcbjxSZWxhdGlvbnNoaXBzIHhtbG5zPVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzXCI+XHJcbiAgPFJlbGF0aW9uc2hpcCBJZD1cInJJZDFcIiBUeXBlPVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudFwiIFRhcmdldD1cIndvcmQvZG9jdW1lbnQueG1sXCIvPlxyXG4gIDxSZWxhdGlvbnNoaXAgSWQ9XCJySWQyXCIgVHlwZT1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcy9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXNcIiBUYXJnZXQ9XCJkb2NQcm9wcy9jb3JlLnhtbFwiLz5cclxuICA8UmVsYXRpb25zaGlwIElkPVwicklkM1wiIFR5cGU9XCJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL2V4dGVuZGVkLXByb3BlcnRpZXNcIiBUYXJnZXQ9XCJkb2NQcm9wcy9hcHAueG1sXCIvPlxyXG48L1JlbGF0aW9uc2hpcHM+YCk7XHJcblxyXG5cdFx0Y29uc3QgY29yZVRpdGxlID0gZXNjYXBlWG1sKHBhcmFtcy50aXRsZSB8fCAnVW50aXRsZWQnKTtcclxuXHRcdGNvbnN0IGNvcmVDcmVhdG9yID0gZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IgfHwgJycpO1xyXG5cdFx0emlwLmZvbGRlcignZG9jUHJvcHMnKT8uZmlsZSgnY29yZS54bWwnLCBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIiBzdGFuZGFsb25lPVwieWVzXCI/PlxyXG48Y3A6Y29yZVByb3BlcnRpZXMgeG1sbnM6Y3A9XCJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L21ldGFkYXRhL2NvcmUtcHJvcGVydGllc1wiXHJcbiB4bWxuczpkYz1cImh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvXCJcclxuIHhtbG5zOmRjdGVybXM9XCJodHRwOi8vcHVybC5vcmcvZGMvdGVybXMvXCJcclxuIHhtbG5zOmRjbWl0eXBlPVwiaHR0cDovL3B1cmwub3JnL2RjL2RjbWl0eXBlL1wiXHJcbiB4bWxuczp4c2k9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZVwiPlxyXG4gIDxkYzp0aXRsZT4ke2NvcmVUaXRsZX08L2RjOnRpdGxlPlxyXG4gICR7Y29yZUNyZWF0b3IgPyBgPGRjOmNyZWF0b3I+JHtjb3JlQ3JlYXRvcn08L2RjOmNyZWF0b3I+YCA6ICcnfVxyXG4gIDxkY3Rlcm1zOmNyZWF0ZWQgeHNpOnR5cGU9XCJkY3Rlcm1zOlczQ0RURlwiPiR7bmV3IERhdGUoKS50b0lTT1N0cmluZygpfTwvZGN0ZXJtczpjcmVhdGVkPlxyXG48L2NwOmNvcmVQcm9wZXJ0aWVzPmApO1xyXG5cclxuXHRcdHppcC5mb2xkZXIoJ2RvY1Byb3BzJyk/LmZpbGUoJ2FwcC54bWwnLCBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIiBzdGFuZGFsb25lPVwieWVzXCI/PlxyXG48UHJvcGVydGllcyB4bWxucz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2V4dGVuZGVkLXByb3BlcnRpZXNcIlxyXG4geG1sbnM6dnQ9XCJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9kb2NQcm9wc1ZUeXBlc1wiPlxyXG4gIDxBcHBsaWNhdGlvbj5Hd3JpdGVyPC9BcHBsaWNhdGlvbj5cclxuPC9Qcm9wZXJ0aWVzPmApO1xyXG5cclxuXHRcdHppcC5mb2xkZXIoJ3dvcmQnKT8uZmlsZSgnc3R5bGVzLnhtbCcsIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiIHN0YW5kYWxvbmU9XCJ5ZXNcIj8+XHJcbjx3OnN0eWxlcyB4bWxuczp3PVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluXCI+XHJcbiAgPHc6c3R5bGUgdzp0eXBlPVwicGFyYWdyYXBoXCIgdzpkZWZhdWx0PVwiMVwiIHc6c3R5bGVJZD1cIk5vcm1hbFwiPlxyXG4gICAgPHc6bmFtZSB3OnZhbD1cIk5vcm1hbFwiLz5cclxuICA8L3c6c3R5bGU+XHJcbiAgPHc6c3R5bGUgdzp0eXBlPVwicGFyYWdyYXBoXCIgdzpzdHlsZUlkPVwiSGVhZGluZzFcIj5cclxuICAgIDx3Om5hbWUgdzp2YWw9XCJoZWFkaW5nIDFcIi8+XHJcbiAgICA8dzpiYXNlZE9uIHc6dmFsPVwiTm9ybWFsXCIvPlxyXG4gICAgPHc6dWlQcmlvcml0eSB3OnZhbD1cIjlcIi8+XHJcbiAgICA8dzpxRm9ybWF0Lz5cclxuICAgIDx3OnBQcj48dzprZWVwTmV4dC8+PHc6a2VlcExpbmVzLz48L3c6cFByPlxyXG4gIDwvdzpzdHlsZT5cclxuPC93OnN0eWxlcz5gKTtcclxuXHJcblx0XHRjb25zdCBib2R5UGFydHM6IHN0cmluZ1tdID0gW107XHJcblx0XHRib2R5UGFydHMucHVzaCh3UGFyYShwYXJhbXMudGl0bGUgfHwgJ1VudGl0bGVkJywgeyBjZW50ZXI6IHRydWUsIGhlYWRpbmc6IHRydWUgfSkpO1xyXG5cdFx0aWYgKHBhcmFtcy5hdXRob3IpIGJvZHlQYXJ0cy5wdXNoKHdQYXJhKHBhcmFtcy5hdXRob3IsIHsgY2VudGVyOiB0cnVlIH0pKTtcclxuXHRcdGJvZHlQYXJ0cy5wdXNoKHdCbGFua1BhcmEoKSk7XHJcblxyXG5cdFx0Zm9yIChjb25zdCBjaCBvZiBwYXJhbXMuY2hhcHRlcnMpIHtcclxuXHRcdFx0Ym9keVBhcnRzLnB1c2god1BhcmEoY2gudGl0bGUgfHwgJ0NoYXB0ZXInLCB7IGhlYWRpbmc6IHRydWUgfSkpO1xyXG5cdFx0XHRib2R5UGFydHMucHVzaCh3QmxhbmtQYXJhKCkpO1xyXG5cdFx0XHRjb25zdCBwbGFpbiA9IG1hcmtkb3duVG9QbGFpblRleHQoY2gubWFya2Rvd24gfHwgJycpO1xyXG5cdFx0XHRmb3IgKGNvbnN0IHAgb2YgcGxhaW4uc3BsaXQoL1xcbnsyLH0vZykpIHtcclxuXHRcdFx0XHRjb25zdCB0cmltbWVkID0gcC50cmltKCk7XHJcblx0XHRcdFx0aWYgKCF0cmltbWVkKSBjb250aW51ZTtcclxuXHRcdFx0XHRib2R5UGFydHMucHVzaCh3UGFyYSh0cmltbWVkKSk7XHJcblx0XHRcdFx0Ym9keVBhcnRzLnB1c2god0JsYW5rUGFyYSgpKTtcclxuXHRcdFx0fVxyXG5cdFx0fVxyXG5cclxuXHRcdGNvbnN0IGRvY3VtZW50WG1sID0gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCIgc3RhbmRhbG9uZT1cInllc1wiPz5cclxuPHc6ZG9jdW1lbnQgeG1sbnM6dz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpblwiPlxyXG4gIDx3OmJvZHk+XHJcbiAgICAke2JvZHlQYXJ0cy5qb2luKCdcXG4nKX1cclxuICAgIDx3OnNlY3RQci8+XHJcbiAgPC93OmJvZHk+XHJcbjwvdzpkb2N1bWVudD5gO1xyXG5cdFx0emlwLmZvbGRlcignd29yZCcpPy5maWxlKCdkb2N1bWVudC54bWwnLCBkb2N1bWVudFhtbCk7XHJcblxyXG5cdFx0Y29uc3QgYWIgPSBhd2FpdCB6aXAuZ2VuZXJhdGVBc3luYyh7IHR5cGU6ICdhcnJheWJ1ZmZlcicgfSk7XHJcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIubWtkaXIoZm9sZGVyKS5jYXRjaCgoKSA9PiB7fSk7XHJcblx0XHRhd2FpdCB0aGlzLnZhdWx0LmFkYXB0ZXIud3JpdGVCaW5hcnkob3V0UGF0aCwgYWIgYXMgQXJyYXlCdWZmZXIpO1xyXG5cdFx0cmV0dXJuIG91dFBhdGg7XHJcblx0fVxyXG59XHJcblxyXG5cclxuIl19