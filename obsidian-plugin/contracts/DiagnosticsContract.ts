/**
 * DiagnosticsContract defines the standardized failure codes and remediation mapping.
 */

export type DiagnosticStatus = 'PASS' | 'WARN' | 'FAIL';

export type DiagnosticFailureCode = 
    | 'OLLAMA_UNREACHABLE'
    | 'MODEL_MISSING'
    | 'CLOUD_AUTH_FAIL'
    | 'INDEX_EMPTY'
    | 'CLOUD_MODEL_MISMATCH'
    | 'INDEX_STALE'
    | 'LOW_DISK_SPACE'
    | 'MODE_INVARIANT_VIOLATION';

export interface DiagnosticResult {
    status: DiagnosticStatus;
    code?: DiagnosticFailureCode;
    message: string;
    suggestedFix?: string;
}

export interface DiagnosticsReport {
    timestamp: number;
    overallStatus: DiagnosticStatus;
    results: DiagnosticResult[];
    environment: {
        relayMode: 'local' | 'cloud';
        pluginVersion: string;
        models: string[];
    };
}

export const REMEDIATION_MAPPING: Record<DiagnosticFailureCode, string> = {
    'OLLAMA_UNREACHABLE': 'Ensure Ollama is running and accessible at the configured URL.',
    'MODEL_MISSING': 'Run "ollama pull [model_name]" to download the required models.',
    'CLOUD_AUTH_FAIL': 'Verify your API key in settings and ensure you have remaining quota.',
    'INDEX_EMPTY': 'Wait for the vault indexing worker to complete or check excluded folders.',
    'CLOUD_MODEL_MISMATCH': 'You are in Cloud mode but configured Local-only models. Update model IDs in settings.',
    'INDEX_STALE': 'The retrieval index is out of date. Trigger a full rescan in Retrieval settings.',
    'LOW_DISK_SPACE': 'Clear vault logs or free up disk space to ensure artifacts can be written.',
    'MODE_INVARIANT_VIOLATION': 'Architecture mismatch: Cloud mode attempted a local-only stage. Check sequential settings.'
};

/**
 * UI Invariant: FAIL blocks generation, WARN surfaces banner.
 */
export function shouldBlockGeneration(report: DiagnosticsReport): boolean {
    return report.results.some(r => r.status === 'FAIL');
}

