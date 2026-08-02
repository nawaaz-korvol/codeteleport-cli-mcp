import { describe, expect, it } from "vitest";
import { bufferIncludesFolded, indexOfFolded, isAsciiQuery, snippetAround, snippetFromRaw } from "../web/search";

const buf = (s: string) => Buffer.from(s, "utf-8");
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

describe("transcript search", () => {
	describe("folded byte scan", () => {
		it("matches regardless of case", () => {
			expect(bufferIncludesFolded(buf("Hello PACO there"), buf("paco"))).toBe(true);
			expect(bufferIncludesFolded(buf("hello paco"), buf("paco"))).toBe(true);
		});

		it("does not match absent text", () => {
			expect(bufferIncludesFolded(buf("hello world"), buf("paco"))).toBe(false);
		});

		it("handles a needle longer than the haystack", () => {
			expect(bufferIncludesFolded(buf("ab"), buf("abcdef"))).toBe(false);
		});

		it("reports the offset of the first match and can resume past it", () => {
			const hay = buf("xx paco yy Paco zz");
			const first = indexOfFolded(hay, buf("paco"));
			expect(first).toBe(3);
			expect(indexOfFolded(hay, buf("paco"), first + 1)).toBe(11);
			expect(indexOfFolded(hay, buf("paco"), 12)).toBe(-1);
		});

		it("only claims the ASCII fast path for ASCII queries", () => {
			expect(isAsciiQuery("paco")).toBe(true);
			expect(isAsciiQuery("café")).toBe(false);
			expect(isAsciiQuery("日本語")).toBe(false);
		});
	});

	describe("snippetFromRaw", () => {
		it("quotes readable prose around the match", () => {
			const raw = buf(line({ type: "user", message: { content: "we talked about paco and the pipeline" } }));
			expect(snippetFromRaw(raw, "paco")).toContain("we talked about paco");
		});

		it("is case-insensitive", () => {
			const raw = buf(line({ message: { content: "Discussing PACO today" } }));
			expect(snippetFromRaw(raw, "paco")).toContain("PACO");
		});

		it("skips base64-style blobs and keeps looking", () => {
			// The real failure: a match inside an attachment produced snippets like
			// `…iKSmlPsnSvGqOI+Ue1D9WGMEuD559…`.
			const blob = `paco${"A1b2C3d4".repeat(40)}`;
			const raw = Buffer.concat([
				buf(line({ type: "attachment", data: blob })),
				buf(line({ type: "user", message: { content: "the real sentence mentions paco here" } })),
			]);
			const snippet = snippetFromRaw(raw, "paco");
			expect(snippet).toContain("the real sentence mentions paco");
			expect(snippet).not.toContain("A1b2C3d4A1b2");
		});

		it("returns nothing when the only match is inside a blob", () => {
			const blob = `paco${"Zz9y8x7w".repeat(40)}`;
			expect(snippetFromRaw(Buffer.from(line({ type: "attachment", data: blob })), "paco")).toBe("");
		});

		it("returns nothing when the term is absent", () => {
			expect(snippetFromRaw(buf(line({ message: { content: "nothing here" } })), "paco")).toBe("");
		});

		it("survives an unparseable line", () => {
			const raw = Buffer.concat([
				buf("{not json at all paco\n"),
				buf(line({ message: { content: "valid line with paco in it" } })),
			]);
			expect(snippetFromRaw(raw, "paco")).toContain("valid line with paco");
		});

		it("finds a match on the first line, with no leading newline", () => {
			expect(snippetFromRaw(buf(line({ message: { content: "paco first" } })), "paco")).toContain("paco first");
		});

		it("handles a non-ASCII query via the decode fallback", () => {
			const raw = buf(line({ message: { content: "we visited a café in Paris" } }));
			expect(snippetFromRaw(raw, "café")).toContain("café");
		});

		it("gives up after the attempt cap rather than scanning forever", () => {
			// Many blob-only matches: bounded work, no snippet.
			const blob = `paco${"Qq1Ww2Ee3".repeat(40)}`;
			const raw = Buffer.concat(Array.from({ length: 50 }, () => buf(line({ type: "attachment", data: blob }))));
			expect(snippetFromRaw(raw, "paco", 3)).toBe("");
		});
	});

	describe("snippetAround", () => {
		it("collapses whitespace and marks truncation", () => {
			const text = `${"x".repeat(200)} hello paco world ${"y".repeat(200)}`;
			const s = snippetAround(text, "paco");
			expect(s.startsWith("…")).toBe(true);
			expect(s.endsWith("…")).toBe(true);
			expect(s).toContain("hello paco world");
			expect(s).not.toMatch(/\s\s/);
		});

		it("does not mark truncation when the whole string fits", () => {
			expect(snippetAround("just paco", "paco")).toBe("just paco");
		});

		it("returns empty when absent", () => {
			expect(snippetAround("nothing", "paco")).toBe("");
		});
	});
});
