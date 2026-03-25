import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanSession } from "../core/scanner";

describe("scanSession", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scanner-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeJsonl(filename: string, entries: Record<string, unknown>[]) {
		const content = entries.map((e) => JSON.stringify(e)).join("\n");
		const filePath = path.join(tmpDir, filename);
		fs.writeFileSync(filePath, content);
		return filePath;
	}

	it("extracts paste-cache references", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "user", message: { content: "see paste-cache/abc123.txt" } },
			{ type: "assistant", message: { content: "I read paste-cache/def456.txt" } },
		]);

		return scanSession(jsonlPath).then(({ assets }) => {
			expect(assets.pasteFiles).toEqual(["abc123.txt", "def456.txt"]);
		});
	});

	it("extracts shell-snapshot references", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "system", message: { content: "snapshot-zsh-12345-abcde.sh loaded" } },
		]);

		return scanSession(jsonlPath).then(({ assets }) => {
			expect(assets.shellSnapshots).toEqual(["snapshot-zsh-12345-abcde.sh"]);
		});
	});

	it("deduplicates repeated references", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "user", message: { content: "paste-cache/abc123.txt" } },
			{ type: "assistant", message: { content: "paste-cache/abc123.txt again" } },
		]);

		return scanSession(jsonlPath).then(({ assets }) => {
			expect(assets.pasteFiles).toEqual(["abc123.txt"]);
		});
	});

	it("ignores non-message types", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "result", message: { content: "paste-cache/ignored.txt" } },
			{ type: "user", message: { content: "paste-cache/included.txt" } },
		]);

		return scanSession(jsonlPath).then(({ assets }) => {
			expect(assets.pasteFiles).toEqual(["included.txt"]);
		});
	});

	it("extracts message counts", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "user", message: { content: "hello" } },
			{ type: "assistant", message: { content: "hi" } },
			{ type: "user", message: { content: "help me" } },
			{ type: "assistant", message: { content: "sure" } },
			{ type: "assistant", message: { content: "done" } },
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.messageCount).toBe(5);
			expect(metadata.userMessageCount).toBe(2);
			expect(metadata.assistantMessageCount).toBe(3);
		});
	});

	it("extracts tool call count", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "assistant", message: { content: "let me read" }, toolCalls: [{ name: "Read" }] },
			{
				type: "assistant",
				message: { content: "editing" },
				toolCalls: [{ name: "Edit" }, { name: "Write" }],
			},
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.toolCallCount).toBe(3);
		});
	});

	it("extracts files modified from tool calls", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{
				type: "assistant",
				toolCalls: [
					{ name: "Edit", input: { file_path: "/Users/alice/proj/foo.ts" } },
					{ name: "Write", input: { file_path: "/Users/alice/proj/bar.ts" } },
				],
			},
			{
				type: "assistant",
				toolCalls: [{ name: "Edit", input: { file_path: "/Users/alice/proj/foo.ts" } }],
			},
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.filesModified).toEqual(["/Users/alice/proj/bar.ts", "/Users/alice/proj/foo.ts"]);
			expect(metadata.filesModifiedCount).toBe(2);
		});
	});

	it("extracts session timestamps", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "user", timestamp: "2026-03-25T07:00:00.000Z", message: { content: "start" } },
			{ type: "assistant", timestamp: "2026-03-25T07:30:00.000Z", message: { content: "middle" } },
			{ type: "user", timestamp: "2026-03-25T08:00:00.000Z", message: { content: "end" } },
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.sessionStartedAt).toBe("2026-03-25T07:00:00.000Z");
			expect(metadata.sessionEndedAt).toBe("2026-03-25T08:00:00.000Z");
			expect(metadata.durationSeconds).toBe(3600);
		});
	});

	it("extracts claude model", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "assistant", model: "claude-opus-4-6", message: { content: "hi" } },
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.claudeModel).toBe("claude-opus-4-6");
		});
	});

	it("extracts summary from first user message", () => {
		const jsonlPath = writeJsonl("session.jsonl", [
			{ type: "user", message: { content: "Build me a REST API for session sync" } },
			{ type: "assistant", message: { content: "Sure, let me start" } },
		]);

		return scanSession(jsonlPath).then(({ metadata }) => {
			expect(metadata.summary).toBe("Build me a REST API for session sync");
		});
	});

	it("handles empty JSONL", () => {
		const jsonlPath = writeJsonl("session.jsonl", []);

		return scanSession(jsonlPath).then(({ assets, metadata }) => {
			expect(assets.pasteFiles).toEqual([]);
			expect(assets.shellSnapshots).toEqual([]);
			expect(metadata.messageCount).toBe(0);
		});
	});
});
