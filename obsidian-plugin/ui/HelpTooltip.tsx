import * as React from 'react';
import { HelpItem, HELP_REGISTRY, HelpDensity } from './HelpRegistry';

interface HelpTooltipProps {
    id: string;
    density: HelpDensity;
}

export const HelpTooltip: React.FC<HelpTooltipProps> = ({ id, density }) => {
    const item = HELP_REGISTRY[id];
    if (!item) return null;

    // Filter based on density
    if (density === 'NONE') return null;
    if (density === 'LITE' && item.density === 'FULL') return null;

    return (
        <span className="help-icon" title={`${item.title}: ${item.description}`}>
            ⓘ
            {item.learnMoreUrl && (
                <a href={item.learnMoreUrl} target="_blank" rel="noopener" className="learn-more-link">
                    Learn More
                </a>
            )}
        </span>
    );
};

