/**
 * SidecarClient — TypeScript client for the GWriter NSM Python sidecar.
 *
 * Communicates with the local FastAPI sidecar over requestUrl (Obsidian's
 * sandbox-safe HTTP mechanism — same as Ollama calls elsewhere in the codebase).
 *
 * Health-checks on construction and every 30s. Falls back gracefully when
 * the sidecar is not running. Never blocks the generation pipeline.
 */

import { requestUrl, Notice } from 'obsidian';
import { relayEventBus } from '../EventBus';
import { gwlog, gwwarn, gwerr } from '../GWLogger';
import type { HiddenStateExtractor, HiddenStateResult, NarrativeFeature } from './HiddenStateExtractor';

// ── Wire types matching the sidecar's JSON schema ────────────────────────────

interface SidecarExtractRequest {
	text: string;
	chunk_id?: string;
	top_k?: number;
	layer?: number;
}

interface SidecarFeatureItem {
	index: number;
	activation: number;
	label?: string;
}

interface SidecarExtractResponse {
	chunk_id: string;
	model_variant: string;
	layer: number;
	sae_dict_size: number;
	features: SidecarFeatureItem[];
	latency_ms: number;
	cache_hit: boolean;
	token_count: number;
}

interface SidecarHealthResponse {
	status: 'ok' | 'loading' | 'error';
	model_loaded: boolean;
	sae_loaded: boolean;
	labels_loaded: boolean;
	model_variant: string;
	layer: number;
	sae_dict_size: number;
	device: string;
	cache_size: number;
	startup_error?: string;
}

interface SidecarFeaturesResponse {
	count: number;
	labels: Record<string, string>;
}

// ── SidecarClient ─────────────────────────────────────────────────────────────

export class SidecarClient implements HiddenStateExtractor {
	private readonly baseUrl: string;
	private _available = false;
	private _lastHealth: SidecarHealthResponse | null = null;
	private _healthInterval: ReturnType<typeof setInterval> | null = null;
	private _fallbackNoticeSent = false;
	private _featureLabelsCache: Record<string, string> | null = null;

	private static readonly TIMEOUT_MS = 60_000; // Forward passes can be slow
	private static readonly HEALTH_INTERVAL_MS = 30_000;

	constructor(port = 8765) {
		this.baseUrl = `http://127.0.0.1:${port}`;
		// Non-blocking startup health check
		this._scheduleHealthCheck(true);
		// Listen for committed chunks and process them async
		relayEventBus.on('chunk:committed', ({ chunkId, content }) => {
			this._processChunkAsync(chunkId, content);
		});
	}

	// ── Public interface ────────────────────────────────────────────────────

	isAvailable(): boolean {
		return this._available;
	}

