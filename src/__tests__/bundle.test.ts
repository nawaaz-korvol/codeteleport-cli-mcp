import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleSession } from "../core/bundle";

describe("bundleSession", () => {
	let tmpDir: string;
	let fakeClaude: string;
	const sessionId = "test-session-001";
	const cwd = "/Users/testuser/myproject";

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
		fakeClaude = path.join(tmpDir, ".claude");

		// Create a fake ~/.claude structure
		const encodedCwd = cwd.replace(/\//g, "-");
		const projDir = path.join(fakeClaude, "projects", encodedCwd);
		fs.mkdirSync(projDir, { recursive: true });

		// Write a session JSONL
		const jsonl = [
			JSON.stringify({ type: "user", timestamp: "2026-03-25T07:00:00.000Z", message: { content: "hello" } }),
			JSON.stringify({
				type: "assistant",
				timestamp: "2026-03-25T07:05:00.000Z",
				model: "claude-opus-4-6",
				message: { content: "hi" },
				toolCalls: [{ name: "Edit", input: { file_path: "/Users/testuser/myproject/foo.ts" } }],
			}),
		].join("\n");
		fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), jsonl);

		// Create session subdir with a subagent
		const subdir = path.join(projDir, sessionId, "subagents");
		fs.mkdirSync(subdir, { recursive: true });
		fs.writeFileSync(path.join(subdir, "agent-001.jsonl"), '{"type":"assistant","message":{"content":"sub"}}');

		// Create file-history
		const fh = path.join(fakeClaude, "file-history", sessionId);
		fs.mkdirSync(fh, { recursive: true });
		fs.writeFileSync(path.join(fh, "foo.ts.json"), "{}");

		// Create session-env
		const se = path.join(fakeClaude, "session-env", sessionId);
		fs.mkdirSync(se, { recursive: true });
		fs.writeFileSync(path.join(se, "env.json"), "{}");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates a .tar.gz bundle", async () => {
		const result = await bundleSession({
			sessionId,
			cwd,
			outputDir: tmpDir,
			claudeDir: fakeClaude,
		});

		expect(result.bundlePath).toMatch(/\.tar\.gz$/);
		expect(fs.existsSync(result.bundlePath)).toBe(true);
		expect(result.sizeBytes).toBeGreaterThan(0);
	});

	it("returns correct session metadata", async () => {
		const result = await bundleSession({
			sessionId,
			cwd,
			outputDir: tmpDir,
			claudeDir: fakeClaude,
		});

		expect(result.sessionId).toBe(sessionId);
		expect(result.sourceCwd).toBe(cwd);
		expect(result.sourceUserDir).toBe(os.homedir());
		expect(result.checksum).toMatch(/^sha256:[a-f0-9]+$/);
	});

	it("includes metadata from JSONL scan", async () => {
		const result = await bundleSession({
			sessionId,
			cwd,
			outputDir: tmpDir,
			claudeDir: fakeClaude,
		});

		expect(result.metadata.messageCount).toBe(2);
		expect(result.metadata.userMessageCount).toBe(1);
		expect(result.metadata.assistantMessageCount).toBe(1);
		expect(result.metadata.toolCallCount).toBe(1);
		expect(result.metadata.claudeModel).toBe("claude-opus-4-6");
		expect(result.metadata.hasFileHistory).toBe(true);
		expect(result.metadata.subagentCount).toBeGreaterThanOrEqual(1);
	});

	it("includes meta.json in the bundle", async () => {
		const result = await bundleSession({
			sessionId,
			cwd,
			outputDir: tmpDir,
			claudeDir: fakeClaude,
		});

		// Extract and verify meta.json exists
		const tar = await import("tar");
		const extractDir = path.join(tmpDir, "extracted");
		fs.mkdirSync(extractDir);
		await tar.extract({ file: result.bundlePath, cwd: extractDir });

		const metaPath = path.join(extractDir, "meta.json");
		expect(fs.existsSync(metaPath)).toBe(true);

		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		expect(meta.sessionId).toBe(sessionId);
		expect(meta.sourceCwd).toBe(cwd);
		expect(meta.sourceUserDir).toBe(os.homedir());
	});

	it("includes session.jsonl in the bundle", async () => {
		const result = await bundleSession({
			sessionId,
			cwd,
			outputDir: tmpDir,
			claudeDir: fakeClaude,
		});

		const tar = await import("tar");
		const extractDir = path.join(tmpDir, "extracted2");
		fs.mkdirSync(extractDir);
		await tar.extract({ file: result.bundlePath, cwd: extractDir });

		expect(fs.existsSync(path.join(extractDir, "session.jsonl"))).toBe(true);
	});

	it("throws if session JSONL not found", async () => {
		await expect(
			bundleSession({
				sessionId: "nonexistent",
				cwd,
				outputDir: tmpDir,
				claudeDir: fakeClaude,
			}),
		).rejects.toThrow("Session JSONL not found");
	});
});
