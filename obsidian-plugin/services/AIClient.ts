import { requestUrl, type RequestUrlResponse } from 'obsidian';
import type { DashboardSettings } from '../main';
import { estimateTokens } from './TokenEstimate';
import { gwlog, gwwarn, gwerr, gwRedactKey, gwSnip } from './GWLogger';

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

	/**
	 * Map the spontaneity slider (0–100) to a model temperature (0.3–1.0).
	 * A value of 50 (default) maps to 0.65, which is a comfortable creative middle ground.
	 */
	private _computeTemperature(settings: DashboardSettings): number {
		const spontaneity = settings.spontaneity ?? 50;
		return 0.3 + (Math.max(0, Math.min(100, spontaneity)) / 100) * 0.7;
	}

	/**
	 * Streaming generation — emits accumulated text via onToken callback as tokens arrive.
	 * Falls back to non-streaming generate() for unsupported providers.
	 * Returns the complete generated text when done.
	 */
	async generateStream(
		prompt: string,
		settings: DashboardSettings,
		onToken: (accumulated: string) => void,
		signal?: AbortSignal
	): Promise<string> {
		const provider = settings.apiProvider;
		const estimatedTokens = estimateTokens(prompt);
		gwlog('API', `generateStream | provider=${provider} | model=${settings.model} | key=${gwRedactKey(settings.apiKey)} | promptChars=${prompt.length} | ~tokens=${estimatedTokens}`);

		let result: string;
		if (provider === 'openai') {
			result = await this._streamOpenAICompat(
				prompt, settings,
				'https://api.openai.com/v1/chat/completions',
				'OpenAI', {}, onToken, signal
			);
		} else if (provider === 'openrouter') {
			result = await this._streamOpenAICompat(
				prompt, settings,
				'https://openrouter.ai/api/v1/chat/completions',
				'OpenRouter',
				{
					'HTTP-Referer': 'https://github.com/JHarp199345/Gwriter',
					'X-Title': 'Writing Dashboard'
				},
				onToken, signal
			);
		} else if (provider === 'anthropic') {
			result = await this._streamAnthropic(prompt, settings, onToken, signal);
		} else if (provider === 'gemini') {
			result = await this._streamGemini(prompt, settings, onToken, signal);
		} else {
			gwwarn('API', `Unknown provider "${provider}" — falling back to non-streaming generate`);
			result = await this.generateSingle(prompt, settings);
			onToken(result);
		}
		gwlog('API', `generateStream DONE | responseChars=${result.length} | ~words=${result.trim().split(/\s+/).length}`);
		return result;
	}

	/** SSE streaming for OpenAI-compatible endpoints (OpenAI, OpenRouter). */
	private async _streamOpenAICompat(
		prompt: string,
		settings: DashboardSettings,
		url: string,
		providerName: string,
		extraHeaders: Record<string, string>,
		onToken: (accumulated: string) => void,
		signal?: AbortSignal
	): Promise<string> {
		const temperature = this._computeTemperature(settings);
		gwlog('STREAM', `${providerName} → POST ${url} | model=${settings.model} | temp=${temperature.toFixed(2)}`);
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${settings.apiKey}`,
				...extraHeaders
			},
			body: JSON.stringify({
				model: settings.model,
				messages: [
					{ role: 'system', content: 'You are a professional writing assistant.' },
					{ role: 'user', content: prompt }
				],
				max_tokens: 4000,
				temperature,
				stream: true
			}),
			signal
		});

		gwlog('STREAM', `${providerName} HTTP status=${response.status}`);
		if (!response.ok) {
			const errText = await response.text().catch(() => String(response.status));
			throw new Error(`${providerName} API error ${response.status}: ${errText.slice(0, 300)}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let lineBuffer = '';
		let accumulated = '';
		let firstChunk = true;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				lineBuffer += decoder.decode(value, { stream: true });
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const payload = trimmed.slice(5).trim();
					if (payload === '[DONE]') break;
					try {
						const delta = (JSON.parse(payload) as any)?.choices?.[0]?.delta?.content;
						if (typeof delta === 'string' && delta.length > 0) {
							if (firstChunk) {
								gwlog('STREAM', `${providerName} first token received`);
								firstChunk = false;
							}
							accumulated += delta;
							onToken(accumulated);
						}
					} catch {
						// Ignore malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		if (accumulated.trim().length === 0) {
			throw new Error(`${providerName} streaming returned empty content.`);
		}
		gwlog('STREAM', `${providerName} stream complete | chars=${accumulated.length}`);
		return accumulated;
	}

	/** SSE streaming for Anthropic Messages API. */
	private async _streamAnthropic(
		prompt: string,
		settings: DashboardSettings,
		onToken: (accumulated: string) => void,
		signal?: AbortSignal
	): Promise<string> {
		const temperature = this._computeTemperature(settings);
		gwlog('STREAM', `Anthropic → POST /v1/messages | model=${settings.model} | temp=${temperature.toFixed(2)}`);
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
				temperature,
				stream: true,
				messages: [{ role: 'user', content: prompt }]
			}),
			signal
		});

		gwlog('STREAM', `Anthropic HTTP status=${response.status}`);
		if (!response.ok) {
			const errText = await response.text().catch(() => String(response.status));
			throw new Error(`Anthropic API error ${response.status}: ${errText.slice(0, 300)}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let lineBuffer = '';
		let accumulated = '';
		let firstChunk = true;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				lineBuffer += decoder.decode(value, { stream: true });
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const payload = trimmed.slice(5).trim();
					try {
						const parsed = JSON.parse(payload) as any;
						if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
							const delta = parsed.delta.text;
							if (typeof delta === 'string' && delta.length > 0) {
								if (firstChunk) {
									gwlog('STREAM', 'Anthropic first token received');
									firstChunk = false;
								}
								accumulated += delta;
								onToken(accumulated);
							}
						}
					} catch {
						// Ignore malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		if (accumulated.trim().length === 0) {
			throw new Error('Anthropic streaming returned empty content.');
		}
		gwlog('STREAM', `Anthropic stream complete | chars=${accumulated.length}`);
		return accumulated;
	}

	/** SSE streaming for Gemini generateContent endpoint. */
	private async _streamGemini(
		prompt: string,
		settings: DashboardSettings,
		onToken: (accumulated: string) => void,
		signal?: AbortSignal
	): Promise<string> {
		const promptTokens = estimateTokens(prompt);
		const limit = settings.contextTokenLimit ?? 128000;
		const reservedForOutput = 6000;
		gwlog('STREAM', `Gemini → streamGenerateContent | model=${settings.model} | ~tokens=${promptTokens} | limit=${limit}`);
		if (promptTokens > limit - reservedForOutput) {
			gwerr('STREAM', `Gemini prompt too large: ~${promptTokens} tokens > limit-reserve (${limit - reservedForOutput})`);
			throw new Error(
				`Prompt too large for configured context limit. ` +
				`Estimated input ~${promptTokens.toLocaleString()} tokens (limit: ${limit.toLocaleString()}). ` +
				`Reduce context or increase the warning limit.`
			);
		}
		const maxOutputTokens = Math.max(512, Math.min(8192, limit - promptTokens - 1024));
		const temperature = this._computeTemperature(settings);

		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${settings.model}:streamGenerateContent?alt=sse&key=${settings.apiKey}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { maxOutputTokens, temperature }
				}),
				signal
			}
		);

		gwlog('STREAM', `Gemini HTTP status=${response.status}`);
		if (!response.ok) {
			const errText = await response.text().catch(() => String(response.status));
			throw new Error(`Gemini API error ${response.status}: ${errText.slice(0, 300)}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let lineBuffer = '';
		let accumulated = '';
		let firstChunk = true;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				lineBuffer += decoder.decode(value, { stream: true });
				const lines = lineBuffer.split('\n');
				lineBuffer = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) continue;
					const payload = trimmed.slice(5).trim();
					try {
						const parsed = JSON.parse(payload) as any;
						const parts = parsed?.candidates?.[0]?.content?.parts;
						if (Array.isArray(parts)) {
							for (const part of parts) {
								if (typeof part.text === 'string' && part.text.length > 0) {
									if (firstChunk) {
										gwlog('STREAM', 'Gemini first token received');
										firstChunk = false;
									}
									accumulated += part.text;
									onToken(accumulated);
								}
							}
						}
					} catch {
						// Ignore malformed SSE lines
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		if (accumulated.trim().length === 0) {
			throw new Error('Gemini streaming returned empty content.');
		}
		gwlog('STREAM', `Gemini stream complete | chars=${accumulated.length}`);
		return accumulated;
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
		const provider = settings.apiProvider;
		const estimatedTokens = estimateTokens(prompt);
		gwlog('API', `generate (non-stream) | provider=${provider} | model=${settings.model} | key=${gwRedactKey(settings.apiKey)} | promptChars=${prompt.length} | ~tokens=${estimatedTokens}`);

		let result: string;
		if (settings.apiProvider === 'openrouter') {
			result = await this._generateOpenRouter(prompt, settings);
		} else if (settings.apiProvider === 'openai') {
			result = await this._generateOpenAI(prompt, settings);
		} else if (settings.apiProvider === 'anthropic') {
			result = await this._generateAnthropic(prompt, settings);
		} else if (settings.apiProvider === 'gemini') {
			result = await this._generateGemini(prompt, settings);
		} else {
			throw new Error(`Unsupported provider: ${provider}`);
		}
		gwlog('API', `generate DONE | responseChars=${result.length} | preview="${gwSnip(result, 80)}"`);
		return result;
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

	private async _generateOpenAICompat(
		prompt: string,
		settings: DashboardSettings,
		url: string,
		providerName: string,
		extraHeaders?: Record<string, string>
	): Promise<string> {
		let response: import('obsidian').RequestUrlResponse;
		try {
			response = await requestUrl({
				url,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${settings.apiKey}`,
					...extraHeaders
				},
				body: JSON.stringify({
					model: settings.model,
					messages: [
						{ role: 'system', content: 'You are a professional writing assistant.' },
						{ role: 'user', content: prompt }
					],
					max_tokens: 4000,
					temperature: this._computeTemperature(settings)
				})
			});
		} catch (reqErr: unknown) {
			const status = (reqErr as any)?.status ?? '?';
			const body = (reqErr as any)?.text ?? (reqErr instanceof Error ? reqErr.message : String(reqErr));
			const bodySnip = typeof body === 'string' ? body.slice(0, 400) : String(body);
			gwerr('API', `${providerName} requestUrl error | status=${status} | body=${bodySnip}`);
			let msg = bodySnip;
			try { const n = this._getNestedErrorMessage(JSON.parse(bodySnip)); if (n) msg = n; } catch { /* not JSON */ }
			throw new Error(`${providerName} API error ${status}: ${msg}`);
		}

		if (response.status >= 400) {
			const error = this._getJson(response);
			throw new Error(`${providerName} API error: ${this._getNestedErrorMessage(error) || response.status}`);
		}

		const data = this._getJson(response);
		const content = this._getOpenAIStyleContent(data);
		if (typeof content !== 'string' || content.trim().length === 0) {
			throw new Error(
				`${providerName} response missing message content. ` +
				`Preview: ${this._safeJsonPreview(data)}`
			);
		}
		return content;
	}

	private async _generateOpenRouter(prompt: string, settings: DashboardSettings): Promise<string> {
		return this._generateOpenAICompat(
			prompt,
			settings,
			'https://openrouter.ai/api/v1/chat/completions',
			'OpenRouter',
			{
				'HTTP-Referer': 'https://github.com/JHarp199345/Gwriter',
				'X-Title': 'Writing Dashboard'
			}
		);
	}

	private async _generateOpenAI(prompt: string, settings: DashboardSettings): Promise<string> {
		return this._generateOpenAICompat(
			prompt,
			settings,
			'https://api.openai.com/v1/chat/completions',
			'OpenAI'
		);
	}

	private async _generateAnthropic(prompt: string, settings: DashboardSettings): Promise<string> {
		let response: import('obsidian').RequestUrlResponse;
		try {
			response = await requestUrl({
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
		} catch (reqErr: unknown) {
			const status = (reqErr as any)?.status ?? '?';
			const body = (reqErr as any)?.text ?? (reqErr instanceof Error ? reqErr.message : String(reqErr));
			const bodySnip = typeof body === 'string' ? body.slice(0, 400) : String(body);
			gwerr('API', `Anthropic requestUrl error | status=${status} | body=${bodySnip}`);
			let msg = bodySnip;
			try { const n = this._getNestedErrorMessage(JSON.parse(bodySnip)); if (n) msg = n; } catch { /* not JSON */ }
			throw new Error(`Anthropic API error ${status}: ${msg}`);
		}

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
		const reservedForOutput = 6000;
		gwlog('API', `Gemini → generateContent | model=${settings.model} | ~tokens=${promptTokens} | limit=${limit}`);
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

		// requestUrl throws a RequestError (with .status and .text) on 4xx/5xx in Obsidian.
		// We catch it here to surface the actual Gemini error body for diagnostics.
		let response: import('obsidian').RequestUrlResponse;
		try {
			response = await requestUrl({
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
						temperature: this._computeTemperature(settings)
					}
				})
			});
		} catch (reqErr: unknown) {
			// Obsidian's requestUrl throws { status, text, headers } on HTTP errors.
			const status = (reqErr as any)?.status ?? '?';
			const body = (reqErr as any)?.text ?? (reqErr instanceof Error ? reqErr.message : String(reqErr));
			const bodySnip = typeof body === 'string' ? body.slice(0, 500) : String(body);
			gwerr('API', `Gemini requestUrl error | status=${status} | body=${bodySnip}`);

			// Parse the body for a human-readable error message
			let geminiMsg = bodySnip;
			try {
				const parsed = JSON.parse(bodySnip);
				const nested = this._getNestedErrorMessage(parsed);
				if (nested) geminiMsg = nested;
			} catch { /* body wasn't JSON */ }

			const shutdownModels = ['gemini-3.1-pro-preview'];
			const isShutdown = shutdownModels.includes(settings.model);
			const hint = String(status) === '429' || String(status) === '404'
				? isShutdown
					? ` (model "${settings.model}" was SHUT DOWN by Google on Mar 9 2026 — change to gemini-2.5-flash in Settings)`
					: ` (${status} = quota/rate-limit or preview model requires waitlist access — try gemini-2.5-flash in Settings)`
				: '';
			throw new Error(`Gemini API error ${status}: ${geminiMsg}${hint}`);
		}

		gwlog('API', `Gemini HTTP status=${response.status}`);
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

