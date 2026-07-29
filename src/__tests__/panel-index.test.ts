import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanLocalSessions } from "../core/local";
import { encodePath } from "../core/paths";
import { scanPanelSessions } from "../panel";

/**
 * Contract for the panel's session index.
 *
 * Two things matter and are both asserted here:
 *
 *  1. **Parity** — it must agree with `scanLocalSessions` field-for-field. The panel
 *     is a faster view over the same truth, not a second, subtly-different one.
 *  2. **Bounded reads** — `scanLocalSessions` calls `readFileSync` on every transcript.
 *     Measured on a real machine that is 477 MB (largest single file 131 MB) and
 *     ~1.0-1.2 s for 88 sessions, which is far too slow for an interactive panel.
 *     The index must therefore never read a whole transcript except to (re)compute a
 *     cached message count.
 */

describe("panel session index", () => {
	let tmpDir: string;
	let claudeDir: string;
	let projectsDir: string;
	let indexFile: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-panel-index-"));
		claudeDir = path.join(tmpDir, ".claude");
		projectsDir = path.join(claudeDir, "projects");
		fs.mkdirSync(projectsDir, { recursive: true });
		indexFile = path.join(tmpDir, "index.json");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Write a session transcript under the encoded form of `cwd`. */
	function createSession(cwd: string, sessionId: string, lines: string[]): string {
		const dir = path.join(projectsDir, encodePath(cwd));
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${sessionId}.jsonl`);
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		return file;
	}

	function msg(timestamp: string, type = "user", cwd?: string) {
		const obj: Record<string, unknown> = { timestamp, type, message: { content: "hello" } };
		if (cwd) obj.cwd = cwd;
		return JSON.stringify(obj);
	}

	/** A realistic transcript: leading no-timestamp meta lines, then real messages. */
	function transcript(cwd: string, sessionId: string, extra: string[] = []): string[] {
		return [
			JSON.stringify({ type: "mode", mode: "normal", sessionId }),
			JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId }),
			msg("2026-03-25T07:00:00.000Z", "user", cwd),
			msg("2026-03-25T07:05:00.000Z", "assistant"),
			...extra,
			msg("2026-03-25T07:10:00.000Z", "assistant"),
		];
	}

	describe("parity with scanLocalSessions", () => {
		it("agrees field-for-field across a mixed set of sessions", () => {
			const a = "/Users/alice/projects/alpha";
			const b = "/Users/alice/projects/beta";
			createSession(a, "11111111-1111-1111-1111-111111111111", transcript(a, "11111111-1111-1111-1111-111111111111"));
			createSession(b, "22222222-2222-2222-2222-222222222222", transcript(b, "22222222-2222-2222-2222-222222222222"));
			// A transcript with neither cwd nor timestamp — the dir-name fallback path.
			createSession(a, "33333333-3333-3333-3333-333333333333", [
				JSON.stringify({ type: "ai-title", aiTitle: "orphan", sessionId: "33333333-3333-3333-3333-333333333333" }),
			]);

			const base = scanLocalSessions(claudeDir);
			const panel = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile });

			expect(panel).toHaveLength(base.length);
			const byId = new Map(panel.map((s) => [s.sessionId, s]));
			for (const b0 of base) {
				const p = byId.get(b0.sessionId);
				expect(p, `session ${b0.sessionId} missing from panel index`).toBeDefined();
				if (!p) continue;
				expect(p.projectPath, `projectPath for ${b0.sessionId}`).toBe(b0.projectPath);
				expect(p.projectName, `projectName for ${b0.sessionId}`).toBe(b0.projectName);
				expect(p.firstMessageAt, `firstMessageAt for ${b0.sessionId}`).toBe(b0.firstMessageAt);
				expect(p.lastMessageAt, `lastMessageAt for ${b0.sessionId}`).toBe(b0.lastMessageAt);
				expect(p.messageCount, `messageCount for ${b0.sessionId}`).toBe(b0.messageCount);
				expect(p.sizeBytes, `sizeBytes for ${b0.sessionId}`).toBe(b0.sizeBytes);
				expect(p.jsonlPath, `jsonlPath for ${b0.sessionId}`).toBe(b0.jsonlPath);
			}
		});

		it("sorts by lastMessageAt descending, like the base scanner", () => {
			const cwd = "/Users/alice/projects/alpha";
			createSession(cwd, "aaaaaaaa-0000-0000-0000-000000000001", [msg("2026-03-01T00:00:00.000Z", "user", cwd)]);
			createSession(cwd, "aaaaaaaa-0000-0000-0000-000000000002", [msg("2026-05-01T00:00:00.000Z", "user", cwd)]);
			createSession(cwd, "aaaaaaaa-0000-0000-0000-000000000003", [msg("2026-04-01T00:00:00.000Z", "user", cwd)]);

			const panel = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile });
			expect(panel.map((s) => s.lastMessageAt)).toEqual([
				"2026-05-01T00:00:00.000Z",
				"2026-04-01T00:00:00.000Z",
				"2026-03-01T00:00:00.000Z",
			]);
		});

		it("ignores nested non-session jsonl files", () => {
			// Real machines have <projDir>/vercel-plugin/skill-injections.jsonl and similar.
			const cwd = "/Users/alice/projects/alpha";
			createSession(
				cwd,
				"bbbbbbbb-0000-0000-0000-000000000001",
				transcript(cwd, "bbbbbbbb-0000-0000-0000-000000000001"),
			);
			const nested = path.join(projectsDir, encodePath(cwd), "vercel-plugin");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, "skill-injections.jsonl"), '{"type":"user"}\n');

			expect(scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })).toHaveLength(1);
		});
	});

	describe("bounded reads", () => {
		it("never reads a whole transcript when the message count is cached", () => {
			const cwd = "/Users/alice/projects/big";
			const id = "cccccccc-0000-0000-0000-000000000001";
			// ~2 MB of filler between the first and last real messages.
			const filler = Array.from({ length: 4000 }, (_, i) =>
				JSON.stringify({ type: "assistant", timestamp: "2026-03-25T07:06:00.000Z", pad: "x".repeat(400), i }),
			);
			const file = createSession(cwd, id, transcript(cwd, id, filler));
			expect(fs.statSync(file).size).toBeGreaterThan(1_500_000);

			// Warm the count cache.
			scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile });

			const readSpy = vi.spyOn(fs, "readFileSync");
			const panel = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile });

			const readTranscript = readSpy.mock.calls.filter((c) => String(c[0]) === file);
			expect(readTranscript, "transcript must not be read whole on a warm scan").toHaveLength(0);
			expect(panel[0].messageCount).toBe(scanLocalSessions(claudeDir)[0].messageCount);
			expect(panel[0].firstMessageAt).toBe("2026-03-25T07:00:00.000Z");
			expect(panel[0].lastMessageAt).toBe("2026-03-25T07:10:00.000Z");
		});

		it("recomputes the count when the transcript changes", () => {
			const cwd = "/Users/alice/projects/alpha";
			const id = "dddddddd-0000-0000-0000-000000000001";
			const file = createSession(cwd, id, transcript(cwd, id));

			const before = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0].messageCount;
			fs.appendFileSync(file, `${msg("2026-03-25T08:00:00.000Z", "user")}\n`);
			const after = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];

			expect(after.messageCount).toBe(before + 1);
			expect(after.lastMessageAt).toBe("2026-03-25T08:00:00.000Z");
			expect(after.messageCount).toBe(scanLocalSessions(claudeDir)[0].messageCount);
		});

		it("works with caching disabled", () => {
			const cwd = "/Users/alice/projects/alpha";
			const id = "eeeeeeee-0000-0000-0000-000000000001";
			createSession(cwd, id, transcript(cwd, id));
			const panel = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null });
			expect(panel[0].messageCount).toBe(scanLocalSessions(claudeDir)[0].messageCount);
		});
	});

	describe("titles", () => {
		const cwd = "/Users/alice/projects/alpha";

		function withTitleEntries(id: string, entries: Record<string, unknown>[]) {
			createSession(cwd, id, [...transcript(cwd, id), ...entries.map((e) => JSON.stringify({ ...e, sessionId: id }))]);
		}

		it("prefers custom-title over agent-name, ai-title and last-prompt", () => {
			const id = "f0000000-0000-0000-0000-000000000001";
			withTitleEntries(id, [
				{ type: "ai-title", aiTitle: "ai one" },
				{ type: "last-prompt", lastPrompt: "prompt one" },
				{ type: "agent-name", agentName: "agent one" },
				{ type: "custom-title", customTitle: "custom one" },
			]);
			const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];
			expect(s.title).toBe("custom one");
			expect(s.titleSource).toBe("custom");
		});

		it("falls back to agent-name, then ai-title, then last-prompt", () => {
			const cases: [string, Record<string, unknown>[], string, string][] = [
				["f0000000-0000-0000-0000-00000000000a", [{ type: "agent-name", agentName: "A" }], "A", "agent"],
				["f0000000-0000-0000-0000-00000000000b", [{ type: "ai-title", aiTitle: "B" }], "B", "ai"],
				["f0000000-0000-0000-0000-00000000000c", [{ type: "last-prompt", lastPrompt: "C" }], "C", "prompt"],
			];
			for (const [id, entries, expected, source] of cases) {
				fs.rmSync(projectsDir, { recursive: true, force: true });
				fs.mkdirSync(projectsDir, { recursive: true });
				withTitleEntries(id, entries);
				const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null })[0];
				expect(s.title, `title for ${source}`).toBe(expected);
				expect(s.titleSource, `titleSource for ${source}`).toBe(source);
			}
		});

		it("falls back to the session id when no title entry exists", () => {
			const id = "f0000000-0000-0000-0000-000000000002";
			createSession(cwd, id, transcript(cwd, id));
			const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];
			expect(s.titleSource).toBe("id");
			expect(s.title).toContain("f0000000");
		});

		it("finds a title entry that sits far from the end of a large transcript", () => {
			// Title entries are appended late, but tool output can follow them.
			const id = "f0000000-0000-0000-0000-000000000003";
			const tail = Array.from({ length: 200 }, (_, i) =>
				JSON.stringify({ type: "assistant", timestamp: "2026-03-25T07:09:00.000Z", pad: "y".repeat(200), i }),
			);
			createSession(cwd, id, [
				...transcript(cwd, id),
				JSON.stringify({ type: "ai-title", aiTitle: "deep title", sessionId: id }),
				...tail,
			]);
			const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];
			expect(s.title).toBe("deep title");
		});
	});

	describe("enrichment", () => {
		it("flags stranded sessions whose project path is gone", () => {
			const gone = "/Users/alice/projects/deleted-repo";
			const here = tmpDir; // exists
			createSession(
				gone,
				"0a000000-0000-0000-0000-000000000001",
				transcript(gone, "0a000000-0000-0000-0000-000000000001"),
			);
			createSession(
				here,
				"0b000000-0000-0000-0000-000000000002",
				transcript(here, "0b000000-0000-0000-0000-000000000002"),
			);

			const panel = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile });
			const strandedIds = panel.filter((s) => s.stranded).map((s) => s.sessionId);
			expect(strandedIds).toEqual(["0a000000-0000-0000-0000-000000000001"]);
		});

		it("reports satellite state without confusing shared memory for session state", () => {
			const cwd = "/Users/alice/projects/alpha";
			const id = "0c000000-0000-0000-0000-000000000001";
			createSession(cwd, id, transcript(cwd, id));
			const projDir = path.join(projectsDir, encodePath(cwd));
			fs.mkdirSync(path.join(projDir, id), { recursive: true });
			fs.mkdirSync(path.join(projDir, "memory"), { recursive: true });
			fs.mkdirSync(path.join(claudeDir, "file-history", id), { recursive: true });

			const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];
			expect(s.satellites.hasSubagents).toBe(true);
			expect(s.satellites.hasFileHistory).toBe(true);
			expect(s.satellites.hasSessionEnv).toBe(false);
			expect(s.satellites.hasMemory).toBe(true);
		});

		it("carries the agent id and a runnable resume command", () => {
			const cwd = "/Users/alice/projects/alpha";
			const id = "0d000000-0000-0000-0000-000000000001";
			createSession(cwd, id, transcript(cwd, id));
			const s = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile })[0];
			expect(s.agentId).toBe("claude-code");
			expect(s.resumeCommand).toBe(`claude --resume ${id}`);
		});
	});

	describe("cross-agent", () => {
		it("defaults to scanning every supported agent", () => {
			const cwd = "/Users/alice/projects/alpha";
			const id = "0e000000-0000-0000-0000-000000000001";
			createSession(cwd, id, transcript(cwd, id));

			const codexDir = path.join(tmpDir, ".codex");
			const geminiDir = path.join(tmpDir, ".gemini");
			fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
			fs.mkdirSync(path.join(geminiDir, "conversations"), { recursive: true });

			// Empty codex/antigravity dirs must not break the merged scan.
			const all = scanPanelSessions({ claudeDir, codexDir, geminiDir, indexFile });
			expect(all).toHaveLength(1);
			expect(all[0].agentId).toBe("claude-code");
		});

		it("rejects an unknown agent id", () => {
			expect(() => scanPanelSessions({ agentId: "not-an-agent", claudeDir, indexFile })).toThrow(/Unknown agent/i);
		});
	});
});
