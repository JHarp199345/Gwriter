/**
 * HiddenStateExtractor — interface and shared types for the NSM feature extraction layer.
 *
 * Two implementations exist:
 *   SidecarExtractor  — calls the Python sidecar (Gemma 3 + Gemma Scope 2 SAE)
 *   FallbackExtractor — uses existing embedding vectors as a proxy when sidecar is unavailable
 */

export interface NarrativeFeature {
	index: number;
	activation: number;
	/** Human-readable label from Neuronpedia. Absent when labels not loaded. */
	label?: string;
}

export interface HiddenStateResult {
	chunkId: string;
	features: NarrativeFeature[];
	modelVariant: string;
	layer: number;
	saeDictSize: number;
	latencyMs: number;
	cacheHit: boolean;
	tokenCount: number;
	/** 'sidecar' = real Gemma 3 + SAE. 'fallback' = embedding proxy. */
	source: 'sidecar' | 'fallback';
}

export interface HiddenStateExtractor {
	extract(text: string, chunkId?: string): Promise<HiddenStateResult>;
	isAvailable(): boolean;
	getFeatureLabels(): Promise<Record<string, string>>;
}
