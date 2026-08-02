import { describe, expect, it } from "vitest";
import type { PanelSession } from "../panel";
import { escapeHtml, renderShell } from "../web/html";
import { type PanelRequest, type RouteDeps, handlePanelRequest } from "../web/routes";

/**
 * Contract for the panel web view.
 *
 * This server hands out the user's entire chat history over a loopback socket, so the
 * security properties are the contract, not a footnote:
 *
 *  - **Any web page the user visits can reach 127.0.0.1.** A page on evil.com can fire
 *    requests at every local port; without a secret it would simply read the whole
 *    session list. Hence a per-run token on every request.
 *  - **DNS rebinding** turns an attacker-controlled hostname into 127.0.0.1, so the
 *    request arrives looking local. The Host header is the only thing that still names
 *    the attacker, so it is validated.
 *  - **Transcripts are arbitrary text** — code, markup, prompt-injection attempts. Any
 *    of it rendered unescaped is stored XSS in the user's own viewer, against a page
 *    that holds the token.
 */

function session(over: Partial<PanelSession> = {}): PanelSession {
	return {
		sessionId: "11111111-2222-4333-8444-555555555555",
		projectPath: "/Users/alice/projects/alpha",
		projectName: "alpha",
		encodedProjectPath: "-Users-alice-projects-alpha",
		jsonlPath: "/Users/alice/.claude/projects/-Users-alice-projects-alpha/11111111.jsonl",
		sizeBytes: 2048,
		messageCount: 12,
		firstMessageAt: "2026-05-01T10:00:00.000Z",
		lastMessageAt: "2026-05-01T12:00:00.000Z",
		agentId: "claude-code",
		title: "Alpha work",
		titleSource: "ai",
		stranded: false,
		satellites: { hasSubagents: false, hasFileHistory: false, hasSessionEnv: false, hasMemory: false },
		resumeCommand: "claude --resume 11111111-2222-4333-8444-555555555555",
		fullResumeCommand: "cd /Users/alice/projects/alpha && claude --resume 11111111-2222-4333-8444-555555555555",
		...over,
	};
}

const TOKEN = "s3cr3t-token";

function deps(over: Partial<RouteDeps> = {}): RouteDeps {
	return {
		token: TOKEN,
		port: 7777,
		listSessions: () => [session()],
		readSession: (id) =>
			id === session().sessionId ? { session: session(), messages: [{ role: "user", text: "hello" }] } : null,
		search: () => [{ sessionId: session().sessionId, title: "Alpha work", projectName: "alpha", snippet: "…hello…" }],
		...over,
	};
}

const req = (over: Partial<PanelRequest> = {}): PanelRequest => ({
	method: "GET",
	url: `/api/sessions?t=${TOKEN}`,
	headers: { host: "127.0.0.1:7777" },
	...over,
});

