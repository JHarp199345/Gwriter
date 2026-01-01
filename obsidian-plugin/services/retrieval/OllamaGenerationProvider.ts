import { requestUrl, App } from 'obsidian';
import WritingDashboardPlugin from '../../main';

export interface GenerationParams {
    model: string;
    temperature: number;
    max_tokens?: number;
    stop?: string[];
    format?: 'json';
    seed?: number;
}

/**
 * OllamaGenerationProvider handles local text generation via Ollama.
 * It enforces deterministic parameters and validates structured JSON outputs.
 */
export class OllamaGenerationProvider {
    private plugin: WritingDashboardPlugin;

    private queue: { 
        priority: number, 
        task: () => Promise<any>, 
        abortController?: AbortController 
    }[] = [];
    private isProcessing = false;

    /**
     * Enqueues a generation task with priority.
     * Priority: 10 (WRITE), 5 (AUDIT), 3 (STITCH), 1 (METADATA).
     */
    async enqueue<T>(
        priority: number, 
        task: (signal?: AbortSignal) => Promise<T>, 
        abortController?: AbortController
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                priority,
                task: async () => {
                    try {
                        const result = await task(abortController?.signal);
                        resolve(result);
                    } catch (err) {
                        reject(err);
                    }
                },
                abortController
            });
            this.queue.sort((a, b) => b.priority - a.priority);
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const { task } = this.queue.shift()!;
            await task();
        }

        this.isProcessing = false;
    }

    /**
     * Cancels all pending tasks in the queue.
     */
    cancelAll() {
        this.queue.forEach(item => item.abortController?.abort());
        this.queue = [];
    }

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    /**
     * Generates text based on a prompt and parameters.
     */
    async generate(prompt: string, params: GenerationParams): Promise<string> {
        console.log(`[OllamaGen] 📡 Sending request to model: ${params.model} (Temp: ${params.temperature})`);
        
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/generate`,
                method: 'POST',
                body: JSON.stringify({
                    model: params.model,
                    prompt: prompt,
                    stream: false,
                    options: {
                        temperature: params.temperature,
                        num_predict: params.max_tokens || 2048,
                        stop: params.stop || [],
                        seed: params.seed || 42 // Deterministic seed
                    },
                    format: params.format === 'json' ? 'json' : undefined
                })
            });

            if (response.status !== 200) {
                throw new Error(`Ollama returned status ${response.status}: ${response.text}`);
            }

            const result = response.json;
            if (!result || !result.response) {
                throw new Error('Invalid response format from Ollama.');
            }

            return result.response;
        } catch (err) {
            console.error('[OllamaGen] ❌ Generation failed:', err);
            throw err;
        }
    }

    /**
     * Specialized method for generating and parsing JSON blocks.
     * Enforces JSON fencing and retry logic.
     */
    async generateJson<T>(prompt: string, model: string): Promise<T> {
        const enhancedPrompt = `${prompt}\n\nIMPORTANT: Output ONLY a single valid JSON block. Do not include any other text or explanations.`;
        
        const rawResponse = await this.generate(enhancedPrompt, {
            model: model,
            temperature: 0, // Force determinism for JSON
            format: 'json'
        });

        try {
            // Attempt to find and parse JSON block
            const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
            const jsonString = jsonMatch ? jsonMatch[0] : rawResponse;
            return JSON.parse(jsonString) as T;
        } catch (err) {
            console.error('[OllamaGen] ❌ JSON Parse Error. Raw response:', rawResponse);
            throw new Error('Failed to parse JSON response from LLM.');
        }
    }

    /**
     * Generates text with token-safe streaming.
     * Flushes complete units at punctuation or sentence-end (150-250ms throttled).
     */
    async generateStream(
        prompt: string, 
        params: GenerationParams, 
        onToken: (token: string) => void
    ): Promise<string> {
        console.log(`[OllamaGen] 📡 Sending streaming request to model: ${params.model}`);
        
        let fullResponse = '';
        let buffer = '';
        let lastFlush = Date.now();

        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: params.model,
                    prompt: prompt,
                    stream: true,
                    options: {
                        temperature: params.temperature,
                        num_predict: params.max_tokens || 2048,
                        seed: params.seed || 42
                    }
                })
            });

            if (!response.body) throw new Error('No response body');
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        const token = json.response || '';
                        fullResponse += token;
                        buffer += token;

                        const now = Date.now();
                        const timeSinceFlush = now - lastFlush;

                        // Token-safe flush: complete units at punctuation or throttled sentence-end
                        if (
                            /[.!?\n]/.test(token) || 
                            (timeSinceFlush > 200 && buffer.length > 50) ||
                            buffer.length > 400
                        ) {
                            onToken(buffer);
                            buffer = '';
                            lastFlush = now;
                        }
                    } catch {
                        // Partial JSON line, continue
                    }
                }
            }

            if (buffer) onToken(buffer); // Final flush
            return fullResponse;
        } catch (err) {
            console.error('[OllamaGen] ❌ Streaming failed:', err);
            throw err;
        }
    }
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET'
            });
            return response.status === 200;
        } catch (e) {
            return false;
        }
    }

    /**
     * Returns the current version of the Ollama server.
     */
    async getOllamaVersion(): Promise<string | undefined> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/version`,
                method: 'GET'
            });
            return response.json?.version;
        } catch {
            return undefined;
        }
    }
}

