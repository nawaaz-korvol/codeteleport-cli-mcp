import { describe, expect, it } from "vitest";
import { encodePath, rewritePaths } from "../core/paths";

describe("encodePath", () => {
	it("replaces slashes with dashes", () => {
		expect(encodePath("/Users/alice/myproject")).toBe("-Users-alice-myproject");
	});

	it("handles root path", () => {
		expect(encodePath("/")).toBe("-");
	});

	it("handles nested paths", () => {
		expect(encodePath("/Users/alice/code/teleport/project")).toBe("-Users-alice-code-teleport-project");
	});

	it("handles path without leading slash", () => {
		expect(encodePath("Users/alice")).toBe("Users-alice");
	});
});

describe("rewritePaths", () => {
	it("rewrites all occurrences of source path to target", () => {
		const content = '{"cwd":"/Users/alice/proj","file":"/Users/alice/proj/foo.ts"}';
		const result = rewritePaths(content, "/Users/alice", "/Users/bob");
		expect(result).toBe('{"cwd":"/Users/bob/proj","file":"/Users/bob/proj/foo.ts"}');
	});

	it("handles content with no matches", () => {
		const content = '{"cwd":"/home/user/proj"}';
		const result = rewritePaths(content, "/Users/alice", "/Users/bob");
		expect(result).toBe('{"cwd":"/home/user/proj"}');
	});

	it("handles empty content", () => {
		expect(rewritePaths("", "/Users/alice", "/Users/bob")).toBe("");
	});

	it("rewrites multiple lines", () => {
		const content = [
			'{"cwd":"/Users/alice/proj"}',
			'{"file":"/Users/alice/proj/a.ts"}',
			'{"file":"/Users/alice/proj/b.ts"}',
		].join("\n");
		const result = rewritePaths(content, "/Users/alice", "/Users/bob");
		expect(result).toContain("/Users/bob/proj");
		expect(result).not.toContain("/Users/alice");
	});

	it("handles same source and target (no-op)", () => {
		const content = '{"cwd":"/Users/alice/proj"}';
		const result = rewritePaths(content, "/Users/alice", "/Users/alice");
		expect(result).toBe(content);
	});
});
