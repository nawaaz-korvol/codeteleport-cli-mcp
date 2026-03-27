export type ListMode = "local" | "cloud";

export type ListFlags = {
	local?: boolean;
	cloud?: boolean;
};

/**
 * Resolve which list mode to use based on CLI flags.
 * If no flag is set, prompts the user interactively.
 */
export async function resolveListMode(
	flags: ListFlags,
	promptFn: (question: string) => Promise<string>,
): Promise<ListMode> {
	if (flags.local) return "local";
	if (flags.cloud) return "cloud";

	const choice = await promptFn("What do you want to list?\n  1) Local sessions\n  2) Cloud sessions\n> ");
	return choice === "2" ? "cloud" : "local";
}

/**
 * Parse the --push flag's session selection input.
 * Returns selected indices (0-based), or "all", or null for quit.
 */
export function parseSessionSelection(input: string, totalSessions: number): number[] | "all" | null {
	const trimmed = input.trim().toLowerCase();

	if (trimmed === "q") return null;
	if (trimmed === "all") return "all";

	const indices = trimmed
		.split(",")
		.map((s) => Number.parseInt(s.trim(), 10) - 1)
		.filter((n) => !Number.isNaN(n) && n >= 0 && n < totalSessions);

	// Deduplicate
	return [...new Set(indices)];
}
