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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTGljZW5zZVRlbXBsYXRlcy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIkxpY2Vuc2VUZW1wbGF0ZXMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBZ0JBLFNBQVMsU0FBUyxDQUFDLEtBQWE7SUFDL0IsT0FBTyxLQUFLO1NBQ1YsT0FBTyxDQUFDLElBQUksRUFBRSxPQUFPLENBQUM7U0FDdEIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxNQUFNLENBQUM7U0FDckIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUM7U0FDdkIsT0FBTyxDQUFDLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztBQUMzQixDQUFDO0FBRUQsU0FBUyxZQUFZLENBQUMsS0FBYSxFQUFFLFNBQWlCO0lBQ3JELE9BQU8sMENBQTBDO1FBQ2hELG1CQUFtQjtRQUNuQiw2REFBNkQ7UUFDN0QsVUFBVTtRQUNWLFlBQVksU0FBUyxDQUFDLEtBQUssQ0FBQyxZQUFZO1FBQ3hDLDhCQUE4QjtRQUM5QiwwRUFBMEU7UUFDMUUsV0FBVztRQUNYLFVBQVU7UUFDVixrQ0FBa0M7UUFDbEMsU0FBUztRQUNULGdCQUFnQjtRQUNoQixXQUFXO1FBQ1gsV0FBVyxDQUFDO0FBQ2QsQ0FBQztBQUVELFNBQVMsdUJBQXVCLENBQUMsTUFBdUU7SUFDdkcsTUFBTSxLQUFLLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0QyxNQUFNLE1BQU0sR0FBRyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3hDLE1BQU0sSUFBSSxHQUFHLFNBQVMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDcEMsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4QyxPQUFPLFlBQVksQ0FBQyxXQUFXLEVBQUU7UUFDaEMsb0JBQW9CO1FBQ3BCLGNB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MkRBQTJELEVBQUUsaURBQWlELENBQUM7S0FDL0k7SUFDRDtRQUNDLEVBQUUsRUFBRSxVQUFVO1FBQ2QsS0FBSyxFQUFFLDJEQUEyRDtRQUNsRSxXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSw4REFBOEQsRUFBRSxpREFBaUQsQ0FBQztLQUNsSjtJQUNEO1FBQ0MsRUFBRSxFQUFFLGFBQWE7UUFDakIsS0FBSyxFQUFFLHlFQUF5RTtRQUNoRixXQUFXLEVBQUUsNkRBQTZEO1FBQzFFLFdBQVcsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsRUFBRSx5RUFBeUUsRUFBRSxvREFBb0QsQ0FBQztLQUNoSztJQUNEO1FBQ0MsRUFBRSxFQUFFLEtBQUs7UUFDVCxLQUFLLEVBQUUsMEJBQTBCO1FBQ2pDLFdBQVcsRUFBRSw2Q0FBNkM7UUFDMUQsV0FBVyxFQUFFLFNBQVM7S0FDdEI7SUFDRDtRQUNDLEVBQUUsRUFBRSxlQUFlO1FBQ25CLEtBQUssRUFBRSwwQkFBMEI7UUFDakMsV0FBVyxFQUFFLHVDQUF1QztRQUNwRCxXQUFXLEVBQUUsa0JBQWtCO0tBQy9CO0NBQ0QsQ0FBQztBQUVGLE1BQU0sVUFBVSxrQkFBa0IsQ0FBQyxFQUFxQjtJQUN2RCxPQUFPLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsSUFBSSxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiZXhwb3J0IHR5cGUgTGljZW5zZVRlbXBsYXRlSWQgPVxuXHR8ICdhbGwtcmlnaHRzLXJlc2VydmVkJ1xuXHR8ICdjYy1ieSdcblx0fCAnY2MtYnktc2EnXG5cdHwgJ2NjLWJ5LW5jJ1xuXHR8ICdjYy1ieS1uYy1zYSdcblx0fCAnY2MwJ1xuXHR8ICdwdWJsaWMtZG9tYWluJztcblxuZXhwb3J0IGludGVyZmFjZSBMaWNlbnNlVGVtcGxhdGUge1xuXHRpZDogTGljZW5zZVRlbXBsYXRlSWQ7XG5cdGxhYmVsOiBzdHJpbmc7XG5cdGRlc2NyaXB0aW9uOiBzdHJpbmc7XG5cdHJlbmRlclhodG1sOiAocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0pID0+IHN0cmluZztcbn1cblxuZnVuY3Rpb24gZXNjYXBlWG1sKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRyZXR1cm4gdmFsdWVcblx0XHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKVxuXHRcdC5yZXBsYWNlKC88L2csICcmbHQ7Jylcblx0XHQucmVwbGFjZSgvPi9nLCAnJmd0OycpXG5cdFx0LnJlcGxhY2UoL1wiL2csICcmcXVvdDsnKVxuXHRcdC5yZXBsYWNlKC8nL2csICcmYXBvczsnKTtcbn1cblxuZnVuY3Rpb24gcGFnZVRlbXBsYXRlKHRpdGxlOiBzdHJpbmcsIGJvZHlJbm5lcjogc3RyaW5nKTogc3RyaW5nIHtcblx0cmV0dXJuIGA8P3htbCB2ZXJzaW9uPVwiMS4wXCIgZW5jb2Rpbmc9XCJ1dGYtOFwiPz5cXG5gICtcblx0XHRgPCFET0NUWVBFIGh0bWw+XFxuYCArXG5cdFx0YDxodG1sIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiIHhtbDpsYW5nPVwiZW5cIj5cXG5gICtcblx0XHRgPGhlYWQ+XFxuYCArXG5cdFx0YCAgPHRpdGxlPiR7ZXNjYXBlWG1sKHRpdGxlKX08L3RpdGxlPlxcbmAgK1xuXHRcdGAgIDxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiIC8+XFxuYCArXG5cdFx0YCAgPGxpbmsgcmVsPVwic3R5bGVzaGVldFwiIHR5cGU9XCJ0ZXh0L2Nzc1wiIGhyZWY9XCIuLi9TdHlsZXMvc3R5bGUuY3NzXCIgLz5cXG5gICtcblx0XHRgPC9oZWFkPlxcbmAgK1xuXHRcdGA8Ym9keT5cXG5gICtcblx0XHRgPHNlY3Rpb24gY2xhc3M9XCJmcm9udC1tYXR0ZXJcIj5cXG5gICtcblx0XHRib2R5SW5uZXIgK1xuXHRcdGBcXG48L3NlY3Rpb24+XFxuYCArXG5cdFx0YDwvYm9keT5cXG5gICtcblx0XHRgPC9odG1sPlxcbmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckFsbFJpZ2h0c1Jlc2VydmVkKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9KTogc3RyaW5nIHtcblx0Y29uc3QgdGl0bGUgPSBlc2NhcGVYbWwocGFyYW1zLnRpdGxlKTtcblx0Y29uc3QgYXV0aG9yID0gZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpO1xuXHRjb25zdCB5ZWFyID0gZXNjYXBlWG1sKHBhcmFtcy55ZWFyKTtcblx0Y29uc3QgaG9sZGVyID0gZXNjYXBlWG1sKHBhcmFtcy5ob2xkZXIpO1xuXHRyZXR1cm4gcGFnZVRlbXBsYXRlKCdDb3B5cmlnaHQnLCBbXG5cdFx0YDxoMT5Db3B5cmlnaHQ8L2gxPmAsXG5cdFx0YDxwPjxzdHJvbmc+JHt0aXRsZX08L3N0cm9uZz48L3A+YCxcblx0XHRhdXRob3IgPyBgPHA+JHthdXRob3J9PC9wPmAgOiAnJyxcblx0XHR5ZWFyICYmIGhvbGRlciA/IGA8cD5Db3B5cmlnaHQgwqkgJHt5ZWFyfSAke2hvbGRlcn08L3A+YCA6ICcnLFxuXHRcdGA8cD5BbGwgcmlnaHRzIHJlc2VydmVkLjwvcD5gLFxuXHRcdGA8cD5ObyBwYXJ0IG9mIHRoaXMgYm9vayBtYXkgYmUgcmVwcm9kdWNlZCwgc3RvcmVkIGluIGEgcmV0cmlldmFsIHN5c3RlbSwgb3IgdHJhbnNtaXR0ZWQgaW4gYW55IGZvcm0gb3IgYnkgYW55IG1lYW5zIHdpdGhvdXQgcHJpb3Igd3JpdHRlbiBwZXJtaXNzaW9uLCBleGNlcHQgYXMgcGVybWl0dGVkIGJ5IGxhdy48L3A+YFxuXHRdLmZpbHRlcihCb29sZWFuKS5qb2luKCdcXG4nKSlcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2MocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0sIG5hbWU6IHN0cmluZywgdXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuXHRjb25zdCB0aXRsZSA9IGVzY2FwZVhtbChwYXJhbXMudGl0bGUpO1xuXHRjb25zdCBhdXRob3IgPSBlc2NhcGVYbWwocGFyYW1zLmF1dGhvcik7XG5cdGNvbnN0IHllYXIgPSBlc2NhcGVYbWwocGFyYW1zLnllYXIpO1xuXHRjb25zdCBob2xkZXIgPSBlc2NhcGVYbWwocGFyYW1zLmhvbGRlcik7XG5cdHJldHVybiBwYWdlVGVtcGxhdGUoJ0xpY2Vuc2UnLCBbXG5cdFx0YDxoMT5MaWNlbnNlPC9oMT5gLFxuXHRcdGA8cD48c3Ryb25nPiR7dGl0bGV9PC9zdHJvbmc+PC9wPmAsXG5cdFx0YXV0aG9yID8gYDxwPiR7YXV0aG9yfTwvcD5gIDogJycsXG5cdFx0eWVhciAmJiBob2xkZXIgPyBgPHA+Q29weXJpZ2h0IMKpICR7eWVhcn0gJHtob2xkZXJ9PC9wPmAgOiAnJyxcblx0XHRgPHA+VGhpcyB3b3JrIGlzIGxpY2Vuc2VkIHVuZGVyIDxzdHJvbmc+JHtlc2NhcGVYbWwobmFtZSl9PC9zdHJvbmc+LjwvcD5gLFxuXHRcdGA8cD5MaWNlbnNlIFVSTDogPGEgaHJlZj1cIiR7ZXNjYXBlWG1sKHVybCl9XCI+JHtlc2NhcGVYbWwodXJsKX08L2E+PC9wPmBcblx0XS5maWx0ZXIoQm9vbGVhbikuam9pbignXFxuJykpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDYzAocGFyYW1zOiB7IHRpdGxlOiBzdHJpbmc7IGF1dGhvcjogc3RyaW5nOyB5ZWFyOiBzdHJpbmc7IGhvbGRlcjogc3RyaW5nIH0pOiBzdHJpbmcge1xuXHRyZXR1cm4gcmVuZGVyQ2MocGFyYW1zLCAnQ0MwIDEuMCBVbml2ZXJzYWwnLCAnaHR0cHM6Ly9jcmVhdGl2ZWNvbW1vbnMub3JnL3B1YmxpY2RvbWFpbi96ZXJvLzEuMC8nKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUHVibGljRG9tYWluKHBhcmFtczogeyB0aXRsZTogc3RyaW5nOyBhdXRob3I6IHN0cmluZzsgeWVhcjogc3RyaW5nOyBob2xkZXI6IHN0cmluZyB9KTogc3RyaW5nIHtcblx0Y29uc3QgdGl0bGUgPSBlc2NhcGVYbWwocGFyYW1zLnRpdGxlKTtcblx0Y29uc3QgYXV0aG9yID0gZXNjYXBlWG1sKHBhcmFtcy5hdXRob3IpO1xuXHRyZXR1cm4gcGFnZVRlbXBsYXRlKCdQdWJsaWMgZG9tYWluJywgW1xuXHRcdGA8aDE+UHVibGljIGRvbWFpbjwvaDE+YCxcblx0XHRgPHA+PHN0cm9uZz4ke3RpdGxlfTwvc3Ryb25nPjwvcD5gLFxuXHRcdGF1dGhvciA/IGA8cD4ke2F1dGhvcn08L3A+YCA6ICcnLFxuXHRcdGA8cD5UaGlzIHdvcmsgaXMgZGVkaWNhdGVkIHRvIHRoZSBwdWJsaWMgZG9tYWluLjwvcD5gXG5cdF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xcbicpKTtcbn1cblxuZXhwb3J0IGNvbnN0IExJQ0VOU0VfVEVNUExBVEVTOiBMaWNlbnNlVGVtcGxhdGVbXSA9IFtcblx0e1xuXHRcdGlkOiAnYWxsLXJpZ2h0cy1yZXNlcnZlZCcsXG5cdFx0bGFiZWw6ICdBbGwgcmlnaHRzIHJlc2VydmVkJyxcblx0XHRkZXNjcmlwdGlvbjogJ1N0YW5kYXJkIGNvcHlyaWdodCBub3RpY2UgZm9yIHRyYWRpdGlvbmFsIHB1Ymxpc2hpbmcuJyxcblx0XHRyZW5kZXJYaHRtbDogcmVuZGVyQWxsUmlnaHRzUmVzZXJ2ZWRcblx0fSxcblx0e1xuXHRcdGlkOiAnY2MtYnknLFxuXHRcdGxhYmVsOiAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbiAoQ0MgQlkgNC4wKScsXG5cdFx0ZGVzY3JpcHRpb246ICdPdGhlcnMgY2FuIGRpc3RyaWJ1dGUgYW5kIGJ1aWxkIHVwb24geW91ciB3b3JrLCBpbmNsdWRpbmcgY29tbWVyY2lhbGx5LCB3aXRoIGF0dHJpYnV0aW9uLicsXG5cdFx0cmVuZGVyWGh0bWw6IChwKSA9PiByZW5kZXJDYyhwLCAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbiA0LjAgSW50ZXJuYXRpb25hbCcsICdodHRwczovL2NyZWF0aXZlY29tbW9ucy5vcmcvbGljZW5zZXMvYnkvNC4wLycpXG5cdH0sXG5cdHtcblx0XHRpZDogJ2NjLWJ5LXNhJyxcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tU2hhcmVBbGlrZSAoQ0MgQlktU0EgNC4wKScsXG5cdFx0ZGVzY3JpcHRpb246ICdEZXJpdmF0aXZlcyBtdXN0IGJlIGxpY2Vuc2VkIHVuZGVyIGlkZW50aWNhbCB0ZXJtcy4nLFxuXHRcdHJlbmRlclhodG1sOiAocCkgPT4gcmVuZGVyQ2MocCwgJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tU2hhcmVBbGlrZSA0LjAgSW50ZXJuYXRpb25hbCcsICdodHRwczovL2NyZWF0aXZlY29tbW9ucy5vcmcvbGljZW5zZXMvYnktc2EvNC4wLycpXG5cdH0sXG5cdHtcblx0XHRpZDogJ2NjLWJ5LW5jJyxcblx0XHRsYWJlbDogJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tTm9uQ29tbWVyY2lhbCAoQ0MgQlktTkMgNC4wKScsXG5cdFx0ZGVzY3JpcHRpb246ICdSZXVzZSBhbGxvd2VkIHdpdGggYXR0cmlidXRpb24gZm9yIG5vbi1jb21tZXJjaWFsIHB1cnBvc2VzLicsXG5cdFx0cmVuZGVyWGh0bWw6IChwKSA9PiByZW5kZXJDYyhwLCAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbi1Ob25Db21tZXJjaWFsIDQuMCBJbnRlcm5hdGlvbmFsJywgJ2h0dHBzOi8vY3JlYXRpdmVjb21tb25zLm9yZy9saWNlbnNlcy9ieS1uYy80LjAvJylcblx0fSxcblx0e1xuXHRcdGlkOiAnY2MtYnktbmMtc2EnLFxuXHRcdGxhYmVsOiAnQ3JlYXRpdmUgQ29tbW9ucyBBdHRyaWJ1dGlvbi1Ob25Db21tZXJjaWFsLVNoYXJlQWxpa2UgKENDIEJZLU5DLVNBIDQuMCknLFxuXHRcdGRlc2NyaXB0aW9uOiAnTm9uLWNvbW1lcmNpYWwgcmV1c2U7IGRlcml2YXRpdmVzIG11c3QgdXNlIGlkZW50aWNhbCB0ZXJtcy4nLFxuXHRcdHJlbmRlclhodG1sOiAocCkgPT4gcmVuZGVyQ2MocCwgJ0NyZWF0aXZlIENvbW1vbnMgQXR0cmlidXRpb24tTm9uQ29tbWVyY2lhbC1TaGFyZUFsaWtlIDQuMCBJbnRlcm5hdGlvbmFsJywgJ2h0dHBzOi8vY3JlYXRpdmVjb21tb25zLm9yZy9saWNlbnNlcy9ieS1uYy1zYS80LjAvJylcblx0fSxcblx0e1xuXHRcdGlkOiAnY2MwJyxcblx0XHRsYWJlbDogJ0NDMCAoTm8gcmlnaHRzIHJlc2VydmVkKScsXG5cdFx0ZGVzY3JpcHRpb246ICdXYWl2ZXMgcmlnaHRzIHRvIHRoZSBleHRlbnQgYWxsb3dlZCBieSBsYXcuJyxcblx0XHRyZW5kZXJYaHRtbDogcmVuZGVyQ2MwXG5cdH0sXG5cdHtcblx0XHRpZDogJ3B1YmxpYy1kb21haW4nLFxuXHRcdGxhYmVsOiAnUHVibGljIGRvbWFpbiBkZWRpY2F0aW9uJyxcblx0XHRkZXNjcmlwdGlvbjogJ1NpbXBsZSBwdWJsaWMgZG9tYWluIGRlZGljYXRpb24gdGV4dC4nLFxuXHRcdHJlbmRlclhodG1sOiByZW5kZXJQdWJsaWNEb21haW5cblx0fVxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldExpY2Vuc2VUZW1wbGF0ZShpZDogTGljZW5zZVRlbXBsYXRlSWQpOiBMaWNlbnNlVGVtcGxhdGUge1xuXHRyZXR1cm4gTElDRU5TRV9URU1QTEFURVMuZmluZCgodCkgPT4gdC5pZCA9PT0gaWQpID8/IExJQ0VOU0VfVEVNUExBVEVTWzBdO1xufVxuXG5cbiJdfQ==