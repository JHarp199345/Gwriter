/**
 * Cheap token estimator for LLM prompts.
 * This is intentionally approximate; it's used for warnings, not billing.
 *
 * Rule of thumb: ~4 characters per token for English prose.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}


