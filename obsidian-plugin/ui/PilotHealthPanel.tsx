import React from 'react';
import WritingDashboardPlugin from '../main';

interface PilotHealthPanelProps {
    plugin: WritingDashboardPlugin;
    misses: any[];
    rejections: any[];
    quarantineCount: number;
}

/**
 * PilotHealthPanel provides a real-time "Cockpit" view of the pilot's performance.
 * It tracks HARD intent misses, stitch rejections, and the Quarantine Review SLA.
 */
export const PilotHealthPanel: React.FC<PilotHealthPanelProps> = ({ misses, rejections, quarantineCount }) => {
    return (
        <div className="pilot-health-panel" style={{ padding: '12px', border: '1px solid var(--background-modifier-border)', borderRadius: '8px', marginTop: '16px' }}>
            <h3 style={{ marginTop: 0 }}>Pilot Cockpit</h3>
            
            <div className="health-metrics" style={{ display: 'flex', gap: '24px', marginBottom: '16px' }}>
                <div className="metric">
                    <div style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>HARD MISSES</div>
                    <div style={{ fontSize: '1.5em', fontWeight: 'bold', color: misses.length > 0 ? 'var(--text-error)' : 'inherit' }}>
                        {misses.length}
                    </div>
                </div>
                <div className="metric">
                    <div style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>STITCH REJECTIONS</div>
                    <div style={{ fontSize: '1.5em', fontWeight: 'bold', color: rejections.length > 0 ? 'var(--text-warning)' : 'inherit' }}>
                        {rejections.length}
                    </div>
                </div>
                <div className="metric">
                    <div style={{ fontSize: '0.8em', color: 'var(--text-muted)' }}>QUARANTINE</div>
                    <div style={{ fontSize: '1.5em', fontWeight: 'bold' }}>
                        {quarantineCount}
                    </div>
                </div>
            </div>

            {misses.length > 0 && (
                <div className="miss-details" style={{ fontSize: '0.9em', marginBottom: '12px' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Recent HARD Misses:</div>
                    <ul style={{ margin: 0, paddingLeft: '20px' }}>
                        {misses.slice(-3).map((m, i) => (
                            <li key={`${m.type}-${i}`}>{m.type}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div className={`sla-status ${quarantineCount > 5 ? 'mod-error' : ''}`} 
                 style={{ 
                    padding: '8px', 
                    borderRadius: '4px', 
                    backgroundColor: quarantineCount > 5 ? 'var(--background-modifier-error-hover)' : 'var(--background-secondary)',
                    textAlign: 'center',
                    fontSize: '0.85em'
                 }}>
                <strong>Quarantine SLA:</strong> {quarantineCount > 5 ? '🔴 REVIEW REQUIRED' : '🟢 HEALTHY'}
            </div>
        </div>
    );
};

