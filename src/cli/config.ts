import { CONFIG_DIR } from "../shared/constants";
import type { Config } from "../shared/types";

/**
 * Read config from ~/.codeteleport/config.json.
 * Throws if not logged in.
 */
export function readConfig(_configDir: string = CONFIG_DIR): Config {
	throw new Error("not implemented");
}

/**
 * Write config to ~/.codeteleport/config.json.
 * Creates the directory if needed. Sets chmod 600.
 */
export function writeConfig(_config: Config, _configDir: string = CONFIG_DIR): void {
	throw new Error("not implemented");
}

/**
 * Check if config file exists.
 */
export function configExists(_configDir: string = CONFIG_DIR): boolean {
	throw new Error("not implemented");
}
