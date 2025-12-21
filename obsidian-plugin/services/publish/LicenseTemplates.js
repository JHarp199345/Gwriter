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
    var _a;
    return (_a = LICENSE_TEMPLATES.find((t) => t.id === id)) !== null && _a !== void 0 ? _a : LICENSE_TEMPLATES[0];
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTGljZW5zZVRlbXBsYXRlcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxpY2Vuc2VUZW1wbGF0ZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBZ0JBLFNBQVMsU0FBUyxDQUFDLEtBQWE7SUFDL0IsT0FBTyxLQUFLO1NBQ1YsT0FBTyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUM7U0FDdEIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUM7U0FDdkIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztBQUMzQixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBYSxFQUFFLFNBQWlCO0lBQ3JELE9BQU8sMENBQTBDO1FBQ2hELG1CQUFtQjtRQUNuQiw2REFBNkQ7UUFDN0QsVUFBVTtRQUNWLFlBQVksU0FBUyxDQUFDLEtBQUssQ0FBQyxZQUFZO1FBQ3hDLDhCQUE4QjtRQUM5QiwwRUFBMEU7UUFDMUUsV0FBVztRQUNYLFVBQVU7UUFDVixrQ0FBa0M7UUFDbEMsU0FBUztRQUNULGdCQUFnQjtRQUNoQixXQUFXO1FBQ1gsV0FBVyxDQUFDO0FBQ2QsQ0FBQztBQUVELFNBQVMsdUJBQXVCLENBQUMsTUFBdUU7SUFDdkcsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0QyxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDcEMsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4QyxPQUFPLFlBQVksQ0FBQyxXQUFXLEVBQUU7UUFDaEMsb0JBQW9CO1FBQ3BCLGNB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MkRBQTJELEVBQUUsaURBQWlELENBQUM7S0FDL0k7SUFDRDtRQUNDLEVBQUUsRUFBRSxVQUFVO1FBQ2QsS0FBSyxFQUFFLDJEQUEyRDtRQUNsRSxXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSw4REFBOEQsRUFBRSxpREFBaUQsQ0FBQztLQUNsSjtJQUNEO1FBQ0MsRUFBRSxFQUFFLGFBQWE7UUFDakIsS0FBSyxFQUFFLHlFQUF5RTtRQUNoRixXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSx5RUFBeUUsRUFBRSxvREFBb0QsQ0FBQztLQUNoSztJQUNEO1FBQ0MsRUFBRSxFQUFFLEtBQUs7UUFDVCxLQUFLLEVBQUUsMEJBQTBCO1FBQ2pDLFdBQVcsRUFBRSw2Q0FBNkM7UUFDMUQsV0FBVyxFQUFFLFNBQVM7S0FDdEI7SUFDRDtRQUNDLEVBQUUsRUFBRSxlQUFlO1FBQ25CLEtBQUssRUFBRSwwQkFBMEI7UUFDakMsV0FBVyxFQUFFLHVDQUF1QztRQUNwRCxXQUFXLEVBQUUsa0JBQWtCO0tBQy9CO0NBQ0QsQ0FBQztBQUVGLE1BQU0sVUFBVSxrQkFBa0IsQ0FBQyxFQUFxQjs7SUFDdkQsT0FBTyxNQUFBLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsbUNBQUksaUJBQWlCLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0UsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCB0eXBlIExpY2Vuc2VUZW1wbGF0ZUlkID1cclxuXHR8ICdhbGwtcmlnaHRzLXJlc2VydmVkJ1xyXG5cdHwgJ2NjLWJ5J1xyXG5cdHwgJ2NjLWJ5LXNhJ1xyXG5cdHwgJ2NjLWJ5LW5jJ1xyXG5cdHwgJ2NjLWJ5LW5jLXNhJ1xyXG5cdHwgJ2NjMCdcclxuXHR8ICdwdWJsaWMtZG9tYWluJztcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgTGljZW5zZVRlbXBsYXRlIHtcclxuXHRpZDogTGljZW5zZVRlbXBsYXRlSWQ7XHJcblx0bGFiZWw6IHN0cmluZztcclxuXHRkZXNjcmlwdGlvbjogc3RyaW5nO1xyXG5cdHJlbmRlclhodG1sOiAocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0pID0+IHN0cmluZztcclxufVxyXG5cclxuZnVuY3Rpb24gZXNjYXBlWG1sKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xyXG5cdHJldHVybiB2YWx1ZVxyXG5cdFx0LnJlcGxhY2UoLyYvZywgJyZhbXA7JylcclxuXHRcdC5yZXBsYWNlKC88L2csICcmbHQ7JylcclxuXHRcdC5yZXBsYWNlKC8+L2csICcmZ3Q7JylcclxuXHRcdC5yZXBsYWNlKC9cIi9nLCAnJnF1b3Q7JylcclxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcGFnZVRlbXBsYXRlKHRpdGxlOiBzdHJpbmcsIGJvZHlJbm5lcjogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRyZXR1cm4gYDw/eG1sIHZlcnNpb249XCIxLjBcIiBlbmNvZGluZz1cInV0Zi04XCI/PlxcbmAgK1xyXG5cdFx0YDwhRE9DVFlQRSBodG1sPlxcbmAgK1xyXG5cdFx0YDxodG1sIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiIHhtbDpsYW5nPVwiZW5cIj5cXG5gICtcclxuXHRcdGA8aGVhZD5cXG5gICtcclxuXHRcdGAgIDx0aXRsZT4ke2VzY2FwZVhtbCh0aXRsZSl9PC90aXRsZT5cXG5gICtcclxuXHRcdGAgIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiIC8+XFxuYCArXHJcblx0XHRgICA8bGluayByZWw9XCJzdHlsZXNoZWV0XCIgdHlwZT1cInRleHQvY3NzXCIgaHJlZj1cIi4uL1N0eWxlcy9zdHlsZS5jc3NcIiAvPlxcbmAgK1xyXG5cdFx0YDwvaGVhZD5cXG5gICtcclxuXHRcdGA8Ym9keT5cXG5gICtcclxuXHRcdGA8c2VjdGlvbiBjbGFzcz1cImZyb250LW1hdHRlclwiPlxcbmAgK1xyXG5cdFx0Ym9keUlubmVyICtcclxuXHRcdGBcXG48L3NlY3Rpb24+XFxuYCArXHJcblx0XHRgPC9ib2R5PlxcbmAgK1xyXG5cdFx0YDwvaHRtbD5cXG5gO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW5kZXJBbGxSaWdodHNSZXNlcnZlZChwYXJhbXM6IHsgdGl0bGU6IHN0cmluZzsgYXV0aG9yOiBzdHJpbmc7IHllYXI6IHN0cmluZzsgaG9sZGVyOiBzdHJpbmcgfSk6IHN0cmluZyB7XHJcblx0Y29uc3QgdGl0bGUgPSBlc2NhcGVYbWwocGFyYW1zLnRpdGxlKTtcclxuXHRjb25zdCBhdXRob3IgPSBlc2NhcGVYbWwocGFyYW1zLmF1dGhvcik7XHJcblx0Y29uc3QgeWVhciA9IGVzY2FwZVhtbChwYXJhbXMueWVhcik7XHJcblx0Y29uc3QgaG9sZGVyID0gZXNjYXBlWG1sKHBhcmFtcy5ob2xkZXIpO1xyXG5cdHJldHVybiBwYWdlVGVtcGxhdGUoJ0NvcHlyaWdodCcsIFtcclxuXHRcdGA8aDE+Q29weXJpZ2h0PC9oMT5gLFxyXG5cdFx0YDxwPjxzdHJvbmc+JHt0aXRsZX08L3N0cm9uZz48L3A+YCxcclxuXHRcdGF1dGhvciA/IGA8cD4ke2F1dGhvcn08L3A+YCA6ICcnLFxyXG5cdFx0eWVhciAmJiBob2xkZXIgPyBgPHA+Q29weXJpZ2h0IMKpICR7eWVhcn0gJHtob2xkZXJ9PC9wPmAgOiAnJyxcclxuXHRcdGA8cD5BbGwgcmlnaHRzIHJlc2VydmVkLjwvcD5gLFxyXG5cdFx0YDxwPk5vIHBhcnQgb2YgdGhpcyBib29rIG1heSBiZSByZXByb2R1Y2VkLCBzdG9yZWQgaW4gYSByZXRyaWV2YWwgc3lzdGVtLCBvciB0cmFuc21pdHRlZCBpbiBhbnkgZm9ybSBvciBieSBhbnkgbWVhbnMgd2l0aG91dCBwcmlvciB3cml0dGVuIHBlcm1pc3Npb24sIGV4Y2VwdCBhcyBwZXJtaXR0ZWQgYnkgbGF3LjwvcD5gXHJcblx0XS5maWx0ZXIoQm9vbGVhbikuam9pbignXFxuJykpXHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlbmRlckNjKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9LCBuYW1lOiBzdHJpbmcsIHVybDogc3RyaW5nKTogc3RyaW5nIHtcclxuXHRjb25zdCB0aXRsZSA9IGVzY2FwZVhtbChwYXJhbXMudGl0bGUpO1xyXG5cdGNvbnN0IGF1dGhvciA9IGVzY2FwZVhtbChwYXJhbXMuYXV0aG9yKTtcclxuXHRjb25zdCB5ZWFyID0gZXNjYXBlWG1sKHBhcmFtcy55ZWFyKTtcclxuXHRjb25zdCBob2xkZXIgPSBlc2NhcGVYbWwocGFyYW1zLmhvbGRlcik7XHJcblx0cmV0dXJuIHBhZ2VUZW1wbGF0ZSgnTGljZW5zZScsIFtcclxuXHRcdGA8aDE+TGljZW5zZTwvaDE+YCxcclxuXHRcdGA8cD48c3Ryb25nPiR7dGl0bGV9PC9zdHJvbmc+PC9wPmAsXHJcblx0XHRhdXRob3IgPyBgPHA+JHthdXRob3J9PC9wPmAgOiAnJyxcclxuXHRcdHllYXIgJiYgaG9sZGVyID8gYDxwPkNvcHlyaWdodCDCqSAke3llYXJ9ICR7aG9sZGVyfTwvcD5gIDogJycsXHJcblx0XHRgPHA+VGhpcyB3b3JrIGlzIGxpY2Vuc2VkIHVuZGVyIDxzdHJvbmc+JHtlc2NhcGVYbWwobmFtZSl9PC9zdHJvbmc+LjwvcD5gLFxyXG5cdFx0YDxwPkxpY2Vuc2UgVVJMOiA8YSBocmVmPVwiJHtlc2NhcGVYbWwodXJsKX1cIj4ke2VzY2FwZVhtbCh1cmwpfTwvYT48L3A+YFxyXG5cdF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xcbicpKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyQ2MwKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9KTogc3RyaW5nIHtcclxuXHRyZXR1cm4gcmVuZGVyQ2MocGFyYW1zLCAnQ0MwIDEuMCBVbml2ZXJzYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL3B1YmxpY2RvbWFpbi96ZXJvLzEuMC8nKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVuZGVyUHVibGljRG9tYWluKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9KTogc3RyaW5nIHtcclxuXHRjb25zdCB0aXRsZSA9IGVzY2FwZVhtbChwYXJhbXMudGl0bGUpO1xyXG5cdGNvbnN0IGF1dGhvciA9IGVzY2FwZVhtbChwYXJhbXMuYXV0aG9yKTtcclxuXHRyZXR1cm4gcGFnZVRlbXBsYXRlKCdQdWJsaWMgZG9tYWluJywgW1xyXG5cdFx0YDxoMT5QdWJsaWMgZG9tYWluPC9oMT5gLFxyXG5cdFx0YDxwPjxzdHJvbmc+JHt0aXRsZX08L3N0cm9uZz48L3A+YCxcclxuXHRcdGF1dGhvciA/IGA8cD4ke2F1dGhvcn08L3A+YCA6ICcnLFxyXG5cdFx0YDxwPlRoaXMgd29yayBpcyBkZWRpY2F0ZWQgdG8gdGhlIHB1YmxpYyBkb21haW4uPC9wPmBcclxuXHRdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBMSUNFTlNFX1RFTVBMQVRFUzogTGljZW5zZVRlbXBsYXRlW10gPSBbXHJcblx0e1xyXG5cdFx0aWQ6ICdhbGwtcmlnaHRzLXJlc2VydmVkJyxcclxuXHRcdGxhYmVsOiAnQWxsIHJpZ2h0cyByZXNlcnZlZCcsXHJcblx0XHRkZXNjcmlwdGlvbjogJ1N0YW5kYXJkIGNvcHlyaWdodCBub3RpY2UgZm9yIHRyYWRpdGlvbmFsIHB1Ymxpc2hpbmcuJyxcclxuXHRcdHJlbmRlclhodG1sOiByZW5kZXJBbGxSaWdodHNSZXNlcnZlZFxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdjYy1ieScsXHJcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24gKENDIEJZIDQuMCknLFxyXG5cdFx0ZGVzY3JpcHRpb246ICdPdGhlcnMgY2FuIGRpc3RyaWJ1dGUgYW5kIGJ1aWxkIHVwb24geW91ciB3b3JrLCBpbmNsdWRpbmcgY29tbWVyY2lhbGx5LCB3aXRoIGF0dHJpYnV0aW9uLicsXHJcblx0XHRyZW5kZXJYaHRtbDogKHApID0+IHJlbmRlckNjKHAsICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uIDQuMCBJbnRlcm5hdGlvbmFsJywgJ2h0dHBzOi8vY3JlYXRpdmVjb21tb25zLm9yZy9saWNlbnNlcy9ieS80LjAvJylcclxuXHR9LFxyXG5cdHtcclxuXHRcdGlkOiAnY2MtYnktc2EnLFxyXG5cdFx0bGFiZWw6ICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uLVNoYXJlQWxpa2UgKENDIEJZLVNBIDQuMCknLFxyXG5cdFx0ZGVzY3JpcHRpb246ICdEZXJpdmF0aXZlcyBtdXN0IGJlIGxpY2Vuc2VkIHVuZGVyIGlkZW50aWNhbCB0ZXJtcy4nLFxyXG5cdFx0cmVuZGVyWGh0bWw6IChwKSA9PiByZW5kZXJDYyhwLCAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbi1TaGFyZUFsaWtlIDQuMCBJbnRlcm5hdGlvbmFsJywgJ2h0dHBzOi8vY3JlYXRpdmVjb21tb25zLm9yZy9saWNlbnNlcy9ieS1zYS80LjAvJylcclxuXHR9LFxyXG5cdHtcclxuXHRcdGlkOiAnY2MtYnktbmMnLFxyXG5cdFx0bGFiZWw6ICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uLU5vbkNvbW1lcmNpYWwgKENDIEJZLU5DIDQuMCknLFxyXG5cdFx0ZGVzY3JpcHRpb246ICdSZXVzZSBhbGxvd2VkIHdpdGggYXR0cmlidXRpb24gZm9yIG5vbi1jb21tZXJjaWFsIHB1cnBvc2VzLicsXHJcblx0XHRyZW5kZXJYaHRtbDogKHApID0+IHJlbmRlckNjKHAsICdDcmVhdGl2ZSBDb21tb25zIEF0dHJpYnV0aW9uLU5vbkNvbW1lcmNpYWwgNC4wIEludGVybmF0aW9uYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LW5jLzQuMC8nKVxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdjYy1ieS1uYy1zYScsXHJcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tTm9uQ29tbWVyY2lhbC1TaGFyZUFsaWtlIChDQyBCWS1OQy1TQSA0LjApJyxcclxuXHRcdGRlc2NyaXB0aW9uOiAnTm9uLWNvbW1lcmNpYWwgcmV1c2U7IGRlcml2YXRpdmVzIG11c3QgdXNlIGlkZW50aWNhbCB0ZXJtcy4nLFxyXG5cdFx0cmVuZGVyWGh0bWw6IChwKSA9PiByZW5kZXJDYyhwLCAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbi1Ob25Db21tZXJjaWFsLVNoYXJlQWxpa2UgNC4wIEludGVybmF0aW9uYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL2xpY2Vuc2VzL2J5LW5jLXNhLzQuMC8nKVxyXG5cdH0sXHJcblx0e1xyXG5cdFx0aWQ6ICdjYzAnLFxyXG5cdFx0bGFiZWw6ICdDQzAgKE5vIHJpZ2h0cyByZXNlcnZlZCknLFxyXG5cdFx0ZGVzY3JpcHRpb246ICdXYWl2ZXMgcmlnaHRzIHRvIHRoZSBleHRlbnQgYWxsb3dlZCBieSBsYXcuJyxcclxuXHRcdHJlbmRlclhodG1sOiByZW5kZXJDYzBcclxuXHR9LFxyXG5cdHtcclxuXHRcdGlkOiAncHVibGljLWRvbWFpbicsXHJcblx0XHRsYWJlbDogJ1B1YmxpYyBkb21haW4gZGVkaWNhdGlvbicsXHJcblx0XHRkZXNjcmlwdGlvbjogJ1NpbXBsZSBwdWJsaWMgZG9tYWluIGRlZGljYXRpb24gdGV4dC4nLFxyXG5cdFx0cmVuZGVyWGh0bWw6IHJlbmRlclB1YmxpY0RvbWFpblxyXG5cdH1cclxuXTtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXRMaWNlbnNlVGVtcGxhdGUoaWQ6IExpY2Vuc2VUZW1wbGF0ZUlkKTogTGljZW5zZVRlbXBsYXRlIHtcclxuXHRyZXR1cm4gTElDRU5TRV9URU1QTEFURVMuZmluZCgodCkgPT4gdC5pZCA9PT0gaWQpID8/IExJQ0VOU0VfVEVNUExBVEVTWzBdO1xyXG59XHJcblxyXG5cclxuIl19