describe("panel web routes", () => {
	describe("authentication", () => {
		it("serves the API with a valid token", () => {
			expect(handlePanelRequest(req(), deps()).status).toBe(200);
		});

		it("refuses a request with no token", () => {
			expect(handlePanelRequest(req({ url: "/api/sessions" }), deps()).status).toBe(401);
		});

		it("refuses a request with the wrong token", () => {
			expect(handlePanelRequest(req({ url: "/api/sessions?t=guess" }), deps()).status).toBe(401);
		});

		it("does not leak session data in an unauthorised response", () => {
			const res = handlePanelRequest(req({ url: "/api/sessions" }), deps());
			expect(res.body).not.toContain("Alpha work");
			expect(res.body).not.toContain("/Users/alice");
		});

		it("protects the session detail and search endpoints too", () => {
			for (const url of [`/api/sessions/${session().sessionId}`, "/api/search?q=hello"]) {
				expect(handlePanelRequest(req({ url }), deps()).status, url).toBe(401);
			}
		});
	});

	describe("DNS rebinding", () => {
		it("accepts loopback hosts", () => {
			for (const host of ["127.0.0.1:7777", "localhost:7777", "[::1]:7777"]) {
				expect(handlePanelRequest(req({ headers: { host } }), deps()).status, host).toBe(200);
			}
		});

		it("refuses a foreign Host header even with a valid token", () => {
			for (const host of ["evil.com", "evil.com:7777", "attacker.local:7777"]) {
				expect(handlePanelRequest(req({ headers: { host } }), deps()).status, host).toBe(403);
			}
		});

		it("refuses a missing Host header", () => {
			expect(handlePanelRequest(req({ headers: {} }), deps()).status).toBe(403);
		});
	});

	describe("cross-origin", () => {
		it("never sends permissive CORS headers", () => {
			const res = handlePanelRequest(req(), deps());
			const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
			expect(keys).not.toContain("access-control-allow-origin");
		});

		it("rejects non-GET methods", () => {
			// The view is read-only; anything else is either a mistake or an attack.
			for (const method of ["POST", "PUT", "DELETE"]) {
				expect(handlePanelRequest(req({ method }), deps()).status, method).toBe(405);
			}
		});
	});

	describe("endpoints", () => {
		it("returns the session list as JSON", () => {
			const res = handlePanelRequest(req(), deps());
			expect(res.headers["Content-Type"]).toContain("application/json");
			const body = JSON.parse(res.body);
			expect(body[0].sessionId).toBe(session().sessionId);
			expect(body[0].resumeCommand).toContain("claude --resume");
		});

		it("returns a session's transcript", () => {
			const res = handlePanelRequest(req({ url: `/api/sessions/${session().sessionId}?t=${TOKEN}` }), deps());
			expect(res.status).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.session.title).toBe("Alpha work");
			expect(body.messages[0].text).toBe("hello");
		});

		it("404s an unknown session rather than erroring", () => {
			const res = handlePanelRequest(req({ url: `/api/sessions/does-not-exist?t=${TOKEN}` }), deps());
			expect(res.status).toBe(404);
		});

		it("returns search hits", () => {
			const res = handlePanelRequest(req({ url: `/api/search?q=hello&t=${TOKEN}` }), deps());
			expect(res.status).toBe(200);
			expect(JSON.parse(res.body)[0].snippet).toContain("hello");
		});

		it("serves the HTML shell at the root", () => {
			const res = handlePanelRequest(req({ url: `/?t=${TOKEN}` }), deps());
			expect(res.status).toBe(200);
			expect(res.headers["Content-Type"]).toContain("text/html");
			expect(res.body).toContain("<!doctype html>");
		});

		it("404s an unknown path", () => {
			expect(handlePanelRequest(req({ url: `/nope?t=${TOKEN}` }), deps()).status).toBe(404);
		});

		it("cannot be walked out of via path traversal", () => {
			// There is no file serving at all, so traversal must simply 404 — never read
			// anything off disk.
			for (const url of ["/../../etc/passwd", "/api/sessions/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
				const res = handlePanelRequest(req({ url: `${url}?t=${TOKEN}` }), deps());
				expect([404, 400], url).toContain(res.status);
				expect(res.body).not.toContain("root:");
			}
		});
	});

	describe("escaping", () => {
		it("escapes the HTML metacharacters", () => {
			expect(escapeHtml('<script>alert("x")</script>')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
			expect(escapeHtml("a & b")).toBe("a &amp; b");
			expect(escapeHtml("it's")).toBe("it&#39;s");
		});

		it("keeps the shell free of an unescaped token in a script-breakable position", () => {
			// The token lives in the page; it must not be injectable into markup.
			const html = renderShell({ token: '"></script><script>evil()</script>' });
			expect(html).not.toContain("<script>evil()</script>");
		});

		it("shows and copies the same resume command", () => {
			// The bug this guards: the page displayed the bare `claude --resume <id>` while
			// the Copy button wrote `cd <path> && …`. Both now read one precomputed field,
			// so what you see is what you get — and the bare command does not silently
			// appear anywhere, because it fails from the wrong directory.
			const html = renderShell({ token: TOKEN });
			expect(html).toContain("session.fullResumeCommand");
			expect(html).not.toMatch(/textContent\s*=\s*session\.resumeCommand/);
			expect(html).not.toMatch(/clipboard\.writeText\(\s*['"]cd['"]/);
		});

		it("renders a self-contained page with no external references", () => {
			const html = renderShell({ token: TOKEN });
			expect(html).toContain("<!doctype html>");
			expect(html).not.toMatch(/src=["']https?:/i);
			expect(html).not.toMatch(/href=["']https?:\/\/(?!127\.0\.0\.1|localhost)/i);
			expect(html).not.toMatch(/@import|cdn\./i);
		});
	});
});
