import WritingDashboardPlugin, { DashboardSettings } from '../main';

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
		
		const response = await fetch(`${this.baseUrl}${endpoint}`, {
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
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Backend error: ${response.status} - ${errorText}`);
		}
		
		return await response.json();
	}

	async extractCharacters(params: {
		selectedText: string;
		settings: DashboardSettings;
	}): Promise<{ updates: Array<{ character: string; update: string }> }> {
		const response = await fetch(`${this.baseUrl}/api/extract/characters`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				selectedText: params.selectedText,
				settings: params.settings
			})
		});
		
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Backend error: ${response.status} - ${errorText}`);
		}
		
		return await response.json();
	}

	async healthCheck(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`);
			return response.ok;
		} catch {
			return false;
		}
	}
}

