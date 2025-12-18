import WritingDashboardPlugin, { DashboardSettings } from '../main';

export class AIClient {
	async generate(
		prompt: string,
		settings: DashboardSettings
	): Promise<string> {
		if (settings.apiProvider === 'openai') {
			return await this._generateOpenAI(prompt, settings);
		} else if (settings.apiProvider === 'anthropic') {
			return await this._generateAnthropic(prompt, settings);
		} else if (settings.apiProvider === 'gemini') {
			return await this._generateGemini(prompt, settings);
		} else {
			throw new Error(`Unsupported provider: ${settings.apiProvider}`);
		}
	}

	private async _generateOpenAI(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${settings.apiKey}`
			},
			body: JSON.stringify({
				model: settings.model,
				messages: [
					{ role: 'system', content: 'You are a professional writing assistant.' },
					{ role: 'user', content: prompt }
				],
				max_tokens: 4000,
				temperature: 0.7
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
			throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
		}

		const data = await response.json();
		return data.choices[0].message.content;
	}

	private async _generateAnthropic(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': settings.apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: settings.model,
				max_tokens: 4000,
				messages: [
					{ role: 'user', content: prompt }
				]
			})
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
			throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
		}

		const data = await response.json();
		return data.content[0].text;
	}

	private async _generateGemini(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: prompt
						}]
					}],
					generationConfig: {
						maxOutputTokens: 4000,
						temperature: 0.7
					}
				})
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
			throw new Error(`Gemini API error: ${error.error?.message || response.statusText}`);
		}

		const data = await response.json();
		return data.candidates[0].content.parts[0].text;
	}
}

