import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_DIR } from "../shared/constants";
import type { SessionInfo } from "../shared/types";

/**
 * Look up the parent PID of a process, cross-platform.
 * - Unix/macOS: `ps -o ppid= -p <pid>`
 * - Windows: PowerShell CIM (`Get-CimInstance Win32_Process`) — `ps` is Unix-only,
 *   so the old `ps` call threw on Windows and broke session detection entirely.
 * Returns null if the parent can't be determined.
 */
function defaultGetParentPid(pid: number): number | null {
	try {
		if (process.platform === "win32") {
			const out = execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
				],
				{ encoding: "utf-8", windowsHide: true },
			).trim();
			const ppid = Number.parseInt(out, 10);
			return Number.isFinite(ppid) ? ppid : null;
		}
		const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8" }).trim();
		const ppid = Number.parseInt(out, 10);
		return Number.isFinite(ppid) ? ppid : null;
	} catch {
		return null;
	}
}

/**
 * Walk up the process tree from startPid, looking for a PID that has a session
 * file at ~/.claude/sessions/<pid>.json (max 5 levels up: claude → shell → script).
 * `getParentPid` is injectable so the walk can be unit-tested without a real
 * process tree (and cross-platform).
 */
export function detectCurrentSession(
	startPid: number = process.ppid,
	claudeDir: string = CLAUDE_DIR,
	getParentPid: (pid: number) => number | null = defaultGetParentPid,
): SessionInfo {
	let pid = startPid;
	let depth = 0;

	while (pid > 1 && depth < 5) {
		const sessionFile = path.join(claudeDir, "sessions", `${pid}.json`);
		if (fs.existsSync(sessionFile)) {
			const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
			return {
				sessionId: data.sessionId,
				cwd: data.cwd,
				pid,
			};
		}

		const parent = getParentPid(pid);
		if (parent === null || parent === pid) {
			break;
		}
		pid = parent;
		depth++;
	}

	throw new Error(
		"Could not find a coding session in the process tree. Are you running this from inside your coding agent?",
	);
}

/**
 * List recent sessions from ~/.claude/projects/ for manual selection.
 * Returns sessions sorted by modification time (newest first).
 */
export function listLocalSessions(
	claudeDir: string = CLAUDE_DIR,
): Array<{ sessionId: string; cwd: string; modifiedAt: Date }> {
	const projectsDir = path.join(claudeDir, "projects");
	if (!fs.existsSync(projectsDir)) return [];

	const sessions: Array<{ sessionId: string; cwd: string; modifiedAt: Date }> = [];

	for (const encodedCwd of fs.readdirSync(projectsDir)) {
		const projDir = path.join(projectsDir, encodedCwd);
		if (!fs.statSync(projDir).isDirectory()) continue;

		for (const file of fs.readdirSync(projDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const sessionId = file.replace(".jsonl", "");
			const stat = fs.statSync(path.join(projDir, file));
			// Decode the cwd from the directory name (reverse of encodePath)
			const cwd = encodedCwd.replace(/-/g, "/");
			sessions.push({ sessionId, cwd, modifiedAt: stat.mtime });
		}
	}

	return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}
