/**
 * GoodWriter diagnostic logger.
 *
 * All output is prefixed with [GW:<TAG>] so you can filter the browser /
 * Obsidian dev console with a single keyword search: "GW".
 *
 * Open the dev console in Obsidian:
 *   Mac  → Cmd + Option + I
 *   Win  → Ctrl + Shift + I
 * Then paste what you see in the console back to the AI for diagnostics.
 */

let _runStart = 0;
let _seq = 0; // monotonic counter so log lines stay in order

function _ts(): string {
    if (_runStart) {
        const ms = Date.now() - _runStart;
        const s = (ms / 1000).toFixed(2);
        return `+${s}s`;
    }
    return new Date().toISOString().slice(11, 23);
}

export function gwlog(tag: string, msg: string, extra?: unknown): void {
    _seq++;
    const line = `[GW:${tag}] ${_ts()} #${_seq} ${msg}`;
    if (extra !== undefined) {
        console.log(line, extra);
    } else {
        console.log(line);
    }
}

export function gwwarn(tag: string, msg: string, extra?: unknown): void {
    _seq++;
    const line = `[GW:${tag}:WARN] ${_ts()} #${_seq} ${msg}`;
    console.warn(line, ...(extra !== undefined ? [extra] : []));
}

export function gwerr(tag: string, msg: string, err?: unknown): void {
    _seq++;
    const errMsg = err instanceof Error
        ? `${err.message}${err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : ''}`
        : String(err ?? '');
    console.error(`[GW:${tag}:ERR] ${_ts()} #${_seq} ${msg}`, errMsg || '');
}

/** Call once at the very start of each generateChapter run. */
export function gwlogRunStart(): void {
    _runStart = Date.now();
    _seq = 0;
    console.log('\n[GW:RUN] ══════════════ NEW GENERATION RUN ══════════════');
}

/** Redact an API key to just the first 8 chars for safe logging. */
export function gwRedactKey(key: string | undefined): string {
    if (!key || key.length < 4) return '(empty)';
    return `${key.slice(0, 8)}… (len=${key.length})`;
}

/** Summarise a long string for logging without flooding the console. */
export function gwSnip(text: string | undefined, maxChars = 120): string {
    if (!text) return '(empty)';
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/** Estimate word count for a string. */
export function gwWords(text: string): number {
    return text.trim() ? text.trim().split(/\s+/).length : 0;
}
