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
	_sessions: LocalSession[],
	_promptFn: (question: string) => Promise<string>,
	_logFn?: (...args: unknown[]) => void,
): Promise<PickedSession | null> {
	throw new Error("Not implemented");
}

/**
 * Format a session for display in the picker list.
 */
export function formatSessionRow(_index: number, _session: LocalSession): string {
	throw new Error("Not implemented");
}
