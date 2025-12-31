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

    const selectedRun = manifests.find(m => m.runId === selectedRunId);

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
                        <p><strong>Fast Model:</strong> {selectedRun.config.fastModel} ({selectedRun.config.fastModelDigest?.slice(0, 12)})</p>
                        <p><strong>Canon Hash:</strong> {selectedRun.initialStateHash}</p>
                    </div>

                    <h3>Stages ({selectedRun.stages.length})</h3>
                    <div className="stage-list">
                        {selectedRun.stages.map((stage, i) => (
                            <div key={stage.stageId} className="stage-item">
                                <span className="index">{i + 1}.</span>
                                <span className="type">{stage.stageType}</span>
                                <span className="duration">{stage.endTime - stage.startTime}ms</span>
                                <button onClick={() => onReplay(selectedRun.runId, stage.stageId)}>
                                    Replay Stage
                                </button>
                                <div className="hashes">
                                    <code>IN: {stage.inputHash}</code>
                                    <code>OUT: {stage.outputHash}</code>
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
