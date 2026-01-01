/**
 * HelpRegistry centralizes all UI guidance and tooltips.
 */

export type HelpDensity = 'NONE' | 'LITE' | 'FULL';

export interface HelpItem {
    id: string;
    title: string;
    description: string;
    learnMoreUrl?: string;
    density: HelpDensity;
}

export const HELP_REGISTRY: Record<string, HelpItem> = {
    'relay-mode': {
        id: 'relay-mode',
        title: 'Generation Mode',
        description: 'Local uses your own hardware via Ollama. Cloud uses high-power APIs for complex editing.',
        density: 'LITE'
    },
    'stitch-logic': {
        id: 'stitch-logic',
        title: 'Prose Stitching',
        description: 'Smooths the boundary between generated chunks. It protects proper nouns and verifies fact integrity.',
        density: 'FULL'
    },
    'replay-exact': {
        id: 'replay-exact',
        title: 'Exact Replay',
        description: 'Uses identical prompt bodies and retrieval hits from the original run to verify model determinism.',
        density: 'FULL'
    },
    'grounding-heatmap': {
        id: 'grounding-heatmap',
        title: 'Grounding Heatmap',
        description: 'Shows where your story bible facts were used. Green = Grounded, Yellow = Inferred, Red = Speculative.',
        density: 'LITE'
    },
    'diagnostics': {
        id: 'diagnostics',
        title: 'System Diagnostics',
        description: 'Checks connectivity, model availability, and index health. Failure here usually blocks generation.',
        density: 'LITE'
    }
};

/**
 * Filter items based on user's help density setting.
 */
export function getVisibleHelp(density: HelpDensity): Record<string, HelpItem> {
    if (density === 'NONE') return {};
    if (density === 'LITE') {
        const lite: Record<string, HelpItem> = {};
        for (const [k, v] of Object.entries(HELP_REGISTRY)) {
            if (v.density === 'LITE') lite[k] = v;
        }
        return lite;
    }
    return HELP_REGISTRY;
}

