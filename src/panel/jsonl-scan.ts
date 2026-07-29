import fs from "node:fs";
import { SCAN_HEAD_CHUNK, SCAN_TAIL_BYTES } from "../shared/constants";
import type { TitleSource } from "./types";

/** Fields recoverable from the start of a transcript. */
export interface HeadScan {
	firstMessageAt: string | null;
	cwd: string | null;
}

/** Fields recoverable from the end of a transcript. */
export interface TailScan {
	lastMessageAt: string | null;
	title: string | null;
	titleSource: TitleSource;
}

function parse(line: string): Record<string, unknown> | null {
	try {
		const v = JSON.parse(line);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Read forward from the start, stopping the moment both the first timestamp and the
 * cwd are known.
 *
 * A fixed-size head read is not a valid substitute: transcripts open with untimestamped
 * meta lines (`mode`, `queue-operation`), and measured on a real machine a 64 KB head
 * recovers `firstMessageAt` for only 59 of 88 sessions — growing it to 4 MB does not
 * improve that while costing 7x the time. Early exit is both correct and cheapest: it
 * read 6.6 MB total instead of 477 MB.
 */
export function scanHead(fd: number, size: number): HeadScan {
	const buf = Buffer.alloc(SCAN_HEAD_CHUNK);
	let pos = 0;
	let carry = "";
	let firstMessageAt: string | null = null;
	let cwd: string | null = null;

	while ((firstMessageAt === null || cwd === null) && pos < size) {
		const read = fs.readSync(fd, buf, 0, SCAN_HEAD_CHUNK, pos);
		if (read === 0) break;
		pos += read;
		const lines = (carry + buf.subarray(0, read).toString("utf-8")).split("\n");
		// The final fragment may be a partial line unless we hit EOF.
		carry = pos < size ? (lines.pop() ?? "") : "";
		for (const line of lines) {
			if (!line) continue;
			const obj = parse(line);
			if (!obj) continue;
			if (firstMessageAt === null) firstMessageAt = str(obj.timestamp);
			if (cwd === null) cwd = str(obj.cwd);
			if (firstMessageAt !== null && cwd !== null) break;
		}
	}
	return { firstMessageAt, cwd };
}

/**
 * Read the last `SCAN_TAIL_BYTES` for the final timestamp and the title entries.
 *
 * 64 KB is measured as sufficient: against a full-file parse of 88 real transcripts it
 * matched 88/88 exactly, including correctly yielding no title for the 17 untitled ones.
 * Larger tails (128 KB - 1 MB) resolve nothing further and cost up to 9x the time.
 */
export function scanTail(fd: number, size: number): TailScan {
	const len = Math.min(SCAN_TAIL_BYTES, size);
	const buf = Buffer.alloc(len);
	if (len > 0) fs.readSync(fd, buf, 0, len, size - len);
	const lines = buf.toString("utf-8").split("\n");
	// Drop the leading fragment when the window starts mid-line.
	if (size > len) lines.shift();

	let lastMessageAt: string | null = null;
	let custom: string | null = null;
	let agent: string | null = null;
	let ai: string | null = null;
	let prompt: string | null = null;

	for (const line of lines) {
		if (!line) continue;
		const obj = parse(line);
		if (!obj) continue;
		const ts = str(obj.timestamp);
		if (ts) lastMessageAt = ts;
		switch (obj.type) {
			case "custom-title":
				custom = str(obj.customTitle) ?? custom;
				break;
			case "agent-name":
				agent = str(obj.agentName) ?? agent;
				break;
			case "ai-title":
				ai = str(obj.aiTitle) ?? ai;
				break;
			case "last-prompt":
				prompt = str(obj.lastPrompt) ?? prompt;
				break;
		}
	}

	const title = custom ?? agent ?? ai ?? prompt;
	const titleSource: TitleSource = custom ? "custom" : agent ? "agent" : ai ? "ai" : prompt ? "prompt" : "id";
	return { lastMessageAt, title, titleSource };
}

const NEWLINE = 0x0a;

/**
 * Count non-empty lines, matching `scanLocalSessions`' definition of `messageCount`
 * (`content.split("\n").filter((l) => l.length > 0).length`).
 *
 * This is the only part of a scan that must touch a whole transcript, and on a real
 * machine the corpus totals 479 MB — so how the bytes are counted dominates the cold
 * scan. Measured over that corpus:
 *
 *   read-only floor (do nothing)   41 ms
 *   Buffer.indexOf (this)          58 ms
 *   JS per-byte loop              445 ms
 *   decode to string + split     ~1.2 s
 *
 * `Buffer.indexOf` runs in native code, so it lands within ~40% of the I/O floor while
 * the equivalent JS loop is 7.7x slower. Tracking whether the current line already had
 * content keeps blank lines excluded, making the result identical to the string-split
 * definition — verified against all 88 real transcripts with 0 mismatches.
 */
export function countMessages(file: string): number {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const buf = Buffer.alloc(SCAN_HEAD_CHUNK);
		let pos = 0;
		let count = 0;
		let lineHasContent = false;
		while (pos < size) {
			const read = fs.readSync(fd, buf, 0, SCAN_HEAD_CHUNK, pos);
			if (read === 0) break;
			pos += read;
			// Bound the search to the bytes actually read — the tail of the buffer may
			// still hold newlines from the previous, longer chunk.
			const chunk = buf.subarray(0, read);
			let from = 0;
			for (;;) {
				const nl = chunk.indexOf(NEWLINE, from);
				if (nl === -1) {
					if (read > from) lineHasContent = true;
					break;
				}
				// Count unless the line is empty: no carried content and nothing before \n.
				if (lineHasContent || nl > from) count++;
				lineHasContent = false;
				from = nl + 1;
			}
		}
		// A trailing line with no final newline still counts.
		if (lineHasContent) count++;
		return count;
	} finally {
		fs.closeSync(fd);
	}
}
