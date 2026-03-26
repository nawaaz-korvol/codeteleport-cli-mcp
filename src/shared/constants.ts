import os from "node:os";
import path from "node:path";

export const CLAUDE_DIR = path.join(os.homedir(), ".claude");
export const CONFIG_DIR = path.join(os.homedir(), ".codeteleport");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const API_URL = "https://api.codeteleport.com/v1";
