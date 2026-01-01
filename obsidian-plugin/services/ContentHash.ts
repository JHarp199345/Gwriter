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

/**
 * Deterministic SHA-256 hash (UTF-8).
 */
export async function sha256(input: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

/**
 * Normalizes whitespace for consistent hashing:
 * - Converts all line endings (\r\n, \r) to \n
 * - Collapses multiple spaces/tabs to single space
 * - Trims leading/trailing whitespace globally
 */
export function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, '\n') // Convert \r\n to \n
		.replace(/\r/g, '\n')   // Convert \r to \n
		.replace(/[ \t]+/g, ' ') // Collapse spaces/tabs to single space
		.trim(); // Global trim
}

/**
 * Normalizes text for excerpt hash calculation:
 * - Applies normalizeWhitespace
 * - Collapses multiple blank lines (\n{2,}) to single \n
 */
export function normalizeForExcerptHash(text: string): string {
	return normalizeWhitespace(text)
		.replace(/\n{2,}/g, '\n'); // Collapse multiple blank lines
}

/**
 * Canonical JSON stringify with deterministic key ordering and stable serialization.
 * Rules:
 * - Key ordering: Lexicographic (Unicode code point) at every object depth
 * - Arrays: Preserve order exactly
 * - Undefined: Omitted (property not emitted)
 * - NaN/Infinity: Serialize as null
 * - Dates: Serialize as ISO strings
 * - BigInt: Throw error (unsupported)
 * - Encoding: UTF-8 bytes
 */
export function canonicalJsonStringify(obj: any): string {
	if (typeof obj === 'bigint') {
		throw new Error('BigInt serialization not supported in canonical JSON');
	}

	if (obj === null || obj === undefined) {
		return 'null';
	}

	if (typeof obj === 'boolean' || typeof obj === 'number') {
		if (!Number.isFinite(obj)) {
			// NaN or Infinity
			return 'null';
		}
		return String(obj);
	}

	if (typeof obj === 'string') {
		return JSON.stringify(obj);
	}

	if (obj instanceof Date) {
		return JSON.stringify(obj.toISOString());
	}

	if (Array.isArray(obj)) {
		const items = obj.map(item => canonicalJsonStringify(item));
		return '[' + items.join(',') + ']';
	}

	if (typeof obj === 'object') {
		// Sort keys lexicographically (Unicode code point order)
		const keys = Object.keys(obj).sort((a, b) => {
			for (let i = 0; i < Math.min(a.length, b.length); i++) {
				const codeA = a.codePointAt(i) || 0;
				const codeB = b.codePointAt(i) || 0;
				if (codeA !== codeB) {
					return codeA - codeB;
				}
			}
			return a.length - b.length;
		});

		const pairs: string[] = [];
		for (const key of keys) {
			const value = obj[key];
			// Omit undefined properties
			if (value !== undefined) {
				pairs.push(JSON.stringify(key) + ':' + canonicalJsonStringify(value));
			}
		}
		return '{' + pairs.join(',') + '}';
	}

	// Fallback to standard JSON.stringify for unknown types
	return JSON.stringify(obj);
}

/**
 * Computes contentHash (SHA-256 of canonical JSON representation).
 */
export async function contentHash(obj: any): Promise<string> {
	const canonical = canonicalJsonStringify(obj);
	return await sha256(canonical);
}

/**
 * Computes fileHash (SHA-256 of raw file bytes).
 */
export async function fileHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	// Convert to Uint8Array, then create a copy to ensure we have a new ArrayBuffer (not SharedArrayBuffer)
	const uint8Array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	// Create a new Uint8Array copy - this creates a new ArrayBuffer
	const copy = new Uint8Array(uint8Array);
	const hashBuffer = await crypto.subtle.digest('SHA-256', copy.buffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
