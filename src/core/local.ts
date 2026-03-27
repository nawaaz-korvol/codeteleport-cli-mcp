import type { CLAUDE_DIR } from "../shared/constants";

export interface LocalSession {
	sessionId: string;
	projectPath: string; // decoded, e.g. "/Users/openclaw/code-teleport"
	projectName: string; // last segment, e.g. "code-teleport"
	encodedProjectPath: string; // e.g. "-Users-openclaw-code-teleport"
	jsonlPath: string; // absolute path to .jsonl
	sizeBytes: number;
	messageCount: number;
	firstMessageAt: string | null; // ISO timestamp
	lastMessageAt: string | null; // ISO timestamp
}

/**
 * Scan ~/.claude/projects/ for all local Claude Code sessions.
 * Returns sessions sorted by lastMessageAt descending (most recent first).
 */
export function scanLocalSessions(_claudeDir?: string): LocalSession[] {
	throw new Error("Not implemented");
}

/**
 * Scan sessions for a specific project directory only.
 * Returns sessions sorted by lastMessageAt descending.
 */
export function scanProjectSessions(_projectPath: string, _claudeDir?: string): LocalSession[] {
	throw new Error("Not implemented");
}
