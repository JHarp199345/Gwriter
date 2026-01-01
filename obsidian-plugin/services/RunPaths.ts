import type { RunManifest } from './Schemas';

/**
 * Unified Run Context Helper - Provides deterministic path construction
 * to prevent path drift across services.
 */
export class RunPaths {
	/**
	 * Base directory for a run (folder name).
	 * @param runKey - Folder name (e.g., "run-1735689600")
	 */
	static baseDir(runKey: string): string {
		return `.gwriter/output/${runKey}`;
	}

	/**
	 * Logs directory for a run or continuation.
	 */
	static logsDir(runKey: string, contId?: string): string {
		const base = this.baseDir(runKey);
		return contId ? `${base}/branches/${contId}/logs` : `${base}/logs`;
	}

	/**
	 * Context directory for a run or continuation (prompts, hits).
	 */
	static contextDir(runKey: string, contId?: string): string {
		const base = this.baseDir(runKey);
		return contId ? `${base}/branches/${contId}/context` : `${base}/context`;
	}

	/**
	 * Snapshots directory for a run.
	 */
	static snapshotsDir(runKey: string): string {
		return `${this.baseDir(runKey)}/snapshots`;
	}

	/**
	 * Harvest directory for a run.
	 */
	static harvestDir(runKey: string): string {
		return `${this.baseDir(runKey)}/harvest`;
	}

	/**
	 * Replays directory for a run.
	 */
	static replaysDir(runKey: string): string {
		return `${this.baseDir(runKey)}/replays`;
	}

	/**
	 * Branches directory for a run.
	 */
	static branchesDir(runKey: string): string {
		return `${this.baseDir(runKey)}/branches`;
	}

	/**
	 * Path to continuation manifest (delta manifest).
	 */
	static continuationManifestPath(runKey: string, contId: string): string {
		return `${this.branchesDir(runKey)}/${contId}/cont.json`;
	}

	/**
	 * Path to policy snapshot for a run.
	 */
	static policySnapshotPath(runKey: string): string {
		return `${this.baseDir(runKey)}/policy.json`;
	}

	/**
	 * Path to run manifest.
	 */
	static manifestPath(runKey: string): string {
		return `${this.baseDir(runKey)}/run.json`;
	}

	/**
	 * Derives runKey from a manifest.
	 */
	static fromManifest(manifest: RunManifest): string | null {
		// Extract runKey from runId or derive from folder structure
		// For now, assume runId contains or maps to runKey
		// In practice, this would be stored in the manifest
		return null; // Implement based on actual manifest structure
	}
}

