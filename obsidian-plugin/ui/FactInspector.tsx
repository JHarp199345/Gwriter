import React, { useState } from 'react';
import WritingDashboardPlugin from '../main';
import { ChapterState, CanonFact } from '../services/Schemas';
import { HelpTooltip } from './HelpTooltip';

interface FactInspectorProps {
    plugin: WritingDashboardPlugin;
    state: ChapterState;
}

export const FactInspector: React.FC<FactInspectorProps> = ({ plugin, state }) => {
    const [selectedFactId, setSelectedFactId] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>('all');

    const selectedFact = state.canonFacts.find(f => f.id === selectedFactId);

    const getOriginBadge = (origin: string) => {
        const colors: Record<string, string> = {
            'BIBLE': 'var(--text-accent)',
            'CANON': 'var(--text-success)',
            'EXTRACTOR': 'var(--text-warning)',
            'CLOUD_MONOLITHIC': 'var(--text-error)'
        };
        return <span className="fact-badge" style={{ color: colors[origin] || 'var(--text-muted)', fontSize: '0.8em', border: '1px solid', padding: '1px 4px', borderRadius: '4px', marginLeft: '8px' }}>{origin}</span>;
    };

    const getStatusIcon = (state: string) => {
        switch (state) {
            case 'CANON': return '🔒';
            case 'PROPOSED': return '🧪';
            case 'QUARANTINED': return '⚠️';
            default: return '❓';
        }
    };

    const filteredFacts = state.canonFacts.filter(f => {
        if (filter === 'all') return true;
        if (filter === 'locked') return f.lifecycleState === 'CANON';
        if (filter === 'pending') return f.lifecycleState === 'PROPOSED';
        if (filter === 'conflict') return f.lifecycleState === 'QUARANTINED';
        return true;
    });

    return (
        <div className="fact-inspector" style={{ display: 'flex', flexDirection: 'column', gap: '12px', flex: '1 1 auto', minHeight: 0 }}>
            <div className="inspector-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>Lore Inspector <HelpTooltip id="grounding-heatmap" density={plugin.settings.helpDensity || 'LITE'} /></h3>
                <div className="filter-bar" style={{ display: 'flex', gap: '4px' }}>
                    <button className={`nav-button ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setFilter('all')}>All</button>
                    <button className={`nav-button ${filter === 'locked' ? 'is-active' : ''}`} onClick={() => setFilter('locked')}>🔒 Locked</button>
                    <button className={`nav-button ${filter === 'pending' ? 'is-active' : ''}`} onClick={() => setFilter('pending')}>🧪 Pending</button>
                    <button className={`nav-button ${filter === 'conflict' ? 'is-active' : ''}`} onClick={() => setFilter('conflict')}>⚠️ Conflict</button>
                </div>
            </div>

            <div className="inspector-layout" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', flexGrow: 1, minHeight: 0 }}>
                <div className="fact-list" style={{ overflowY: 'auto', border: '1px solid var(--background-modifier-border)', borderRadius: '4px', padding: '8px' }}>
                    {filteredFacts.length === 0 ? (
                        <p className="empty-msg" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No facts found for this filter.</p>
                    ) : (
                        filteredFacts.map(fact => (
                            <div 
                                key={fact.id} 
                                className={`fact-item ${selectedFactId === fact.id ? 'is-selected' : ''}`}
                                onClick={() => setSelectedFactId(fact.id)}
                                style={{ 
                                    padding: '8px', 
                                    cursor: 'pointer', 
                                    borderBottom: '1px solid var(--background-modifier-border)',
                                    backgroundColor: selectedFactId === fact.id ? 'var(--background-modifier-hover)' : 'transparent'
                                }}
                            >
                                <div className="fact-main" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span className="fact-icon">{getStatusIcon(fact.lifecycleState)}</span>
                                    <span className="fact-summary" style={{ fontSize: '0.9em' }}>
                                        <strong>{fact.entityId}</strong>: {fact.attribute} is <em>{String(fact.value)}</em>
                                    </span>
                                </div>
                                <div className="fact-meta" style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', alignItems: 'center' }}>
                                    {getOriginBadge(fact.origin)}
                                    <span className="fact-conf" style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>{(fact.confidence * 100).toFixed(0)}% confidence</span>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="fact-detail-panel" style={{ overflowY: 'auto', border: '1px solid var(--background-modifier-border)', borderRadius: '4px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {selectedFact ? (
                        <div className="fact-detail-content">
                            <h4 style={{ marginTop: 0 }}>Fact Detail: {selectedFact.id}</h4>
                            
                            <section className="detail-section" style={{ marginBottom: '16px' }}>
                                <h5 style={{ borderBottom: '1px solid var(--background-modifier-border)', paddingBottom: '4px' }}>Why this exists (Provenance)</h5>
                                <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px', fontSize: '0.9em' }}>
                                    <span>Origin:</span> <strong>{selectedFact.origin}</strong>
                                    <span>Added:</span> <strong>{new Date(selectedFact.timestamp).toLocaleString()}</strong>
                                    <span>Source Run:</span> <strong>{selectedFact.chunkId || 'Initial Seed'}</strong>
                                    <span>Confidence:</span> <strong>{(selectedFact.confidence * 100).toFixed(0)}%</strong>
                                </div>
                            </section>

                            <section className="detail-section">
                                <h5 style={{ borderBottom: '1px solid var(--background-modifier-border)', paddingBottom: '4px' }}>Where this matters (Impact)</h5>
                                <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '4px', fontSize: '0.9em' }}>
                                    <span>Scope:</span> <strong>{selectedFact.scope}</strong>
                                    <span>Status:</span> <strong>{selectedFact.lifecycleState}</strong>
                                    <span>Attribute:</span> <strong>{selectedFact.attribute}</strong>
                                </div>
                                {selectedFact.sourceSpan && (
                                    <div style={{ marginTop: '8px', fontSize: '0.85em', fontStyle: 'italic', color: 'var(--text-muted)', borderLeft: '2px solid var(--text-accent)', paddingLeft: '8px' }}>
                                        "...{selectedFact.sourceSpan.anchorTextBefore} <strong>[{selectedFact.value}]</strong> {selectedFact.sourceSpan.anchorTextAfter}..."
                                    </div>
                                )}
                            </section>
                        </div>
                    ) : (
                        <p className="empty-msg" style={{ textAlign: 'center', color: 'var(--text-muted)', margin: 'auto' }}>Select a fact to see details.</p>
                    )}
                </div>
            </div>

            <div className="timeline-section" style={{ height: '150px', border: '1px solid var(--background-modifier-border)', borderRadius: '4px', padding: '8px', overflowY: 'auto' }}>
                <h4 style={{ marginTop: 0, fontSize: '0.9em' }}>Run Timeline</h4>
                <div className="timeline-list" style={{ fontSize: '0.85em' }}>
                    {state.timeline.length === 0 ? (
                        <p className="empty-msg" style={{ color: 'var(--text-muted)' }}>No timeline events yet.</p>
                    ) : (
                        state.timeline.map((t, i) => (
                            <div key={i} style={{ display: 'flex', gap: '12px', marginBottom: '4px' }}>
                                <span style={{ color: 'var(--text-accent)', minWidth: '60px' }}>{t.chunkId}</span>
                                <span>{t.summary}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
