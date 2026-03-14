import React, { useEffect, useState } from 'react';
import WritingDashboardPlugin from '../main';
import { RunPaths } from '../services/RunPaths';
import { RunManifest, StageResult } from '../services/Schemas';
import { Notice } from 'obsidian';

interface ReplayPanelProps {
    plugin: WritingDashboardPlugin;
}

export const ReplayPanel: React.FC<ReplayPanelProps> = ({ plugin }) => {
    const [runs, setRuns] = useState<{ key: string, manifest: RunManifest }[]>([]);
    const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        loadRuns();
    }, []);

    const loadRuns = async () => {
        setIsLoading(true);
        try {
            const vault = plugin.app.vault;
            const outputDir = '.gwriter/output';
            
            if (!(await vault.adapter.exists(outputDir))) {
                setRuns([]);
                return;
            }

            const folders = await vault.adapter.list(outputDir);
            const manifestPromises = folders.folders.map(async (folderPath) => {
                const runKey = folderPath.split('/').pop() || '';
                const manifestPath = RunPaths.manifestPath(runKey);
                
                if (await vault.adapter.exists(manifestPath)) {
                    const content = await vault.adapter.read(manifestPath);
                    try {
                        const manifest = JSON.parse(content) as RunManifest;
                        return { key: runKey, manifest };
                    } catch (e) {
                        console.error(`Failed to parse manifest at ${manifestPath}`, e);
                        return null;
                    }
                }
                return null;
            });

            const loadedRuns = (await Promise.all(manifestPromises))
                .filter((r): r is { key: string, manifest: RunManifest } => r !== null)
                .sort((a, b) => b.manifest.startTime - a.manifest.startTime);
            
            setRuns(loadedRuns);
        } catch (error) {
            console.error('Failed to load runs', error);
            new Notice('Failed to load generation runs.');
        } finally {
            setIsLoading(false);
        }
    };

    const selectedRun = runs.find(r => r.key === selectedRunKey);

    const getStageLabel = (stage: StageResult) => {
        // Terminology correction for cloud-monolithic runs
        if (selectedRun?.manifest?.config?.smartModel?.includes('gpt') || 
            selectedRun?.manifest?.config?.smartModel?.includes('claude') || 
            selectedRun?.manifest?.config?.smartModel?.includes('gemini')) {
            
            switch (stage.stageType) {
                case 'RETRIEVE': return 'CONTEXT_PACK';
                case 'WRITE': return 'CLOUD_STRIKE';
                case 'AUDIT': return 'LOCAL_AUDIT';
                case 'HARVEST': return 'LORE_HARVEST';
                default: return stage.stageType;
            }
        }
        return stage.stageType;
    };

    const getHealthBadge = (manifest: RunManifest) => {
        // Simplified health logic for the panel
        const hasError = manifest.stages.some(s => s.stageType === 'AUDIT' && s.data?.overallSeverity >= 4);
        if (hasError) return <span style={{ color: 'var(--text-error)', fontSize: '0.8em' }}>❌ Issues</span>;
        return <span style={{ color: 'var(--text-success)', fontSize: '0.8em' }}>✅ Healthy</span>;
    };

    const getRunSignificance = (manifest: RunManifest) => {
        const promoted = manifest.harvestSummary?.approvedIds?.length || 0;
        const isCloud = manifest.config?.smartModel?.includes('gpt') || manifest.config?.smartModel?.includes('claude');
        
        const parts = [];
        if (promoted > 0) parts.push(`Promoted ${promoted} facts`);
        if (isCloud) parts.push('Cloud monolithic');
        else parts.push('Local relay');
        
        return parts.join(' • ');
    };

    return (
        <div className="replay-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '12px' }}>
            <div className="replay-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Generation History</h3>
                <button className="nav-button" onClick={loadRuns} disabled={isLoading}>
                    {isLoading ? 'Loading...' : 'Refresh'}
                </button>
            </div>

            <div className="replay-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '12px', flexGrow: 1, minHeight: 0 }}>
                <div className="run-list" style={{ overflowY: 'auto', border: '1px solid var(--background-modifier-border)', borderRadius: '4px', padding: '8px' }}>
                    {runs.length === 0 ? (
                        <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No runs found.</p>
                    ) : (
                        runs.map(run => (
                            <div
                                key={run.key}
                                className={`run-item ${selectedRunKey === run.key ? 'is-selected' : ''}`}
                                role="button"
                                tabIndex={0}
                                onClick={() => setSelectedRunKey(run.key)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setSelectedRunKey(run.key); } }}
                                style={{
                                    padding: '8px',
                                    cursor: 'pointer',
                                    borderBottom: '1px solid var(--background-modifier-border)',
                                    backgroundColor: selectedRunKey === run.key ? 'var(--background-modifier-hover)' : 'transparent'
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <strong style={{ fontSize: '0.9em' }}>{new Date(run.manifest.startTime).toLocaleString()}</strong>
                                    {getHealthBadge(run.manifest)}
                                </div>
                                <div style={{ fontSize: '0.8em', color: 'var(--text-muted)', marginTop: '4px' }}>
                                    {getRunSignificance(run.manifest)}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="run-detail" style={{ overflowY: 'auto', border: '1px solid var(--background-modifier-border)', borderRadius: '4px', padding: '12px' }}>
                    {selectedRun ? (
                        <div className="run-detail-content">
                            <h4 style={{ marginTop: 0 }}>Run: {selectedRun.key}</h4>
                            <div style={{ fontSize: '0.9em', marginBottom: '16px', display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px' }}>
                                <span>Model:</span> <strong>{selectedRun.manifest.config.smartModel}</strong>
                                <span>Start:</span> <strong>{new Date(selectedRun.manifest.startTime).toLocaleString()}</strong>
                                <span>Stages:</span> <strong>{selectedRun.manifest.stages.length}</strong>
                            </div>

                            <h5 style={{ borderBottom: '1px solid var(--background-modifier-border)', paddingBottom: '4px' }}>Execution Stages</h5>
                            <div className="stage-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                                {selectedRun.manifest.stages.map((stage) => (
                                    <div key={stage.stageType + stage.startTime} style={{ padding: '8px', backgroundColor: 'var(--background-secondary)', borderRadius: '4px', fontSize: '0.9em' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                            <span style={{ color: 'var(--text-accent)', fontWeight: 'bold' }}>{getStageLabel(stage)}</span>
                                            <span style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{Math.round(stage.endTime - stage.startTime)}ms</span>
                                        </div>
                                        {stage.stageType === 'AUDIT' && stage.data && (
                                            <div style={{ marginTop: '4px', fontSize: '0.85em' }}>
                                                {stage.data.violations?.length > 0 ? (
                                                    <span style={{ color: 'var(--text-error)' }}>⚠️ {stage.data.violations.length} violations</span>
                                                ) : (
                                                    <span style={{ color: 'var(--text-success)' }}>✅ No violations</span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                            
                            <div style={{ marginTop: '20px', display: 'flex', gap: '8px' }}>
                                <button className="mod-cta" style={{ fontSize: '0.85em' }} onClick={() => new Notice('Safe Context Pack inspection coming soon.')}>
                                    Inspect Context Pack
                                </button>
                                <button style={{ fontSize: '0.85em' }} onClick={() => new Notice('Replay mode coming soon.')}>
                                    Replay Run
                                </button>
                            </div>
                        </div>
                    ) : (
                        <p style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '40px' }}>Select a run to see execution details.</p>
                    )}
                </div>
            </div>
        </div>
    );
};
