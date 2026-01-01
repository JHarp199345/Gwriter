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
     */
    async getModelDigest(name: string): Promise<string | undefined> {
        const models = await this.fetchInstalledModels();
        return models.find(m => m.id === name)?.digest;
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
                        // ignore partial lines
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

