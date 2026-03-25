import type { UnbundleOptions, UnbundleResult } from "../shared/types";

/**
 * Extract a session bundle onto the target machine.
 * Reads meta.json, rewrites paths from source to target,
 * and installs all assets into ~/.claude/.
 */
export async function unbundleSession(_options: UnbundleOptions): Promise<UnbundleResult> {
	throw new Error("not implemented");
}
