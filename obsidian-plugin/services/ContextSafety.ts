/**
 * ContextSafety.ts - RAM-Aware Context Window Management
 * 
 * This module provides safe context limits based on:
 * 1. RAM tier (user's hardware)
 * 2. Model tier (parsed from model name)
 * 3. Risk profile (user preference)
 * 4. Model's actual context limit (from Ollama, if verified)
 * 
 * Two controllers, not three:
 * - RAM/Profile Controller: BASE_TABLE × PROFILE_MULTIPLIER, clamped by PROFILE_CONTEXT_CAP
 * - Model Controller: Actual num_ctx from Ollama /api/show (if verified)
 * 
 * No TIER_CEILING - the model's real limit is the authority.
 */

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export type RamTier = 8 | 16 | 24 | 32 | 64 | 128;
export type ModelTier = '7b' | '13b' | '20b' | '30b' | '40b' | '50b' | '60b' | '70b';
export type RiskProfile = 'safe' | 'moderate' | 'aggressive';
export type CellRisk = 'blocked' | 'ok';
export type UsageWarning = 'safe' | 'caution' | 'danger';

export const RAM_TIERS: RamTier[] = [8, 16, 24, 32, 64, 128];
export const MODEL_TIERS: ModelTier[] = ['7b', '13b', '20b', '30b', '40b', '50b', '60b', '70b'];
export const RISK_PROFILES: RiskProfile[] = ['safe', 'moderate', 'aggressive'];

// =============================================================================
// SAFETY TABLES
// =============================================================================

/**
 * BASE_TABLE: Conservative starting points for each RAM + Model combination.
 * 0 = blocked (model cannot run on this RAM tier).
 * 
 * These values account for:
 * - Model weight memory (~4-40GB depending on model size)
 * - OS/system overhead (~2-4GB)
 * - Remaining RAM available for KV cache
 */
export const BASE_TABLE: Record<RamTier, Record<ModelTier, number>> = {
    //         7B      13B     20B     30B     40B     50B     60B     70B
    8:   { '7b': 4096,  '13b': 0,     '20b': 0,     '30b': 0,     '40b': 0,     '50b': 0,     '60b': 0,     '70b': 0     },
    16:  { '7b': 8192,  '13b': 0,     '20b': 0,     '30b': 0,     '40b': 0,     '50b': 0,     '60b': 0,     '70b': 0     },
    24:  { '7b': 16384, '13b': 12288, '20b': 4096,  '30b': 0,     '40b': 0,     '50b': 0,     '60b': 0,     '70b': 0     },
    32:  { '7b': 24576, '13b': 20480, '20b': 16384, '30b': 12288, '40b': 4096,  '50b': 2048,  '60b': 2048,  '70b': 0     },
    64:  { '7b': 49152, '13b': 40960, '20b': 32768, '30b': 16384, '40b': 8192,  '50b': 4096,  '60b': 4096,  '70b': 4096  },
    128: { '7b': 65536, '13b': 65536, '20b': 65536, '30b': 32768, '40b': 16384, '50b': 8192,  '60b': 8192,  '70b': 65536 },
};

/**
 * PROFILE_MULTIPLIER: User-selected risk tolerance.
 * Applied to BASE_TABLE values before capping.
 */
export const PROFILE_MULTIPLIER: Record<RiskProfile, number> = {
    safe: 1.0,       // Use base value as-is
    moderate: 1.5,   // 50% more headroom
    aggressive: 2.0, // Double (risky)
};

/**
 * PROFILE_CONTEXT_CAP: Hard ceiling per RAM tier + profile.
 * Prevents the multiplier from producing unsafe values.
 */
