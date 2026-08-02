import readline from "node:readline";
import { Command } from "commander";
import {
	type PanelSession,
	deletePanelSession,
	movePanelSession,
	restorePanelSession,
	scanPanelSessions,
} from "../../panel";
import type { DeleteResult, MoveResult, RestoreResult } from "../../panel/types";
import { SUPPORTED_AGENT_IDS } from "../../shared/constants";

/**
 * `codeteleport local *` — the panel's user-facing surface.
 *
 * LOCAL-ONLY by construction: no account, no token, no network. Nothing in this file may
 * import `../config` (the token) or `../../client/api`; `boundary.test.ts` enforces it,
 * because a free local tool silently chained to the paid cloud CLI is exactly the
 * regression the panel exists to avoid.
 */

export interface ListFilters {
	stranded?: boolean;
	project?: string;
	limit?: number;
}

/** Validate `--agent`. Defaults to every agent — the cross-agent view is the point. */
export function resolveAgentFilter(value?: string): string {
	if (!value || value === "all") return "all";
	if (!(SUPPORTED_AGENT_IDS as readonly string[]).includes(value)) {
		throw new Error(`Unknown agent: ${value}. Supported: ${SUPPORTED_AGENT_IDS.join(", ")}, all`);
	}
	return value;
}

/** Apply display filters. Order is preserved — the scan already sorted by recency. */
export function filterSessions(sessions: PanelSession[], filters: ListFilters): PanelSession[] {
	let out = sessions;
	if (filters.stranded) out = out.filter((s) => s.stranded);
	if (filters.project) out = out.filter((s) => s.projectPath === filters.project);
	// A limit of 0 or a non-number means "no limit" rather than "show nothing" — the
	// latter is never what someone typing --limit wanted.
	if (typeof filters.limit === "number" && filters.limit > 0) out = out.slice(0, filters.limit);
	return out;
}

function human(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${bytes}B`;
}

function stamp(iso: string | null): string {
	if (!iso) return "unknown";
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Pad to a fixed column width, always leaving at least one space of separation.
 *
 * Truncation triggers at `>= n`, not `> n`: a value exactly the column width would
 * otherwise butt straight into the next column. Real data hit this immediately — a
 * project named `integration-research` (20 chars in a 20-wide column) rendered as
 * `integration-research3064`, silently fusing the project and message-count fields.
 */
const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 2)}… ` : s.padEnd(n));

/**
 * Render the session list.
 *
 * `--json` is an interface, not a debug aid: it emits the whole `PanelSession` untouched
 * so the CLI and the web view consume one shape rather than drifting apart.
 */
export function formatLocalList(sessions: PanelSession[], opts: { json?: boolean } = {}): string {
	if (opts.json) return JSON.stringify(sessions, null, 2);
	if (sessions.length === 0) return "No local sessions found.";

	const lines = [
		`${pad("ID", 38)}${pad("LAST USED", 18)}${pad("AGENT", 13)}${pad("PROJECT", 20)}${pad("MSGS", 7)}${pad("SIZE", 8)}TITLE`,
		"-".repeat(130),
	];
	for (const s of sessions) {
		const title = s.stranded ? `${s.title}  [STRANDED]` : s.title;
		lines.push(
			pad(s.sessionId, 38) +
				pad(stamp(s.lastMessageAt), 18) +
				pad(s.agentId, 13) +
				pad(s.projectName, 20) +
				pad(String(s.messageCount), 7) +
				pad(human(s.sizeBytes), 8) +
				title,
		);
	}
	const stranded = sessions.filter((s) => s.stranded).length;
	lines.push("");
	lines.push(
		`${sessions.length} session${sessions.length === 1 ? "" : "s"}${stranded ? `, ${stranded} stranded` : ""}`,
	);
	return lines.join("\n");
}

export function describeMovePlan(result: MoveResult): string {
	const lines: string[] = [];
	lines.push(result.dryRun ? `Dry run — would move ${result.sessionId}:` : `Moved ${result.sessionId}:`);
	lines.push(`  from      ${result.fromPath}`);
	lines.push(`  to        ${result.toPath}`);
	lines.push(`  size      ${human(result.movedBytes)}`);
	if (result.satellitesMoved.length > 0) lines.push(`  carries   ${result.satellitesMoved.join(", ")}`);
	if (result.sourceKept && !result.dryRun) lines.push("  note      source kept in place");
	if (!result.dryRun) lines.push(`  resume    ${result.resumeCommand}`);
	return lines.join("\n");
}

