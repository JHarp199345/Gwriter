import React from 'react';
import { ChapterState, AuditResult, PatchOp, CanonFact } from '../services/Schemas';
import { DORMANCY_THRESHOLD, DENSITY_THRESHOLD } from '../services/ExplainabilityService';

interface FactInspectorProps {
    state: ChapterState;
    lastAudit?: AuditResult;
    lastPatches?: PatchOp[];
    currentChunkIndex: number;
}

/**
 * FactInspector provides a diff-aware view of the ChapterState.
 * It categorizes facts by their status and surfaces formula-based Risk Alerts.
 */
export const FactInspector: React.FC<FactInspectorProps> = ({ state, lastAudit, lastPatches, currentChunkIndex }) => {
    const violations = lastAudit?.violations || [];
    const patches = lastPatches || [];

    // Formula-based Alerts
    const dormantFacts = state.canonFacts.filter(f => {
        const lastUsed = parseInt(f.chunkId?.split('-').pop() || '0');
        return (currentChunkIndex - lastUsed) >= DORMANCY_THRESHOLD;
    });

    const isOverReliant = state.canonFacts.some(f => {
        // Mock over-reliance logic
        return false;
    });

    return (
        <div className="fact-inspector">
            <h2>Canon Fact Inspector (v{state.canonVersion})</h2>

            {(dormantFacts.length > 0 || isOverReliant) && (
                <section className="risk-alerts">
                    <h3>⚠️ Trust Signals / Risk Alerts</h3>
                    {dormantFacts.length > 5 && (
                        <div className="alert-item warning">
                            <strong>Drift Risk:</strong> {dormantFacts.length} core facts have been dormant for {DORMANCY_THRESHOLD}+ chunks.
                        </div>
                    )}
                    {isOverReliant && (
                        <div className="alert-item warning">
                            <strong>Over-reliance:</strong> Specific facts are appearing in >40% of recent paragraphs.
                        </div>
                    )}
                </section>
            )}
            
            <section className="fact-category violated">
                <h3>Violations ({violations.length})</h3>
                {violations.map((v, i) => (
                    <div key={i} className="violation-item">
                        <span className="severity">Level {v.severity}</span>
                        <span className="type">{v.type}</span>
                        <p className="message">{v.message}</p>
                        <code className="evidence">"{v.evidence}"</code>
                    </div>
                ))}
            </section>

            <section className="fact-category patched">
                <h3>Applied Patches ({patches.length})</h3>
                {patches.map((p, i) => (
                    <div key={i} className="patch-item">
                        <span className="op">{p.op.toUpperCase()}</span>
                        <p className="justification">{p.justification}</p>
                        <div className="diff">
                            {p.oldValue && <del>{p.oldValue}</del>}
                            <ins>{p.newValue}</ins>
                        </div>
                    </div>
                ))}
            </section>

            <section className="fact-category canon">
                <h3>Canonical Facts ({state.canonFacts.length})</h3>
                <div className="fact-grid">
                    {state.canonFacts.map((f) => (
                        <div key={f.id} className="fact-card">
                            <span className="entity">{f.entityId}</span>
                            <span className="attr">{f.attribute}:</span>
                            <span className="value">{JSON.stringify(f.value)}</span>
                            {f.chunkId && <span className="source">Source: {f.chunkId}</span>}
                        </div>
                    ))}
                </div>
            </section>
        </div>
    );
};
