import WritingDashboardPlugin, { DashboardSettings } from '../main';

export interface MultiModelResult {
	primary: string;
	alternatives?: string[];
	revision?: string;
	stages?: {
		draft?: string;
		characterChecked?: string;
		styleRefined?: string;
		final?: string;
	};
}

export class AIClient {
	private _safeJsonPreview(value: unknown, maxLen = 1200): string {
		try {
			const text = JSON.stringify(value);
			if (!text) return '';
			return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
		} catch {
			return '';
		}
	}

	async generate(
		prompt: string,
		settings: DashboardSettings
	): Promise<string | MultiModelResult> {
		if (settings.generationMode === 'multi') {
			return await this.generateMulti(prompt, settings);
		} else {
			return await this.generateSingle(prompt, settings);
		}
	}

	private async generateSingle(
		prompt: string,
		settings: DashboardSettings
	): Promise<string> {
		if (settings.apiProvider === 'openrouter') {
			return await this._generateOpenRouter(prompt, settings);
		} else if (settings.apiProvider === 'openai') {
			return await this._generateOpenAI(prompt, settings);
		} else if (settings.apiProvider === 'anthropic') {
			return await this._generateAnthropic(prompt, settings);
		} else if (settings.apiProvider === 'gemini') {
			return await this._generateGemini(prompt, settings);
		} else {
			throw new Error(`Unsupported provider: ${settings.apiProvider}`);
		}
	}

	private async generateMulti(
		prompt: string,
		settings: DashboardSettings
	): Promise<MultiModelResult> {
		if (settings.multiStrategy === 'draft-revision') {
			return await this.generateDraftRevision(prompt, settings);
		} else if (settings.multiStrategy === 'consensus-multistage') {
			return await this.generateConsensusMultiStage(prompt, settings);
		} else {
			throw new Error(`Unsupported multi-strategy: ${settings.multiStrategy}`);
		}
	}

	private async generateDraftRevision(
		prompt: string,
		settings: DashboardSettings
	): Promise<MultiModelResult> {
		if (!settings.draftModel || !settings.revisionModel) {
			throw new Error('Draft and revision models must be configured for draft-revision strategy');
		}

		// Stage 1: Generate draft with fast model
		const draftSettings: DashboardSettings = {
			...settings,
			model: settings.draftModel
		};
		const draft = await this.generateSingle(prompt, draftSettings);

		// Stage 2: Refine with quality model
		const revisionPrompt = `Refine the following draft to improve prose quality, maintain character voice consistency, enhance narrative flow, and ensure stylistic coherence:\n\n${draft}`;
		
		const revisionSettings: DashboardSettings = {
			...settings,
			model: settings.revisionModel
		};
		const revision = await this.generateSingle(revisionPrompt, revisionSettings);

		return {
			primary: revision,
			revision: revision,
			stages: {
				draft: draft,
				final: revision
			}
		};
	}

	private async generateConsensusMultiStage(
		prompt: string,
		settings: DashboardSettings
	): Promise<MultiModelResult> {
		if (!settings.consensusModel1 || !settings.consensusModel2) {
			throw new Error('At least 2 consensus models must be configured');
		}

		// Stage 1: Parallel consensus generation (2-3 models generate simultaneously)
		const consensusModels = [
			settings.consensusModel1,
			settings.consensusModel2,
			settings.consensusModel3
		].filter(Boolean) as string[];

		const consensusPromises = consensusModels.map(model => {
			const modelSettings: DashboardSettings = { ...settings, model };
			return this.generateSingle(prompt, modelSettings);
		});

		const consensusResults = await Promise.all(consensusPromises);
		const primaryDraft = consensusResults[0];

		// Stage 2: Character consistency check
		const characterCheckPrompt = `Review this passage for character voice consistency, dialogue authenticity, and character trait alignment. Maintain all character personalities and ensure dialogue matches each character's established voice:\n\n${primaryDraft}`;
		
		const characterSettings: DashboardSettings = {
			...settings,
			model: settings.consensusModel1
		};
		const characterChecked = await this.generateSingle(characterCheckPrompt, characterSettings);

		// Stage 3: Style/voice refinement
		const stylePrompt = `Refine this passage to match the author's unique style and narrative voice. Ensure prose quality, pacing, and stylistic coherence throughout:\n\n${characterChecked}`;
		
		const styleSettings: DashboardSettings = {
			...settings,
			model: settings.consensusModel1
		};
		const styleRefined = await this.generateSingle(stylePrompt, styleSettings);

		// Stage 4: Final synthesis (combine best elements from consensus)
		let final = styleRefined;
		if (settings.synthesisModel && consensusResults.length > 1) {
			const synthesisPrompt = `Combine the best elements from these alternative versions into a single refined passage. Prioritize quality, coherence, and the most compelling narrative elements:\n\n${consensusResults.map((alt, i) => `Version ${i + 1}:\n${alt}`).join('\n\n---\n\n')}`;
			
			const synthesisSettings: DashboardSettings = {
				...settings,
				model: settings.synthesisModel
			};
			final = await this.generateSingle(synthesisPrompt, synthesisSettings);
		}

		return {
			primary: final,
			alternatives: consensusResults.slice(1),
			revision: final,
			stages: {
				draft: primaryDraft,
				characterChecked: characterChecked,
				styleRefined: styleRefined,
				final: final
			}
		};
	}

	private async _generateOpenRouter(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${settings.apiKey}`,
				'HTTP-Referer': 'https://github.com/JHarp199345/Gwriter',
				'X-Title': 'Writing Dashboard'
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
			throw new Error(`OpenRouter API error: ${error.error?.message || response.statusText}`);
		}

		const data = await response.json();
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new Error(
				`OpenRouter response missing message content. ` +
				`Preview: ${this._safeJsonPreview(data?.error || data)}`
			);
		}
		return content;
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
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new Error(
				`OpenAI response missing message content. ` +
				`Preview: ${this._safeJsonPreview(data?.error || data)}`
			);
		}
		return content;
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
		const text = data?.content?.[0]?.text;
		if (typeof text !== 'string' || text.trim().length === 0) {
			throw new Error(
				`Anthropic response missing content text. ` +
				`Preview: ${this._safeJsonPreview(data?.error || data)}`
			);
		}
		return text;
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

		const candidates = data?.candidates;
		if (!Array.isArray(candidates) || candidates.length === 0) {
			const blockReason = data?.promptFeedback?.blockReason;
			const details =
				blockReason ? ` blockReason=${String(blockReason)}` : '';
			const preview = this._safeJsonPreview(
				data?.error || data?.promptFeedback || data
			);
			throw new Error(
				`Gemini returned no candidates.${details} Preview: ${preview}`
			);
		}

		const parts = candidates?.[0]?.content?.parts;
		const text = Array.isArray(parts)
			? parts.map((p: any) => p?.text).filter(Boolean).join('\n')
			: undefined;

		if (typeof text !== 'string' || text.trim().length === 0) {
			const finishReason = candidates?.[0]?.finishReason;
			const preview = this._safeJsonPreview(candidates?.[0] || data);
			throw new Error(
				`Gemini candidate missing text. finishReason=${String(finishReason)} Preview: ${preview}`
			);
		}

		return text;
	}
}

