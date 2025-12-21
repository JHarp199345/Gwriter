import type { Vault } from 'obsidian';
import { markdownToPlainText } from './ExportTextUtils';

export interface ExportRtfParams {
	title: string;
	author: string;
	chapters: Array<{ title: string; markdown: string; sourcePath: string }>;
	outputFolder: string;
	outputFileName: string; // should end with .rtf
}

function normalizeFolder(folder: string): string {
	const f = folder.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	return f.length ? f : 'Exports';
}

function ensureRtfExt(name: string): string {
	return name.toLowerCase().endsWith('.rtf') ? name : `${name}.rtf`;
}

function escapeRtfText(text: string): string {
	return (text || '')
		.replace(/\\/g, '\\\\')
		.replace(/{/g, '\\{')
		.replace(/}/g, '\\}')
		.replace(/\r?\n/g, '\\par\n');
}

export class RtfExportService {
	private readonly vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async export(params: ExportRtfParams): Promise<string> {
		const folder = normalizeFolder(params.outputFolder);
		const fileName = ensureRtfExt(params.outputFileName);
		const outPath = `${folder}/${fileName}`.replace(/\/+/g, '/');

		// Simple manuscript-ish layout: 1-inch margins approximated by default, double-spaced via \sl.
		const parts: string[] = [];
		parts.push('{\\rtf1\\ansi\\deff0');
		parts.push('{\\fonttbl{\\f0 Times New Roman;}}');
		parts.push('\\fs24'); // 12pt
		parts.push('\\sl480\\slmult1'); // ~double-spaced

		const title = escapeRtfText(params.title || 'Untitled');
		const author = escapeRtfText(params.author || '');
		parts.push(`\\qc\\b ${title}\\b0\\par`);
		if (author) parts.push(`\\qc ${author}\\par`);
		parts.push('\\ql\\par\\par');

		for (const ch of params.chapters) {
			const chTitle = escapeRtfText(ch.title || 'Chapter');
			parts.push(`\\qc\\b ${chTitle}\\b0\\par`);
			parts.push('\\ql\\par');
			const body = markdownToPlainText(ch.markdown || '');
			parts.push(escapeRtfText(body));
			parts.push('\\par\\par');
		}

		parts.push('}');
		const rtf = parts.join('\n');

		// RTF is plain text; write via adapter.
		await this.vault.adapter.mkdir(folder).catch(() => {});
		await this.vault.adapter.write(outPath, rtf);
		return outPath;
	}
}


