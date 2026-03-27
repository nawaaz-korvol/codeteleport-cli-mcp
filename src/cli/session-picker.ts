import type { LocalSession } from "../core/local";

export interface PickedSession {
	sessionId: string;
	projectPath: string;
}

/**
 * Given a list of local sessions for the current project, resolve which one to push.
 * - 0 sessions: returns null
 * - 1 session: returns it directly (no prompt)
 * - multiple: displays list and prompts the user to pick one (default: 1, most recent)
 */
export async function pickSession(
	sessions: LocalSession[],
	promptFn: (question: string) => Promise<string>,
	logFn: (...args: unknown[]) => void = console.log,
): Promise<PickedSession | null> {
	if (sessions.length === 0) return null;

	if (sessions.length === 1) {
		return { sessionId: sessions[0].sessionId, projectPath: sessions[0].projectPath };
	}

	// Display session list
	logFn(`\nSessions for ${sessions[0].projectName} (${sessions.length} found):\n`);
	for (let i = 0; i < sessions.length; i++) {
		logFn(formatSessionRow(i + 1, sessions[i]));
	}
	logFn("");

	const choice = await promptFn("Select session [1]: ");

	if (choice.toLowerCase() === "q") return null;

	const index = choice === "" ? 0 : Number.parseInt(choice, 10) - 1;

	if (Number.isNaN(index) || index < 0 || index >= sessions.length) {
		return { sessionId: sessions[0].sessionId, projectPath: sessions[0].projectPath };
	}

	return { sessionId: sessions[index].sessionId, projectPath: sessions[index].projectPath };
}

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return "yesterday";
	return `${days} days ago`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a session for display in the picker list.
 */
export function formatSessionRow(index: number, session: LocalSession): string {
	const id = session.sessionId.slice(0, 8);
	const msgs = String(session.messageCount).padStart(6);
	const size = formatSize(session.sizeBytes).padStart(8);
	const time = session.lastMessageAt ? relativeTime(session.lastMessageAt).padStart(15) : "        unknown";

	return `  ${index})  ${id}  ${msgs} msgs  ${time}  ${size}`;
}
