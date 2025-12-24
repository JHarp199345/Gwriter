// Type definitions for vendored transformers.js
// This is a minimal declaration to satisfy TypeScript

export interface TransformersEnv {
	backends?: {
		onnx?: {
			wasm?: {
				wasmPaths?: string;
			};
		};
	};
}

export interface TransformersModule {
	pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
	default?: {
		pipeline?: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
	};
	env?: TransformersEnv;
}

declare const transformers: TransformersModule;
export default transformers;
export const pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
export const env: TransformersEnv;