	async extract(text: string, chunkId?: string): Promise<HiddenStateResult> {
		if (!this._available) {
			return this._fallbackResult(text, chunkId);
		}

		const body: SidecarExtractRequest = { text };
		if (chunkId) body.chunk_id = chunkId;

		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/extract`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				throw: false,
			} as any);

			if (response.status === 503) {
				gwwarn('NSM', 'Sidecar returned 503 — still loading. Using fallback.');
				return this._fallbackResult(text, chunkId);
			}
			if (response.status >= 400) {
				throw new Error(`Sidecar HTTP ${response.status}`);
			}

			const data: SidecarExtractResponse = response.json;
			return this._mapResponse(data);

		} catch (err) {
			gwerr('NSM', `Sidecar extract failed: ${(err as Error).message}`);
			this._available = false;
			this._emitStatus(false);
			return this._fallbackResult(text, chunkId);
		}
	}

	async getFeatureLabels(): Promise<Record<string, string>> {
		if (this._featureLabelsCache) return this._featureLabelsCache;

		if (!this._available) return {};

		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/features`,
				method: 'GET',
			});
			const data: SidecarFeaturesResponse = response.json;
			this._featureLabelsCache = data.labels ?? {};
			gwlog('NSM', `Feature labels loaded: ${data.count.toLocaleString()}`);
			return this._featureLabelsCache;
		} catch {
			return {};
		}
	}

	getLastHealth(): SidecarHealthResponse | null {
		return this._lastHealth;
	}

	destroy(): void {
		if (this._healthInterval) {
			clearInterval(this._healthInterval);
			this._healthInterval = null;
		}
	}

	// ── Health checking ─────────────────────────────────────────────────────

	private _scheduleHealthCheck(immediate = false): void {
		if (immediate) {
			setTimeout(() => this._healthCheck(), 0);
		}
		if (this._healthInterval) clearInterval(this._healthInterval);
		this._healthInterval = setInterval(
			() => this._healthCheck(),
			SidecarClient.HEALTH_INTERVAL_MS,
		);
	}

	private async _healthCheck(): Promise<void> {
		try {
			const response = await requestUrl({
				url: `${this.baseUrl}/health`,
				method: 'GET',
				throw: false,
			} as any);

			if (response.status === 200) {
				const health: SidecarHealthResponse = response.json;
				this._lastHealth = health;
				const wasAvailable = this._available;
				this._available = health.status === 'ok';

				if (this._available && !wasAvailable) {
					gwlog('NSM', `Sidecar online | device=${health.device} | model=${health.model_variant}`);
					this._emitStatus(true, health.device);
					// Pre-load feature labels in background
					this.getFeatureLabels().catch(() => {});
				}
			} else {
				this._markOffline();
			}
		} catch {
			this._markOffline();
		}
	}

	private _markOffline(): void {
		if (this._available) {
			gwwarn('NSM', 'Sidecar went offline — falling back to embedding proxy.');
			this._emitStatus(false);
		}
		this._available = false;
		this._lastHealth = null;
	}

	private _emitStatus(available: boolean, device?: string): void {
		relayEventBus.emit('nsm:sidecar_status', { available, device });
	}

	// ── Async chunk processing (non-blocking) ────────────────────────────────

	private async _processChunkAsync(chunkId: string, content: string): Promise<void> {
		if (!this._available) {
			if (!this._fallbackNoticeSent) {
				this._fallbackNoticeSent = true;
				new Notice(
					'NSM: Sidecar not running — using embedding proxy for narrative state.\n' +
					'Run the sidecar (start.sh) for full feature extraction.',
					8000,
				);
			}
			return;
		}

		try {
			const result = await this.extract(content, chunkId);
			relayEventBus.emit('nsm:features_extracted', {
				chunkId,
				features: result.features,
				source: result.source,
			});
			gwlog('NSM', `chunk=${chunkId.slice(0, 8)} | features=${result.features.length} | ${result.latencyMs.toFixed(0)}ms | source=${result.source}`);
		} catch (err) {
			gwerr('NSM', `Background extraction failed for ${chunkId}: ${(err as Error).message}`);
		}
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	private _mapResponse(data: SidecarExtractResponse): HiddenStateResult {
		const features: NarrativeFeature[] = data.features.map(f => ({
			index: f.index,
			activation: f.activation,
			label: f.label,
		}));
		return {
			chunkId: data.chunk_id,
			features,
			modelVariant: data.model_variant,
			layer: data.layer,
			saeDictSize: data.sae_dict_size,
			latencyMs: data.latency_ms,
			cacheHit: data.cache_hit,
			tokenCount: data.token_count,
			source: 'sidecar',
		};
	}

	private _fallbackResult(text: string, chunkId?: string): HiddenStateResult {
		// Lightweight proxy: return empty features — the NSM registry
		// will use the embedding-proxy path when source === 'fallback'
		return {
			chunkId: chunkId ?? 'fallback',
			features: [],
			modelVariant: 'embedding-proxy',
			layer: -1,
			saeDictSize: 0,
			latencyMs: 0,
			cacheHit: false,
			tokenCount: 0,
			source: 'fallback',
		};
	}
}
