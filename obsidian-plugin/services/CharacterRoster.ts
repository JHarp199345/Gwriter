export interface CharacterRosterEntry {
	name: string;
	aliases?: string[];
}

function normalizeName(name: string): string {
	return name.trim().replace(/\s+/g, ' ');
}

/**
 * Parse a roster response into a list of names/aliases.
 * Expected formats:
 * - "- Name | aliases: A, B"
 * - "1. Name (aliases: A, B)"
 * - "Name, Name2, Name3"
 */
export function parseCharacterRoster(text: string): CharacterRosterEntry[] {
	const raw = (text || '').trim();
	if (!raw) return [];

	const entries: CharacterRosterEntry[] = [];
	const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

	for (const line of lines) {
		// Remove common list prefixes like "-", "*", "1.", "1)", "1]"
		// (avoid unnecessary escapes inside character classes)
		const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+[.)\]]\s+/, '').trim();
		if (!cleaned) continue;

		// Split "Name | aliases: ..."
		const [left, right] = cleaned.split(/\s*\|\s*/);
		const namePart = normalizeName(left || '');
		if (!namePart) continue;

		const entry: CharacterRosterEntry = { name: namePart };
		if (right) {
			const m = right.match(/aliases?\s*:\s*(.+)$/i);
			if (m?.[1]) {
				const aliases = m[1].split(',').map(a => normalizeName(a)).filter(Boolean);
				if (aliases.length) entry.aliases = aliases;
			}
		}

		entries.push(entry);
	}

	// Fallback: comma-separated list
	if (entries.length === 0 && raw.includes(',')) {
		for (const part of raw.split(',').map(p => normalizeName(p)).filter(Boolean)) {
			entries.push({ name: part });
		}
	}

	// De-dupe by name (case-insensitive)
	const byLower = new Map<string, CharacterRosterEntry>();
	for (const e of entries) {
		const key = e.name.toLowerCase();
		const existing = byLower.get(key);
		if (!existing) {
			byLower.set(key, e);
		} else {
			const merged = new Set<string>([...(existing.aliases || []), ...(e.aliases || [])].map(a => a));
			existing.aliases = merged.size ? Array.from(merged) : existing.aliases;
		}
	}

	return Array.from(byLower.values());
}

export function rosterToBulletList(roster: CharacterRosterEntry[]): string {
	if (!roster.length) return '[No roster]';
	return roster
		.map(r => `- ${r.name}${r.aliases?.length ? ` | aliases: ${r.aliases.join(', ')}` : ''}`)
		.join('\n');
}


