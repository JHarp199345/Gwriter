function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function pageTemplate(title, bodyInner) {
    return `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<!DOCTYPE html>\n` +
        `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">\n` +
        `<head>\n` +
        `  <title>${escapeXml(title)}</title>\n` +
        `  <meta charset="utf-8" />\n` +
        `  <link rel="stylesheet" type="text/css" href="../Styles/style.css" />\n` +
        `</head>\n` +
        `<body>\n` +
        `<section class="front-matter">\n` +
        bodyInner +
        `\n</section>\n` +
        `</body>\n` +
        `</html>\n`;
}
function renderAllRightsReserved(params) {
    const title = escapeXml(params.title);
    const author = escapeXml(params.author);
    const year = escapeXml(params.year);
    const holder = escapeXml(params.holder);
    return pageTemplate('Copyright', [
        `<h1>Copyright</h1>`,
        `<p><strong>${title}</strong></p>`,
        author ? `<p>${author}</p>` : '',
        year && holder ? `<p>Copyright © ${year} ${holder}</p>` : '',
        `<p>All rights reserved.</p>`,
        `<p>No part of this book may be reproduced, stored in a retrieval system, or transmitted in any form or by any means without prior written permission, except as permitted by law.</p>`
    ].filter(Boolean).join('\n'));
}
function renderCc(params, name, url) {
    const title = escapeXml(params.title);
    const author = escapeXml(params.author);
    const year = escapeXml(params.year);
    const holder = escapeXml(params.holder);
    return pageTemplate('License', [
        `<h1>License</h1>`,
        `<p><strong>${title}</strong></p>`,
        author ? `<p>${author}</p>` : '',
        year && holder ? `<p>Copyright © ${year} ${holder}</p>` : '',
        `<p>This work is licensed under <strong>${escapeXml(name)}</strong>.</p>`,
        `<p>License URL: <a href="${escapeXml(url)}">${escapeXml(url)}</a></p>`
    ].filter(Boolean).join('\n'));
}
function renderCc0(params) {
    return renderCc(params, 'CC0 1.0 Universal', 'https://creativecommons.org/publicdomain/zero/1.0/');
}
function renderPublicDomain(params) {
    const title = escapeXml(params.title);
    const author = escapeXml(params.author);
    return pageTemplate('Public domain', [
        `<h1>Public domain</h1>`,
        `<p><strong>${title}</strong></p>`,
        author ? `<p>${author}</p>` : '',
        `<p>This work is dedicated to the public domain.</p>`
    ].filter(Boolean).join('\n'));
}
export const LICENSE_TEMPLATES = [
    {
        id: 'all-rights-reserved',
        label: 'All rights reserved',
        description: 'Standard copyright notice for traditional publishing.',
        renderXhtml: renderAllRightsReserved
    },
    {
        id: 'cc-by',
        label: 'Creative Commons Attribution (CC BY 4.0)',
        description: 'Others can distribute and build upon your work, including commercially, with attribution.',
        renderXhtml: (p) => renderCc(p, 'Creative Commons Attribution 4.0 International', 'https://creativecommons.org/licenses/by/4.0/')
    },
    {
        id: 'cc-by-sa',
        label: 'Creative Commons Attribution-ShareAlike (CC BY-SA 4.0)',
        description: 'Derivatives must be licensed under identical terms.',
        renderXhtml: (p) => renderCc(p, 'Creative Commons Attribution-ShareAlike 4.0 International', 'https://creativecommons.org/licenses/by-sa/4.0/')
    },
    {
        id: 'cc-by-nc',
        label: 'Creative Commons Attribution-NonCommercial (CC BY-NC 4.0)',
        description: 'Reuse allowed with attribution for non-commercial purposes.',
        renderXhtml: (p) => renderCc(p, 'Creative Commons Attribution-NonCommercial 4.0 International', 'https://creativecommons.org/licenses/by-nc/4.0/')
    },
    {
        id: 'cc-by-nc-sa',
        label: 'Creative Commons Attribution-NonCommercial-ShareAlike (CC BY-NC-SA 4.0)',
        description: 'Non-commercial reuse; derivatives must use identical terms.',
        renderXhtml: (p) => renderCc(p, 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International', 'https://creativecommons.org/licenses/by-nc-sa/4.0/')
    },
    {
        id: 'cc0',
        label: 'CC0 (No rights reserved)',
        description: 'Waives rights to the extent allowed by law.',
        renderXhtml: renderCc0
    },
    {
        id: 'public-domain',
        label: 'Public domain dedication',
        description: 'Simple public domain dedication text.',
        renderXhtml: renderPublicDomain
    }
];
export function getLicenseTemplate(id) {
    return LICENSE_TEMPLATES.find((t) => t.id === id) ?? LICENSE_TEMPLATES[0];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTGljZW5zZVRlbXBsYXRlcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxpY2Vuc2VUZW1wbGF0ZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBZ0JBLFNBQVMsU0FBUyxDQUFDLEtBQWE7SUFDL0IsT0FBTyxLQUFLO1NBQ1YsT0FBTyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUM7U0FDdEIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUM7U0FDdkIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztBQUMzQixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBYSxFQUFFLFNBQWlCO0lBQ3JELE9BQU8sMENBQTBDO1FBQ2hELG1CQUFtQjtRQUNuQiw2REFBNkQ7UUFDN0QsVUFBVTtRQUNWLFlBQVksU0FBUyxDQUFDLEtBQUssQ0FBQyxZQUFZO1FBQ3hDLDhCQUE4QjtRQUM5QiwwRUFBMEU7UUFDMUUsV0FBVztRQUNYLFVBQVU7UUFDVixrQ0FBa0M7UUFDbEMsU0FBUztRQUNULGdCQUFnQjtRQUNoQixXQUFXO1FBQ1gsV0FBVyxDQUFDO0FBQ2QsQ0FBQztBQUVELFNBQVMsdUJBQXVCLENBQUMsTUFBdUU7SUFDdkcsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0QyxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDcEMsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4QyxPQUFPLFlBQVksQ0FBQyxXQUFXLEVBQUU7UUFDaEMsb0JBQW9CO1FBQ3BCLGNB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MkRBQTJELEVBQUUsaURBQWlELENBQUM7S0FDL0k7SUFDRDtRQUNDLEVBQUUsRUFBRSxVQUFVO1FBQ2QsS0FBSyxFQUFFLDJEQUEyRDtRQUNsRSxXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSw4REFBOEQsRUFBRSxpREFBaUQsQ0FBQztLQUNsSjtJQUNEO1FBQ0MsRUFBRSxFQUFFLGFBQWE7UUFDakIsS0FBSyxFQUFFLHlFQUF5RTtRQUNoRixXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSx5RUFBeUUsRUFBRSxvREFBb0QsQ0FBQztLQUNoSztJQUNEO1FBQ0MsRUFBRSxFQUFFLEtBQUs7UUFDVCxLQUFLLEVBQUUsMEJBQTBCO1FBQ2pDLFdBQVcsRUFBRSw2Q0FBNkM7UUFDMUQsV0FBVyxFQUFFLFNBQVM7S0FDdEI7SUFDRDtRQUNDLEVBQUUsRUFBRSxlQUFlO1FBQ25CLEtBQUssRUFBRSwwQkFBMEI7UUFDakMsV0FBVyxFQUFFLHVDQUF1QztRQUNwRCxXQUFXLEVBQUUsa0JBQWtCO0tBQy9CO0NBQ0QsQ0FBQztBQUVGLE1BQU0sVUFBVSxrQkFBa0IsQ0FBQyxFQUFxQjtJQUN2RCxPQUFPLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsSUFBSSxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IHR5cGUgTGljZW5zZVRlbXBsYXRlSWQgPVxyXG5cdHwgJ2FsbC1yaWdodHMtcmVzZXJ2ZWQnXHJcblx0fCAnY2MtYnknXHJcblx0fCAnY2MtYnktc2EnXHJcblx0fCAnY2MtYnktbmMnXHJcblx0fCAnY2MtYnktbmMtc2EnXHJcblx0fCAnY2MwJ1xyXG5cdHwgJ3B1YmxpYy1kb21haW4nO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBMaWNlbnNlVGVtcGxhdGUge1xyXG5cdGlkOiBMaWNlbnNlVGVtcGxhdGVJZDtcclxuXHRsYWJlbDogc3RyaW5nO1xyXG5cdGRlc2NyaXB0aW9uOiBzdHJpbmc7XHJcblx0cmVuZGVyWGh0bWw6IChwYXJhbXM6IHsgdGl0bGU6IHN0cmluZzsgYXV0aG9yOiBzdHJpbmc7IHllYXI6IHN0cmluZzsgaG9sZGVyOiBzdHJpbmcgfSkgPT4gc3RyaW5nO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlc2NhcGVYbWwodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XHJcblx0cmV0dXJuIHZhbHVlXHJcblx0XHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKVxyXG5cdFx0LnJlcGxhY2UoLzwvZywgJyZsdDsnKVxyXG5cdFx0LnJlcGxhY2UoLz4vZywgJyZndDsnKVxyXG5cdFx0LnJlcGxhY2UoL1wiL2csICcmcXVvdDsnKVxyXG5cdFx0LnJlcGxhY2UoLycvZywgJyZhcG9zOycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBwYWdlVGVtcGxhdGUodGl0bGU6IHN0cmluZywgYm9keUlubmVyOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiBgPD94bWwgdmVyc2lvbj1cIjEuMFwiIGVuY29kaW5nPVwidXRmLThcIj8+XFxuYCArXHJcblx0XHRgPCFET0NUWVBFIGh0bWw+XFxuYCArXHJcblx0XHRgPGh0bWwgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIgeG1sOmxhbmc9XCJlblwiPlxcbmAgK1xyXG5cdFx0YDxoZWFkPlxcbmAgK1xyXG5cdFx0YCAgPHRpdGxlPiR7ZXNjYXBlWG1sKHRpdGxlKX08L3RpdGxlPlxcbmAgK1xyXG5cdFx0YCAgPG1ldGEgY2hhcnNldD1cInV0Zi04XCIgLz5cXG5gICtcclxuXHRcdGAgIDxsaW5rIHJlbD1cInN0eWxlc2hlZXRcIiB0eXBlPVwidGV4dC9jc3NcIiBocmVmPVwiLi4vU3R5bGVzL3N0eWxlLmNzc1wiIC8+XFxuYCArXHJcblx0XHRgPC9oZWFkPlxcbmAgK1xyXG5cdFx0YDxib2R5PlxcbmAgK1xyXG5cdFx0YDxzZWN0aW9uIGNsYXNzPVwiZnJvbnQtbWF0dGVyXCI+XFxuYCArXHJcblx0XHRib2R5SW5uZXIgK1xyXG5cdFx0YFxcbjwvc2VjdGlvbj5cXG5gICtcclxuXHRcdGA8L2JvZHk+XFxuYCArXHJcblx0XHRgPC9odG1sPlxcbmA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckFsbFJpZ2h0c1Jlc2VydmVkKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9KTogc3RyaW5nIHtcclxuXHRjb25zdCB0aXRsZSA9IGVzY2FwZVhtbChwYXJhbXMudGl0bGUpO1xyXG5cdGNvbnN0IGF1dGhvciA9IGVzY2FwZVhtbChwYXJhbXMuYXV0aG9yKTtcclxuXHRjb25zdCB5ZWFyID0gZXNjYXBlWG1sKHBhcmFtcy55ZWFyKTtcclxuXHRjb25zdCBob2xkZXIgPSBlc2NhcGVYbWwocGFyYW1zLmhvbGRlcik7XHJcblx0cmV0dXJuIHBhZ2VUZW1wbGF0ZSgnQ29weXJpZ2h0JywgW1xyXG5cdFx0YDxoMT5Db3B5cmlnaHQ8L2gxPmAsXHJcblx0XHRgPHA+PHN0cm9uZz4ke3RpdGxlfTwvc3Ryb25nPjwvcD5gLFxyXG5cdFx0YXV0aG9yID8gYDxwPiR7YXV0aG9yfTwvcD5gIDogJycsXHJcblx0XHR5ZWFyICYmIGhvbGRlciA/IGA8cD5Db3B5cmlnaHQgwqkgJHt5ZWFyfSAke2hvbGRlcn08L3A+YCA6ICcnLFxyXG5cdFx0YDxwPkFsbCByaWdodHMgcmVzZXJ2ZWQuPC9wPmAsXHJcblx0XHRgPHA+Tm8gcGFydCBvZiB0aGlzIGJvb2sgbWF5IGJlIHJlcHJvZHVjZWQsIHN0b3JlZCBpbiBhIHJldHJpZXZhbCBzeXN0ZW0sIG9yIHRyYW5zbWl0dGVkIGluIGFueSBmb3JtIG9yIGJ5IGFueSBtZWFucyB3aXRob3V0IHByaW9yIHdyaXR0ZW4gcGVybWlzc2lvbiwgZXhjZXB0IGFzIHBlcm1pdHRlZCBieSBsYXcuPC9wPmBcclxuXHRdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKSlcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyQ2MocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0sIG5hbWU6IHN0cmluZywgdXJsOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdGNvbnN0IHRpdGxlID0gZXNjYXBlWG1sKHBhcmFtcy50aXRsZSk7XHJcblx0Y29uc3QgYXV0aG9yID0gZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpO1xyXG5cdGNvbnN0IHllYXIgPSBlc2NhcGVYbWwocGFyYW1zLnllYXIpO1xyXG5cdGNvbnN0IGhvbGRlciA9IGVzY2FwZVhtbChwYXJhbXMuaG9sZGVyKTtcclxuXHRyZXR1cm4gcGFnZVRlbXBsYXRlKCdMaWNlbnNlJywgW1xyXG5cdFx0YDxoMT5MaWNlbnNlPC9oMT5gLFxyXG5cdFx0YDxwPjxzdHJvbmc+JHt0aXRsZX08L3N0cm9uZz48L3A+YCxcclxuXHRcdGF1dGhvciA/IGA8cD4ke2F1dGhvcn08L3A+YCA6ICcnLFxyXG5cdFx0eWVhciAmJiBob2xkZXIgPyBgPHA+Q29weXJpZ2h0IMKpICR7eWVhcn0gJHtob2xkZXJ9PC9wPmAgOiAnJyxcclxuXHRcdGA8cD5UaGlzIHdvcmsgaXMgbGljZW5zZWQgdW5kZXIgPHN0cm9uZz4ke2VzY2FwZVhtbChuYW1lKX08L3N0cm9uZz4uPC9wPmAsXHJcblx0XHRgPHA+TGljZW5zZSBVUkw6IDxhIGhyZWY9XCIke2VzY2FwZVhtbCh1cmwpfVwiPiR7ZXNjYXBlWG1sKHVybCl9PC9hPjwvcD5gXHJcblx0XS5maWx0ZXIoQm9vbGVhbikuam9pbignXFxuJykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJDYzAocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0pOiBzdHJpbmcge1xyXG5cdHJldHVybiByZW5kZXJDYyhwYXJhbXMsICdDQzAgMS4wIFVuaXZlcnNhbCcsICdodHRwczovL2NyZWF0aXZlY29tbW9ucy5vcmcvcHVibGljZG9tYWluL3plcm8vMS4wLycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJQdWJsaWNEb21haW4ocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0pOiBzdHJpbmcge1xyXG5cdGNvbnN0IHRpdGxlID0gZXNjYXBlWG1sKHBhcmFtcy50aXRsZSk7XHJcblx0Y29uc3QgYXV0aG9yID0gZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpO1xyXG5cdHJldHVybiBwYWdlVGVtcGxhdGUoJ1B1YmxpYyBkb21haW4nLCBbXHJcblx0XHRgPGgxPlB1YmxpYyBkb21haW48L2gxPmAsXHJcblx0XHRgPHA+PHN0cm9uZz4ke3RpdGxlfTwvc3Ryb25nPjwvcD5gLFxyXG5cdFx0YXV0aG9yID8gYDxwPiR7YXV0aG9yfTwvcD5gIDogJycsXHJcblx0XHRgPHA+VGhpcyB3b3JrIGlzIGRlZGljYXRlZCB0byB0aGUgcHVibGljIGRvbWFpbi48L3A+YFxyXG5cdF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xcbicpKTtcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IExJQ0VOU0VfVEVNUExBVEVTOiBMaWNlbnNlVGVtcGxhdGVbXSA9IFtcclxuXHR7XHJcblx0XHRpZDogJ2FsbC1yaWdodHMtcmVzZXJ2ZWQnLFxyXG5cdFx0bGFiZWw6ICdBbGwgcmlnaHRzIHJlc2VydmVkJyxcclxuXHRcdGRlc2NyaXB0aW9uOiAnU3RhbmRhcmQgY29weXJpZ2h0IG5vdGljZSBmb3IgdHJhZGl0aW9uYWwgcHVibGlzaGluZy4nLFxyXG5cdFx0cmVuZGVyWGh0bWw6IHJlbmRlckFsbFJpZ2h0c1Jlc2VydmVkXHJcblx0fSxcclxuXHR7XHJcblx0XHRpZDogJ2NjLWJ5JyxcclxuXHRcdGxhYmVsOiAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbiAoQ0MgQlkgNC4wKScsXHJcblx0XHRkZXNjcmlwdGlvbjogJ090aGVycyBjYW4gZGlzdHJpYnV0ZSBhbmQgYnVpbGQgdXBvbiB5b3VyIHdvcmssIGluY2x1ZGluZyBjb21tZXJjaWFsbHksIHdpdGggYXR0cmlidXRpb24uJyxcclxuXHRcdHJlbmRlclhodG1sOiAocCkgPT4gcmVuZGVyQ2MocCwgJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24gNC4wIEludGVybmF0aW9uYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LzQuMC8nKVxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdjYy1ieS1zYScsXHJcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tU2hhcmVBbGlrZSAoQ0MgQlktU0EgNC4wKScsXHJcblx0XHRkZXNjcmlwdGlvbjogJ0Rlcml2YXRpdmVzIG11c3QgYmUgbGljZW5zZWQgdW5kZXIgaWRlbnRpY2FsIHRlcm1zLicsXHJcblx0XHRyZW5kZXJYaHRtbDogKHApID0+IHJlbmRlckNjKHAsICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uLVNoYXJlQWxpa2UgNC4wIEludGVybmF0aW9uYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LXNhLzQuMC8nKVxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdjYy1ieS1uYycsXHJcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tTm9uQ29tbWVyY2lhbCAoQ0MgQlktTkMgNC4wKScsXHJcblx0XHRkZXNjcmlwdGlvbjogJ1JldXNlIGFsbG93ZWQgd2l0aCBhdHRyaWJ1dGlvbiBmb3Igbm9uLWNvbW1lcmNpYWwgcHVycG9zZXMuJyxcclxuXHRcdHJlbmRlclhodG1sOiAocCkgPT4gcmVuZGVyQ2MocCwgJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tTm9uQ29tbWVyY2lhbCA0LjAgSW50ZXJuYXRpb25hbCcsICdodHRwczovL2NyZWF0aXZlY29tbW9ucy5vcmcvbGljZW5zZXMvYnktbmMvNC4wLycpXHJcblx0fSxcclxuXHR7XHJcblx0XHRpZDogJ2NjLWJ5LW5jLXNhJyxcclxuXHRcdGxhYmVsOiAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbi1Ob25Db21tZXJjaWFsLVNoYXJlQWxpa2UgKENDIEJZLU5DLVNBIDQuMCknLFxyXG5cdFx0ZGVzY3JpcHRpb246ICdOb24tY29tbWVyY2lhbCByZXVzZTsgZGVyaXZhdGl2ZXMgbXVzdCB1c2UgaWRlbnRpY2FsIHRlcm1zLicsXHJcblx0XHRyZW5kZXJYaHRtbDogKHApID0+IHJlbmRlckNjKHAsICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uLU5vbkNvbW1lcmNpYWwtU2hhcmVBbGlrZSA0LjAgSW50ZXJuYXRpb25hbCcsICdodHRwczovL2NyZWF0aXZlY29tbW9ucy5vcmcvbGljZW5zZXMvYnktbmMtc2EvNC4wLycpXHJcblx0fSxcclxuXHR7XHJcblx0XHRpZDogJ2NjMCcsXHJcblx0XHRsYWJlbDogJ0NDMCAoTm8gcmlnaHRzIHJlc2VydmVkKScsXHJcblx0XHRkZXNjcmlwdGlvbjogJ1dhaXZlcyByaWdodHMgdG8gdGhlIGV4dGVudCBhbGxvd2VkIGJ5IGxhdy4nLFxyXG5cdFx0cmVuZGVyWGh0bWw6IHJlbmRlckNjMFxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdwdWJsaWMtZG9tYWluJyxcclxuXHRcdGxhYmVsOiAnUHVibGljIGRvbWFpbiBkZWRpY2F0aW9uJyxcclxuXHRcdGRlc2NyaXB0aW9uOiAnU2ltcGxlIHB1YmxpYyBkb21haW4gZGVkaWNhdGlvbiB0ZXh0LicsXHJcblx0XHRyZW5kZXJYaHRtbDogcmVuZGVyUHVibGljRG9tYWluXHJcblx0fVxyXG5dO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGdldExpY2Vuc2VUZW1wbGF0ZShpZDogTGljZW5zZVRlbXBsYXRlSWQpOiBMaWNlbnNlVGVtcGxhdGUge1xyXG5cdHJldHVybiBMSUNFTlNFX1RFTVBMQVRFUy5maW5kKCh0KSA9PiB0LmlkID09PSBpZCkgPz8gTElDRU5TRV9URU1QTEFURVNbMF07XHJcbn1cclxuXHJcblxyXG4iXX0=