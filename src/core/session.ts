import type { SessionInfo } from "../shared/types";

/**
 * Walk up the process tree from startPid, looking for a PID
 * that has a session file at ~/.claude/sessions/<pid>.json.
 * Max 5 levels up (claude → bash → this script).
 */
export function detectCurrentSession(_startPid?: number): SessionInfo {
	throw new Error("not implemented");
}
