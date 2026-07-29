import type { LocalSession } from "../core/local";

/** Where a session's display title came from, best first. */
export type TitleSource = "custom" | "agent" | "ai" | "prompt" | "id";

/** Satellite state that lives outside the transcript but belongs to the session. */
export interface SatelliteState {
	hasSubagents: boolean;
	hasFileHistory: boolean;
	hasSessionEnv: boolean;
	/** The session's project dir has a memory/ dir. Shared — never delete it. */
	hasMemory: boolean;
}

/**
 * A local session enriched for panel display. Superset of `LocalSession`, and
 * deliberately agent-neutral: every field is derivable for claude-code, codex and
 * antigravity, because all three adapters return the same `LocalSession` shape.
 */
export interface PanelSession extends LocalSession {
	agentId: string;
	title: string;
	titleSource: TitleSource;
	/** projectPath no longer exists on disk — a relink candidate. */
	stranded: boolean;
	satellites: SatelliteState;
	/** Ready-to-run resume command for this session's agent. */
	resumeCommand: string;
}

export interface ScanPanelOptions {
	/** Agent id, or "all" to merge every supported agent. Defaults to "all". */
	agentId?: string;
	claudeDir?: string;
	codexDir?: string;
	geminiDir?: string;
	/** Skip the satellite existence checks (pure listing). Defaults to false. */
	skipSatellites?: boolean;
	/**
	 * Path to the message-count cache. Counting lines is the only part of a scan
	 * that must read a whole transcript, so it is cached by (path, size, mtime).
	 * Pass null to disable caching (always count).
	 */
	indexFile?: string | null;
}
