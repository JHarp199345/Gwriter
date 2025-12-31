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
        STICKY_CONTINUITY_RATIO: 0.3, // 30% of chunks are sticky anchors
        NOVELTY_BIAS_THRESHOLD: 0.7, // Force rotation if novelty bias exceeds this
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
    }
};

