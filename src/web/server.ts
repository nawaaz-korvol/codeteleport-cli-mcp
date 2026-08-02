import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { readAntigravityTranscript, readClaudeTranscript, readCodexTranscript } from "../core/conversion/readers";
import { type PanelSession, scanPanelSessions } from "../panel";
import {
	type PanelRequest,
	type RouteDeps,
	type SearchHit,
	type TranscriptMessage,
	handlePanelRequest,
} from "./routes";
import { snippetFromRaw } from "./search";

/**
 * Loopback HTTP server for the panel web view.
 *
 * Binds 127.0.0.1 only — never 0.0.0.0 — so nothing outside this machine can reach it,
 * and mints a fresh token per run. Together with the Host check in `routes.ts` that
 * covers the three ways a local server leaks: other hosts, other local processes, and
 * pages the user happens to be browsing.
 */

export interface PanelServerOptions {
	port?: number;
	claudeDir?: string;
	codexDir?: string;
	geminiDir?: string;
	/** Cap on transcripts scanned by a content search. */
	searchLimit?: number;
}

export interface PanelServerHandle {
	url: string;
	port: number;
	token: string;
	close(): Promise<void>;
}

const READERS: Record<string, (jsonl: string) => { messages: { role: string; text: string }[] }> = {
	"claude-code": readClaudeTranscript,
	codex: readCodexTranscript,
	antigravity: readAntigravityTranscript,
};

/** Decode a transcript into displayable messages. Never throws — a bad file yields none. */
function readMessages(session: PanelSession): TranscriptMessage[] {
	const reader = READERS[session.agentId];
	if (!reader) return [];
	try {
		const raw = fs.readFileSync(session.jsonlPath, "utf-8");
		return reader(raw).messages.map((m) => ({
			role: m.role === "user" ? "user" : "assistant",
			text: m.text,
		}));
	} catch {
		return [];
	}
}

export function createPanelServer(options: PanelServerOptions = {}): Promise<PanelServerHandle> {
	const token = randomBytes(24).toString("base64url");
	const scanOptions = {
		claudeDir: options.claudeDir,
		codexDir: options.codexDir,
		geminiDir: options.geminiDir,
	};

	// Cached so a click on a session doesn't rescan every agent home. Cheap to refresh:
	// a warm scan is ~40ms for 141 sessions.
	let cache: PanelSession[] = [];
	let cachedAt = 0;
	const sessions = (): PanelSession[] => {
		if (Date.now() - cachedAt > 5000) {
			cache = scanPanelSessions(scanOptions);
			cachedAt = Date.now();
		}
		return cache;
	};

	const deps: Omit<RouteDeps, "port"> = {
		token,
		listSessions: sessions,
		readSession(id) {
			const session = sessions().find((s) => s.sessionId === id);
			return session ? { session, messages: readMessages(session) } : null;
		},
		search(query) {
			const q = query.trim();
			if (q.length < 2) return [];
			const hits: SearchHit[] = [];
			// Newest first, bounded: the corpus is ~479MB on a real machine, so an
			// unbounded scan would stall the request rather than answer it.
			for (const s of sessions().slice(0, options.searchLimit ?? 200)) {
				let raw: Buffer;
				try {
					raw = fs.readFileSync(s.jsonlPath);
				} catch {
					continue;
				}
				// One forward pass per file: find a match in the raw bytes and parse only
				// the JSONL line it sits on. Separate "does it match" and "get a snippet"
				// passes scanned the same 718 MB twice; folding them together halves it.
				const snippet = snippetFromRaw(raw, q);
				if (!snippet) continue;
				hits.push({ sessionId: s.sessionId, title: s.title, projectName: s.projectName, snippet });
			}
			return hits;
		},
	};

	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const panelReq: PanelRequest = {
				method: req.method ?? "GET",
				url: req.url ?? "/",
				headers: req.headers as Record<string, string | undefined>,
			};
			const port = (server.address() as { port: number } | null)?.port ?? 0;
			const out = handlePanelRequest(panelReq, { ...deps, port });
			res.writeHead(out.status, out.headers);
			res.end(out.body);
		});

		server.on("error", reject);
		// 127.0.0.1, never 0.0.0.0: the view must not be reachable off this machine.
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				url: `http://127.0.0.1:${port}/?t=${token}`,
				port,
				token,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
					}),
			});
		});
	});
}
