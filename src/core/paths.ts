/**
 * Encode a filesystem path the way Claude Code does for project directories.
 * e.g. "/Users/alice/myproject" → "-Users-alice-myproject"
 */
export function encodePath(_fsPath: string): string {
	throw new Error("not implemented");
}

/**
 * Rewrite all occurrences of sourceUserDir to targetUserDir in a string.
 * This is the core path-rewriting logic that makes sessions portable.
 */
export function rewritePaths(_content: string, _sourceUserDir: string, _targetUserDir: string): string {
	throw new Error("not implemented");
}
