// Namespace import on purpose. `import { z } from 'zod'` goes through a
// re-exported namespace that esbuild cannot tree-shake (evanw/esbuild#1420), so
// it bundled ALL of zod, every locale and the JSON-schema tooling included:
// about 250 KB of a 410 KB main.js. This form ships only what the schema uses.
import * as z from 'zod';
import { en } from 'zod/locales';

// Register English explicitly. Some zod 4.4.x builds drop the default locale
// under a namespace import in esbuild (colinhacks/zod#5953), which would turn
// every validation message into a bare "Invalid input". 4.4.3 with esbuild
// 0.28.2 keeps it (checked by running the bundled schema), but the messages
// reach the logs and this costs a few bytes, so it is not left to a default.
z.config(en());

const SUPPORTED_SCHEMA_VERSIONS = ['1'] as const;

// Optional descriptive metadata must never make an otherwise valid scan fail.
// Ignore non-strings instead of coercing them into misleading note content.
const OptionalScanText = z.preprocess(
	(value) => typeof value === 'string' ? value : undefined,
	z.string().trim().transform((value) => value || undefined).optional()
);

export const ScanFileSchema = z.object({
	version: z.union([z.string(), z.number()]).transform(String),
	// Must be a real ISO datetime (the producer emits Date.toISOString()). A loose
	// z.string() would let a garbage value reach new Date() in note-creator and yield an
	// "Invalid Date" filename with a NaN:NaN time instead of a clean schema_mismatch.
	createdAt: z.iso.datetime(),
	markdown: z.string(),
	title: OptionalScanText,
	summary: OptionalScanText,
	confidence: z.number().int().min(0).max(100),
	provider: z.string(),
	model: z.string(),
	imageFileName: z.string(),
	synced: z.boolean().optional().default(false),
});

export type ScanFile = z.infer<typeof ScanFileSchema>;

export function validateScanFile(raw: unknown): ScanFile | { error: string } {
	const result = ScanFileSchema.safeParse(raw);
	if (!result.success) {
		return { error: `Invalid ScanFile: ${result.error.issues.map((i) => i.message).join(', ')}` };
	}

	if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(result.data.version)) {
		return {
			error: `Unsupported schema version "${result.data.version}" — update the PaperSync plugin`,
		};
	}

	return result.data;
}
