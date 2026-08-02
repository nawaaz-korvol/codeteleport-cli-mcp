import { describe, expect, it } from "vitest";
import type { PanelSession } from "../panel";
import { type PanelRequest, type RouteDeps, handlePanelRequest } from "../web/routes";

/**
 * Hardening for the panel web view (see docs/PRODUCT_DIRECTION.md §3).
 *
 * The token reaches the page through the URL once, then lives only in memory and travels
 * as a request header. URLs leak into shell history, browser history, `Referer` and
 * screenshots — tokenised panel URLs have already been pasted into chat transcripts
 * during development.
 *
 * A cookie was tried first and rejected. Cookies are scoped by host and ignore port
 * (RFC 6265 §8.5), and `__Host-` adds no port scoping — verified in Chrome, a cookie set
 * by one loopback port was sent to another, which could then replay it and read session
 * data. That would have handed the token to every local dev server the browser touches,
 * making the "stop the token leaking" change a net regression.
 */

const TOKEN = "s3cr3t-token-value";
const HEADER = "x-panel-token";

const deps: RouteDeps = {
	token: TOKEN,
	port: 7777,
	listSessions: () => [] as PanelSession[],
	readSession: () => null,
	search: () => [],
};

const req = (over: Partial<PanelRequest> = {}): PanelRequest => ({
	method: "GET",
	url: "/api/sessions",
	headers: { host: "127.0.0.1:7777" },
	...over,
});

describe("web hardening", () => {
	describe("header-based authentication", () => {
		it("never sets a cookie", () => {
			// A cookie would be sent to every other HTTP server on 127.0.0.1.
			for (const url of [`/?t=${TOKEN}`, `/api/sessions?t=${TOKEN}`, "/?t=wrong"]) {
				const res = handlePanelRequest(req({ url }), deps);
				const keys = Object.keys(res.headers).map((k) => k.toLowerCase());
				expect(keys, url).not.toContain("set-cookie");
			}
		});

		it("ignores a cookie even when it carries the right value", () => {
			const res = handlePanelRequest(
				req({ headers: { host: "127.0.0.1:7777", cookie: `__Host-ct-panel=${TOKEN}` } }),
				deps,
			);
			expect(res.status).toBe(401);
		});

		it("authenticates an API request by header, with no token in the URL", () => {
			const res = handlePanelRequest(
				req({ url: "/api/sessions", headers: { host: "127.0.0.1:7777", [HEADER]: TOKEN } }),
				deps,
			);
			expect(res.status).toBe(200);
		});

		it("rejects a header carrying the wrong value", () => {
			const res = handlePanelRequest(req({ headers: { host: "127.0.0.1:7777", [HEADER]: "nope" } }), deps);
			expect(res.status).toBe(401);
		});

		it("still accepts a query token, so scripted access keeps working", () => {
			expect(handlePanelRequest(req({ url: `/api/sessions?t=${TOKEN}` }), deps).status).toBe(200);
		});

		it("gives the page the token and tells it to strip the URL", () => {
			const res = handlePanelRequest(req({ url: `/?t=${TOKEN}` }), deps);
			expect(res.body).toContain("replaceState");
			expect(res.body).toContain("X-Panel-Token");
			expect(res.body).toContain(TOKEN);
		});

		it("answers an expired shell link with a readable page, not a JSON blob", () => {
			const res = handlePanelRequest(req({ url: "/" }), deps);
			expect(res.status).toBe(401);
			expect(res.headers["Content-Type"]).toContain("text/html");
			expect(res.body).toContain("codeteleport web");
			expect(res.body).not.toContain(TOKEN);
		});
	});

	describe("Origin", () => {
		it("refuses a cross-origin request even with a valid cookie", () => {
			// Belt-and-braces with the Host check: a page on evil.com sends its own Origin.
			const res = handlePanelRequest(
				req({ headers: { host: "127.0.0.1:7777", origin: "https://evil.com", [HEADER]: TOKEN } }),
				deps,
			);
			expect(res.status).toBe(403);
		});

		it("allows a same-origin request", () => {
			const res = handlePanelRequest(
				req({ headers: { host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", [HEADER]: TOKEN } }),
				deps,
			);
			expect(res.status).toBe(200);
		});

		it("allows a request with no Origin at all (curl, direct navigation)", () => {
			expect(handlePanelRequest(req({ url: `/api/sessions?t=${TOKEN}` }), deps).status).toBe(200);
		});
	});
});
