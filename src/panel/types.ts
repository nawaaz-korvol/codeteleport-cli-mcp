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

/** Directory overrides shared by every panel operation (tests, non-default homes). */
export interface PanelDirs {
	claudeDir?: string;
	codexDir?: string;
	geminiDir?: string;
	/** Overrides ~/.codeteleport/panel (trash + caches). */
	panelDir?: string;
	/** Overrides os.homedir() when resolving/rewriting paths. Tests only. */
	userDir?: string;
}

export interface MoveOptions extends PanelDirs {
	sessionId: string;
	agentId?: string;
	/** Absolute path to anchor the session at. */
	targetDir: string;
	/** Report the plan without touching anything. */
	dryRun?: boolean;
	/** Leave the source in place — this is what `copy` uses. */
	keepSource?: boolean;
	/**
	 * Invoked after the destination is verified and immediately before the source is
	 * removed. Exists so the live-session guard (§8: re-stat before deleting) can be
	 * exercised deterministically — a test mutates the transcript here to simulate an
	 * agent appending mid-move. Not part of the CLI/MCP surface.
	 */
	onBeforeSourceDelete?: () => void;
}

export interface MoveResult {
	/** Session id at the destination. */
	sessionId: string;
	sourceSessionId: string;
	fromPath: string;
	toPath: string;
	movedBytes: number;
	/** Satellite kinds that travelled, e.g. ["subagents", "file-history"]. */
	satellitesMoved: string[];
	resumeCommand: string;
	dryRun: boolean;
	/** Set when the source was deliberately kept (copy) or the move was a no-op. */
	sourceKept: boolean;
}

export interface DeleteOptions extends PanelDirs {
	sessionId: string;
	agentId?: string;
	dryRun?: boolean;
	/** Bundle the session into the trash first. Defaults to true. */
	backup?: boolean;
}

export interface DeleteResult {
	sessionId: string;
	/** Paths actually removed (or that would be, when dryRun). */
	removedPaths: string[];
	freedBytes: number;
	/** Trash bundle written before deletion, unless backup was disabled. */
	backupPath?: string;
	dryRun: boolean;
}

export interface RestoreOptions extends PanelDirs {
	sessionId: string;
	/** Explicit trash bundle. Defaults to the newest backup for this session. */
	backupPath?: string;
	dryRun?: boolean;
}

export interface RestoreResult {
	sessionId: string;
	restoredTo: string;
	backupPath: string;
	resumeCommand: string;
	dryRun: boolean;
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
