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
	.action(async (opts) => {
		try {
			const port = opts.port ? Number.parseInt(opts.port, 10) : undefined;
			if (port !== undefined && (Number.isNaN(port) || port < 0 || port > 65535)) {
				throw new Error(`Invalid port: ${opts.port}`);
			}

			const server = await createPanelServer({ port });
			console.log(`Local session panel: ${server.url}`);
			console.log("Bound to 127.0.0.1 only. Press Ctrl+C to stop.");

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
