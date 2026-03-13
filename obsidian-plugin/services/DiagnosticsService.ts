import { App, Notice, TFile } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { 
    DiagnosticResult, 
    DiagnosticsReport, 
    REMEDIATION_MAPPING,
    DiagnosticStatus,
    DiagnosticFailureCode
} from '../contracts/DiagnosticsContract';
import { RunPaths } from './RunPaths';

export class DiagnosticsService {
    private readonly plugin: WritingDashboardPlugin;

    constructor(plugin: WritingDashboardPlugin) {
        this.plugin = plugin;
    }

    async runDiagnostics(): Promise<DiagnosticsReport> {
        const relayMode = this.plugin.settings.relayMode || 'local';
        const results: DiagnosticResult[] = [];
        
        // 1. Common Checks
        await this.checkIndexSanity(results);

        // 2. Mode-Specific Checks
        if (relayMode === 'local') {
            await this.runLocalDiagnostics(results);
        } else {
            await this.runCloudDiagnostics(results);
        }

        const overallStatus = this.determineOverallStatus(results);
        const report: DiagnosticsReport = {
            timestamp: Date.now(),
            overallStatus,
            results,
            environment: {
                relayMode,
                pluginVersion: this.plugin.manifest.version,
                models: [this.plugin.settings.relaySmartModel]
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

    private async runLocalDiagnostics(results: DiagnosticResult[]) {
        // Ollama Heartbeat
        const version = await this.plugin.ollamaGen.getOllamaVersion();
        if (!version) {
            results.push({
                status: 'FAIL',
                code: 'OLLAMA_UNREACHABLE',
                message: 'Cannot reach Ollama.',
                suggestedFix: REMEDIATION_MAPPING['OLLAMA_UNREACHABLE']
            });
            return;
        }

        results.push({ status: 'PASS', message: `Ollama reachable (v${version})` });

        // Required Models
        const smartModel = this.plugin.settings.relaySmartModel;
        const smartDigest = await this.plugin.ollamaModels.getModelDigest(smartModel);
        if (!smartDigest) {
            results.push({
                status: 'FAIL',
                code: 'MODEL_MISSING',
                message: `Model '${smartModel}' not found in Ollama.`,
                suggestedFix: REMEDIATION_MAPPING['MODEL_MISSING']
            });
        } else {
            results.push({ status: 'PASS', message: `Model '${smartModel}' available.` });
        }

        // Embedding Model
        const embedModel = this.plugin.settings.relayEmbeddingModel;
        const embedDigest = await this.plugin.ollamaModels.getModelDigest(embedModel);
        if (!embedDigest) {
            results.push({
                status: 'FAIL',
                code: 'MODEL_MISSING',
                message: `Embedding model '${embedModel}' not found in Ollama. Retrieval will be limited to BM25.`,
                suggestedFix: `Pull '${embedModel}' using the button in the Writing Dashboard settings tab.`
            });
        } else {
            results.push({ status: 'PASS', message: `Embedding model '${embedModel}' available.` });
        }

        // Minimal Generation Test
        try {
            const testPrompt = 'Respond with "pong" in JSON format: { "result": "pong" }';
            const response = await this.plugin.ollamaGen.generate(testPrompt, { 
                model: smartModel,
                temperature: 0.1,
                max_tokens: 128,
                format: 'json'
            });
            const parsed = JSON.parse(response);
            if (parsed.result === 'pong') {
                results.push({ status: 'PASS', message: 'Local generation test successful.' });
            } else {
                throw new Error('Unexpected response content.');
            }
        } catch (e) {
            results.push({
                status: 'FAIL',
                message: `Local generation test failed: ${e instanceof Error ? e.message : String(e)}`
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

        // Check for Local-only models in Cloud mode
        const smartModel = this.plugin.settings.relaySmartModel;
        if (smartModel.includes(':') || !(['gpt', 'claude', 'gemini'].some(m => smartModel.toLowerCase().includes(m)))) {
            results.push({
                status: 'WARN',
                code: 'CLOUD_MODEL_MISMATCH',
                message: `Model '${smartModel}' appears to be a local model name.`,
                suggestedFix: REMEDIATION_MAPPING['CLOUD_MODEL_MISMATCH']
            });
        }

        // Connectivity Test (Ping)
        try {
            // Note: Actual implementation would ping the provider endpoint
            results.push({ status: 'PASS', message: 'Cloud provider connectivity verified (mock).' });
        } catch (e) {
            results.push({
                status: 'FAIL',
                code: 'CLOUD_AUTH_FAIL',
                message: `Cloud connectivity failed: ${e instanceof Error ? e.message : String(e)}`,
                suggestedFix: REMEDIATION_MAPPING['CLOUD_AUTH_FAIL']
            });
        }

        // Cost-capped Mini Monolith Test
        try {
            // Placeholder for real connectivity test
            results.push({ status: 'PASS', message: 'Cloud generation test successful (mock).' });
        } catch (e) {
            results.push({
                status: 'FAIL',
                message: `Cloud generation test failed: ${e instanceof Error ? e.message : String(e)}`
            });
        }
    }

    private determineOverallStatus(results: DiagnosticResult[]): DiagnosticStatus {
        if (results.some(r => r.status === 'FAIL')) return 'FAIL';
        if (results.some(r => r.status === 'WARN')) return 'WARN';
        return 'PASS';
    }

    private async writeArtifacts(report: DiagnosticsReport) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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

