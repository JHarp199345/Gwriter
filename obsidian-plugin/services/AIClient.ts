import { requestUrl, type RequestUrlResponse } from 'obsidian';
import type { DashboardSettings } from '../main';
import { estimateTokens } from './TokenEstimate';

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
	private _formatUnknown(value: unknown): string {
		if (value instanceof Error) return value.message;
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean') {
			return value.toString();
		}
		if (typeof value === 'bigint') {
			return 'bigint';
		}
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		try {
			return JSON.stringify(value);
		} catch {
			return '[unserializable value]';
		}
	}
	private _getJson(resp: RequestUrlResponse): unknown {
		// requestUrl may populate `json`, but fall back to parsing `text` when needed.
		const anyResp = resp as unknown as { json?: unknown; text?: string };
		if (anyResp.json !== undefined) return anyResp.json;
		if (typeof anyResp.text === 'string' && anyResp.text.trim().length > 0) {
			try {
				return JSON.parse(anyResp.text);
			} catch {
				return { text: anyResp.text };
			}
		}
		return undefined;
	}

	private _getNestedErrorMessage(payload: unknown): string | undefined {
		if (!payload || typeof payload !== 'object') return undefined;
		const obj = payload as Record<string, unknown>;

		// Common: { error: { message: string } }
		const err = obj.error;
		if (err && typeof err === 'object') {
			const errObj = err as Record<string, unknown>;
			const msg = errObj.message;
			if (typeof msg === 'string' && msg.trim().length > 0) return msg;
		}

		// Sometimes: { message: string }
		const msg = obj.message;
		if (typeof msg === 'string' && msg.trim().length > 0) return msg;

		// Sometimes: { error: string }
		if (typeof err === 'string' && err.trim().length > 0) return err;

		return undefined;
	}

	private _getOpenAIStyleContent(payload: unknown): string | undefined {
		if (!payload || typeof payload !== 'object') return undefined;
		const obj = payload as Record<string, unknown>;
		const choices = obj.choices;
		if (!Array.isArray(choices) || choices.length === 0) return undefined;
		const first = choices[0];
		if (!first || typeof first !== 'object') return undefined;
		const message = (first as Record<string, unknown>).message;
		if (!message || typeof message !== 'object') return undefined;
		const content = (message as Record<string, unknown>).content;
		return typeof content === 'string' ? content : undefined;
	}

	private _safeJsonPreview(value: unknown, maxLen = 1200): string {
		try {
			const text = JSON.stringify(value);
			if (!text) return '';
			return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
		} catch {
			return '';
		}
	}

	async generate(prompt: string, settings: DashboardSettings & { generationMode: 'single' }): Promise<string>;
	async generate(prompt: string, settings: DashboardSettings & { generationMode: 'multi' }): Promise<MultiModelResult>;
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
		// Capture before narrowing so template literals don't end up with `never` types in unreachable branches.
		const provider = settings.apiProvider;
		if (settings.apiProvider === 'openrouter') {
			return await this._generateOpenRouter(prompt, settings);
		} else if (settings.apiProvider === 'openai') {
			return await this._generateOpenAI(prompt, settings);
		} else if (settings.apiProvider === 'anthropic') {
			return await this._generateAnthropic(prompt, settings);
		} else if (settings.apiProvider === 'gemini') {
			return await this._generateGemini(prompt, settings);
		} else {
			throw new Error(`Unsupported provider: ${provider}`);
		}
	}

	private async generateMulti(
		prompt: string,
		settings: DashboardSettings
	): Promise<MultiModelResult> {
		// Capture before narrowing so template literals don't end up with `never` types in unreachable branches.
		const strategy = settings.multiStrategy;
		if (settings.multiStrategy === 'draft-revision') {
			return await this.generateDraftRevision(prompt, settings);
		} else if (settings.multiStrategy === 'consensus-multistage') {
			return await this.generateConsensusMultiStage(prompt, settings);
		} else {
			throw new Error(`Unsupported multi-strategy: ${strategy}`);
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
		].filter((m): m is string => typeof m === 'string' && m.length > 0);

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
		const response = await requestUrl({
			url: 'https://openrouter.ai/api/v1/chat/completions',
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

		if (response.status >= 400) {
			const error = this._getJson(response);
			throw new Error(`OpenRouter API error: ${this._getNestedErrorMessage(error) || response.status}`);
		}

		const data = this._getJson(response);
		const content = this._getOpenAIStyleContent(data);
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new Error(
				`OpenRouter response missing message content. ` +
				`Preview: ${this._safeJsonPreview(data)}`
			);
		}
		return content;
	}

	private async _generateOpenAI(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.openai.com/v1/chat/completions',
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

		if (response.status >= 400) {
			const error = this._getJson(response);
			throw new Error(`OpenAI API error: ${this._getNestedErrorMessage(error) || response.status}`);
		}

		const data = this._getJson(response);
		const content = this._getOpenAIStyleContent(data);
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new Error(
				`OpenAI response missing message content. ` +
				`Preview: ${this._safeJsonPreview(data)}`
			);
		}
		return content;
	}

	private async _generateAnthropic(prompt: string, settings: DashboardSettings): Promise<string> {
		const response = await requestUrl({
			url: 'https://api.anthropic.com/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': settings.apiKey,
				'anthropic-version': '2023-06-01'
			},
			body: JSON.stringify({
				model: settings.model,
				max_tokens: 4000,
				messages: [{ role: 'user', content: prompt }]
			})
		});

		if (response.status >= 400) {
			const error = this._getJson(response);
			throw new Error(`Anthropic API error: ${this._getNestedErrorMessage(error) || response.status}`);
		}

		const data = this._getJson(response);
		let text: string | undefined;
		if (data && typeof data === 'object') {
			const obj = data as Record<string, unknown>;
			const content = obj.content;
			if (Array.isArray(content) && content[0] && typeof content[0] === 'object') {
				const first = content[0] as Record<string, unknown>;
				const t = first.text;
				if (typeof t === 'string') text = t;
			}
		}
		if (typeof text !== 'string' || text.trim().length === 0) {
			throw new Error(
				`Anthropic response missing content text. ` +
				`Preview: ${this._safeJsonPreview(data)}`
			);
		}
		return text;
	}

	private async _generateGemini(prompt: string, settings: DashboardSettings): Promise<string> {
		const promptTokens = estimateTokens(prompt);
		const limit = settings.contextTokenLimit ?? 128000;
		// Reserve space for the model to answer. If input crowds out output, Gemini can return MAX_TOKENS with no text.
		const reservedForOutput = 6000;
		if (promptTokens > limit - reservedForOutput) {
			throw new Error(
				`Prompt too large for configured context limit. ` +
					`Estimated input ~${promptTokens.toLocaleString()} tokens (limit: ${limit.toLocaleString()}). ` +
					`Reduce context (story bible/character notes/Smart Connections) or increase the warning limit.`
			);
		}

		const maxOutputTokens = Math.max(
			512,
			Math.min(8192, limit - promptTokens - 1024)
		);

		const response = await requestUrl({
			url: `https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:generateContent?key=${settings.apiKey}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				contents: [
					{
						parts: [{ text: prompt }]
					}
				],
				generationConfig: {
					maxOutputTokens,
					temperature: 0.7
				}
			})
		});

		if (response.status >= 400) {
			const error = this._getJson(response);
			throw new Error(`Gemini API error: ${this._getNestedErrorMessage(error) || response.status}`);
		}

		const data = this._getJson(response);

		const candidates =
			data && typeof data === 'object'
				? (data as Record<string, unknown>).candidates
				: undefined;
		if (!Array.isArray(candidates) || candidates.length === 0) {
			let blockReason: unknown;
			let promptFeedback: unknown;
			if (data && typeof data === 'object') {
				promptFeedback = (data as Record<string, unknown>).promptFeedback;
				if (promptFeedback && typeof promptFeedback === 'object') {
					blockReason = (promptFeedback as Record<string, unknown>).blockReason;
				}
			}
			const details =
				blockReason ? ` blockReason=${this._formatUnknown(blockReason)}` : '';
			const preview = this._safeJsonPreview(
				promptFeedback || data
			);
			throw new Error(
				`Gemini returned no candidates.${details} Preview: ${preview}`
			);
		}

		const firstCandidate = candidates[0];
		let parts: unknown;
		if (firstCandidate && typeof firstCandidate === 'object') {
			const content = (firstCandidate as Record<string, unknown>).content;
			if (content && typeof content === 'object') {
				parts = (content as Record<string, unknown>).parts;
			}
		}
		const partText = (p: unknown): string | null => {
			if (!p || typeof p !== 'object') return null;
			if (!('text' in p)) return null;
			const t = (p as { text?: unknown }).text;
			return typeof t === 'string' ? t : null;
		};
		const text = Array.isArray(parts)
			? parts.map(partText).filter((t): t is string => Boolean(t)).join('\n')
			: undefined;

		if (typeof text !== 'string' || text.trim().length === 0) {
			let finishReason: unknown;
			if (firstCandidate && typeof firstCandidate === 'object') {
				finishReason = (firstCandidate as Record<string, unknown>).finishReason;
			}
			const preview = this._safeJsonPreview(firstCandidate || data);
			throw new Error(
				`Gemini candidate missing text. finishReason=${this._formatUnknown(finishReason)} Preview: ${preview}`
			);
		}

		return text;
	}
}

