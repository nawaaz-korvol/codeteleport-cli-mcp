import os from "node:os";
import readline from "node:readline";
import { Command } from "commander";
import open from "open";
import { CodeTeleportClient } from "../../client/api";
import { resolveApiUrl } from "../api-url";
import { writeConfig } from "../config";
import { resolveLoginMethod, startOAuthCallbackServer } from "../github-oauth";

function prompt(question: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

function promptPassword(question: string): Promise<string> {
	return prompt(question);
}

export async function createApiTokenAndSave(apiUrl: string, jwt: string, email?: string) {
	const deviceName = os.hostname().replace(/\.local$/, "");
	const authedClient = new CodeTeleportClient({ apiUrl, token: jwt });

	const { token: apiToken } = await authedClient.createApiToken(deviceName);

	writeConfig({
		token: apiToken,
		apiUrl,
		deviceName,
	});

	if (email) {
		console.log(`\nLogged in as ${email}`);
	} else {
		console.log("\nLogged in via GitHub");
	}
	console.log(`Device: ${deviceName}`);
	console.log(`API: ${apiUrl}`);
	console.log("Config saved to ~/.codeteleport/config.json");
}

async function loginWithEmail(apiUrl: string, register: boolean) {
	const email = await prompt("Email: ");
	const password = await promptPassword("Password: ");

	const client = new CodeTeleportClient({ apiUrl, token: "" });

	let jwt: string;
	if (register) {
		const result = await client.register(email, password);
		jwt = result.token;
		console.log(`Account created for ${email}`);
	} else {
		const result = await client.login(email, password);
		jwt = result.token;
	}

	await createApiTokenAndSave(apiUrl, jwt, email);
}

async function loginWithGitHub(apiUrl: string) {
	const { port, tokenPromise } = await startOAuthCallbackServer();

	const apiBase = apiUrl.replace(/\/v1$/, "");
	const authUrl = `${apiBase}/v1/auth/github?cli_port=${port}`;

	console.log("Opening browser for GitHub login...");
	console.log(`If the browser doesn't open, visit: ${authUrl}`);

	open(authUrl).catch(() => {
		// Browser open failed — user can manually visit the URL
	});

	const jwt = await tokenPromise;
	await createApiTokenAndSave(apiUrl, jwt);
}

export const authCommand = new Command("auth").description("Manage authentication");

authCommand
	.command("login")
	.description("Log in to CodeTeleport")
	.option("--register", "Create a new account")
	.option("--github", "Log in with GitHub")
	.option("--email", "Log in with email and password")
	.option("--api-url <url>", "API server URL (default: https://api.codeteleport.com)")
	.action(async (opts) => {
		const apiUrl = resolveApiUrl(opts.apiUrl);

		try {
			const method = await resolveLoginMethod(opts, prompt);

			if (method === "github") {
				await loginWithGitHub(apiUrl);
			} else {
				await loginWithEmail(apiUrl, !!opts.register);
			}
		} catch (err) {
			console.error(`Authentication failed: ${(err as Error).message}`);
			process.exit(1);
		}
	});

authCommand
	.command("logout")
	.description("Remove local credentials")
	.action(() => {
		const fs = require("node:fs") as typeof import("node:fs");
		const { CONFIG_FILE } = require("../../shared/constants") as typeof import("../../shared/constants");
		try {
			fs.unlinkSync(CONFIG_FILE);
			console.log("Logged out. Config removed.");
		} catch {
			console.log("Already logged out.");
		}
	});
