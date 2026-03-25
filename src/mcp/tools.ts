import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { readConfig } from "../cli/config";
import { CodeTeleportClient } from "../client/api";
import { bundleSession } from "../core/bundle";
import { detectCurrentSession } from "../core/session";
import { unbundleSession } from "../core/unbundle";

interface ToolArgs {
	label?: string;
	tags?: string[];
	sessionId?: string;
	machine?: string;
	tag?: string;
	limit?: number;
}

export function registerTools(server: McpServer) {
	server.registerTool(
		"teleport_push",
		{ description: "Push the current Claude Code session to CodeTeleport cloud" },
		async () => {
			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			const session = detectCurrentSession();
			const bundle = await bundleSession({ sessionId: session.sessionId, cwd: session.cwd });

			const { uploadUrl } = await client.initiateUpload({
				sessionId: bundle.sessionId,
				sourceMachine: config.deviceName,
				sourceCwd: bundle.sourceCwd,
				sourceUserDir: bundle.sourceUserDir,
				sizeBytes: bundle.sizeBytes,
				checksum: bundle.checksum,
				metadata: bundle.metadata,
			});

			await client.uploadBundle(uploadUrl, bundle.bundlePath);
			await client.confirmUpload(bundle.sessionId);

			try {
				fs.unlinkSync(bundle.bundlePath);
			} catch {}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							"Session teleported to CodeTeleport",
							`  id      : ${bundle.sessionId}`,
							`  size    : ${(bundle.sizeBytes / 1024).toFixed(0)} KB`,
							`  machine : ${config.deviceName}`,
							`  messages: ${bundle.metadata.messageCount || "unknown"}`,
						].join("\n"),
					},
				],
			};
		},
	);

	server.registerTool(
		"teleport_pull",
		{ description: "Pull a session from CodeTeleport cloud to this machine" },
		async (args: ToolArgs) => {
			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			if (args.sessionId) {
				const { downloadUrl } = await client.getDownloadUrl(args.sessionId);
				const tmpFile = path.join(os.tmpdir(), `codeteleport-${args.sessionId}.tar.gz`);

				try {
					await client.downloadBundle(downloadUrl, tmpFile);
					const result = await unbundleSession({ bundlePath: tmpFile });

					return {
						content: [
							{
								type: "text" as const,
								text: `Session installed\n  id: ${result.sessionId}\n  Resume with: ${result.resumeCommand}`,
							},
						],
					};
				} finally {
					try {
						fs.unlinkSync(tmpFile);
					} catch {}
				}
			}

			const { sessions } = await client.listSessions({ machine: args.machine, limit: args.limit || 10 });

			if (sessions.length === 0) {
				return { content: [{ type: "text" as const, text: "No sessions found." }] };
			}

			const lines = ["Available sessions:", ""];
			for (let i = 0; i < sessions.length; i++) {
				const s = sessions[i];
				const date = new Date(s.createdAt).toLocaleString();
				const machine = s.sourceMachine || "unknown";
				const msgs = s.metadata?.messageCount ? ` ${s.metadata.messageCount} msgs` : "";
				lines.push(`  ${i + 1}. ${s.id.slice(0, 8)}  ${machine}  ${s.sourceCwd}  ${date}${msgs}`);
			}
			lines.push("", "Use teleport_pull with sessionId to pull a specific session.");

			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	);

	server.registerTool(
		"teleport_list",
		{ description: "List all sessions stored in CodeTeleport cloud" },
		async (args: ToolArgs) => {
			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			const { sessions, total } = await client.listSessions({
				machine: args.machine,
				tag: args.tag,
				limit: args.limit || 20,
			});

			if (sessions.length === 0) {
				return { content: [{ type: "text" as const, text: "No sessions found." }] };
			}

			const lines = [`Sessions (${sessions.length} of ${total}):`, ""];
			for (const s of sessions) {
				const date = new Date(s.createdAt).toLocaleString();
				const machine = s.sourceMachine || "unknown";
				const label = s.label ? ` "${s.label}"` : "";
				const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
				const msgs = s.metadata?.messageCount ? `${s.metadata.messageCount} msgs` : "";
				const size = `${(s.sizeBytes / 1024).toFixed(0)} KB`;
				lines.push(`  ${s.id.slice(0, 8)}  ${machine}  ${s.sourceCwd}  ${date}  ${size}  ${msgs}${label}${tags}`);
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	);

	server.registerTool(
		"teleport_status",
		{ description: "Show CodeTeleport account status and sync info" },
		async () => {
			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			const { sessions, total } = await client.listSessions({ limit: 1 });

			const lines = [
				"CodeTeleport Status",
				`  device   : ${config.deviceName}`,
				`  api      : ${config.apiUrl}`,
				`  sessions : ${total} stored`,
			];

			if (sessions.length > 0) {
				const last = sessions[0];
				const date = new Date(last.createdAt).toLocaleString();
				lines.push(`  last push: ${date} (${last.sourceMachine || "unknown"})`);
			}

			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	);

	server.registerTool(
		"teleport_delete",
		{ description: "Delete a session from CodeTeleport cloud" },
		async (args: ToolArgs) => {
			if (!args.sessionId) {
				return { content: [{ type: "text" as const, text: "sessionId is required" }], isError: true };
			}

			const config = readConfig();
			const client = new CodeTeleportClient({ apiUrl: config.apiUrl, token: config.token });

			await client.deleteSession(args.sessionId);
			return { content: [{ type: "text" as const, text: `Session ${args.sessionId} deleted.` }] };
		},
	);
}
