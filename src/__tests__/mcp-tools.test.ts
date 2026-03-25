import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTools } from "../mcp/tools";

vi.mock("../cli/config", () => ({
	readConfig: () => ({
		token: "ctk_live_test",
		apiUrl: "https://api.test.com/v1",
		deviceName: "test-macbook",
	}),
}));

vi.mock("../core/session", () => ({
	detectCurrentSession: () => ({
		sessionId: "test-session-001",
		cwd: "/Users/testuser/project",
		pid: 12345,
	}),
}));

// bundlePath points to a real temp file created in beforeEach
const fakeBundlePath = "/tmp/codeteleport-test-bundle.tar.gz";

vi.mock("../core/bundle", () => ({
	bundleSession: async () => ({
		bundlePath: fakeBundlePath,
		sessionId: "test-session-001",
		sourceCwd: "/Users/testuser/project",
		sourceUserDir: "/Users/testuser",
		sizeBytes: 51200,
		checksum: "sha256:abc123",
		metadata: { messageCount: 10, projectName: "project" },
	}),
}));

vi.mock("../core/unbundle", () => ({
	unbundleSession: async () => ({
		sessionId: "test-session-001",
		installedTo: "/Users/bob/.claude/projects/-Users-bob-project",
		resumeCommand: "claude --resume test-session-001",
	}),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: "OK",
		json: async () => body,
		arrayBuffer: async () => new ArrayBuffer(0),
	};
}

type ToolCallback = (
	args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

describe("MCP Tools", () => {
	const tools = new Map<string, { description: string; callback: ToolCallback }>();

	beforeEach(() => {
		mockFetch.mockReset();
		tools.clear();

		// Create the fake bundle file
		fs.writeFileSync(fakeBundlePath, "fake bundle content");

		// Capture tool registrations from McpServer.registerTool(name, config, cb)
		const mockServer = {
			registerTool: (name: string, config: { description?: string }, callback: ToolCallback) => {
				tools.set(name, { description: config.description || "", callback });
			},
		};

		registerTools(mockServer as never);
	});

	afterEach(() => {
		try {
			fs.unlinkSync(fakeBundlePath);
		} catch {}
	});

	function callTool(name: string, args: Record<string, unknown> = {}) {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool ${name} not registered`);
		return tool.callback(args);
	}

	describe("tool registration", () => {
		it("registers all 5 tools", () => {
			expect(tools.size).toBe(5);
			expect(tools.has("teleport_push")).toBe(true);
			expect(tools.has("teleport_pull")).toBe(true);
			expect(tools.has("teleport_list")).toBe(true);
			expect(tools.has("teleport_status")).toBe(true);
			expect(tools.has("teleport_delete")).toBe(true);
		});

		it("each tool has a description", () => {
			for (const [, tool] of tools) {
				expect(tool.description.length).toBeGreaterThan(0);
			}
		});
	});

	describe("teleport_push", () => {
		it("bundles and uploads the current session", async () => {
			// 3 fetch calls: initiateUpload, uploadBundle (PUT), confirmUpload
			mockFetch
				.mockResolvedValueOnce(mockResponse(200, { uploadUrl: "https://r2.test/put", sessionRecordId: "s1" }))
				.mockResolvedValueOnce(mockResponse(200, {}))
				.mockResolvedValueOnce(mockResponse(200, { ok: true }));

			const result = await callTool("teleport_push", { label: "test push" });

			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toContain("teleported");
			expect(result.content[0].text).toContain("test-session-001");
			// 51200 / 1024 = 50
			expect(result.content[0].text).toContain("50 KB");
			expect(result.content[0].text).toContain("test-macbook");
		});
	});

	describe("teleport_pull", () => {
		it("downloads and installs a specific session by ID", async () => {
			mockFetch
				.mockResolvedValueOnce(
					mockResponse(200, {
						downloadUrl: "https://r2.test/get",
						session: {
							id: "test-session-001",
							sourceCwd: "/Users/alice/proj",
							sourceUserDir: "/Users/alice",
							sourceMachine: "alice-mac",
							metadata: null,
						},
					}),
				)
				.mockResolvedValueOnce(mockResponse(200, {}));

			const result = await callTool("teleport_pull", { sessionId: "test-session-001" });

			expect(result.isError).toBeUndefined();
			expect(result.content[0].text).toContain("installed");
			expect(result.content[0].text).toContain("claude --resume test-session-001");
		});

		it("lists available sessions when no sessionId given", async () => {
			mockFetch.mockResolvedValueOnce(
				mockResponse(200, {
					sessions: [
						{
							id: "sess-aaa",
							sourceMachine: "macbook",
							sourceCwd: "/Users/alice/proj",
							createdAt: "2026-03-25T07:00:00Z",
							metadata: { messageCount: 20 },
							tags: [],
						},
					],
					total: 1,
				}),
			);

			const result = await callTool("teleport_pull", {});

			expect(result.content[0].text).toContain("Available sessions");
			expect(result.content[0].text).toContain("sess-aaa");
			expect(result.content[0].text).toContain("macbook");
		});
	});

	describe("teleport_list", () => {
		it("returns formatted session list", async () => {
			mockFetch.mockResolvedValueOnce(
				mockResponse(200, {
					sessions: [
						{
							id: "sess-bbb",
							label: "my session",
							sourceMachine: "macbook",
							sourceCwd: "/Users/alice/proj",
							sizeBytes: 51200,
							createdAt: "2026-03-25T07:00:00Z",
							metadata: { messageCount: 20 },
							tags: ["work"],
						},
					],
					total: 1,
				}),
			);

			const result = await callTool("teleport_list", {});

			expect(result.content[0].text).toContain("Sessions (1 of 1)");
			expect(result.content[0].text).toContain("sess-bbb");
			expect(result.content[0].text).toContain("my session");
			expect(result.content[0].text).toContain("work");
		});

		it("returns empty message when no sessions", async () => {
			mockFetch.mockResolvedValueOnce(mockResponse(200, { sessions: [], total: 0 }));

			const result = await callTool("teleport_list", {});

			expect(result.content[0].text).toContain("No sessions found");
		});
	});

	describe("teleport_status", () => {
		it("returns account status", async () => {
			mockFetch.mockResolvedValueOnce(
				mockResponse(200, {
					sessions: [{ id: "sess-ccc", sourceMachine: "macbook", createdAt: "2026-03-25T07:00:00Z" }],
					total: 5,
				}),
			);

			const result = await callTool("teleport_status");

			expect(result.content[0].text).toContain("CodeTeleport Status");
			expect(result.content[0].text).toContain("test-macbook");
			expect(result.content[0].text).toContain("5 stored");
		});
	});

	describe("teleport_delete", () => {
		it("deletes a session", async () => {
			mockFetch.mockResolvedValueOnce(mockResponse(200, { ok: true }));

			const result = await callTool("teleport_delete", { sessionId: "sess-ddd" });

			expect(result.content[0].text).toContain("sess-ddd");
			expect(result.content[0].text).toContain("deleted");
		});
	});
});
