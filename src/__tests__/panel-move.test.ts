import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../core/paths";
import { movePanelSession, scanPanelSessions } from "../panel";

/**
 * Contract for `move` — re-anchoring a session from one project path to another.
 *
 * The relocation machinery already exists: `bundleSession` → `unbundleSession({targetDir})`
 * performs the two-pass path rewrite and re-encodes the project directory. These tests pin
 * the *operation* built on top of it, and in particular the safety properties, because the
 * failure modes here destroy user data rather than merely returning a wrong answer:
 *
 *   - the source is removed only after the destination is verified
 *   - a dry run touches nothing
 *   - project memory (shared by every session in a project) is never destroyed
 *   - a live session is never moved out from under a running agent
 */

describe("panel move", () => {
	let tmp: string;
	let claudeDir: string;
	let projectsDir: string;
	let panelDir: string;
	let srcCwd: string;
	let dstCwd: string;

	const ID = "11111111-2222-4333-8444-555555555555";

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-panel-move-")));
		claudeDir = path.join(tmp, ".claude");
		projectsDir = path.join(claudeDir, "projects");
		panelDir = path.join(tmp, "panel");
		srcCwd = path.join(tmp, "repo", "f1");
		dstCwd = path.join(tmp, "repo", "f3", "ff1");
		fs.mkdirSync(projectsDir, { recursive: true });
		fs.mkdirSync(srcCwd, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const line = (o: Record<string, unknown>) => JSON.stringify(o);

	function seedSession(cwd: string, id = ID, opts: { satellites?: boolean; memory?: boolean } = {}) {
		const projDir = path.join(projectsDir, encodePath(cwd));
		fs.mkdirSync(projDir, { recursive: true });
		fs.writeFileSync(
			path.join(projDir, `${id}.jsonl`),
			`${[
				line({ type: "mode", mode: "normal", sessionId: id }),
				line({ type: "user", timestamp: "2026-05-01T10:00:00.000Z", cwd, message: { content: `work in ${cwd}` } }),
				line({ type: "assistant", timestamp: "2026-05-01T10:05:00.000Z", message: { content: "ok" } }),
				line({ type: "ai-title", aiTitle: "moved session", sessionId: id }),
			].join("\n")}\n`,
		);
		if (opts.satellites !== false) {
			fs.mkdirSync(path.join(projDir, id), { recursive: true });
			fs.writeFileSync(path.join(projDir, id, "subagent.jsonl"), `${line({ type: "user", cwd })}\n`);
			fs.mkdirSync(path.join(claudeDir, "file-history", id), { recursive: true });
			fs.writeFileSync(path.join(claudeDir, "file-history", id, "snap.json"), JSON.stringify({ file: `${cwd}/a.ts` }));
			fs.mkdirSync(path.join(claudeDir, "session-env", id), { recursive: true });
			fs.writeFileSync(path.join(claudeDir, "session-env", id, "env.json"), JSON.stringify({ CWD: cwd }));
		}
		if (opts.memory) {
			fs.mkdirSync(path.join(projDir, "memory"), { recursive: true });
			fs.writeFileSync(path.join(projDir, "memory", "note.md"), `see ${cwd}/README.md`);
		}
		return projDir;
	}

	const dirs = () => ({ claudeDir, panelDir, userDir: tmp });
	const move = (over: Partial<Parameters<typeof movePanelSession>[0]> = {}) =>
		movePanelSession({ sessionId: ID, agentId: "claude-code", targetDir: dstCwd, ...dirs(), ...over });

	const dstProj = () => path.join(projectsDir, encodePath(dstCwd));
	const srcProj = () => path.join(projectsDir, encodePath(srcCwd));

	describe("relocation", () => {
		it("re-anchors the transcript at the target and rewrites its paths", async () => {
			seedSession(srcCwd);
			const res = await move();

			expect(res.dryRun).toBe(false);
			expect(res.fromPath).toBe(srcCwd);
			expect(res.toPath).toBe(dstCwd);
			expect(res.sessionId).toBe(ID);
			expect(res.resumeCommand).toBe(`claude --resume ${ID}`);

			const installed = path.join(dstProj(), `${ID}.jsonl`);
			expect(fs.existsSync(installed)).toBe(true);
			const content = fs.readFileSync(installed, "utf-8");
			expect(content).toContain(dstCwd);
			expect(content).not.toContain(`"${srcCwd}"`);
			for (const l of content.trim().split("\n")) expect(() => JSON.parse(l)).not.toThrow();
		});

		it("removes the source once the destination is verified", async () => {
			seedSession(srcCwd);
			await move();
			expect(fs.existsSync(path.join(srcProj(), `${ID}.jsonl`))).toBe(false);
			expect(fs.existsSync(path.join(srcProj(), ID))).toBe(false);
		});

		it("carries satellite state across", async () => {
			seedSession(srcCwd);
			const res = await move();
			expect(fs.existsSync(path.join(dstProj(), ID, "subagent.jsonl"))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "file-history", ID))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "session-env", ID))).toBe(true);
			expect(res.satellitesMoved).toEqual(expect.arrayContaining(["subagents", "file-history", "session-env"]));
			expect(res.movedBytes).toBeGreaterThan(0);
		});

		it("makes the session discoverable at the new path and gone from the old", async () => {
			seedSession(srcCwd);
			await move();
			const sessions = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null });
			expect(sessions.map((s) => s.projectPath)).toEqual([dstCwd]);
			expect(sessions[0].projectName).toBe("ff1");
			expect(sessions[0].title).toBe("moved session");
		});

		it("does not destroy project memory shared by other sessions", async () => {
			// memory/ is project-scoped: on a real machine 70 sessions shared just 7 dirs.
			seedSession(srcCwd, ID, { memory: true });
			const other = "99999999-2222-4333-8444-555555555555";
			seedSession(srcCwd, other, { satellites: false });

			await move();

			expect(fs.existsSync(path.join(srcProj(), "memory", "note.md"))).toBe(true);
			expect(fs.existsSync(path.join(srcProj(), `${other}.jsonl`))).toBe(true);
		});
	});

	describe("dry run", () => {
		it("reports the plan without touching the filesystem", async () => {
			seedSession(srcCwd);
			const before = fs.readFileSync(path.join(srcProj(), `${ID}.jsonl`), "utf-8");

			const res = await move({ dryRun: true });

			expect(res.dryRun).toBe(true);
			expect(res.fromPath).toBe(srcCwd);
			expect(res.toPath).toBe(dstCwd);
			expect(fs.existsSync(dstProj())).toBe(false);
			expect(fs.readFileSync(path.join(srcProj(), `${ID}.jsonl`), "utf-8")).toBe(before);
		});
	});

	describe("refusals", () => {
		it("treats a move to the current location as a no-op", async () => {
			seedSession(srcCwd);
			const res = await move({ targetDir: srcCwd });
			expect(res.sourceKept).toBe(true);
			expect(fs.existsSync(path.join(srcProj(), `${ID}.jsonl`))).toBe(true);
		});

		it("refuses when the destination already holds this session", async () => {
			seedSession(srcCwd);
			seedSession(dstCwd, ID, { satellites: false });
			await expect(move()).rejects.toThrow(/already exists|collision/i);
			expect(fs.existsSync(path.join(srcProj(), `${ID}.jsonl`))).toBe(true);
		});

		it("refuses an unknown session", async () => {
			seedSession(srcCwd);
			await expect(move({ sessionId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/not found/i);
		});

		it("refuses a relative target", async () => {
			seedSession(srcCwd);
			await expect(move({ targetDir: "relative/path" })).rejects.toThrow(/absolute/i);
		});

		it("refuses to anchor a session inside an agent's own state directory", async () => {
			seedSession(srcCwd);
			for (const bad of [claudeDir, path.join(claudeDir, "projects", "x"), path.join(tmp, ".codex", "sessions")]) {
				await expect(move({ targetDir: bad })).rejects.toThrow(/agent state|not a valid target/i);
			}
		});

		it("refuses a sensitive target directory", async () => {
			seedSession(srcCwd);
			for (const bad of [".ssh", ".aws", ".gnupg"]) {
				await expect(move({ targetDir: path.join(tmp, bad, "proj") })).rejects.toThrow(/sensitive|not a valid target/i);
			}
		});

		it("aborts if the transcript changes between planning and deletion", async () => {
			// A live agent may be appending while the panel works. The source must not be
			// deleted in that window.
			seedSession(srcCwd);
			const jsonl = path.join(srcProj(), `${ID}.jsonl`);
			const res = move({
				onBeforeSourceDelete: () => {
					fs.appendFileSync(jsonl, `${line({ type: "user", timestamp: "2026-05-01T11:00:00.000Z" })}\n`);
				},
			});
			await expect(res).rejects.toThrow(/changed|live|in use/i);
			expect(fs.existsSync(jsonl)).toBe(true);
		});
	});

	describe("failure safety", () => {
		it("leaves the source intact when the destination cannot be written", async () => {
			seedSession(srcCwd);
			// Occupy the destination project dir with a file, so mkdir of it must fail.
			const blocked = dstProj();
			fs.mkdirSync(path.dirname(blocked), { recursive: true });
			fs.writeFileSync(blocked, "not a directory");

			await expect(move()).rejects.toThrow();
			expect(fs.existsSync(path.join(srcProj(), `${ID}.jsonl`))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "file-history", ID))).toBe(true);
		});
	});
});
