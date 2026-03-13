import { requestUrl, App } from 'obsidian';
import WritingDashboardPlugin from '../main';

export interface OllamaModel {
    id: string;
    name: string;
    digest?: string;
    size?: number;
    status: 'ready' | 'installable' | 'update-available';
    role?: 'WRITE' | 'FAST' | 'EMBED';
    sizeTier?: 'tiny' | 'small' | 'medium' | 'large';
}

/**
 * OllamaModelManager handles the discovery, selection, and installation of local LLMs.
 * It merges the local installed tags with a curated catalog.
 */
export class OllamaModelManager {
    private plugin: WritingDashboardPlugin;
    private catalog: Partial<OllamaModel>[] = [];

    private get baseUrl() {
        return this.plugin.settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
    }

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
        this.catalog = [
            { id: 'llama3.1:70b', role: 'WRITE', sizeTier: 'large' },
            { id: 'llama3.1:8b', role: 'FAST', sizeTier: 'small' },
            { id: 'nomic-embed-text', role: 'EMBED', sizeTier: 'tiny' }
        ];
    }

    /**
     * Fetches all models (Installed + Catalog).
     */
    async getModels(): Promise<OllamaModel[]> {
        const installed = await this.fetchInstalledModels();
        const merged: Map<string, OllamaModel> = new Map();

        // 1. Add catalog models as 'installable'
        this.catalog.forEach(c => {
            merged.set(c.id!, {
                ...c,
                id: c.id!,
                name: c.id!,
                status: 'installable'
            } as OllamaModel);
        });

        // 2. Overwrite with installed models
        installed.forEach(i => {
            const catalogEntry = this.catalog.find(c => c.id === i.id);
            merged.set(i.id, {
                ...catalogEntry,
                ...i,
                status: 'ready'
            } as OllamaModel);
        });

        return Array.from(merged.values());
    }

    /**
     * Fetches only installed models from the Ollama API.
     */
    async fetchInstalledModels(): Promise<Partial<OllamaModel>[]> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/tags`,
                method: 'GET'
            });

            if (response.status === 200 && response.json && Array.isArray(response.json.models)) {
                return response.json.models.map((m: any) => ({
                    id: m.name,
                    digest: m.digest,
                    size: m.size
                }));
            }
            return [];
        } catch (e) {
            console.warn('[ModelManager] Ollama not reachable for tag fetch.');
            return [];
        }
    }

    /**
     * Gets the specific digest for a model by name.
     * Smart matching: handles ':latest' tags and case-insensitivity.
     */
    async getModelDigest(name: string): Promise<string | undefined> {
        const models = await this.fetchInstalledModels();
        const searchLower = name.toLowerCase().trim();
        const searchBase = searchLower.split(':')[0];

        // 1. Try exact match
        const exact = models.find(m => m.id?.toLowerCase() === searchLower);
        if (exact) return exact.digest;

        // 2. Try base name match (e.g. 'nomic-embed-text' matches 'nomic-embed-text:latest')
        const baseMatch = models.find(m => {
            const idLower = (m.id || '').toLowerCase();
            return idLower === `${searchLower}:latest` || 
                   idLower.split(':')[0] === searchBase;
        });
        
        return baseMatch?.digest;
    }

    /**
     * Gets the model's actual context limit from Ollama /api/show.
     * Returns null if model is not loaded or Ollama is unreachable.
     */
    async getModelContextLimit(modelName: string): Promise<number | null> {
        try {
            const response = await requestUrl({
                url: `${this.baseUrl}/api/show`,
                method: 'POST',
                body: JSON.stringify({ name: modelName })
            });

            if (response.status !== 200) {
                console.warn(`[ModelManager] /api/show returned ${response.status} for ${modelName}`);
                return null;
            }

            const info = response.json;
            
            // Ollama returns context in different locations depending on version
            // Try multiple paths to find num_ctx
            const numCtx = 
                info?.model_info?.['context_length'] ||
                info?.model_info?.['llama.context_length'] ||
                info?.parameters?.num_ctx ||
                info?.details?.context_length ||
                null;

            if (numCtx && typeof numCtx === 'number') {
                console.log(`[ModelManager] Model ${modelName} context limit: ${numCtx}`);
                return numCtx;
            }

            // Try parsing from modelfile template if present
            if (info?.template || info?.modelfile) {
                const templateStr = info.template || info.modelfile || '';
                const ctxMatch = templateStr.match(/num_ctx\s+(\d+)/i);
                if (ctxMatch) {
                    const parsed = parseInt(ctxMatch[1], 10);
                    console.log(`[ModelManager] Model ${modelName} context limit (from template): ${parsed}`);
                    return parsed;
                }
            }

            console.warn(`[ModelManager] Could not determine context limit for ${modelName}`);
            return null;
        } catch (e) {
            console.warn(`[ModelManager] Failed to get context limit for ${modelName}:`, e);
            return null;
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

    /**
     * Pulls a model from the Ollama library.
     * Uses the /api/pull endpoint and emits progress events.
     */
    async pullModel(modelId: string, onProgress: (data: any) => void): Promise<void> {
        console.log(`[ModelManager] 📥 Pulling model: ${modelId}`);
        
        try {
            const response = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: modelId, stream: true })
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
                        onProgress(json);
                    } catch {
                        // Partial streaming line; skip and continue.
                        continue;
                    }
                }
            }
            console.log(`[ModelManager] ✅ Pull complete: ${modelId}`);
        } catch (err) {
            console.error('[ModelManager] ❌ Pull failed:', err);
            throw err;
        }
    }

    /**
     * Performs a tiny warmup generation to catch initialization errors.
     */
    async warmup(modelId: string): Promise<{ success: boolean, latency: number, error?: string }> {
        const start = Date.now();
        try {
            const prompt = '{"test": true}';
            const result = await this.plugin.ollamaGen.generateJson<{ test: boolean }>(
                'Output a JSON object: {"test": true}', 
                modelId
            );
            return {
                success: result?.test === true,
                latency: Date.now() - start
            };
        } catch (err) {
            return {
                success: false,
                latency: Date.now() - start,
                error: err.message
            };
        }
    }
}

