import { describe, expect, it } from "vitest";
import { formatSessionRow, pickSession } from "../cli/session-picker";
import type { LocalSession } from "../core/local";

function makeSession(overrides: Partial<LocalSession> = {}): LocalSession {
	return {
		sessionId: "abc-123",
		projectPath: "/Users/alice/my-project",
		projectName: "my-project",
		encodedProjectPath: "-Users-alice-my-project",
		jsonlPath: "/tmp/abc-123.jsonl",
		sizeBytes: 5_300_000,
		messageCount: 3490,
		firstMessageAt: "2026-03-25T07:00:00.000Z",
		lastMessageAt: "2026-03-27T14:30:00.000Z",
		...overrides,
	};
}

const noopLog = () => {};

describe("pickSession", () => {
	it("returns null when no sessions", async () => {
		const result = await pickSession([], async () => "", noopLog);
		expect(result).toBeNull();
	});

	it("returns the only session without prompting", async () => {
		let prompted = false;
		const result = await pickSession(
			[makeSession()],
			async () => {
				prompted = true;
				return "";
			},
			noopLog,
		);
		expect(result).not.toBeNull();
		expect(result?.sessionId).toBe("abc-123");
		expect(prompted).toBe(false);
	});

	it("returns the selected session when user picks a number", async () => {
		const sessions = [
			makeSession({ sessionId: "newest", lastMessageAt: "2026-03-27T12:00:00.000Z" }),
			makeSession({ sessionId: "oldest", lastMessageAt: "2026-03-20T08:00:00.000Z" }),
		];

		const result = await pickSession(sessions, async () => "2", noopLog);
		expect(result?.sessionId).toBe("oldest");
	});

	it("defaults to first session (most recent) on empty input", async () => {
		const sessions = [makeSession({ sessionId: "newest" }), makeSession({ sessionId: "oldest" })];

		const result = await pickSession(sessions, async () => "", noopLog);
		expect(result?.sessionId).toBe("newest");
	});

	it("defaults to first session on Enter (just pressing return)", async () => {
		const sessions = [makeSession({ sessionId: "first" }), makeSession({ sessionId: "second" })];

		const result = await pickSession(sessions, async () => "1", noopLog);
		expect(result?.sessionId).toBe("first");
	});

	it("returns null on q input", async () => {
		const sessions = [makeSession(), makeSession({ sessionId: "other" })];
		const result = await pickSession(sessions, async () => "q", noopLog);
		expect(result).toBeNull();
	});

	it("returns projectPath from the selected session", async () => {
		const session = makeSession({ projectPath: "/Users/bob/work" });
		const result = await pickSession([session], async () => "", noopLog);
		expect(result?.projectPath).toBe("/Users/bob/work");
	});
});

describe("formatSessionRow", () => {
	it("includes index, truncated session ID, message count, and size", () => {
		const session = makeSession({
			sessionId: "c3a05473-9f12-4a2b-ae27-9478ab66d216",
			messageCount: 3490,
			sizeBytes: 5_300_000,
		});
		const row = formatSessionRow(1, session);
		expect(row).toContain("1");
		expect(row).toContain("c3a05473");
		expect(row).toContain("3490");
		expect(row).toContain("5.1 MB");
	});

	it("includes relative time for lastMessageAt", () => {
		const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
		const session = makeSession({ lastMessageAt: recent });
		const row = formatSessionRow(1, session);
		expect(row).toContain("ago");
	});

	it("shows 'unknown' when lastMessageAt is null", () => {
		const session = makeSession({ lastMessageAt: null });
		const row = formatSessionRow(1, session);
		expect(row).toContain("unknown");
	});
});
