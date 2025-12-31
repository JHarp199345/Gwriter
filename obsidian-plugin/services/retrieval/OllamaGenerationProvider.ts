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

    private get baseUrl() {
        return this.plugin.settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
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
     * Checks if the Ollama server is available.
     */
    async isAvailable(): Promise<boolean> {
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

