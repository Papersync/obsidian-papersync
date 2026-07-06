import { z } from 'zod';

const SUPPORTED_SCHEMA_VERSIONS = ['1'] as const;

export const ScanFileSchema = z.object({
	version: z.union([z.string(), z.number()]).transform(String),
	// Must be a real ISO datetime (the producer emits Date.toISOString()). A loose
	// z.string() would let a garbage value reach new Date() in note-creator and yield an
	// "Invalid Date" filename with a NaN:NaN time instead of a clean schema_mismatch.
	createdAt: z.iso.datetime(),
	markdown: z.string(),
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

	if (!SUPPORTED_SCHEMA_VERSIONS.includes(result.data.version as (typeof SUPPORTED_SCHEMA_VERSIONS)[number])) {
		return {
			error: `Unsupported schema version "${result.data.version}" — update the PaperSync plugin`,
		};
	}

	return result.data;
}
