import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../core/paths";
import { deletePanelSession, movePanelSession, scanPanelSessions } from "../panel";

/**
 * Which agent owns a session should be resolved from the session, not asserted by the
 * caller.
 *
 * `local list` defaults to every agent, so a user picks a Codex session out of a
 * cross-agent list — but `move`/`rm` defaulted to claude-code and reported
 * "Session not found: <id>". Technically true, actively misleading, and it made the
 * cross-agent list a trap: everything it showed looked actionable and only a third of it
 * was.
 */

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

describe("panel agent resolution", () => {
	let tmp: string;
	let claudeDir: string;
	let codexDir: string;
	let geminiDir: string;
	let panelDir: string;
	let claudeCwd: string;
	let codexCwd: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-agent-res-")));
		claudeDir = path.join(tmp, ".claude");
		codexDir = path.join(tmp, ".codex");
		geminiDir = path.join(tmp, ".gemini");
		panelDir = path.join(tmp, "panel");
		claudeCwd = path.join(tmp, "repo-claude");
		codexCwd = path.join(tmp, "repo-codex");
		fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
		fs.mkdirSync(claudeCwd, { recursive: true });
		fs.mkdirSync(codexCwd, { recursive: true });
		fs.mkdirSync(path.join(geminiDir, "conversations"), { recursive: true });

		// Claude session
		const projDir = path.join(claudeDir, "projects", encodePath(claudeCwd));
		fs.mkdirSync(projDir, { recursive: true });
		fs.writeFileSync(
			path.join(projDir, `${CLAUDE_ID}.jsonl`),
			`${[
				JSON.stringify({
					type: "user",
					timestamp: "2026-06-01T10:00:00.000Z",
					cwd: claudeCwd,
					message: { content: "claude side" },
				}),
			].join("\n")}\n`,
		);

		// Codex rollout, in the layout the codex adapter expects
		const rolloutDir = path.join(codexDir, "sessions", "2026/06/01");
		fs.mkdirSync(rolloutDir, { recursive: true });
		fs.writeFileSync(
			path.join(rolloutDir, `rollout-2026-06-01T10-00-00-000Z-${CODEX_ID}.jsonl`),
			[
				JSON.stringify({
					timestamp: "2026-06-01T10:00:00.000Z",
					type: "session_meta",
					payload: { id: CODEX_ID, cwd: codexCwd, timestamp: "2026-06-01T10:00:00.000Z" },
				}),
				JSON.stringify({
					timestamp: "2026-06-01T10:01:00.000Z",
					type: "response_item",
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex side" }] },
				}),
			].join("\n"),
		);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const dirs = () => ({ claudeDir, codexDir, geminiDir, panelDir, userDir: tmp });

	it("lists both agents' sessions, so both look actionable", () => {
		const all = scanPanelSessions({ claudeDir, codexDir, geminiDir, indexFile: null });
		const byAgent = all.reduce<Record<string, number>>((a, s) => {
			a[s.agentId] = (a[s.agentId] ?? 0) + 1;
			return a;
		}, {});
		expect(byAgent["claude-code"]).toBe(1);
		expect(byAgent.codex).toBe(1);
	});

	it("resolves the owning agent for a move when none is given", async () => {
		const res = await movePanelSession({
			sessionId: CODEX_ID,
			targetDir: path.join(tmp, "repo-codex-moved"),
			dryRun: true,
			...dirs(),
		});
		expect(res.fromPath).toBe(codexCwd);
		expect(res.resumeCommand).toContain("codex resume");
	});

	it("resolves the owning agent for a delete when none is given", async () => {
		const res = await deletePanelSession({ sessionId: CODEX_ID, dryRun: true, ...dirs() });
		expect(res.sessionId).toBe(CODEX_ID);
		expect(res.removedPaths.length).toBeGreaterThan(0);
	});

	it("still honours an explicit agent", async () => {
		const res = await movePanelSession({
			sessionId: CLAUDE_ID,
			agentId: "claude-code",
			targetDir: path.join(tmp, "repo-claude-moved"),
			dryRun: true,
			...dirs(),
		});
		expect(res.fromPath).toBe(claudeCwd);
		expect(res.resumeCommand).toContain("claude --resume");
	});

	it("actually completes a real (non-dry-run) move of a codex session", async () => {
		// The dry-run tests above return before the destination is verified, so they
		// cannot see this: move verified the destination at
		// <claudeDir>/projects/<encoded>/<id>.jsonl — the Claude layout, hard-coded — so
		// for a Codex rollout the check threw ENOENT and move reported failure for an
		// operation that had already succeeded, with a "Source left untouched" message
		// that was false.
		const target = path.join(tmp, "codex-moved");
		const res = await movePanelSession({ sessionId: CODEX_ID, targetDir: target, ...dirs() });

		expect(res.toPath).toBe(target);
		expect(res.dryRun).toBe(false);

		const after = scanPanelSessions({ claudeDir, codexDir, geminiDir, indexFile: null });
		const moved = after.find((s) => s.sessionId === CODEX_ID);
		expect(moved, "session should still be listable after the move").toBeDefined();
		expect(moved?.projectPath).toBe(target);
		expect(fs.existsSync(moved?.jsonlPath ?? "")).toBe(true);
	});

	it("reports a genuinely unknown id as not found", async () => {
		await expect(
			movePanelSession({ sessionId: "00000000-0000-4000-8000-000000000000", targetDir: tmp, ...dirs() }),
		).rejects.toThrow(/not found/i);
	});

	it("refuses an explicit agent that does not own the session, naming the one that does", async () => {
		// Better than "not found": the id exists, just not where the caller said.
		await expect(
			movePanelSession({
				sessionId: CODEX_ID,
				agentId: "claude-code",
				targetDir: path.join(tmp, "x"),
				...dirs(),
			}),
		).rejects.toThrow(/codex/i);
	});
});
