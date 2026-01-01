/**
 * Centralized policy module for all thresholds, constants, and decay rates.
 * Enables easy tuning of the Freedom Stack's co-authoring engine.
 */

export const CO_AUTHORING_POLICY = {
    // GROUNDING THRESHOLDS
    GROUNDING: {
        TARGET_SCORE: 0.8, // Target 80% grounded paragraphs
        DENSITY_THRESHOLD: 0.4, // Alert if fact ID appears in >40% of paragraphs
        DORMANCY_THRESHOLD: 3, // Chunks since last fact reference before drift alert
        CREATIVE_DENOMINATOR_EXEMPT: true, // Creative paragraphs don't count towards the grounding target
    },

    // RETRIEVAL & DECAY
    RETRIEVAL: {
        MAX_STICKY_LIFETIME: 3, // Chunks a context anchor can remain sticky
        STICKY_CONTINUITY_RATIO: 0.3, // Default 30% of chunks are sticky anchors
        NOVELTY_BIAS_THRESHOLD: 0.7, // Force rotation if novelty bias exceeds this
        SCORING_VERSION: 1,
        SCORING_WEIGHTS: { lex: 0.4, embed: 0.6 },
        HARD_INTENT_THRESHOLDS: {
            FINAL: 0.7,
            EMBED: 0.6,
            LEX: 0.6
        },
        JACCARD_SIMILARITY_THRESHOLD: 0.6, // For creative replay metrics
        LORE_PARITY_THRESHOLD: 1.0 // For creative replay metrics
    },

    // SPONTANEITY & CREATIVITY
    SPONTANEITY: {
        LOOKUP: [
            { min: 0, max: 60, temp: [0.0, 0.4], novelty: [0.0, 0.2], sticky_min: 0.3 },
            { min: 60, max: 90, temp: [0.4, 0.8], novelty: [0.2, 0.5], sticky_min: 0.2 },
            { min: 90, max: 100, temp: [0.8, 1.2], novelty: [0.5, 0.7], sticky_min: 0.1 }
        ],
        CURVE_EPSILON: 0.01,
        PIN_TTL_CHUNKS: 3,
        MAX_PIN_EXTENSIONS: 3,
    },

    // CONTINUITY RISK POLICY
    CONTINUITY_RISK: {
        WEIGHTS: {
            DORMANCY: 0.35,
            DENSITY_DROP: 0.25,
            REPAIR_RATE: 0.25,
            OVER_RELIANCE: 0.15
        },
        WINDOWS: {
            DORMANCY_CHUNKS: 3,
            DENSITY_DROP_CHUNKS: 2,
            REPAIR_RATE_CHUNKS: 3,
            OVER_RELIANCE_PARAS: 10
        },
        THRESHOLDS: {
            R0_START_CLAMPING: 0.3,
            R1_FULL_CLAMP: 0.7
        }
    },

    // PENALTIES
    PENALTIES: {
        ENTITY_MISMATCH: -0.3, // Penalty if cited fact's entity is missing from text
        BUNDLE_ABSENCE: -0.5, // Penalty if cited fact was not in the retrieval bundle
        CITATION_SPAM: -0.2, // Penalty for > 5 citations in one paragraph
    },

    // SEGMENTATION & IDENTITY
    SEGMENTATION: {
        TARGET_SENTENCES_PER_PARA: { min: 3, max: 6 },
        HARD_MAX_CHARS_PER_PARA: 1200,
        FUZZY_IDENTITY_THRESHOLD: 0.75, // Jaccard similarity for p_id recovery
    },

    // QUALITY FLOORS
    QUALITY_FLOORS: {
        MAX_SPECULATIVE_RATIO: 0.2, // Max 20% speculative paragraphs allowed
        MAX_CONSECUTIVE_LITE_CHUNKS: 2, // Max consecutive chunks using Lite Fallback
    },

    // PERFORMANCE GATES
    PERFORMANCE: {
        MAX_HOVER_LATENCY_MS: 150,
        MAX_UI_EVENT_RATE_PER_SEC: 60,
        MAX_MEMORY_GROWTH_MB_PER_RUN: 50,
        STREAM_FLUSH_INTERVAL_MS: 250,
        STREAM_MAX_BUFFER_CHARS: 600,
        MAX_TIME_PER_SMART_CALL_MS: 15000, // 15s budget per smart model call
        MAX_REPAIR_ATTEMPTS_PER_PARA: 3,
    }
};

