import type { App } from 'obsidian';
import { Notice, TFile, TFolder } from 'obsidian';
import type WritingDashboardPlugin from '../main';
import { fnv1a32 } from './ContentHash';

export interface GenerationLogStart {
	mode: 'chapter' | 'micro-edit' | 'character-update' | 'story-bible' | 'publish';
	title: string;
	model: string;
	provider: string;
	queryText: string;
	userInputs: Record<string, string>;
	retrievedContext: string;
	finalPrompt?: string;
}

export interface GenerationLogFinish {
	outputText?: string;
	error?: string;
}

function normalizeFolder(folder: string): string {
	const f = (folder || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
	return f.length ? f : 'Generation logs';
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function timestampForFile(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}

function escapeFenceContent(s: string): string {
	// Avoid accidental closing fences inside logs.
	return (s || '').replace(/```/g, '``\\`');
}

export class GenerationLogService {
	private readonly app: App;
	private readonly plugin: WritingDashboardPlugin;

	constructor(app: App, plugin: WritingDashboardPlugin) {
		this.app = app;
		this.plugin = plugin;
	}

	getFolderPath(): string {
		return normalizeFolder(this.plugin.settings.generationLogsFolder);
	}

	async ensureFolder(): Promise<void> {
		const folderPath = this.getFolderPath();
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing instanceof TFolder) return;
		try {
			await this.app.vault.createFolder(folderPath);
		} catch {
			// Folder may already exist or fail due to permissions; ignore.
		}
	}

	async startLog(params: GenerationLogStart): Promise<string | null> {
		if (!this.plugin.settings.generationLogsEnabled) return null;
		await this.ensureFolder();

		const now = new Date();
		const folder = this.getFolderPath();
		const stamp = timestampForFile(now);
		const safeTitle = (params.title || 'Run').trim().slice(0, 80) || 'Run';
		const fileName = `${stamp} ${safeTitle}.md`;
		const path = `${folder}/${fileName}`.replace(/\/+/g, '/');

		const inputsLines = Object.entries(params.userInputs)
			.map(([k, v]) => `- ${k}: ${v ? `${v.length} chars` : '0 chars'}`)
			.join('\n');

		const body =
			`# Generation log\n\n` +
			`- Mode: ${params.mode}\n` +
			`- Provider: ${params.provider}\n` +
			`- Model: ${params.model}\n` +
			`- Time: ${now.toISOString()}\n` +
			`- Query hash: ${fnv1a32(params.queryText || '')}\n\n` +
			`## Inputs\n\n` +
			`${inputsLines}\n\n` +
			`## Query\n\n` +
			'```text\n' +
			`${escapeFenceContent(params.queryText || '')}\n` +
			'```\n\n' +
			`## Retrieved context\n\n` +
			'```text\n' +
			`${escapeFenceContent(params.retrievedContext || '')}\n` +
			'```\n\n' +
			(params.finalPrompt
				? `## Final prompt\n\n\`\`\`text\n${escapeFenceContent(params.finalPrompt)}\n\`\`\`\n\n`
				: '');

		try {
			await this.app.vault.create(path, body);
			return path;
		} catch {
			new Notice('Failed to write generation log.');
			return null;
		}
	}

	async finishLog(path: string | null, params: GenerationLogFinish): Promise<void> {
		if (!path) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;

		const appendix =
			`## Result\n\n` +
			(params.error
				? `Error: ${params.error}\n\n`
				: 'Status: Success\n\n') +
			(params.outputText
				? `\`\`\`text\n${escapeFenceContent(params.outputText)}\n\`\`\`\n`
				: '');

		try {
			const existing = await this.app.vault.read(file);
			await this.app.vault.modify(file, `${existing}\n${appendix}`);
		} catch {
			// ignore
		}
	}
}


