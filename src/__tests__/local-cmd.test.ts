import { describe, expect, it } from "vitest";
import {
	describeDeletePlan,
	describeMovePlan,
	describeRestore,
	filterSessions,
	formatLocalList,
	localCommand,
	resolveAgentFilter,
} from "../cli/commands/local";
import type { PanelSession } from "../panel";
import type { DeleteResult, MoveResult, RestoreResult } from "../panel/types";

/**
 * Contract for `codeteleport local *`.
 *
 * The panel library is already tested; this pins the surface a human (and the future
 * web view) actually consumes. Two things carry real weight here:
 *
 *  - **`--json` is an interface, not a debug aid.** The web view will consume exactly
 *    this shape, so it must be the full `PanelSession`, parseable, and free of the
 *    decoration the human table adds.
 *  - **Destructive commands must describe what they will do before doing it.** The plan
 *    text is what a user reads before typing "y", so it has to name the real paths.
 */

function session(over: Partial<PanelSession> = {}): PanelSession {
	return {
		sessionId: "11111111-2222-4333-8444-555555555555",
		projectPath: "/Users/alice/projects/alpha",
		projectName: "alpha",
		encodedProjectPath: "-Users-alice-projects-alpha",
		jsonlPath: "/Users/alice/.claude/projects/-Users-alice-projects-alpha/11111111.jsonl",
		sizeBytes: 2048,
		messageCount: 42,
		firstMessageAt: "2026-05-01T10:00:00.000Z",
		lastMessageAt: "2026-05-01T12:00:00.000Z",
		agentId: "claude-code",
		title: "Alpha work",
		titleSource: "ai",
		stranded: false,
		satellites: { hasSubagents: false, hasFileHistory: false, hasSessionEnv: false, hasMemory: false },
		resumeCommand: "claude --resume 11111111-2222-4333-8444-555555555555",
		fullResumeCommand: "cd /Users/alice/projects/alpha && claude --resume 11111111-2222-4333-8444-555555555555",
		...over,
	};
}

