import fs from 'node:fs';
import path from 'node:path';
import { validateScanFile } from '@/validation/scan-file-schema';

interface Fixture {
	file: string;
	expected: 'ok' | 'schema' | 'unsupported_version';
	reason: string;
	normalized?: Record<string, unknown>;
	absent?: string[];
}

// Resolve the installed package, not a copy of its fixtures, so upgrades exercise
// the exact contract shipped with the dependency.
const fixturesDir = path.resolve(path.dirname(require.resolve('@papersync/scan-format')), '../fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'manifest.json'), 'utf8')) as Fixture[];

it.each(manifest)('shared fixture $file: $reason', ({ file, expected, normalized, absent }) => {
	const raw: unknown = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'));
	const result = validateScanFile(raw);
	if (expected === 'ok') {
		expect(result).not.toHaveProperty('error');
		expect(result).toHaveProperty('version', 1);
		if (normalized) {
			expect(result).toMatchObject(normalized);
		}
		for (const field of absent ?? []) {
			expect((result as unknown as Record<string, unknown>)[field]).toBeUndefined();
		}
	} else {
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain(expected === 'unsupported_version'
				? 'update the Papersync plugin'
				: 'Invalid Papersync scan file:');
		}
	}
});
