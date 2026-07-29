import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Architectural guard for the local session panel.
 *
 * The panel is local-only: it MUST work with no account, no login and no network.
 * That constraint is only real if it is enforced — otherwise a future import of the
 * API client silently chains a free local tool to the paid cloud CLI.
 *
 * The boundary is a *directory* boundary, not a package boundary. `packages/mcp` is
 * published to npm as `codeteleport` and pushed verbatim to a standalone public repo
 * (`git subtree push --prefix=packages/mcp`), so it must stay self-contained — a
 * sibling workspace package could not be resolved by either consumer. The layering is
 * therefore:
 *
 *   src/core, src/shared, src/panel  →  local, network-free, auth-free
 *   src/cli, src/mcp, src/client     →  may talk to the cloud API
 *
 * The inner layers must never import the outer ones.
 */

const SRC = path.join(__dirname, "..");

/** Directories that make up the network-free local layer. */
const LOCAL_LAYER = ["core", "shared", "panel"];

/** Every .ts file under the given src-relative dirs, excluding tests. */
function sourceFiles(dirs: string[] = LOCAL_LAYER): string[] {
	const acc: string[] = [];
	const walk = (dir: string) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__" || entry.name === "node_modules") continue;
				walk(full);
			} else if (entry.name.endsWith(".ts")) {
				acc.push(full);
			}
		}
	};
	for (const d of dirs) walk(path.join(SRC, d));
	return acc;
}

function importSpecifiers(content: string): string[] {
	const specs: string[] = [];
	const patterns = [
		/import\s+(?:type\s+)?[^"';]*?from\s*["']([^"']+)["']/g,
		/import\s*["']([^"']+)["']/g,
		/require\s*\(\s*["']([^"']+)["']\s*\)/g,
		/import\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
		while ((m = re.exec(content)) !== null) specs.push(m[1]);
	}
	return specs;
}

/** Modules that would drag networking or CLI/auth concerns into the local layer. */
const FORBIDDEN_MODULES = [
	"node:http",
	"node:https",
	"node:http2",
	"node:tls",
	"node:dgram",
	"undici",
	"node-fetch",
	"axios",
	"got",
	"open",
	"@modelcontextprotocol/sdk",
	"commander",
];

/** Source text that implies a network call or a credential read. */
const FORBIDDEN_PATTERNS: { pattern: RegExp; why: string }[] = [
	{ pattern: /\bfetch\s*\(/, why: "network call" },
	{ pattern: /\bXMLHttpRequest\b/, why: "network call" },
	{ pattern: /CodeTeleportClient/, why: "cloud API client" },
	{ pattern: /\breadConfig\s*\(/, why: "reads the auth config/token" },
	{ pattern: /ctk_live_/, why: "API token handling" },
];

describe("local layer boundary", () => {
	it("guards a non-empty set of files", () => {
		// Without this, deleting the local layer would make every other test pass.
		expect(sourceFiles(["core", "shared"]).length).toBeGreaterThan(10);
	});

	it("imports no networking or auth modules", () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			const rel = path.relative(SRC, file);
			for (const spec of importSpecifiers(fs.readFileSync(file, "utf-8"))) {
				if (FORBIDDEN_MODULES.includes(spec)) violations.push(`${rel} imports "${spec}"`);
			}
		}
		expect(violations, `local layer must stay network-free:\n${violations.join("\n")}`).toEqual([]);
	});

	it("contains no network calls or credential reads", () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			const rel = path.relative(SRC, file);
			const content = fs.readFileSync(file, "utf-8");
			for (const { pattern, why } of FORBIDDEN_PATTERNS) {
				if (pattern.test(content)) violations.push(`${rel}: ${why} (${pattern})`);
			}
		}
		expect(violations, `local layer must stay auth-free:\n${violations.join("\n")}`).toEqual([]);
	});

	it("never imports the cloud-facing layers", () => {
		const violations: string[] = [];
		for (const file of sourceFiles()) {
			const rel = path.relative(SRC, file);
			for (const spec of importSpecifiers(fs.readFileSync(file, "utf-8"))) {
				if (/(^|\/)(cli|client|mcp)\//.test(spec)) violations.push(`${rel} imports "${spec}"`);
			}
		}
		expect(violations, `local layer must not depend on cli/client/mcp:\n${violations.join("\n")}`).toEqual([]);
	});

	it("keeps packages/mcp self-contained (publishable + subtree-syncable)", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(["core", "shared", "panel", "cli", "mcp", "client"])) {
			const rel = path.relative(SRC, file);
			for (const spec of importSpecifiers(fs.readFileSync(file, "utf-8"))) {
				// A workspace sibling cannot be resolved from the published npm package
				// (files: ["dist"]) nor from the standalone public repo.
				if (spec.startsWith("@codeteleport/") || spec.includes("packages/")) {
					violations.push(`${rel} imports "${spec}"`);
				}
			}
		}
		expect(violations, `packages/mcp must not depend on workspace siblings:\n${violations.join("\n")}`).toEqual([]);
	});

	it("exposes the panel module surface", () => {
		const expected = ["index.ts", "types.ts"];
		const missing = expected.filter((f) => !fs.existsSync(path.join(SRC, "panel", f)));
		expect(missing, `missing panel modules: ${missing.join(", ")}`).toEqual([]);
	});
});