describe("local command surface", () => {
	describe("resolveAgentFilter", () => {
		it("defaults to every agent", () => {
			expect(resolveAgentFilter(undefined)).toBe("all");
			expect(resolveAgentFilter("all")).toBe("all");
		});

		it("accepts each supported agent", () => {
			for (const id of ["claude-code", "codex", "antigravity"]) {
				expect(resolveAgentFilter(id)).toBe(id);
			}
		});

		it("rejects an unknown agent instead of silently listing everything", () => {
			expect(() => resolveAgentFilter("gpt-5")).toThrow(/unknown agent/i);
		});
	});

	describe("filterSessions", () => {
		const sessions = [
			session({ sessionId: "a", lastMessageAt: "2026-05-03T00:00:00.000Z" }),
			session({ sessionId: "b", stranded: true, lastMessageAt: "2026-05-02T00:00:00.000Z" }),
			session({ sessionId: "c", projectPath: "/Users/alice/projects/beta", lastMessageAt: "2026-05-01T00:00:00.000Z" }),
		];

		it("returns everything by default", () => {
			expect(filterSessions(sessions, {}).map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
		});

		it("filters to stranded sessions", () => {
			expect(filterSessions(sessions, { stranded: true }).map((s) => s.sessionId)).toEqual(["b"]);
		});

		it("filters by project path", () => {
			expect(filterSessions(sessions, { project: "/Users/alice/projects/beta" }).map((s) => s.sessionId)).toEqual([
				"c",
			]);
		});

		it("applies a limit without reordering", () => {
			expect(filterSessions(sessions, { limit: 2 }).map((s) => s.sessionId)).toEqual(["a", "b"]);
		});

		it("ignores a non-positive limit rather than returning nothing", () => {
			expect(filterSessions(sessions, { limit: 0 })).toHaveLength(3);
		});
	});

	describe("formatLocalList", () => {
		it("emits the full PanelSession shape as JSON", () => {
			const out = formatLocalList([session()], { json: true });
			const parsed = JSON.parse(out);
			expect(Array.isArray(parsed)).toBe(true);
			// The web view consumes this — every field the library produces must survive.
			for (const key of [
				"sessionId",
				"projectPath",
				"jsonlPath",
				"lastMessageAt",
				"messageCount",
				"sizeBytes",
				"agentId",
				"title",
				"titleSource",
				"stranded",
				"satellites",
				"resumeCommand",
			]) {
				expect(parsed[0], `missing ${key}`).toHaveProperty(key);
			}
		});

		it("emits valid JSON for an empty list", () => {
			expect(JSON.parse(formatLocalList([], { json: true }))).toEqual([]);
		});

		it("renders a human table with the identifying columns", () => {
			const out = formatLocalList([session()]);
			expect(out).toContain("11111111-2222-4333-8444-555555555555");
			expect(out).toContain("Alpha work");
			expect(out).toContain("alpha");
			expect(out).toContain("claude-code");
		});

		it("marks stranded sessions visibly in the human output", () => {
			const out = formatLocalList([session({ stranded: true })]);
			expect(out.toLowerCase()).toMatch(/stranded/);
		});

		it("says so plainly when there is nothing to show", () => {
			expect(formatLocalList([]).toLowerCase()).toMatch(/no (local )?sessions/);
		});

		it("keeps columns separated when a value exactly fills its width", () => {
			// Found on real data: a project named `integration-research` is exactly the
			// column width, and rendered as `integration-research3064` — project and
			// message count fused into one unreadable token.
			const out = formatLocalList([session({ projectName: "integration-research", messageCount: 3064 })]);
			expect(out).not.toContain("integration-research3064");
			const row = out.split("\n").find((l) => l.includes("11111111-2222"));
			expect(row).toMatch(/\s3064\b/);
		});

		it("never lets a long value run into the next column", () => {
			const out = formatLocalList([
				session({ projectName: "a-really-long-project-name-that-overflows", messageCount: 7 }),
			]);
			const row = out.split("\n").find((l) => l.includes("11111111-2222")) ?? "";
			expect(row).toMatch(/\s7\b/);
		});
	});

	describe("plan descriptions", () => {
		const move: MoveResult = {
			sessionId: "abc",
			sourceSessionId: "abc",
			fromPath: "/Users/alice/old",
			toPath: "/Users/alice/new",
			movedBytes: 4096,
			satellitesMoved: ["subagents", "file-history"],
			resumeCommand: "claude --resume abc",
			dryRun: true,
			sourceKept: false,
		};

		it("names both paths and the satellites in a move plan", () => {
			const out = describeMovePlan(move);
			expect(out).toContain("/Users/alice/old");
			expect(out).toContain("/Users/alice/new");
			expect(out).toContain("subagents");
			expect(out.toLowerCase()).toMatch(/dry run|would/);
		});

		it("does not claim 'would' once the move has actually happened", () => {
			const out = describeMovePlan({ ...move, dryRun: false });
			expect(out).toContain("claude --resume abc");
			expect(out.toLowerCase()).not.toMatch(/dry run/);
		});

		it("lists the paths a delete will remove", () => {
			const del: DeleteResult = {
				sessionId: "abc",
				removedPaths: ["/Users/alice/.claude/projects/x/abc.jsonl", "/Users/alice/.claude/file-history/abc"],
				freedBytes: 8192,
				dryRun: true,
			};
			const out = describeDeletePlan(del);
			expect(out).toContain("abc.jsonl");
			expect(out).toContain("file-history/abc");
			expect(out.toLowerCase()).toMatch(/dry run|would/);
		});

		it("surfaces the backup location so a delete is visibly reversible", () => {
			const out = describeDeletePlan({
				sessionId: "abc",
				removedPaths: ["/x/abc.jsonl"],
				freedBytes: 10,
				backupPath: "/Users/alice/.codeteleport/panel/trash/abc-0001.tar.gz",
				dryRun: false,
			});
			expect(out).toContain("abc-0001.tar.gz");
			expect(out.toLowerCase()).toMatch(/restore/);
		});

		it("reports where a restore landed", () => {
			const restore: RestoreResult = {
				sessionId: "abc",
				restoredTo: "/Users/alice/.claude/projects/x",
				backupPath: "/trash/abc-0001.tar.gz",
				resumeCommand: "claude --resume abc",
				dryRun: false,
			};
			const out = describeRestore(restore);
			expect(out).toContain("/Users/alice/.claude/projects/x");
			expect(out).toContain("claude --resume abc");
		});
	});

	describe("command wiring", () => {
		const names = () => localCommand.commands.map((c) => c.name());

		it("registers list, move, rm and restore", () => {
			expect(names().sort()).toEqual(["list", "move", "restore", "rm"]);
		});

		it("exposes --json on list, for the web view and scripting", () => {
			const list = localCommand.commands.find((c) => c.name() === "list");
			const flags = list?.options.map((o) => o.long) ?? [];
			expect(flags).toEqual(expect.arrayContaining(["--json", "--agent", "--stranded"]));
		});

		it("makes every destructive command dry-runnable and confirmable", () => {
			for (const name of ["move", "rm"]) {
				const cmd = localCommand.commands.find((c) => c.name() === name);
				const flags = cmd?.options.map((o) => o.long) ?? [];
				expect(flags, `${name} flags`).toEqual(expect.arrayContaining(["--dry-run", "--yes"]));
			}
		});

		it("does not pin move/rm to a single agent by default", () => {
			// `local list` shows every agent, so defaulting these to claude-code made the
			// list a trap: a Codex session picked from it failed with "Session not found".
			for (const name of ["move", "rm"]) {
				const cmd = localCommand.commands.find((c) => c.name() === name);
				const agent = cmd?.options.find((o) => o.long === "--agent");
				expect(agent, `${name} --agent`).toBeDefined();
				expect(agent?.defaultValue, `${name} --agent default`).toBeUndefined();
			}
		});

		it("lets restore preview which backup it would use", () => {
			const restore = localCommand.commands.find((c) => c.name() === "restore");
			expect(restore?.options.map((o) => o.long)).toContain("--dry-run");
		});

		it("requires a target for move", () => {
			const move = localCommand.commands.find((c) => c.name() === "move");
			expect(move?.options.some((o) => o.long === "--to" && o.required)).toBe(true);
		});
	});
});
