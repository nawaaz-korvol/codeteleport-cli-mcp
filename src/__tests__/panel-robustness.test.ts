import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodePath } from "../core/paths";
import { deletePanelSession, restorePanelSession, scanPanelSessions } from "../panel";
import type { PanelSession } from "../panel";
import { handlePanelRequest } from "../web/routes";

/**
 * Failure modes found by an adversarial end-to-end pass, all of which turn a recoverable
 * situation into a broken one:
 *
 *  - a malformed percent-escape in a URL killed the web server outright
 *  - one unreadable directory under ~/.claude/projects killed both the server and
 *    `local list`, hiding every readable session
 *  - `rm`'s live-transcript guard could never fire, so a session being appended to
 *    during the delete lost those messages permanently
 *  - `restore` built a RegExp from the raw session id, so a wildcard id restored a
 *    different session's backup
 */

const ID = "11111111-2222-4333-8444-555555555555";

describe("panel robustness", () => {
	let tmp: string;
	let claudeDir: string;
	let panelDir: string;
	let cwd: string;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ct-robust-")));
		claudeDir = path.join(tmp, ".claude");
		panelDir = path.join(tmp, "panel");
		cwd = path.join(tmp, "repo");
		fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		// Restore permissions so cleanup can proceed even if a test chmod'd a dir.
		const projects = path.join(claudeDir, "projects");
		if (fs.existsSync(projects)) {
			for (const e of fs.readdirSync(projects)) {
				try {
					fs.chmodSync(path.join(projects, e), 0o755);
				} catch {}
			}
		}
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	const line = (o: Record<string, unknown>) => JSON.stringify(o);

	function seed(id = ID, at = cwd) {
		const dir = path.join(claudeDir, "projects", encodePath(at));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${id}.jsonl`),
			`${[
				line({ type: "user", timestamp: "2026-06-01T10:00:00.000Z", cwd: at, message: { content: "hello" } }),
				line({ type: "ai-title", aiTitle: `session ${id.slice(0, 4)}`, sessionId: id }),
			].join("\n")}\n`,
		);
		return path.join(dir, `${id}.jsonl`);
	}

	describe("unreadable directories", () => {
		// Windows does not enforce chmod the way POSIX does, so the EACCES cases only
		// mean something on POSIX.
		const posixOnly = process.platform === "win32" ? it.skip : it;

		posixOnly("lists readable sessions even when one project directory is unreadable", () => {
			seed();
			const locked = path.join(claudeDir, "projects", "-tmp-locked");
			fs.mkdirSync(locked, { recursive: true });
			fs.writeFileSync(path.join(locked, `${"9".repeat(8)}-0000-4000-8000-000000000000.jsonl`), "{}\n");
			fs.chmodSync(locked, 0o000);

			// One bad directory must not hide every good one.
			const sessions = scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null });
			expect(sessions.map((s) => s.sessionId)).toContain(ID);
		});

		posixOnly("does not throw when the projects root itself is unreadable", () => {
			seed();
			const projects = path.join(claudeDir, "projects");
			fs.chmodSync(projects, 0o000);
			expect(() => scanPanelSessions({ agentId: "claude-code", claudeDir, indexFile: null })).not.toThrow();
			fs.chmodSync(projects, 0o755);
		});
	});

	describe("web routing never throws", () => {
		const deps = {
			token: "tok",
			port: 1234,
			listSessions: () => [] as PanelSession[],
			readSession: () => null,
			search: () => [],
		};
		const req = (url: string) => ({ method: "GET", url, headers: { host: "127.0.0.1:1234" } });

		it("answers a malformed percent-escape instead of throwing", () => {
			// `decodeURIComponent("%ZZ")` throws URIError; unhandled it killed the server
			// and every later request got ECONNREFUSED.
			for (const bad of ["%ZZ", "%E0%A4%A", "%", "%C0%80", "a%ff"]) {
				expect(() => handlePanelRequest(req(`/api/sessions/${bad}?t=tok`), deps), bad).not.toThrow();
				const res = handlePanelRequest(req(`/api/sessions/${bad}?t=tok`), deps);
				expect([400, 404], bad).toContain(res.status);
			}
		});

		it("answers a malformed escape in the query string instead of throwing", () => {
			expect(() => handlePanelRequest(req("/api/search?q=%ZZ&t=tok"), deps)).not.toThrow();
		});
	});

	describe("rm live-transcript guard", () => {
		it("aborts when the transcript changes while the delete is in flight", async () => {
			const file = seed();
			// The guard existed but compared a baseline taken on the previous line, so it
			// could never fire. The window that matters is the bundling, which is async and
			// takes real time; simulate an agent appending during it.
			const original = fs.readFileSync(file, "utf-8");
			const timer = setTimeout(() => {
				fs.appendFileSync(file, `${line({ type: "user", timestamp: "2026-06-01T11:00:00.000Z" })}\n`);
			}, 5);

			await expect(
				deletePanelSession({ sessionId: ID, agentId: "claude-code", claudeDir, panelDir, userDir: tmp }),
			).rejects.toThrow(/changed|live|in use/i);
			clearTimeout(timer);

			// Nothing removed, and the appended content is still there.
			expect(fs.existsSync(file)).toBe(true);
			expect(fs.readFileSync(file, "utf-8").startsWith(original)).toBe(true);
		});

		it("still deletes normally when nothing is writing", async () => {
			const file = seed();
			const res = await deletePanelSession({
				sessionId: ID,
				agentId: "claude-code",
				claudeDir,
				panelDir,
				userDir: tmp,
			});
			expect(fs.existsSync(file)).toBe(false);
			expect(res.backupPath).toBeDefined();
		});
	});

	describe("restore does not treat the session id as a pattern", () => {
		it("refuses a wildcard id rather than restoring a different session", async () => {
			seed();
			await deletePanelSession({ sessionId: ID, agentId: "claude-code", claudeDir, panelDir, userDir: tmp });

			// `.` matched any character, so this id resolved to the real session's backup.
			const wildcard = `.${ID.slice(1)}`;
			await expect(restorePanelSession({ sessionId: wildcard, claudeDir, panelDir, userDir: tmp })).rejects.toThrow(
				/no backup/i,
			);
		});

		it("reports no backup for a regex-metacharacter id instead of a regex error", async () => {
			await expect(restorePanelSession({ sessionId: "((", claudeDir, panelDir, userDir: tmp })).rejects.toThrow(
				/no backup/i,
			);
		});

		it("still restores the correct session by its exact id", async () => {
			const file = seed();
			const before = fs.readFileSync(file, "utf-8");
			await deletePanelSession({ sessionId: ID, agentId: "claude-code", claudeDir, panelDir, userDir: tmp });
			await restorePanelSession({ sessionId: ID, claudeDir, panelDir, userDir: tmp });
			expect(fs.readFileSync(file, "utf-8")).toBe(before);
		});
	});
});
