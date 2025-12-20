import { requestUrl } from 'obsidian';
import type { DashboardSettings } from '../main';

export class PythonBridge {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	async generate(params: {
		mode: 'chapter' | 'micro-edit' | 'character-update';
		selectedText?: string;
		directorNotes?: string;
		wordCount?: number;
		settings: DashboardSettings;
	}): Promise<{ text: string }> {
		const endpoint = params.mode === 'chapter' 
			? '/api/generate/chapter'
			: '/api/generate/micro-edit';
		
		const response = await requestUrl({
			url: `${this.baseUrl}${endpoint}`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: params.mode,
				selectedText: params.selectedText,
				directorNotes: params.directorNotes,
				wordCount: params.wordCount,
				settings: params.settings
			})
		});
		
		if (response.status >= 400) {
			throw new Error(`Backend error: ${response.status} - ${response.text || ''}`);
		}
		
		return (response.json as { text: string }) ?? JSON.parse(response.text);
	}

	async extractCharacters(params: {
		selectedText: string;
		settings: DashboardSettings;
	}): Promise<{ updates: Array<{ character: string; update: string }> }> {
		const response = await requestUrl({
			url: `${this.baseUrl}/api/extract/characters`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				selectedText: params.selectedText,
				settings: params.settings
			})
		});
		
		if (response.status >= 400) {
			throw new Error(`Backend error: ${response.status} - ${response.text || ''}`);
		}
		
		return (response.json as { updates: Array<{ character: string; update: string }> }) ?? JSON.parse(response.text);
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await requestUrl({ url: `${this.baseUrl}/health`, method: 'GET' });
			return response.status >= 200 && response.status < 300;
		} catch {
			return false;
		}
	}
}

