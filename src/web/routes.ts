import type { PanelSession } from "../panel";
import { renderShell } from "./html";

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

	let url: URL;
	try {
		url = new URL(req.url, `http://127.0.0.1:${deps.port}`);
	} catch {
		return json(400, { error: "bad_request" });
	}

	// 3. Token. Checked before any routing, so an unauthorised caller cannot even probe
	// which paths exist, and the response body carries nothing but an error code.
	if (!tokenMatches(url.searchParams.get("t"), deps.token)) {
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
		const found = deps.readSession(decodeURIComponent(detail[1]));
		return found ? json(200, found) : json(404, { error: "not_found" });
	}

	if (pathname === "/api/search") {
		return json(200, deps.search(url.searchParams.get("q") ?? ""));
	}

	return json(404, { error: "not_found" });
}
