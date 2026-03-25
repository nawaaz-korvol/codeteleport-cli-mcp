import type { ScannedAssets, SessionMetadata } from "../shared/types";

/**
 * Scan a session JSONL file for referenced assets and extract metadata.
 * Processes lines with type: user, assistant, progress, system.
 * Extracts paste-cache refs, shell-snapshot refs, message counts,
 * file paths, timestamps, and model info.
 */
export async function scanSession(_jsonlPath: string): Promise<{ assets: ScannedAssets; metadata: SessionMetadata }> {
	throw new Error("not implemented");
}
