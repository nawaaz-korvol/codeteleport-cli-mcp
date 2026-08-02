/**
 * Transcript content search.
 *
 * Two phases, because the naive version was both slow and wrong on real data:
 *
 *  1. **Byte scan** over the raw file to decide whether it can possibly match. Decoding
 *     479 MB of transcripts to UTF-8 strings and lowercasing them took ~7 s per query;
 *     scanning the bytes takes ~60 ms (the same finding as `countMessages` — the decode
 *     dominates, not the I/O).
 *  2. **Decode only the candidates**, then search the *messages*. Searching raw JSONL
 *     matched base64 attachment blobs and JSON keys, so hits included files that never
 *     mentioned the term in any human-readable way, and snippets rendered as
 *     `…iKSmlPsnSvGqOI+Ue1D9WGMEuD559…`. Matching decoded prose fixes the snippet and
 *     drops those false positives.
 */

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const CASE_BIT = 0x20;

/** ASCII-lowercase a byte. */
const fold = (b: number): number => (b >= UPPER_A && b <= UPPER_Z ? b | CASE_BIT : b);

/**
 * Case-insensitive byte search, ASCII-folding only.
 *
 * `Buffer.indexOf` is case-sensitive and `toString().toLowerCase()` is exactly the cost
 * being avoided, so the fold happens per byte during the scan. Callers must pass an
 * ASCII-lowercased needle; non-ASCII queries take the decode path instead (see
 * `transcriptMatches`).
 */
export function bufferIncludesFolded(haystack: Buffer, needleLower: Buffer): boolean {
	const n = needleLower.length;
	if (n === 0) return true;
	if (haystack.length < n) return false;
	const first = needleLower[0];
	const last = haystack.length - n;

	for (let i = 0; i <= last; i++) {
		if (fold(haystack[i]) !== first) continue;
		let j = 1;
		while (j < n && fold(haystack[i + j]) === needleLower[j]) j++;
		if (j === n) return true;
	}
	return false;
}

/** True when the query is plain ASCII and so eligible for the byte fast path. */
export function isAsciiQuery(query: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ASCII range is the point
	return /^[\x00-\x7F]*$/.test(query);
}

/**
 * Cheap pre-filter: can this raw transcript possibly contain the query?
 *
 * False positives are fine and expected (a match may be inside base64 or JSON keys) —
 * phase 2 discards those. False negatives are not, which is why a non-ASCII query skips
 * the fast path rather than guessing at Unicode case folding.
 */
export function transcriptMatches(raw: Buffer, query: string): boolean {
	if (isAsciiQuery(query)) {
		return bufferIncludesFolded(raw, Buffer.from(query.toLowerCase(), "utf-8"));
	}
	return raw.toString("utf-8").toLowerCase().includes(query.toLowerCase());
}

/** Byte offset of the first folded match, or -1. */
export function indexOfFolded(haystack: Buffer, needleLower: Buffer, from = 0): number {
	const n = needleLower.length;
	if (n === 0) return from;
	const first = needleLower[0];
	const last = haystack.length - n;
	for (let i = from; i <= last; i++) {
		if (fold(haystack[i]) !== first) continue;
		let j = 1;
		while (j < n && fold(haystack[i + j]) === needleLower[j]) j++;
		if (j === n) return i;
	}
	return -1;
}

/** Bounds of the JSONL line containing `offset`. */
function lineBounds(buf: Buffer, offset: number): { start: number; end: number } {
	let start = offset;
	while (start > 0 && buf[start - 1] !== 0x0a) start--;
	let end = offset;
	while (end < buf.length && buf[end] !== 0x0a) end++;
	return { start, end };
}

/** Collect string leaves from a parsed JSONL entry, outermost first. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
	if (depth > 8 || out.length > 200) return out;
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const v of value) strings(v, out, depth + 1);
	else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out, depth + 1);
	return out;
}

/**
 * A long run with no whitespace is an encoded blob (base64 attachments, data URIs), not
 * prose. Matching inside one produced snippets like `…iKSmlPsnSvGqOI+Ue1D9WGMEuD559…`.
 */
const isBlob = (s: string): boolean => s.length > 200 && !/\s/.test(s);

/**
 * How many matches to inspect before giving up on a file.
 *
 * Each attempt advances a forward scan, so a file whose only matches sit inside base64
 * blobs costs one full pass. Measured over the real corpus (137 sessions, 718 MB), for
 * the query "paco": 40 attempts -> 8 hits in 4.2 s, 12 -> 7 hits in 2.4 s, 4 -> 7 hits
 * in 1.4 s, 1 -> 4 hits in 0.8 s. Twelve keeps essentially all the recall at a little
 * over half the time; search is an explicit action in the UI, not type-ahead.
 */
const SNIPPET_MAX_ATTEMPTS = 12;

/**
 * Find a readable snippet for `query` without decoding the whole transcript.
 *
 * Fully decoding each candidate was what made search slow — ~4.5 s per query, dominated
 * by parsing multi-megabyte files end to end just to quote 180 characters. Instead: find
 * the match offset in the raw bytes, parse only the JSONL line containing it, and pull
 * the string that actually matched. Returns "" when every match sits in a blob or a
 * structural field, which also filters the false positives phase 1 lets through.
 */
export function snippetFromRaw(raw: Buffer, query: string, maxAttempts = SNIPPET_MAX_ATTEMPTS): string {
	if (!isAsciiQuery(query)) {
		// Rare path: fall back to decoding, correctness over speed.
		const text = raw.toString("utf-8");
		return snippetAround(text, query);
	}
	const needle = Buffer.from(query.toLowerCase(), "utf-8");
	let at = indexOfFolded(raw, needle);
	for (let attempt = 0; at !== -1 && attempt < maxAttempts; attempt++) {
		const { start, end } = lineBounds(raw, at);
		const line = raw.subarray(start, end).toString("utf-8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			parsed = null;
		}
		if (parsed) {
			for (const s of strings(parsed)) {
				if (isBlob(s)) continue;
				const snippet = snippetAround(s, query);
				if (snippet) return snippet;
			}
		}
		at = indexOfFolded(raw, needle, at + 1);
	}
	return "";
}

/** Human-readable excerpt around the first match, or "" when the text doesn't contain it. */
export function snippetAround(text: string, query: string, span = 90): string {
	const at = text.toLowerCase().indexOf(query.toLowerCase());
	if (at === -1) return "";
	const from = Math.max(0, at - span);
	const to = Math.min(text.length, at + query.length + span);
	const body = text.slice(from, to).replace(/\s+/g, " ").trim();
	return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}
