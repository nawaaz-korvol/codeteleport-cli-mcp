import fs from "node:fs";
import path from "node:path";
import { countMessages } from "./jsonl-scan";

/**
 * Message counts are the only part of a scan that must read a whole transcript, so
 * they are cached on (path, size, mtime). Any edit to a transcript changes at least
 * one of size or mtime, so the entry self-invalidates — there is no staleness window
 * to reason about.
 */
type CacheShape = Record<string, { size: number; mtimeMs: number; count: number }>;

export class MessageCountCache {
	private data: CacheShape = {};
	private dirty = false;

	constructor(private readonly file: string | null) {
		if (!file) return;
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
			if (parsed && typeof parsed === "object") this.data = parsed as CacheShape;
		} catch {
			// Missing or corrupt cache is not an error — recompute and rewrite.
			this.data = {};
		}
	}

	get(file: string, size: number, mtimeMs: number): number {
		const hit = this.data[file];
		if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.count;
		const count = countMessages(file);
		this.data[file] = { size, mtimeMs, count };
		this.dirty = true;
		return count;
	}

	/** Persist if anything changed. Never throws — a failed cache write is not a failed scan. */
	flush(): void {
		if (!this.file || !this.dirty) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			fs.writeFileSync(this.file, JSON.stringify(this.data));
			this.dirty = false;
		} catch {
			// Best effort only.
		}
	}
}
