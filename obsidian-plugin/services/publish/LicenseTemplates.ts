export type LicenseTemplateId =
	| 'all-rights-reserved'
	| 'cc-by'
	| 'cc-by-sa'
	| 'cc-by-nc'
	| 'cc-by-nc-sa'
	| 'cc0'
	| 'public-domain';

export interface LicenseTemplate {
	id: LicenseTemplateId;
	label: string;
	description: string;
	renderXhtml: (params: { title: string; author: string; year: string; holder: string }) => string;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function pageTemplate(title: string, bodyInner: string): string {
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

function renderAllRightsReserved(params: { title: string; author: string; year: string; holder: string }): string {
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
	].filter(Boolean).join('\n'))
}

function renderCc(params: { title: string; author: string; year: string; holder: string }, name: string, url: string): string {
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

function renderCc0(params: { title: string; author: string; year: string; holder: string }): string {
	return renderCc(params, 'CC0 1.0 Universal', 'https://creativecommons.org/publicdomain/zero/1.0/');
}

function renderPublicDomain(params: { title: string; author: string; year: string; holder: string }): string {
	const title = escapeXml(params.title);
	const author = escapeXml(params.author);
	return pageTemplate('Public domain', [
		`<h1>Public domain</h1>`,
		`<p><strong>${title}</strong></p>`,
		author ? `<p>${author}</p>` : '',
		`<p>This work is dedicated to the public domain.</p>`
	].filter(Boolean).join('\n'));
}

export const LICENSE_TEMPLATES: LicenseTemplate[] = [
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

export function getLicenseTemplate(id: LicenseTemplateId): LicenseTemplate {
	return LICENSE_TEMPLATES.find((t) => t.id === id) ?? LICENSE_TEMPLATES[0];
}