export function describeDeletePlan(result: DeleteResult): string {
	const lines: string[] = [];
	lines.push(result.dryRun ? `Dry run — would remove ${result.sessionId}:` : `Removed ${result.sessionId}:`);
	for (const p of result.removedPaths) lines.push(`  ${p}`);
	lines.push(`  frees     ${human(result.freedBytes)}`);
	if (result.backupPath) {
		lines.push(`  backup    ${result.backupPath}`);
		lines.push(`  restore   codeteleport local restore ${result.sessionId}`);
	}
	// Stated explicitly because it is the single most reassuring fact about `rm`.
	lines.push("  kept      project memory, paste-cache and shell-snapshots (shared)");
	return lines.join("\n");
}

export function describeRestore(result: RestoreResult): string {
	return [
		`Restored ${result.sessionId}:`,
		`  to        ${result.restoredTo}`,
		`  from      ${result.backupPath}`,
		`  resume    ${result.resumeCommand}`,
	].join("\n");
}

function confirm(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} (y/N) `, (answer) => {
			rl.close();
			resolve(answer.trim().toLowerCase() === "y");
		});
	});
}

function fail(err: unknown): never {
	console.error(`Failed: ${(err as Error).message}`);
	process.exit(1);
}

// ── Subcommands ──────────────────────────────────────────────────────────────────

const listCmd = new Command("list")
	.description("List local sessions across every agent")
	.option("--agent <id>", "claude-code | codex | antigravity | all", "all")
	.option("--json", "Emit the full session objects as JSON")
	.option("--stranded", "Only sessions whose project directory no longer exists")
	.option("--project <path>", "Only sessions anchored at this project path")
	.option("--limit <n>", "Show at most N sessions")
	.action((opts) => {
		try {
			const agentId = resolveAgentFilter(opts.agent);
			const sessions = scanPanelSessions({ agentId });
			const limit = opts.limit === undefined ? undefined : Number.parseInt(opts.limit, 10);
			console.log(formatLocalList(filterSessions(sessions, { ...opts, limit }), { json: opts.json }));
		} catch (err) {
			fail(err);
		}
	});

const moveCmd = new Command("move")
	.description("Re-anchor a session at a different project path")
	.argument("<session-id>", "Session to move")
	.requiredOption("--to <path>", "Absolute path to anchor the session at")
	.option("--agent <id>", "Agent that owns the session", "claude-code")
	.option("--dry-run", "Show the plan without changing anything")
	.option("-y, --yes", "Skip the confirmation prompt")
	.action(async (sessionId: string, opts) => {
		try {
			const base = { sessionId, agentId: opts.agent, targetDir: opts.to };
			if (opts.dryRun) {
				console.log(describeMovePlan(await movePanelSession({ ...base, dryRun: true })));
				return;
			}
			if (!opts.yes) {
				console.log(describeMovePlan(await movePanelSession({ ...base, dryRun: true })));
				if (!(await confirm("\nProceed?"))) {
					console.log("Cancelled.");
					return;
				}
			}
			console.log(describeMovePlan(await movePanelSession(base)));
		} catch (err) {
			fail(err);
		}
	});

const rmCmd = new Command("rm")
	.description("Delete a local session (backed up to trash by default)")
	.argument("<session-id>", "Session to delete")
	.option("--agent <id>", "Agent that owns the session", "claude-code")
	.option("--dry-run", "Show what would be removed without removing it")
	.option("--no-backup", "Do not write a trash bundle first")
	.option("-y, --yes", "Skip the confirmation prompt")
	.action(async (sessionId: string, opts) => {
		try {
			const base = { sessionId, agentId: opts.agent, backup: opts.backup !== false };
			if (opts.dryRun) {
				console.log(describeDeletePlan(await deletePanelSession({ ...base, dryRun: true })));
				return;
			}
			if (!opts.yes) {
				console.log(describeDeletePlan(await deletePanelSession({ ...base, dryRun: true })));
				if (!(await confirm("\nDelete this session?"))) {
					console.log("Cancelled.");
					return;
				}
			}
			console.log(describeDeletePlan(await deletePanelSession(base)));
		} catch (err) {
			fail(err);
		}
	});

const restoreCmd = new Command("restore")
	.description("Restore a deleted session from the trash")
	.argument("<session-id>", "Session to restore")
	.action(async (sessionId: string) => {
		try {
			console.log(describeRestore(await restorePanelSession({ sessionId })));
		} catch (err) {
			fail(err);
		}
	});

export const localCommand = new Command("local")
	.description("Manage local sessions on this machine (no account needed)")
	.addCommand(listCmd)
	.addCommand(moveCmd)
	.addCommand(rmCmd)
	.addCommand(restoreCmd);
