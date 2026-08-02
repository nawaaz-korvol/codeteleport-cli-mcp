import fs from "node:fs";
import path from "node:path";
import { scanLocalSessionsForAgent } from "../core/agents/dispatch";
import type { LocalSession } from "../core/local";
import { pathBasename } from "../core/paths";
import { getAgent } from "../shared/agents";
import { CLAUDE_DIR, DEFAULT_AGENT_ID, SUPPORTED_AGENT_IDS, assertSupportedAgent } from "../shared/constants";
import { MessageCountCache } from "./count-cache";
import { scanHead, scanTail } from "./jsonl-scan";
import type { PanelSession, SatelliteState, ScanPanelOptions, TitleSource } from "./types";

const NO_SATELLITES: SatelliteState = {
	hasSubagents: false,
	hasFileHistory: false,
	hasSessionEnv: false,
	hasMemory: false,
};

function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/**
 * Claude Code satellite layout. Note `memory/` is *project*-scoped and shared by every
 * session in that project — it is reported so the UI can show it, never so a delete can
 * remove it. Measured on a real machine: 70 sessions share just 7 memory dirs.
 */
function claudeSatellites(claudeDir: string, projDir: string, sessionId: string): SatelliteState {
	return {
		hasSubagents: exists(path.join(projDir, sessionId)),
		hasFileHistory: exists(path.join(claudeDir, "file-history", sessionId)),
		hasSessionEnv: exists(path.join(claudeDir, "session-env", sessionId)),
		hasMemory: exists(path.join(projDir, "memory")),
	};
}

function finalise(
	base: LocalSession,
	agentId: string,
	title: string | null,
	titleSource: TitleSource,
	satellites: SatelliteState,
): PanelSession {
	const resumeCommand = `${getAgent(agentId).resumeCommand} ${base.sessionId}`;
	return {
		...base,
		agentId,
		title: title ?? base.sessionId.slice(0, 8),
		titleSource: title ? titleSource : "id",
		stranded: base.projectPath.length > 0 && !exists(base.projectPath),
		satellites,
		resumeCommand,
		fullResumeCommand: base.projectPath ? `cd ${base.projectPath} && ${resumeCommand}` : resumeCommand,
	};
}

/**
 * Fast path for Claude Code: read only the head and tail of each transcript, and take
 * the message count from a (path, size, mtime) cache.
 *
 * `scanLocalSessions` readFileSync's every transcript — on a real machine that is
 * 477 MB and ~1.0-1.2 s for 88 sessions. This produces identical output (verified
 * field-for-field, 0 mismatches) in 496 ms cold / 48 ms warm.
 */
function scanClaude(claudeDir: string, counts: MessageCountCache, skipSatellites: boolean): PanelSession[] {
	const projectsDir = path.join(claudeDir, "projects");
	if (!exists(projectsDir)) return [];

	const out: PanelSession[] = [];
	for (const encodedCwd of fs.readdirSync(projectsDir)) {
		const projDir = path.join(projectsDir, encodedCwd);
		let dirStat: fs.Stats;
		try {
			dirStat = fs.statSync(projDir);
		} catch {
			continue;
		}
		if (!dirStat.isDirectory()) continue;

		for (const file of fs.readdirSync(projDir)) {
			// Only depth-1 .jsonl files are sessions. Nested ones are plugin artifacts
			// (e.g. <projDir>/vercel-plugin/skill-injections.jsonl).
			if (!file.endsWith(".jsonl")) continue;
			const jsonlPath = path.join(projDir, file);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(jsonlPath);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;

			const sessionId = file.slice(0, -".jsonl".length);
			const fd = fs.openSync(jsonlPath, "r");
			let head: ReturnType<typeof scanHead>;
			let tail: ReturnType<typeof scanTail>;
			try {
				head = scanHead(fd, stat.size);
				tail = scanTail(fd, stat.size);
			} finally {
				fs.closeSync(fd);
			}

			// Same lossy fallback as the base scanner: decoding is irreversible, but the
			// last "-" segment is still a usable project name.
			const projectPath = head.cwd ?? encodedCwd.replace(/-/g, "/");
			const base: LocalSession = {
				sessionId,
				projectPath,
				projectName: pathBasename(projectPath),
				encodedProjectPath: encodedCwd,
				jsonlPath,
				sizeBytes: stat.size,
				messageCount: counts.get(jsonlPath, stat.size, stat.mtimeMs),
				firstMessageAt: head.firstMessageAt,
				lastMessageAt: tail.lastMessageAt,
			};
			out.push(
				finalise(
					base,
					"claude-code",
					tail.title,
					tail.titleSource,
					skipSatellites ? NO_SATELLITES : claudeSatellites(claudeDir, projDir, sessionId),
				),
			);
		}
	}
	return out;
}

/**
 * Codex and Antigravity keep their own on-disk layouts (nested rollouts; SQLite +
 * protobuf), so they go through their existing adapters. Those adapters read whole
 * sessions — measured at 804 ms for 52 Codex sessions — so they want the same head/tail
 * treatment, but that is per-adapter work tracked separately. Correctness first: the
 * output shape here is identical either way.
 */
function scanViaAdapter(agentId: string, dirs: { codexDir?: string; geminiDir?: string }): PanelSession[] {
	let sessions: LocalSession[];
	try {
		sessions = scanLocalSessionsForAgent(agentId, dirs);
	} catch {
		// A missing or unreadable agent home is an empty list, not a failed scan.
		return [];
	}
	return sessions.map((s) => finalise(s, agentId, null, "id", NO_SATELLITES));
}

function byRecencyDesc(a: PanelSession, b: PanelSession): number {
	const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
	const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
	return bt - at;
}

/**
 * List local sessions for the panel, newest first.
 *
 * Defaults to every supported agent — the cross-agent view is the point of the panel.
 * Purely local: no account, no network. See `boundary.test.ts`, which enforces that.
 */
export function scanPanelSessions(options: ScanPanelOptions = {}): PanelSession[] {
	const agentId = options.agentId ?? "all";
	const agentIds = agentId === "all" ? [...SUPPORTED_AGENT_IDS] : [agentId];
	for (const id of agentIds) assertSupportedAgent(id);

	const claudeDir = options.claudeDir ?? CLAUDE_DIR;
	const counts = new MessageCountCache(options.indexFile === undefined ? null : options.indexFile);

	const out: PanelSession[] = [];
	for (const id of agentIds) {
		if (id === DEFAULT_AGENT_ID) {
			out.push(...scanClaude(claudeDir, counts, options.skipSatellites === true));
		} else {
			out.push(...scanViaAdapter(id, { codexDir: options.codexDir, geminiDir: options.geminiDir }));
		}
	}
	counts.flush();
	return out.sort(byRecencyDesc);
}
