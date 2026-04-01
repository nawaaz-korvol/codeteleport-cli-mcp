import { describe, expect, it, vi } from "vitest";

// Mock config
vi.mock("../cli/config", () => ({
	readConfig: () => ({
		token: "ctk_live_test",
		apiUrl: "https://api.test.com/v1",
		deviceName: "test-machine",
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
	};
}

describe("versions command", () => {
	it("formats version history with latest marker", async () => {
		// The versions command imports and calls getVersions
		// We test the formatting logic by importing the command module
		const { formatVersionRow, formatVersionHeader } = await import("../cli/commands/versions");

		const header = formatVersionHeader("sess-001", 3, 2);
		expect(header).toContain("sess-001");
		expect(header).toContain("free");

		const row = formatVersionRow(3, 5000000, "2026-04-01T10:00:00Z", true);
		expect(row).toContain("v3");
		expect(row).toContain("4.8 MB");
		expect(row).toContain("(latest)");

		const oldRow = formatVersionRow(2, 4000000, "2026-03-31T08:00:00Z", false);
		expect(oldRow).toContain("v2");
		expect(oldRow).not.toContain("(latest)");
	});

	it("pro plan shows correct label", async () => {
		const { formatVersionHeader } = await import("../cli/commands/versions");
		const header = formatVersionHeader("sess-001", 5, 10);
		expect(header).toContain("pro");
	});
});
