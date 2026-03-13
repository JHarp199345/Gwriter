import React, { useState } from 'react';
import { RunManifest, StageResult } from '../services/Schemas';

interface DevReplayPanelProps {
    manifests: RunManifest[];
    onReplay: (runId: string, stageId?: string) => void;
}

/**
 * DevReplayPanel allows developers to inspect RunManifests and trigger 
 * strict-mode replays of specific generation stages.
 */
export const DevReplayPanel: React.FC<DevReplayPanelProps> = ({ manifests, onReplay }) => {
    const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
    const [normalizedMode, setNormalizedMode] = useState(true);
    const [replayDiff, setReplayDiff] = useState<{ original: any, replayed: any, stageType: string, metrics?: any } | null>(null);

    const selectedRun = manifests.find(m => m.runId === selectedRunId);

    const normalizeProse = (text: string) => {
        if (typeof text !== 'string') return text;
        return text.replace(/\s+/g, ' ').trim();
    };

    const renderData = (data: any, type: string) => {
        if (type === 'WRITE' || type === 'REPAIR') {
            return normalizedMode ? normalizeProse(data) : data;
        }
        return JSON.stringify(data, null, 2);
    };

    return (
        <div className="dev-replay-panel">
            <h2>Developer Replay Utility</h2>
            
            <div className="run-selector">
                <label>Select Run Manifest:</label>
                <select onChange={(e) => setSelectedRunId(e.target.value)} value={selectedRunId || ''}>
                    <option value="">-- Choose a Run --</option>
                    {manifests.map(m => (
                        <option key={m.runId} value={m.runId}>
                            {m.runId} ({new Date(m.startTime).toLocaleTimeString()})
                        </option>
                    ))}
                </select>
            </div>

            {selectedRun && (
                <div className="run-details">
                    <div className="metadata">
                        <p><strong>Ollama Version:</strong> {selectedRun.ollamaVersion || 'Unknown'}</p>
                        <p><strong>Smart Model:</strong> {selectedRun.config.smartModel} ({selectedRun.config.smartModelDigest?.slice(0, 12)})</p>
                        {selectedRun.config.fastModel && (
                            <p><strong>Legacy Fast Model:</strong> {selectedRun.config.fastModel} ({selectedRun.config.fastModelDigest?.slice(0, 12)})</p>
                        )}
                        <p><strong>Canon Hash:</strong> {selectedRun.initialStateHash}</p>
                    </div>

                    <div className="diff-settings">
                        <label>
                            <input type="checkbox" checked={normalizedMode} onChange={() => setNormalizedMode(!normalizedMode)} />
                            {' '}Normalized Diff (Ignore whitespace)
                        </label>
                    </div>

                    {replayDiff && (
                        <div className="replay-diff-viewer">
                            <div className="diff-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h3>Stage Diff: {replayDiff.stageType}</h3>
                                <button onClick={() => setReplayDiff(null)}>Close Diff</button>
                            </div>

                            {replayDiff.metrics && (
                                <div className="replay-metrics-bar" style={{ display: 'flex', gap: 20, marginBottom: 12, padding: 8, backgroundColor: 'var(--background-secondary)', borderRadius: 4 }}>
                                    <div className={replayDiff.metrics.retrievalSimilarity >= 0.6 ? 'metric-pass' : 'metric-fail'}>
                                        <strong>Retrieval Similarity:</strong> {(replayDiff.metrics.retrievalSimilarity * 100).toFixed(0)}%
                                    </div>
                                    <div className={replayDiff.metrics.loreParity ? 'metric-pass' : 'metric-fail'}>
                                        <strong>Lore Parity:</strong> {replayDiff.metrics.loreParity ? '✅ Match' : '❌ Mismatch'}
                                    </div>
                                    {replayDiff.metrics.retrievalSimilarity < 0.6 && (
                                        <button className="rerun-btn mod-warning" onClick={() => onReplay(selectedRun!.runId)}>
                                            Rerun with Reduced Novelty
                                        </button>
                                    )}
                                </div>
                            )}

                            <div className="diff-container" style={{ display: 'flex', gap: 12 }}>
                                <div className="original" style={{ flex: 1 }}>
                                    <h4>Original</h4>
                                    <pre style={{ whiteSpace: 'pre-wrap' }}>{renderData(replayDiff.original, replayDiff.stageType)}</pre>
                                </div>
                                <div className="replayed" style={{ flex: 1 }}>
                                    <h4>Replayed</h4>
                                    <pre style={{ whiteSpace: 'pre-wrap' }}>{renderData(replayDiff.replayed, replayDiff.stageType)}</pre>
                                </div>
                            </div>
                            <button onClick={() => setReplayDiff(null)}>Close Diff</button>
                        </div>
                    )}

                    <h3>Stages ({selectedRun.stages.length})</h3>
                    <div className="stage-list">
                        {selectedRun.stages.map((stage, i) => (
                            <div key={stage.stageId} className="stage-item">
                                <span className="index">{i + 1}.</span>
                                <span className="type">{stage.stageType}</span>
                                <span className="duration">{stage.endTime - stage.startTime}ms</span>
                                <button onClick={() => {
                                    onReplay(selectedRun.runId, stage.stageId);
                                    // MOCK: In a real implementation, onReplay would return the result
                                    // which we would then set into setReplayDiff.
                                }}>
                                    Replay Stage
                                </button>
                                <div className="hashes">
                                    <code>IN: {stage.inputHash.slice(0, 8)}</code>
                                    <code>OUT: {stage.outputHash.slice(0, 8)}</code>
                                </div>
                            </div>
                        ))}
                    </div>

                    <button className="full-replay-btn" onClick={() => onReplay(selectedRun.runId)}>
                        Run Full Strict Replay
                    </button>
                </div>
            )}
        </div>
    );
};
