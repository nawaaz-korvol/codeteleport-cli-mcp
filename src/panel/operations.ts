import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleSession } from "../core/bundle";
import { encodePath, samePath } from "../core/paths";
import { unbundleSession } from "../core/unbundle";
import { getAgent } from "../shared/agents";
import { CLAUDE_DIR, DEFAULT_AGENT_ID, TRASH_DIR, assertSupportedAgent } from "../shared/constants";
import { assertValidTargetDir } from "./paths-guard";
import { scanPanelSessions } from "./scan";
import type {
	DeleteOptions,
	DeleteResult,
	MoveOptions,
	MoveResult,
	PanelDirs,
	PanelSession,
	RestoreOptions,
	RestoreResult,
} from "./types";

/**
 * Write operations for the local session panel.
 *
 * Everything here is built on the existing bundle/unbundle machinery rather than raw
 * filesystem moves. That is deliberate: a session is not one file. It spans the
 * transcript, a subagent subdirectory, `file-history/<id>`, `session-env/<id>`, and a
 * transcript full of absolute paths that must be rewritten when the project moves.
 * A `mv` orphans all of it and leaves the transcript pointing at a path that no longer
 * exists.
 */

/** Satellite locations owned by one session. Deliberately excludes shared state. */
interface SessionPaths {
	jsonl: string;
	subagentDir: string;
	fileHistoryDir: string;
	sessionEnvDir: string;
}

function sessionPaths(claudeDir: string, projDir: string, sessionId: string): SessionPaths {
	return {
		jsonl: path.join(projDir, `${sessionId}.jsonl`),
		subagentDir: path.join(projDir, sessionId),
		fileHistoryDir: path.join(claudeDir, "file-history", sessionId),
		sessionEnvDir: path.join(claudeDir, "session-env", sessionId),
	};
}

function exists(p: string): boolean {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}

/** Recursive size in bytes; 0 when absent. */
function sizeOf(p: string): number {
	let total = 0;
	const walk = (target: string) => {
		let st: fs.Stats;
		try {
			st = fs.statSync(target);
		} catch {
			return;
		}
		if (st.isDirectory()) {
			for (const entry of fs.readdirSync(target)) walk(path.join(target, entry));
		} else {
			total += st.size;
		}
	};
	walk(p);
	return total;
}

function resolveDirs(options: PanelDirs): Required<Pick<PanelDirs, "claudeDir">> & PanelDirs {
	return { ...options, claudeDir: options.claudeDir ?? CLAUDE_DIR };
}

function trashDir(options: PanelDirs): string {
	return options.panelDir ? path.join(options.panelDir, "trash") : TRASH_DIR;
}

/** Locate a session across the configured agent, or throw. */
function findSession(sessionId: string, agentId: string, options: PanelDirs): PanelSession {
	const found = scanPanelSessions({
		agentId,
		claudeDir: options.claudeDir,
		codexDir: options.codexDir,
		geminiDir: options.geminiDir,
		indexFile: null,
		skipSatellites: true,
	}).find((s) => s.sessionId === sessionId);
	if (!found) throw new Error(`Session not found: ${sessionId}`);
	return found;
}

