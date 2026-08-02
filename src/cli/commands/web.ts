import { Command } from "commander";
import open from "open";
import { createPanelServer } from "../../web/server";

/**
 * `codeteleport web` — browse local sessions in a browser.
 *
 * Local-only, like the rest of the panel: no account, no token, no outbound network.
 * The server binds 127.0.0.1 and mints a fresh URL token each run, so the printed URL
 * is what grants access — it is not a secret worth persisting, and a new one is issued
 * every time.
 */
export const webCommand = new Command("web")
	.description("Browse local sessions in a web view (no account needed)")
	.option("--port <n>", "Port to listen on (default: any free port)")
	.option("--no-open", "Print the URL instead of opening a browser")
	.option("--idle-timeout <minutes>", "Shut down after this many idle minutes (0 disables)", "60")
	.action(async (opts) => {
		try {
			const port = opts.port ? Number.parseInt(opts.port, 10) : undefined;
			if (port !== undefined && (Number.isNaN(port) || port < 0 || port > 65535)) {
				throw new Error(`Invalid port: ${opts.port}`);
			}

			// setTimeout is capped at 2^31-1 ms; beyond that Node clamps the delay to 1 and
			// the panel exits immediately while announcing a huge timeout — the exact
			// opposite of what someone typing a big number wants. Parse strictly (so "1e3"
			// is not silently read as 1) and refuse anything past the cap, pointing at the
			// flag that actually means "never".
			const MAX_IDLE_MINUTES = Math.floor(2 ** 31 / 60_000); // ~35791
			if (!/^\d+$/.test(String(opts.idleTimeout).trim())) {
				throw new Error(`Invalid --idle-timeout: ${opts.idleTimeout} (expected a whole number of minutes)`);
			}
			const idleMinutes = Number.parseInt(String(opts.idleTimeout).trim(), 10);
			if (idleMinutes > MAX_IDLE_MINUTES) {
				throw new Error(
					`--idle-timeout ${idleMinutes} is too large (max ${MAX_IDLE_MINUTES}). Use --idle-timeout 0 to never time out.`,
				);
			}

			const server = await createPanelServer({ port, idleTimeoutMs: idleMinutes * 60_000 });
			console.log(`Local session panel: ${server.url}`);
			console.log(
				idleMinutes > 0
					? `Bound to 127.0.0.1 only. Exits after ${idleMinutes} idle minutes. Press Ctrl+C to stop.`
					: "Bound to 127.0.0.1 only. Press Ctrl+C to stop.",
			);
			console.log("The link is single-use per run — rerun this command to get a fresh one.");

			if (opts.open !== false) {
				try {
					await open(server.url);
				} catch {
					// A headless or restricted environment is fine — the URL is printed above.
				}
			}

			const stop = () => {
				server.close().then(() => process.exit(0));
			};
			process.on("SIGINT", stop);
			process.on("SIGTERM", stop);
		} catch (err) {
			console.error(`Failed: ${(err as Error).message}`);
			process.exit(1);
		}
	});
