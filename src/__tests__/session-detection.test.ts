import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCurrentSession } from "../core/session";

// Closes the coverage gap that let the Windows `ps` break slip through: the
// process-tree walk is now tested directly via an injected parent-PID lookup,
// independent of the host OS or a real process tree.
describe("detectCurrentSession (process-tree walk)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-session-test-"));
		fs.mkdirSync(path.join(dir, "sessions"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(pid: number, sessionId: string, cwd: string) {
		fs.writeFileSync(path.join(dir, "sessions", `${pid}.json`), JSON.stringify({ sessionId, cwd }));
	}

	it("walks up via the injected parent lookup to find the session (cross-platform)", () => {
		writeSession(100, "sess-1", "/proj");
		const parents: Record<number, number> = { 300: 200, 200: 100 };
		const info = detectCurrentSession(300, dir, (pid) => parents[pid] ?? null);
		expect(info.sessionId).toBe("sess-1");
		expect(info.cwd).toBe("/proj");
		expect(info.pid).toBe(100);
	});

	it("finds a session directly at the start pid", () => {
		writeSession(500, "sess-2", "/x");
		const info = detectCurrentSession(500, dir, () => null);
		expect(info.sessionId).toBe("sess-2");
	});

	it("throws when no session is found in the tree", () => {
		const parents: Record<number, number> = { 300: 200, 200: 100 };
		expect(() => detectCurrentSession(300, dir, (pid) => parents[pid] ?? null)).toThrow(
			"Could not find a coding session",
		);
	});

	it("terminates at the depth cap (no infinite loop)", () => {
		expect(() => detectCurrentSession(1000, dir, (pid) => pid - 1)).toThrow("Could not find");
	});
});
