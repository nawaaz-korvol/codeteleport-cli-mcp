import type { BundleOptions, BundleResult } from "../shared/types";

/**
 * Bundle a Claude Code session into a portable .tar.gz archive.
 * Includes session JSONL, subagents, file-history, session-env,
 * paste-cache, and shell-snapshots.
 */
export async function bundleSession(_options: BundleOptions): Promise<BundleResult> {
	throw new Error("not implemented");
}
