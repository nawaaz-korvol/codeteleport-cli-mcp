import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countMessages } from "../panel/jsonl-scan";
import { SCAN_HEAD_CHUNK } from "../shared/constants";

/**
 * `countMessages` must equal the authoritative definition used by `scanLocalSessions`:
 *
 *   content.split("\n").filter((l) => l.length > 0).length
 *
 * It reaches that answer with a chunked native `Buffer.indexOf` scan (7.7x faster than
 * a JS per-byte loop over a 479 MB corpus), which makes chunk boundaries and blank
 * lines the interesting cases. Each test below asserts against the reference definition
 * rather than a hand-counted number, so the two can never drift.
 */

const reference = (content: string): number => content.split("\n").filter((l) => l.length > 0).length;

describe("countMessages", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-count-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function write(name: string, content: string): string {
		const file = path.join(dir, name);
		fs.writeFileSync(file, content);
		return file;
	}

	function check(name: string, content: string) {
		const file = write(`${name}.jsonl`, content);
		expect(countMessages(file), `content: ${JSON.stringify(content.slice(0, 60))}`).toBe(reference(content));
	}

	it("handles an empty file", () => check("empty", ""));
	it("handles a single line with a trailing newline", () => check("one", '{"a":1}\n'));
	it("handles a single line with no trailing newline", () => check("noeol", '{"a":1}'));
	it("handles several lines", () => check("many", '{"a":1}\n{"b":2}\n{"c":3}\n'));
	it("excludes blank lines", () => check("blank", '{"a":1}\n\n\n{"b":2}\n'));
	it("excludes leading blank lines", () => check("leading", '\n\n{"a":1}\n'));
	it("handles a file of only newlines", () => check("newlines", "\n\n\n\n"));
	it("handles whitespace-only lines as content", () => check("space", '{"a":1}\n \n{"b":2}\n'));
	it("handles CRLF line endings", () => check("crlf", '{"a":1}\r\n{"b":2}\r\n'));

	it("is correct when a line spans a chunk boundary", () => {
		// One line longer than the read chunk, so it is assembled across reads.
		const long = `{"pad":"${"x".repeat(SCAN_HEAD_CHUNK * 2)}"}`;
		check("spanning", `${long}\n${long}\n`);
	});

	it("is correct when a newline lands exactly on a chunk boundary", () => {
		// Make the first line exactly fill a chunk, newline included.
		const filler = "x".repeat(SCAN_HEAD_CHUNK - 1);
		check("boundary", `${filler}\n${filler}\n`);
	});

	it("is correct when the final chunk is shorter than the buffer", () => {
		// Guards the subarray(0, read) bound: without it, stale bytes from the previous
		// longer chunk would still be searched for newlines.
		const content = `${"a".repeat(SCAN_HEAD_CHUNK + 10)}\nshort\n`;
		check("shorttail", content);
	});

	it("is correct for multi-byte UTF-8 split across a chunk boundary", () => {
		// 0x0a never appears inside a UTF-8 continuation byte, so byte scanning is safe —
		// assert that rather than assume it.
		const emoji = "🚀".repeat(Math.ceil(SCAN_HEAD_CHUNK / 4) + 3);
		check("utf8", `{"e":"${emoji}"}\n{"b":2}\n`);
	});

	it("matches the reference across randomised shapes", () => {
		let seed = 42;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		for (let i = 0; i < 40; i++) {
			const parts: string[] = [];
			const lines = Math.floor(rand() * 12);
			for (let j = 0; j < lines; j++) {
				const r = rand();
				if (r < 0.2) parts.push("");
				else if (r < 0.3) parts.push(" ");
				else parts.push(`{"i":${j},"pad":"${"y".repeat(Math.floor(rand() * 200))}"}`);
			}
			const content = parts.join("\n") + (rand() < 0.5 ? "\n" : "");
			check(`rand-${i}`, content);
		}
	});
});
