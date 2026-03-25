import { z } from "zod";

const envSchema = z.object({
	CODETELEPORT_API_URL: z.string().url(),
});

/**
 * Validates and returns environment variables.
 * Throws a descriptive error if validation fails.
 */
export function getEnv() {
	const result = envSchema.safeParse(process.env);
	if (!result.success) {
		const errors = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid environment variables:\n${errors}`);
	}
	return result.data;
}
