import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../core/paths";
import { deletePanelSession, restorePanelSession, scanPanelSessions } from "../panel";

/**
 * Contract for `rm` and `restore`.
 *
 * The dangerous part of deleting a session is what sits *next* to it. Measured on a real
 * machine: 70 of 88 sessions live in a project directory containing `memory/`, but there
 * are only 7 distinct memory dirs — so removing one session's `memory/` would destroy it
 * for ~10 others. `paste-cache/` and `shell-snapshots/` are content-addressed and shared
 * the same way. Those assertions are the point of this file.
 */

describe("panel delete + restore", () => {
	let tmp: string;
	let claudeDir: string;
	let projectsDir: string;
	let panelDir: string;
	let cwd: string;

	const ID = "aaaaaaaa-2222-4333-8444-555555555555";
	const OTHER = "bbbbbbbb-2222-4333-8444-555555555555";

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-panel-del-")));
		claudeDir = path.join(tmp, ".claude");
		projectsDir = path.join(claudeDir, "projects");
		panelDir = path.join(tmp, "panel");
		cwd = path.join(tmp, "repo");
		fs.mkdirSync(projectsDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const line = (o: Record<string, unknown>) => JSON.stringify(o);
	const projDir = () => path.join(projectsDir, encodePath(cwd));

	function seed(id: string, withSatellites = true) {
		const dir = projDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${id}.jsonl`),
			`${[
				line({ type: "user", timestamp: "2026-05-01T10:00:00.000Z", cwd, message: { content: "hello" } }),
				line({ type: "assistant", timestamp: "2026-05-01T10:05:00.000Z", message: { content: "hi" } }),
				line({ type: "ai-title", aiTitle: `session ${id.slice(0, 4)}`, sessionId: id }),
			].join("\n")}\n`,
		);
		if (withSatellites) {
			fs.mkdirSync(path.join(dir, id), { recursive: true });
			fs.writeFileSync(path.join(dir, id, "subagent.jsonl"), `${line({ type: "user" })}\n`);
			fs.mkdirSync(path.join(claudeDir, "file-history", id), { recursive: true });
			fs.writeFileSync(path.join(claudeDir, "file-history", id, "snap.json"), "{}");
			fs.mkdirSync(path.join(claudeDir, "session-env", id), { recursive: true });
			fs.writeFileSync(path.join(claudeDir, "session-env", id, "env.json"), "{}");
		}
	}

	/** Project-scoped state that must survive deleting any single session. */
	function seedShared() {
		fs.mkdirSync(path.join(projDir(), "memory"), { recursive: true });
		fs.writeFileSync(path.join(projDir(), "memory", "note.md"), "shared knowledge");
		fs.mkdirSync(path.join(claudeDir, "paste-cache"), { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "paste-cache", "abc123.txt"), "pasted");
		fs.mkdirSync(path.join(claudeDir, "shell-snapshots"), { recursive: true });
		fs.writeFileSync(path.join(claudeDir, "shell-snapshots", "snap-1.sh"), "echo hi");
	}

	const dirs = () => ({ claudeDir, panelDir, userDir: tmp });
	const del = (over: Partial<Parameters<typeof deletePanelSession>[0]> = {}) =>
		deletePanelSession({ sessionId: ID, agentId: "claude-code", ...dirs(), ...over });

	describe("removal", () => {
		it("removes the transcript and this session's satellites", async () => {
			seed(ID);
			const res = await del({ backup: false });

			expect(res.dryRun).toBe(false);
			expect(res.freedBytes).toBeGreaterThan(0);
			expect(fs.existsSync(path.join(projDir(), `${ID}.jsonl`))).toBe(false);
			expect(fs.existsSync(path.join(projDir(), ID))).toBe(false);
			expect(fs.existsSync(path.join(claudeDir, "file-history", ID))).toBe(false);
			expect(fs.existsSync(path.join(claudeDir, "session-env", ID))).toBe(false);
			expect(res.removedPaths.length).toBeGreaterThanOrEqual(4);
		});

		it("never removes project memory, paste-cache or shell-snapshots", async () => {
			seed(ID);
			seedShared();
			await del({ backup: false });

			expect(fs.existsSync(path.join(projDir(), "memory", "note.md"))).toBe(true);
			expect(fs.readFileSync(path.join(projDir(), "memory", "note.md"), "utf-8")).toBe("shared knowledge");
			expect(fs.existsSync(path.join(claudeDir, "paste-cache", "abc123.txt"))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "shell-snapshots", "snap-1.sh"))).toBe(true);
		});

		it("leaves sibling sessions in the same project untouched", async () => {
			seed(ID);
			seed(OTHER);
			await del({ backup: false });

			expect(fs.existsSync(path.join(projDir(), `${OTHER}.jsonl`))).toBe(true);
			expect(fs.existsSync(path.join(projDir(), OTHER))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "file-history", OTHER))).toBe(true);
			const left = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null });
			expect(left.map((s) => s.sessionId)).toEqual([OTHER]);
		});

		it("reports only session-scoped paths as removed", async () => {
			seed(ID);
			seedShared();
			const res = await del({ backup: false });
			const joined = res.removedPaths.join("\n");
			expect(joined).not.toMatch(/[/\\]memory([/\\]|$)/);
			expect(joined).not.toMatch(/paste-cache/);
			expect(joined).not.toMatch(/shell-snapshots/);
		});
	});

	describe("dry run", () => {
		it("lists what would go without removing anything", async () => {
			seed(ID);
			const res = await del({ dryRun: true });

			expect(res.dryRun).toBe(true);
			expect(res.removedPaths.length).toBeGreaterThan(0);
			expect(res.backupPath).toBeUndefined();
			expect(fs.existsSync(path.join(projDir(), `${ID}.jsonl`))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "file-history", ID))).toBe(true);
		});
	});

	describe("trash + restore", () => {
		it("writes a backup by default and restores the session byte-identically", async () => {
			seed(ID);
			const original = fs.readFileSync(path.join(projDir(), `${ID}.jsonl`), "utf-8");

			const removed = await del();
			expect(removed.backupPath).toBeDefined();
			expect(fs.existsSync(removed.backupPath as string)).toBe(true);
			expect(fs.existsSync(path.join(projDir(), `${ID}.jsonl`))).toBe(false);

			const restored = await restorePanelSession({ sessionId: ID, ...dirs() });
			expect(restored.sessionId).toBe(ID);
			expect(restored.resumeCommand).toBe(`claude --resume ${ID}`);
			expect(fs.readFileSync(path.join(projDir(), `${ID}.jsonl`), "utf-8")).toBe(original);
			expect(fs.existsSync(path.join(projDir(), ID, "subagent.jsonl"))).toBe(true);
			expect(fs.existsSync(path.join(claudeDir, "file-history", ID))).toBe(true);
		});

		it("skips the backup when asked", async () => {
			seed(ID);
			const res = await del({ backup: false });
			expect(res.backupPath).toBeUndefined();
		});

		it("refuses to restore when no backup exists", async () => {
			await expect(restorePanelSession({ sessionId: ID, ...dirs() })).rejects.toThrow(/no backup|not found/i);
		});

		it("restores the newest backup when a session was deleted more than once", async () => {
			seed(ID);
			await del();
			await restorePanelSession({ sessionId: ID, ...dirs() });
			fs.appendFileSync(
				path.join(projDir(), `${ID}.jsonl`),
				`${line({ type: "user", timestamp: "2026-05-02T10:00:00.000Z", message: { content: "second round" } })}\n`,
			);
			await del();

			await restorePanelSession({ sessionId: ID, ...dirs() });
			expect(fs.readFileSync(path.join(projDir(), `${ID}.jsonl`), "utf-8")).toContain("second round");
		});
	});

	describe("refusals", () => {
		it("refuses an unknown session", async () => {
			seed(ID);
			await expect(del({ sessionId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/not found/i);
		});
	});
});