export const PROFILE_CONTEXT_CAP: Record<RamTier, Record<RiskProfile, number>> = {
    //        Safe      Moderate   Aggressive
    8:   { safe: 2048,   moderate: 4096,   aggressive: 6144   },
    16:  { safe: 4096,   moderate: 8192,   aggressive: 12288  },
    24:  { safe: 6144,   moderate: 12288,  aggressive: 16384  },
    32:  { safe: 8192,   moderate: 12288,  aggressive: 16384  },
    64:  { safe: 16384,  moderate: 20480,  aggressive: 32768  },
    128: { safe: 32768,  moderate: 49152,  aggressive: 65536  },
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Round to nearest 1024 for clean context values.
 */
export function quantize(n: number): number {
    return Math.max(0, Math.floor(n / 1024) * 1024);
}

/**
 * Detect model tier from model name by parsing size indicators.
 * Falls back to '7b' (safest assumption) if unknown.
 */
export function detectModelTier(modelName: string): ModelTier {
    const lower = modelName.toLowerCase();
    
    if (lower.includes('70b') || lower.includes('72b')) return '70b';
    if (lower.includes('65b') || lower.includes('60b')) return '60b';
    if (lower.includes('50b') || lower.includes('52b')) return '50b';
    if (lower.includes('40b') || lower.includes('42b') || lower.includes('45b')) return '40b';
    if (lower.includes('30b') || lower.includes('32b') || lower.includes('34b') || lower.includes('35b')) return '30b';
    if (lower.includes('20b') || lower.includes('22b') || lower.includes('21b')) return '20b';
    if (lower.includes('13b') || lower.includes('14b') || lower.includes('12b')) return '13b';
    if (lower.includes('7b') || lower.includes('8b') || lower.includes('9b')) return '7b';
    
    // Check for smaller models (treat as 7b tier)
    if (lower.includes('3b') || lower.includes('1b') || lower.includes('0.5b')) return '7b';
    
    // Default to safest tier
    return '7b';
}

/**
 * Classify a cell as blocked or ok based on its cap value.
 * The tables ARE the safety system - if cap > 0, it's ok.
 */
export function classifyCell(cap: number): CellRisk {
    if (cap <= 0) return 'blocked';
    return 'ok';
}

/**
 * Get usage warning based on slider position relative to derived cap.
 * Warnings are based on how much of the safe allocation the user is using.
 */
export function getUsageWarning(sliderValue: number, derivedCap: number): UsageWarning {
    if (derivedCap <= 0) return 'danger';
    
    const ratio = sliderValue / derivedCap;
    
    if (ratio >= 0.95) return 'danger';   // At 95%+ of cap
    if (ratio >= 0.80) return 'caution';  // At 80%+ of cap
    return 'safe';
}

/**
 * Get slider bounds for a given max cap.
 * Slider range is [maxCap/2, maxCap] to always provide meaningful range.
 */
export function getSliderBounds(maxCap: number): { min: number; max: number } {
    const minCap = quantize(maxCap / 2);
    return { 
        min: Math.max(minCap, 1024), 
        max: maxCap 
    };
}

// =============================================================================
// CORE DERIVATION
// =============================================================================

export interface SafeContextResult {
    /** The derived safe context limit in tokens */
    cap: number;
    /** Whether this configuration is blocked (cannot run) */
    isBlocked: boolean;
    /** Whether the model's context limit was verified from Ollama */
    isVerified: boolean;
    /** The RAM-based cap before model limit was applied */
    ramCap: number;
    /** The model's actual context limit (null if unverified) */
    modelLimit: number | null;
    /** Usage warning based on slider value */
    warning: UsageWarning;
}

/**
 * Derive the safe context cap from all constraints.
 * 
 * Formula:
 *   ramCap = min(BASE_TABLE[ram][model] × PROFILE_MULTIPLIER[profile], PROFILE_CONTEXT_CAP[ram][profile])
 *   derivedCap = min(ramCap, modelContextLimit if verified)
 *   finalCap = min(derivedCap, sliderValue if provided)
 */
export function deriveCap(
    ramTier: RamTier,
    modelTier: ModelTier,
    profile: RiskProfile,
    modelContextLimit: number | null,
    sliderValue?: number
): SafeContextResult {
    // Get base value from table
    const base = BASE_TABLE[ramTier][modelTier];
    
    // Check if blocked
    if (base <= 0) {
        return {
            cap: 0,
            isBlocked: true,
            isVerified: modelContextLimit !== null,
            ramCap: 0,
            modelLimit: modelContextLimit,
            warning: 'danger'
        };
    }
    
    // Apply profile multiplier
    const scaled = base * PROFILE_MULTIPLIER[profile];
    
    // Apply profile cap
    const profileCap = PROFILE_CONTEXT_CAP[ramTier][profile];
    const ramCap = quantize(Math.min(scaled, profileCap));
    
    // Apply model limit if verified
    const isVerified = modelContextLimit !== null;
    const capBeforeSlider = isVerified 
        ? quantize(Math.min(ramCap, modelContextLimit)) 
        : ramCap;
    
    // Apply slider value if provided (user's choice within safe bounds)
    const finalCap = sliderValue !== undefined && sliderValue > 0
        ? quantize(Math.min(capBeforeSlider, sliderValue))
        : capBeforeSlider;
    
    // Calculate warning based on slider position
    const warning = sliderValue !== undefined 
        ? getUsageWarning(sliderValue, capBeforeSlider)
        : 'safe';
    
    return {
        cap: finalCap,
        isBlocked: false,
        isVerified,
        ramCap,
        modelLimit: modelContextLimit,
        warning
    };
}

/**
 * Main entry point for getting safe context limit.
 * This is what other services should call.
 */
export function getSafeContextLimit(
    ramTier: RamTier,
    modelName: string,
    profile: RiskProfile,
    modelContextLimit: number | null,
    sliderValue?: number
): SafeContextResult {
    const modelTier = detectModelTier(modelName);
    return deriveCap(ramTier, modelTier, profile, modelContextLimit, sliderValue);
}

/**
 * Check if a model is blocked for a given RAM tier.
 * Use this for runtime guards before generation.
 */
export function isModelBlocked(ramTier: RamTier, modelName: string): boolean {
    const modelTier = detectModelTier(modelName);
    return BASE_TABLE[ramTier][modelTier] <= 0;
}

/**
 * Get human-readable error message for blocked model.
 */
export function getBlockedModelError(ramTier: RamTier, modelName: string): string {
    const modelTier = detectModelTier(modelName);
    
    // Find minimum RAM tier that supports this model
    let minRam: RamTier | null = null;
    for (const rt of RAM_TIERS) {
        if (BASE_TABLE[rt][modelTier] > 0) {
            minRam = rt;
            break;
        }
    }
    
    if (minRam) {
        return `Model "${modelName}" (${modelTier}) cannot run on ${ramTier}GB RAM. Requires at least ${minRam}GB.`;
    } else {
        return `Model "${modelName}" (${modelTier}) is not supported in the current safety tables.`;
    }
}

// =============================================================================
// DEV-ONLY INVARIANT CHECKS
// =============================================================================

/**
 * Assert that caps never decrease as RAM increases (for a given profile).
 */
export function assertRamMonotonicity(profile: RiskProfile): void {
    for (const tier of MODEL_TIERS) {
        let prevCap = -1;
        for (const ram of RAM_TIERS) {
            const base = BASE_TABLE[ram][tier];
            const scaled = base * PROFILE_MULTIPLIER[profile];
            const profileCap = PROFILE_CONTEXT_CAP[ram][profile];
            const cap = Math.min(scaled, profileCap);
            
            if (cap > 0 && prevCap > 0 && cap < prevCap) {
                throw new Error(
                    `RAM monotonicity violation [${profile}]: ${tier} @ ${ram}GB (${cap}) < previous (${prevCap})`
                );
            }
            if (cap > 0) prevCap = cap;
        }
    }
}

/**
 * Assert that safe <= moderate <= aggressive for all configs.
 */
export function assertProfileOrdering(): void {
    for (const ram of RAM_TIERS) {
        for (const tier of MODEL_TIERS) {
            const s = deriveCap(ram, tier, 'safe', null).cap;
            const m = deriveCap(ram, tier, 'moderate', null).cap;
            const a = deriveCap(ram, tier, 'aggressive', null).cap;

            // Skip if all blocked
            if (s === 0 && m === 0 && a === 0) continue;

            if (s > m || m > a) {
                throw new Error(
                    `Profile ordering violation: ${tier} @ ${ram}GB: safe=${s} > moderate=${m} or moderate=${m} > aggressive=${a}`
                );
            }
        }
    }
}

/**
 * Run all invariant checks. Call in dev mode on plugin load.
 */
export function runInvariantChecks(): void {
    assertRamMonotonicity('safe');
    assertRamMonotonicity('moderate');
    assertRamMonotonicity('aggressive');
    assertProfileOrdering();
    console.debug('[ContextSafety] All invariants passed');
}

