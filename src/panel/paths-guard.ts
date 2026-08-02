import os from "node:os";
import path from "node:path";
import { isSensitivePath, isUnder, safeRealpath } from "../core/paths";
import { ANTIGRAVITY_DIR, CLAUDE_DIR, CODEX_DIR, CONFIG_DIR } from "../shared/constants";
import type { PanelDirs } from "./types";

/**
 * Validate a directory a session may be anchored at.
 *
 * Two classes of target are rejected outright:
 *
 *  - **Sensitive dirs** (`~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`) — reused from the
 *    bundler's deny-list, so the panel can't be used to scatter files into them.
 *  - **Agent state dirs** (`~/.claude`, `~/.codex`, `~/.gemini/…`, and the CodeTeleport
 *    config dir) — anchoring a *project* inside an agent's own store means the next scan
 *    treats agent state as a project and the encoded-path scheme starts colliding with
 *    itself. Nothing good is downstream of that.
 *
 * Throws with a message naming the reason; callers surface it verbatim.
 */
export function assertValidTargetDir(targetDir: string, dirs: PanelDirs = {}): void {
	if (!targetDir || typeof targetDir !== "string") {
		throw new Error("Target directory is required.");
	}
	if (!path.isAbsolute(targetDir)) {
		throw new Error(`Target directory must be an absolute path: ${targetDir}`);
	}

	const normalized = path.normalize(targetDir);
	const real = safeRealpath(normalized);
	const homeDir = dirs.userDir ?? os.homedir();

	if (isSensitivePath(normalized, real, homeDir)) {
		throw new Error(`Refusing to use a sensitive directory as a target: ${targetDir}`);
	}

	const agentStateDirs = [
		dirs.claudeDir ?? CLAUDE_DIR,
		dirs.codexDir ?? CODEX_DIR,
		dirs.geminiDir ?? ANTIGRAVITY_DIR,
		dirs.panelDir,
		CONFIG_DIR,
		// Cover the default layout too when tests point the dirs elsewhere.
		path.join(homeDir, ".claude"),
		path.join(homeDir, ".codex"),
		path.join(homeDir, ".gemini"),
		path.join(homeDir, ".codeteleport"),
	].filter((d): d is string => typeof d === "string" && d.length > 0);

	for (const stateDir of agentStateDirs) {
		const realState = safeRealpath(stateDir);
		if (isUnder(normalized, stateDir) || isUnder(real, realState)) {
			throw new Error(`Refusing to anchor a session inside agent state: ${targetDir} is under ${stateDir}`);
		}
	}
}
