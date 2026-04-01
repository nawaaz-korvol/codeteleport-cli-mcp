import { Command } from "commander";
import { CodeTeleportClient } from "../../client/api";
import { readConfig } from "../config";

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatVersionHeader(sessionId: string, currentVersion: number, limit: number): string {
	return `\nSession ${sessionId.slice(0, 8)}\n  Version limit: ${limit} (${limit <= 2 ? "free" : "pro"} plan)`;
}

export function formatVersionRow(version: number, sizeBytes: number, createdAt: string, isLatest: boolean): string {
	const latest = isLatest ? "  (latest)" : "";
	return `  v${version}       ${formatSize(sizeBytes).padEnd(10)}${formatDate(createdAt)}${latest}`;
}

export const versionsCommand = new Command("versions")
	.description("Show version history for a session")
	.argument("<session-id>", "Session ID (full or prefix)")
	.action(async (sessionId: string) => {
		try {
			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			const result = await client.getVersions(sessionId);

			console.log(formatVersionHeader(sessionId, result.currentVersion, result.limit));
			console.log("\n  Version  Size      Pushed");
			for (const v of result.versions) {
				console.log(formatVersionRow(v.version, v.sizeBytes, v.createdAt, v.version === result.currentVersion));
			}

			if (result.versions.length > 1) {
				console.log("\n  Pull a specific version:");
				console.log(
					`    codeteleport pull --session-id ${sessionId} --version ${result.versions[result.versions.length - 1].version}`,
				);
			}
		} catch (err) {
			console.error(`Failed to fetch versions: ${(err as Error).message}`);
			process.exit(1);
		}
	});
