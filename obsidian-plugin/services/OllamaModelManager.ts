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
     * Auto-selects the best models for Smart and Fast roles.
     */
    async autoSelectModels(): Promise<{ smart: string, fast: string }> {
        const models = await this.getModels();
        const ready = models.filter(m => m.status === 'ready');

        const smart = ready.find(m => m.role === 'WRITE' || m.sizeTier === 'large')?.id 
                   || ready[0]?.id || 'llama3.1:8b';
        
        const fast = ready.find(m => m.role === 'FAST' || m.sizeTier === 'small')?.id 
                  || ready[0]?.id || 'llama3.1:8b';

        return { smart, fast };
    }
}

