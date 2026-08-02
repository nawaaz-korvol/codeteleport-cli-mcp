import type { PanelSession } from "../panel";
import { renderShell, renderUnauthorized } from "./html";

/**
 * Request routing for the local panel web view.
 *
 * A pure function over a plain request/response shape, so every security check is
 * testable without binding a socket.
 *
 * `src/web` sits on the CLOUD side of the layer boundary purely because it needs
 * `node:http`; it consumes the local layer and adds no network egress of its own.
 */

export interface PanelRequest {
	method: string;
	url: string;
	headers: Record<string, string | undefined>;
}

export interface PanelResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

export interface TranscriptMessage {
	role: "user" | "assistant";
	text: string;
}

export interface SearchHit {
	sessionId: string;
	title: string;
	projectName: string;
	snippet: string;
}

export interface RouteDeps {
	/** Per-run secret. Every request must present it. */
	token: string;
	port: number;
	listSessions(): PanelSession[];
	readSession(id: string): { session: PanelSession; messages: TranscriptMessage[] } | null;
	search(query: string): SearchHit[];
}

/**
 * Header the page authenticates with.
 *
 * NOT a cookie. Cookies are scoped by host and ignore port (RFC 6265 §8.5), and the
 * `__Host-` prefix does not change that — it forbids `Domain`, forces `Path=/` and
 * requires `Secure`, but adds no port scoping. A cookie set by the panel on
 * 127.0.0.1:47801 is therefore sent to *every* HTTP server on 127.0.0.1 the browser
 * touches: a local dev server, a docs preview, anything. Verified in Chrome — a cookie
 * set on one loopback port arrived at another, and the receiving server could replay it
 * against the panel and read session data.
 *
 * A custom header has none of that ambient reach. It is never sent automatically, it
 * cannot be attached cross-origin without a CORS preflight (which this server refuses),
 * and it lives only in the page that was already given the token.
 */
export const PANEL_HEADER = "x-panel-token";

/**
 * Same-origin check, belt-and-braces with the Host check.
 *
 * A page on evil.com sends `Origin: https://evil.com` even when the request lands on
 * loopback. Absent Origin (curl, direct navigation) is allowed — browsers always send it
 * for cross-origin requests, which is the case being blocked.
 */
function originAllowed(origin: string | undefined, port: number): boolean {
	if (!origin) return true;
	return (
		origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`
	);
}

/** Headers sent on every response. Deliberately restrictive, and never CORS-permissive. */
const BASE_HEADERS: Record<string, string> = {
	// The page is entirely self-contained, so the strictest useful CSP applies: no
	// external anything, and inline script/style only (which is all the shell uses).
	"Content-Security-Policy":
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Cache-Control": "no-store",
};

const json = (status: number, value: unknown): PanelResponse => ({
	status,
	headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
	body: JSON.stringify(value),
});

const html = (status: number, body: string): PanelResponse => ({
	status,
	headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" },
	body,
});

/**
 * Only loopback hosts are accepted.
 *
 * This is the DNS-rebinding defence. An attacker can point `evil.com` at 127.0.0.1, at
 * which point the browser happily sends the request to this server — the connection
 * genuinely is local, so the socket tells us nothing. The Host header is the one place
 * the attacker's name survives, so it has to be checked.
 */
/** Pathname of a parsed URL, for checks that run before routing. */
function pathnameOf(url: URL): string {
	return url.pathname;
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) return false;
	// Strip the port, handling bracketed IPv6 ("[::1]:7777").
	const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
	return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1";
}

/** Constant-time-ish comparison; token lengths are fixed per run so length leak is moot. */
function tokenMatches(provided: string | null, expected: string): boolean {
	if (!provided || provided.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

export function handlePanelRequest(req: PanelRequest, deps: RouteDeps): PanelResponse {
	// 1. Host first: a rebound request is hostile regardless of what else it carries.
	if (!isLoopbackHost(req.headers.host)) {
		return json(403, { error: "forbidden" });
	}

	// 2. Read-only surface.
	if (req.method !== "GET") {
		return json(405, { error: "method_not_allowed" });
	}

	if (!originAllowed(req.headers.origin, deps.port)) {
		return json(403, { error: "forbidden" });
	}

	let url: URL;
	try {
		url = new URL(req.url, `http://127.0.0.1:${deps.port}`);
	} catch {
		return json(400, { error: "bad_request" });
	}

	// 3. Authentication, before any routing, so an unauthorised caller cannot even probe
	// which paths exist and the response body carries nothing but an error code.
	//
	// Two accepted forms: the query token (the entry ticket, and what scripted access
	// uses) and the header the page sends. Deliberately no cookie — see PANEL_HEADER.
	const queryToken = url.searchParams.get("t");
	const authedByQuery = tokenMatches(queryToken, deps.token);
	const authed = authedByQuery || tokenMatches(req.headers[PANEL_HEADER] ?? null, deps.token);
	if (!authed) {
		// The shell is what a human lands on, so answer with something readable rather
		// than a bare JSON blob. `replaceState` erases the tokenised URL from history, so
		// after a restart (each run mints a fresh token) the bookmarked URL is the bare
		// one and this is exactly what they hit.
		if (pathnameOf(url) === "/") return html(401, renderUnauthorized());
		return json(401, { error: "unauthorized" });
	}

	// `new URL` already normalises `..`, and nothing here touches the filesystem by
	// path — session lookup is by id against the scanned list — so traversal has no
	// target. It simply falls through to 404.
	const pathname = url.pathname;

	if (pathname === "/") {
		return html(200, renderShell({ token: deps.token }));
	}

	if (pathname === "/api/sessions") {
		return json(200, deps.listSessions());
	}

	const detail = pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (detail) {
		// decodeURIComponent throws URIError on a malformed escape such as "%ZZ". Left
		// unhandled that propagated out of the request handler and killed the process, so
		// one bad URL took the whole panel down and every later request got ECONNREFUSED.
		let id: string;
		try {
			id = decodeURIComponent(detail[1]);
		} catch {
			return json(400, { error: "bad_request" });
		}
		const found = deps.readSession(id);
		return found ? json(200, found) : json(404, { error: "not_found" });
	}

	if (pathname === "/api/search") {
		return json(200, deps.search(url.searchParams.get("q") ?? ""));
	}

	return json(404, { error: "not_found" });
}
