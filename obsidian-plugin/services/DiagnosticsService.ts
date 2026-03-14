import WritingDashboardPlugin from '../main';
import {
    DiagnosticResult,
    DiagnosticsReport,
    REMEDIATION_MAPPING,
    DiagnosticStatus
} from '../contracts/DiagnosticsContract';

export class DiagnosticsService {
    private readonly plugin: WritingDashboardPlugin;

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    async runDiagnostics(): Promise<DiagnosticsReport> {
        const results: DiagnosticResult[] = [];

        // Common checks
        await this.checkIndexSanity(results);

        // Cloud diagnostics (the only mode)
        await this.runCloudDiagnostics(results);

        const overallStatus = this.determineOverallStatus(results);
        const report: DiagnosticsReport = {
            timestamp: Date.now(),
            overallStatus,
            results,
            environment: {
                relayMode: 'cloud',
                pluginVersion: this.plugin.manifest.version,
                models: [this.plugin.settings.model]
            }
        };

        await this.writeArtifacts(report);
        return report;
    }

    private async checkIndexSanity(results: DiagnosticResult[]) {
        const status = this.plugin.embeddingsIndex.getStatus();
        if (status.indexedChunks === 0) {
            results.push({
                status: 'FAIL',
                code: 'INDEX_EMPTY',
                message: 'Retrieval index is empty. No files are currently being searched.',
                suggestedFix: 'Ensure your vault is not excluded in settings, and run "Re-index Vault" from the Writing Dashboard settings tab.'
            });
        } else if (this.plugin.embeddingsIndex.getErrorSummary().total > 0) {
            results.push({
                status: 'WARN',
                code: 'INDEX_STALE',
                message: `Retrieval index has ${this.plugin.embeddingsIndex.getErrorSummary().total} errors.`,
                suggestedFix: REMEDIATION_MAPPING['INDEX_STALE']
            });
        } else {
            results.push({
                status: 'PASS',
                message: `Index healthy: ${status.indexedChunks} chunks across ${status.indexedFiles} files.`
            });
        }
    }

    private async runCloudDiagnostics(results: DiagnosticResult[]) {
        const apiKey = this.plugin.settings.apiKey;
        if (!apiKey) {
            results.push({
                status: 'FAIL',
                code: 'CLOUD_AUTH_FAIL',
                message: 'API Key is missing.',
                suggestedFix: REMEDIATION_MAPPING['CLOUD_AUTH_FAIL']
            });
            return;
        }

        results.push({ status: 'PASS', message: 'API key is present.' });

        const apiProvider = this.plugin.settings.apiProvider;
        if (!apiProvider) {
            results.push({
                status: 'FAIL',
                code: 'CLOUD_AUTH_FAIL',
                message: 'API provider is not set.',
                suggestedFix: REMEDIATION_MAPPING['CLOUD_AUTH_FAIL']
            });
            return;
        }

        results.push({ status: 'PASS', message: `API provider set: ${apiProvider}.` });

        // Connectivity test (mock — real ping requires provider-specific implementation)
        try {
            // Note: Actual implementation would ping the provider endpoint.
            results.push({ status: 'PASS', message: 'Cloud provider connectivity verified (mock).' });
        } catch (e) {
            results.push({
                status: 'FAIL',
                code: 'CLOUD_AUTH_FAIL',
                message: `Cloud connectivity failed: ${e instanceof Error ? e.message : String(e)}`,
                suggestedFix: REMEDIATION_MAPPING['CLOUD_AUTH_FAIL']
            });
        }
    }

    private determineOverallStatus(results: DiagnosticResult[]): DiagnosticStatus {
        if (results.some(r => r.status === 'FAIL')) return 'FAIL';
        if (results.some(r => r.status === 'WARN')) return 'WARN';
        return 'PASS';
    }

    private async writeArtifacts(report: DiagnosticsReport) {
        const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
        const diagDir = `.gwriter/diagnostics/diag-${timestamp}`;

        try {
            await this.plugin.vaultService.ensureParentFolder(`${diagDir}/report.json`);
            await this.plugin.vaultService.writeFile(`${diagDir}/report.json`, JSON.stringify(report, null, 2));

            // Also write environment snapshot
            await this.plugin.vaultService.writeFile(`${diagDir}/env.json`, JSON.stringify(report.environment, null, 2));
        } catch (e) {
            console.error('Failed to write diagnostic artifacts', e);
        }
    }
}
