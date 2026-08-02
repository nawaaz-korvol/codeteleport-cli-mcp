/**
 * Local session panel — barrel.
 *
 * Everything under `panel/` is part of the network-free local layer: no account, no
 * login, no API client. `src/__tests__/boundary.test.ts` enforces that.
 */

export type {
	DeleteOptions,
	DeleteResult,
	MoveOptions,
	MoveResult,
	PanelDirs,
	PanelSession,
	RestoreOptions,
	RestoreResult,
	SatelliteState,
	ScanPanelOptions,
	TitleSource,
} from "./types";
export { countMessages, scanHead, scanTail } from "./jsonl-scan";
export { deletePanelSession, movePanelSession, restorePanelSession } from "./operations";
export { assertValidTargetDir } from "./paths-guard";
export { scanPanelSessions } from "./scan";
