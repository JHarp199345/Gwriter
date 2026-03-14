/**
 * ContextSafety.ts - Cloud API Context Window Utility
 *
 * Provides a simple utility for getting the effective context token limit
 * for cloud AI providers. Local AI (Ollama/RAM-tier) tables have been removed.
 */

import { DashboardSettings } from '../main';

/**
 * Returns the effective context token limit from settings.
 * Falls back to 128,000 (a common cloud model default) if not configured.
 */
export function getContextLimit(settings: Pick<DashboardSettings, 'contextTokenLimit'>): number {
    return settings.contextTokenLimit ?? 128000;
}