/** Identity of a file at plan time, used to detect a live agent writing underneath us. */
function stamp(file: string): { size: number; mtimeMs: number } | null {
	try {
		const st = fs.statSync(file);
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

function assertUnchanged(file: string, before: ReturnType<typeof stamp>, what: string): void {
	const now = stamp(file);
	if (!before || !now || now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
		throw new Error(`${what} changed while the operation was in progress — the session may be live. Nothing removed.`);
	}
}

/**
 * Remove this session's own files. Never touches memory/, paste-cache/ or shell-snapshots/.
 *
 * `skip` lets a move exclude paths that the destination shares with the source. This is
 * not hypothetical: `file-history/<id>` and `session-env/<id>` are keyed by session id
 * alone, so for a same-machine move the "source" and "destination" are literally the
 * same directory — deleting the source afterwards would delete what unbundle just
 * installed, silently losing the session's file history.
 */
function removeSessionPaths(paths: SessionPaths, skip: Set<string> = new Set()): { removed: string[]; freed: number } {
	const removed: string[] = [];
	let freed = 0;
	for (const target of [paths.jsonl, paths.subagentDir, paths.fileHistoryDir, paths.sessionEnvDir]) {
		if (skip.has(target) || !exists(target)) continue;
		freed += sizeOf(target);
		fs.rmSync(target, { recursive: true, force: true });
		removed.push(target);
	}
	return { removed, freed };
}

/** Source paths that the destination reuses verbatim, and so must survive the move. */
function sharedWithDestination(src: SessionPaths, dst: SessionPaths): Set<string> {
	const shared = new Set<string>();
	const pairs: [string, string][] = [
		[src.jsonl, dst.jsonl],
		[src.subagentDir, dst.subagentDir],
		[src.fileHistoryDir, dst.fileHistoryDir],
		[src.sessionEnvDir, dst.sessionEnvDir],
	];
	for (const [a, b] of pairs) if (samePath(a, b)) shared.add(a);
	return shared;
}

function satelliteLabels(paths: SessionPaths): string[] {
	const labels: string[] = [];
	if (exists(paths.subagentDir)) labels.push("subagents");
	if (exists(paths.fileHistoryDir)) labels.push("file-history");
	if (exists(paths.sessionEnvDir)) labels.push("session-env");
	return labels;
}

/**
 * Re-anchor a session at `targetDir`.
 *
 * Order matters and is the whole safety story: bundle → install at destination → verify
 * the installed transcript exists and parses → only then remove the source. Any failure
 * before the final step leaves the original exactly as it was.
 */
export async function movePanelSession(options: MoveOptions): Promise<MoveResult> {
	const agentId = options.agentId ?? DEFAULT_AGENT_ID;
	assertSupportedAgent(agentId);
	const dirs = resolveDirs(options);
	const claudeDir = dirs.claudeDir;

	const session = findSession(options.sessionId, agentId, dirs);
	assertValidTargetDir(options.targetDir, dirs);

	const targetDir = path.normalize(options.targetDir);
	const srcProjDir = path.dirname(session.jsonlPath);
	const src = sessionPaths(claudeDir, srcProjDir, session.sessionId);
	const satellitesMoved = satelliteLabels(src);
	const movedBytes =
		sizeOf(src.jsonl) + sizeOf(src.subagentDir) + sizeOf(src.fileHistoryDir) + sizeOf(src.sessionEnvDir);
	const resumeCommand = `${getAgent(agentId).resumeCommand} ${session.sessionId}`;

	const base: MoveResult = {
		sessionId: session.sessionId,
		sourceSessionId: session.sessionId,
		fromPath: session.projectPath,
		toPath: targetDir,
		movedBytes,
		satellitesMoved,
		resumeCommand,
		dryRun: options.dryRun === true,
		sourceKept: options.keepSource === true,
	};

	// Already anchored where it was asked to go.
	if (samePath(session.projectPath, targetDir)) {
		return { ...base, dryRun: options.dryRun === true, sourceKept: true };
	}

	const dstProjDir = path.join(claudeDir, "projects", encodePath(targetDir));
	if (exists(path.join(dstProjDir, `${session.sessionId}.jsonl`))) {
		throw new Error(
			`A session with id ${session.sessionId} already exists at ${targetDir} — collision. Use copy to fork it instead.`,
		);
	}

	if (options.dryRun) return base;

	const before = stamp(src.jsonl);
	const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeteleport-move-"));
	let bundlePath: string | null = null;
	try {
		const bundle = await bundleSession({
			sessionId: session.sessionId,
			cwd: session.projectPath,
			// Read from where the files actually are, which is not always
			// encodePath(projectPath) — see BundleOptions.projDir.
			projDir: srcProjDir,
			agentId,
			claudeDir,
			codexDir: dirs.codexDir,
			geminiDir: dirs.geminiDir,
			outputDir: stagingDir,
			sourceUserDir: dirs.userDir,
		});
		bundlePath = bundle.bundlePath;

		await unbundleSession({
			bundlePath: bundle.bundlePath,
			targetDir,
			claudeDir,
			codexDir: dirs.codexDir,
			geminiDir: dirs.geminiDir,
			targetUserDir: dirs.userDir,
			memoryConflict: "merge",
		});

		// Verify before destroying anything: the transcript must exist, be non-empty and
		// parse. An unverified destination plus a deleted source is unrecoverable.
		const installed = path.join(dstProjDir, `${session.sessionId}.jsonl`);
		const content = fs.readFileSync(installed, "utf-8");
		if (content.trim().length === 0) throw new Error(`Installed transcript is empty: ${installed}`);
		for (const l of content.split("\n")) {
			if (!l.trim()) continue;
			JSON.parse(l);
		}

		if (!options.keepSource) {
			options.onBeforeSourceDelete?.();
			assertUnchanged(src.jsonl, before, "Source transcript");
			const dst = sessionPaths(claudeDir, dstProjDir, session.sessionId);
			removeSessionPaths(src, sharedWithDestination(src, dst));
		}
		return base;
	} catch (err) {
		// The bundle is the recovery path — say where it is rather than deleting it.
		if (bundlePath && exists(bundlePath)) {
			const kept = path.join(trashDir(dirs), path.basename(bundlePath));
			try {
				fs.mkdirSync(path.dirname(kept), { recursive: true });
				fs.copyFileSync(bundlePath, kept);
				throw new Error(`${(err as Error).message}\nSource left untouched. Bundle retained at: ${kept}`);
			} catch (copyErr) {
				if (copyErr !== err) throw copyErr;
			}
		}
		throw err;
	} finally {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}
}

/**
 * Delete a session and its own satellite state.
 *
 * Never removes `memory/`, `paste-cache/` or `shell-snapshots/`: those are project- or
 * content-scoped and shared. Measured on a real machine, 70 sessions shared just 7
 * memory directories, so treating memory as session state would destroy it for ~10
 * sessions each time.
 */
export async function deletePanelSession(options: DeleteOptions): Promise<DeleteResult> {
	const agentId = options.agentId ?? DEFAULT_AGENT_ID;
	assertSupportedAgent(agentId);
	const dirs = resolveDirs(options);
	const claudeDir = dirs.claudeDir;

	const session = findSession(options.sessionId, agentId, dirs);
	const projDir = path.dirname(session.jsonlPath);
	const paths = sessionPaths(claudeDir, projDir, session.sessionId);

	const targets = [paths.jsonl, paths.subagentDir, paths.fileHistoryDir, paths.sessionEnvDir].filter(exists);
	const freedBytes = targets.reduce((a, t) => a + sizeOf(t), 0);

	if (options.dryRun) {
		return { sessionId: session.sessionId, removedPaths: targets, freedBytes, dryRun: true };
	}

	let backupPath: string | undefined;
	if (options.backup !== false) {
		const dir = trashDir(dirs);
		fs.mkdirSync(dir, { recursive: true });
		const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codeteleport-trash-"));
		try {
			const bundle = await bundleSession({
				sessionId: session.sessionId,
				cwd: session.projectPath,
				projDir,
				agentId,
				claudeDir,
				codexDir: dirs.codexDir,
				geminiDir: dirs.geminiDir,
				outputDir: staging,
				sourceUserDir: dirs.userDir,
			});
			// Monotonic suffix so repeated deletes of one session are ordered without a
			// clock — restore picks the highest.
			const seq = nextTrashSequence(dir, session.sessionId);
			backupPath = path.join(dir, `${session.sessionId}-${String(seq).padStart(4, "0")}.tar.gz`);
			fs.copyFileSync(bundle.bundlePath, backupPath);
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
	}

	const before = stamp(paths.jsonl);
	assertUnchanged(paths.jsonl, before, "Session transcript");
	const { removed, freed } = removeSessionPaths(paths);

	return {
		sessionId: session.sessionId,
		removedPaths: removed,
		freedBytes: freed || freedBytes,
		backupPath,
		dryRun: false,
	};
}

/** Highest existing trash sequence for a session, plus one. */
function nextTrashSequence(dir: string, sessionId: string): number {
	let max = 0;
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return 1;
	}
	for (const name of entries) {
		const m = name.match(new RegExp(`^${sessionId}-(\\d+)\\.tar\\.gz$`));
		if (m) max = Math.max(max, Number.parseInt(m[1], 10));
	}
	return max + 1;
}

/** Newest trash bundle for a session, or null. */
function findBackup(dir: string, sessionId: string): string | null {
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return null;
	}
	const matches = entries
		.map((name) => ({ name, m: name.match(new RegExp(`^${sessionId}-(\\d+)\\.tar\\.gz$`)) }))
		.filter((x) => x.m)
		.sort((a, b) => Number.parseInt(b.m?.[1] ?? "0", 10) - Number.parseInt(a.m?.[1] ?? "0", 10));
	return matches.length > 0 ? path.join(dir, matches[0].name) : null;
}

/** Restore a session from its trash bundle back to the path it was deleted from. */
export async function restorePanelSession(options: RestoreOptions): Promise<RestoreResult> {
	const dirs = resolveDirs(options);
	const backupPath = options.backupPath ?? findBackup(trashDir(dirs), options.sessionId);
	if (!backupPath || !exists(backupPath)) {
		throw new Error(`No backup found for session ${options.sessionId} in ${trashDir(dirs)}`);
	}

	if (options.dryRun) {
		return {
			sessionId: options.sessionId,
			restoredTo: "",
			backupPath,
			resumeCommand: "",
			dryRun: true,
		};
	}

	const result = await unbundleSession({
		bundlePath: backupPath,
		claudeDir: dirs.claudeDir,
		codexDir: dirs.codexDir,
		geminiDir: dirs.geminiDir,
		targetUserDir: dirs.userDir,
		memoryConflict: "merge",
	});

	return {
		sessionId: result.sessionId,
		restoredTo: result.installedTo,
		backupPath,
		resumeCommand: result.resumeCommand,
		dryRun: false,
	};
}
