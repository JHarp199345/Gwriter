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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRG9jeEV4cG9ydFNlcnZpY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJEb2N4RXhwb3J0U2VydmljZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEtBQUssTUFBTSxPQUFPLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFVeEQsU0FBUyxTQUFTLENBQUMsS0FBYTtJQUMvQixPQUFPLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztTQUNsQixPQUFPLENBQUMsSUFBSSxFQUFFLE9BQU8sQ0FBQztTQUN0QixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQztTQUNyQixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQztTQUN2QixPQUFPLENBQUMsSUFBSSxFQUFFLFFBQVEsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFjO0lBQ3RDLE1BQU0sQ0FBQyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEdBQUcsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztJQUM3RSxPQUFPLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ2pDLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxJQUFZO0lBQ2xDLE9BQU8sSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLElBQUksT0FBTyxDQUFDO0FBQ3JFLENBQUM7QUFFRCxTQUFTLEtBQUssQ0FBQyxJQUFZLEVBQUUsSUFBOEM7SUFDMUUsTUFBTSxJQUFJLEdBQUcsU0FB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NUQsTUFBTSxJQUFJLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxHQUFFLENBQUMsQ0FBQyxDQUFDO1FBQ3ZELE1BQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLE9BQU8sRUFBRSxFQUFpQixDQUFDLENBQUM7UUFDakUsT0FBTyxPQUFPLENBQUM7SUFDaEIsQ0FBQztDQUNEIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHR5cGUgeyBWYXVsdCB9IGZyb20gJ29ic2lkaWFuJztcbmltcG9ydCBKU1ppcCBmcm9tICdqc3ppcCc7XG5pbXBvcnQgeyBtYXJrZG93blRvUGxhaW5UZXh0IH0gZnJvbSAnLi9FeHBvcnRUZXh0VXRpbHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIEV4cG9ydERvY3hQYXJhbXMge1xuXHR0aXRsZTogc3RyaW5nO1xuXHRhdXRob3I6IHN0cmluZztcblx0Y2hhcHRlcnM6IEFycmF5PHsgdGl0bGU6IHN0cmluZzsgbWFya2Rvd246IHN0cmluZzsgc291cmNlUGF0aDogc3RyaW5nIH0+O1xuXHRvdXRwdXRGb2xkZXI6IHN0cmluZztcblx0b3V0cHV0RmlsZU5hbWU6IHN0cmluZzsgLy8gc2hvdWxkIGVuZCB3aXRoIC5kb2N4XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVhtbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuICh2YWx1ZSB8fCAnJylcblx0XHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKVxuXHRcdC5yZXBsYWNlKC88L2csICcmbHQ7Jylcblx0XHQucmVwbGFjZSgvPi9nLCAnJmd0OycpXG5cdFx0LnJlcGxhY2UoL1wiL2csICcmcXVvdDsnKVxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRm9sZGVyKGZvbGRlcjogc3RyaW5nKTogc3RyaW5nIHtcblx0Y29uc3QgZiA9IGZvbGRlci5yZXBsYWNlKC9cXFxcL2csICcvJykucmVwbGFjZSgvXlxcLysvLCAnJykucmVwbGFjZSgvXFwvKyQvLCAnJyk7XG5cdHJldHVybiBmLmxlbmd0aCA/IGYgOiAnRXhwb3J0cyc7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZURvY3hFeHQobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIG5hbWUudG9Mb3dlckNhc2UoKS5lbmRzV2l0aCgnLmRvY3gnKSA/IG5hbWUgOiBgJHtuYW1lfS5kb2N4YDtcbn1cblxuZnVuY3Rpb24gd1BhcmEodGV4dDogc3RyaW5nLCBvcHRzPzogeyBoZWFkaW5nPzogYm9vbGVhbjsgY2VudGVyPzogYm9vbGVhbiB9KTogc3RyaW5nIHtcblx0Y29uc3QgcnVucyA9IGVzY2FwZVhtbCh0ZXh0IHx8ICcnKVxuXHRcdC5zcGxpdCgvXFxyP1xcbi8pXG5cdFx0Lm1hcCgobGluZSkgPT4ge1xuXHRcdFx0Y29uc3QgdCA9IGxpbmUgfHwgJyc7XG5cdFx0XHRyZXR1cm4gYDx3OnI+PHc6dCB4bWw6c3BhY2U9XCJwcmVzZXJ2ZVwiPiR7ZXNjYXBlWG1sKHQpfTwvdzp0PjwvdzpyPmA7XG5cdFx0fSlcblx0XHQuam9pbignJyk7XG5cblx0Y29uc3QgcFByOiBzdHJpbmdbXSA9IFtdO1xuXHRpZiAob3B0cz8uaGVhZGluZykgcFByLnB1c2goJzx3OnBTdHlsZSB3OnZhbD1cIkhlYWRpbmcxXCIvPicpO1xuXHRpZiAob3B0cz8uY2VudGVyKSBwUHIucHVzaCgnPHc6amMgdzp2YWw9XCJjZW50ZXJcIi8+Jyk7XG5cdGNvbnN0IHBQclhtbCA9IHBQci5sZW5ndGggPyBgPHc6cFByPiR7cFByLmpvaW4oJycpfTwvdzpwUHI+YCA6ICcnO1xuXHRyZXR1cm4gYDx3OnA+JHtwUHJYbWx9JHtydW5zfTwvdzpwPmA7XG59XG5cbmZ1bmN0aW9uIHdCbGFua1BhcmEoKTogc3RyaW5nIHtcblx0cmV0dXJuICc8dzpwPjx3OnI+PHc6dCB4bWw6c3BhY2U9XCJwcmVzZXJ2ZVwiPiA8L3c6dD48L3c6cj48L3c6cD4nO1xufVxuXG5leHBvcnQgY2xhc3MgRG9jeEV4cG9ydFNlcnZpY2Uge1xuXHRwcml2YXRlIHJlYWRvbmx5IHZhdWx0OiBWYXVsdDtcblxuXHRjb25zdHJ1Y3Rvcih2YXVsdDogVmF1bHQpIHtcblx0XHR0aGlzLnZhdWx0ID0gdmF1bHQ7XG5cdH1cblxuXHRhc3luYyBleHBvcnQocGFyYW1zOiBFeHBvcnREb2N4UGFyYW1zKTogUHJvbWlzZTxzdHJpbmc+IHtcblx0XHRjb25zdCBmb2xkZXIgPSBub3JtYWxpemVGb2xkZXIocGFyYW1zLm91dHB1dEZvbGRlcik7XG5cdFx0Y29uc3QgZmlsZU5hbWUgPSBlbnN1cmVEb2N4RXh0KHBhcmFtcy5vdXRwdXRGaWxlTmFtZSk7XG5cdFx0Y29uc3Qgb3V0UGF0aCA9IGAke2ZvbGRlcn0vJHtmaWxlTmFtZX1gLnJlcGxhY2UoL1xcLysvZywgJy8nKTtcblxuXHRcdGNvbnN0IHppcCA9IG5ldyBKU1ppcCgpO1xuXG5cdFx0Ly8gTWluaW1hbCByZXF1aXJlZCBwYXJ0cyBmb3IgV29yZCB0byBvcGVuLlxuXHRcdHppcC5maWxlKCdbQ29udGVudF9UeXBlc10ueG1sJywgYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCIgc3RhbmRhbG9uZT1cInllc1wiPz5cbjxUeXBlcyB4bWxucz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlc1wiPlxuICA8RGVmYXVsdCBFeHRlbnNpb249XCJyZWxzXCIgQ29udGVudFR5cGU9XCJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5yZWxhdGlvbnNoaXBzK3htbFwiLz5cbiAgPERlZmF1bHQgRXh0ZW5zaW9uPVwieG1sXCIgQ29udGVudFR5cGU9XCJhcHBsaWNhdGlvbi94bWxcIi8+XG4gIDxPdmVycmlkZSBQYXJ0TmFtZT1cIi93b3JkL2RvY3VtZW50LnhtbFwiIENvbnRlbnRUeXBlPVwiYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWxcIi8+XG4gIDxPdmVycmlkZSBQYXJ0TmFtZT1cIi93b3JkL3N0eWxlcy54bWxcIiBDb250ZW50VHlwZT1cImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLnN0eWxlcyt4bWxcIi8+XG4gIDxPdmVycmlkZSBQYXJ0TmFtZT1cIi9kb2NQcm9wcy9jb3JlLnhtbFwiIENvbnRlbnRUeXBlPVwiYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UuY29yZS1wcm9wZXJ0aWVzK3htbFwiLz5cbiAgPE92ZXJyaWRlIFBhcnROYW1lPVwiL2RvY1Byb3BzL2FwcC54bWxcIiBDb250ZW50VHlwZT1cImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbFwiLz5cbjwvVHlwZXM+YCk7XG5cblx0XHR6aXAuZm9sZGVyKCdfcmVscycpPy5maWxlKCcucmVscycsIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiIHN0YW5kYWxvbmU9XCJ5ZXNcIj8+XG48UmVsYXRpb25zaGlwcyB4bWxucz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwc1wiPlxuICA8UmVsYXRpb25zaGlwIElkPVwicklkMVwiIFR5cGU9XCJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL29mZmljZURvY3VtZW50XCIgVGFyZ2V0PVwid29yZC9kb2N1bWVudC54bWxcIi8+XG4gIDxSZWxhdGlvbnNoaXAgSWQ9XCJySWQyXCIgVHlwZT1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcy9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXNcIiBUYXJnZXQ9XCJkb2NQcm9wcy9jb3JlLnhtbFwiLz5cbiAgPFJlbGF0aW9uc2hpcCBJZD1cInJJZDNcIiBUeXBlPVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9leHRlbmRlZC1wcm9wZXJ0aWVzXCIgVGFyZ2V0PVwiZG9jUHJvcHMvYXBwLnhtbFwiLz5cbjwvUmVsYXRpb25zaGlwcz5gKTtcblxuXHRcdGNvbnN0IGNvcmVUaXRsZSA9IGVzY2FwZVhtbChwYXJhbXMudGl0bGUgfHwgJ1VudGl0bGVkJyk7XG5cdFx0Y29uc3QgY29yZUNyZWF0b3IgPSBlc2NhcGVYbWwocGFyYW1zLmF1dGhvciB8fCAnJyk7XG5cdFx0emlwLmZvbGRlcignZG9jUHJvcHMnKT8uZmlsZSgnY29yZS54bWwnLCBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwiVVRGLThcIiBzdGFuZGFsb25lPVwieWVzXCI/PlxuPGNwOmNvcmVQcm9wZXJ0aWVzIHhtbG5zOmNwPVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXNcIlxuIHhtbG5zOmRjPVwiaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS9cIlxuIHhtbG5zOmRjdGVybXM9XCJodHRwOi8vcHVybC5vcmcvZGMvdGVybXMvXCJcbiB4bWxuczpkY21pdHlwZT1cImh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS9cIlxuIHhtbG5zOnhzaT1cImh0dHA6Ly93d3cudzMub3JnLzIwMDEvWE1MU2NoZW1hLWluc3RhbmNlXCI+XG4gIDxkYzp0aXRsZT4ke2NvcmVUaXRsZX08L2RjOnRpdGxlPlxuICAke2NvcmVDcmVhdG9yID8gYDxkYzpjcmVhdG9yPiR7Y29yZUNyZWF0b3J9PC9kYzpjcmVhdG9yPmAgOiAnJ31cbiAgPGRjdGVybXM6Y3JlYXRlZCB4c2k6dHlwZT1cImRjdGVybXM6VzNDRFRGXCI+JHtuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCl9PC9kY3Rlcm1zOmNyZWF0ZWQ+XG48L2NwOmNvcmVQcm9wZXJ0aWVzPmApO1xuXG5cdFx0emlwLmZvbGRlcignZG9jUHJvcHMnKT8uZmlsZSgnYXBwLnhtbCcsIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJVVEYtOFwiIHN0YW5kYWxvbmU9XCJ5ZXNcIj8+XG48UHJvcGVydGllcyB4bWxucz1cImh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2V4dGVuZGVkLXByb3BlcnRpZXNcIlxuIHhtbG5zOnZ0PVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvZG9jUHJvcHNWVHlwZXNcIj5cbiAgPEFwcGxpY2F0aW9uPkd3cml0ZXI8L0FwcGxpY2F0aW9uPlxuPC9Qcm9wZXJ0aWVzPmApO1xuXG5cdFx0emlwLmZvbGRlcignd29yZCcpPy5maWxlKCdzdHlsZXMueG1sJywgYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCIgc3RhbmRhbG9uZT1cInllc1wiPz5cbjx3OnN0eWxlcyB4bWxuczp3PVwiaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluXCI+XG4gIDx3OnN0eWxlIHc6dHlwZT1cInBhcmFncmFwaFwiIHc6ZGVmYXVsdD1cIjFcIiB3OnN0eWxlSWQ9XCJOb3JtYWxcIj5cbiAgICA8dzpuYW1lIHc6dmFsPVwiTm9ybWFsXCIvPlxuICA8L3c6c3R5bGU+XG4gIDx3OnN0eWxlIHc6dHlwZT1cInBhcmFncmFwaFwiIHc6c3R5bGVJZD1cIkhlYWRpbmcxXCI+XG4gICAgPHc6bmFtZSB3OnZhbD1cImhlYWRpbmcgMVwiLz5cbiAgICA8dzpiYXNlZE9uIHc6dmFsPVwiTm9ybWFsXCIvPlxuICAgIDx3OnVpUHJpb3JpdHkgdzp2YWw9XCI5XCIvPlxuICAgIDx3OnFGb3JtYXQvPlxuICAgIDx3OnBQcj48dzprZWVwTmV4dC8+PHc6a2VlcExpbmVzLz48L3c6cFByPlxuICA8L3c6c3R5bGU+XG48L3c6c3R5bGVzPmApO1xuXG5cdFx0Y29uc3QgYm9keVBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuXHRcdGJvZHlQYXJ0cy5wdXNoKHdQYXJhKHBhcmFtcy50aXRsZSB8fCAnVW50aXRsZWQnLCB7IGNlbnRlcjogdHJ1ZSwgaGVhZGluZzogdHJ1ZSB9KSk7XG5cdFx0aWYgKHBhcmFtcy5hdXRob3IpIGJvZHlQYXJ0cy5wdXNoKHdQYXJhKHBhcmFtcy5hdXRob3IsIHsgY2VudGVyOiB0cnVlIH0pKTtcblx0XHRib2R5UGFydHMucHVzaCh3QmxhbmtQYXJhKCkpO1xuXG5cdFx0Zm9yIChjb25zdCBjaCBvZiBwYXJhbXMuY2hhcHRlcnMpIHtcblx0XHRcdGJvZHlQYXJ0cy5wdXNoKHdQYXJhKGNoLnRpdGxlIHx8ICdDaGFwdGVyJywgeyBoZWFkaW5nOiB0cnVlIH0pKTtcblx0XHRcdGJvZHlQYXJ0cy5wdXNoKHdCbGFua1BhcmEoKSk7XG5cdFx0XHRjb25zdCBwbGFpbiA9IG1hcmtkb3duVG9QbGFpblRleHQoY2gubWFya2Rvd24gfHwgJycpO1xuXHRcdFx0Zm9yIChjb25zdCBwIG9mIHBsYWluLnNwbGl0KC9cXG57Mix9L2cpKSB7XG5cdFx0XHRcdGNvbnN0IHRyaW1tZWQgPSBwLnRyaW0oKTtcblx0XHRcdFx0aWYgKCF0cmltbWVkKSBjb250aW51ZTtcblx0XHRcdFx0Ym9keVBhcnRzLnB1c2god1BhcmEodHJpbW1lZCkpO1xuXHRcdFx0XHRib2R5UGFydHMucHVzaCh3QmxhbmtQYXJhKCkpO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdGNvbnN0IGRvY3VtZW50WG1sID0gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cIlVURi04XCIgc3RhbmRhbG9uZT1cInllc1wiPz5cbjx3OmRvY3VtZW50IHhtbG5zOnc9XCJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvd29yZHByb2Nlc3NpbmdtbC8yMDA2L21haW5cIj5cbiAgPHc6Ym9keT5cbiAgICAke2JvZHlQYXJ0cy5qb2luKCdcXG4nKX1cbiAgICA8dzpzZWN0UHIvPlxuICA8L3c6Ym9keT5cbjwvdzpkb2N1bWVudD5gO1xuXHRcdHppcC5mb2xkZXIoJ3dvcmQnKT8uZmlsZSgnZG9jdW1lbnQueG1sJywgZG9jdW1lbnRYbWwpO1xuXG5cdFx0Y29uc3QgYWIgPSBhd2FpdCB6aXAuZ2VuZXJhdGVBc3luYyh7IHR5cGU6ICdhcnJheWJ1ZmZlcicgfSk7XG5cdFx0YXdhaXQgdGhpcy52YXVsdC5hZGFwdGVyLm1rZGlyKGZvbGRlcikuY2F0Y2goKCkgPT4ge30pO1xuXHRcdGF3YWl0IHRoaXMudmF1bHQuYWRhcHRlci53cml0ZUJpbmFyeShvdXRQYXRoLCBhYiBhcyBBcnJheUJ1ZmZlcik7XG5cdFx0cmV0dXJuIG91dFBhdGg7XG5cdH1cbn1cblxuXG4iXX0=