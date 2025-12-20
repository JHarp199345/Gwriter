/**
 * Fast, stable, non-cryptographic hash for content change detection.
 * FNV-1a 32-bit over UTF-16 code units.
 */
export function fnv1a32(input: string): string {
	let hash = 0x811c9dc5; // offset basis
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// hash *= 16777619 (FNV prime) using bit ops
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}


