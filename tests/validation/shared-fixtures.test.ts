import fs from 'node:fs';
import { validateScanFile } from '@/validation/scan-file-schema';

interface Fixture {
	file: string;
	expected: 'ok' | 'schema' | 'unsupported_version';
	reason: string;
	output?: Record<string, unknown>;
}

// Resolve the installed package, not a copy of its fixtures, so upgrades exercise
// the exact contract shipped with the dependency.
const manifest = JSON.parse(fs.readFileSync(
	require.resolve('@papersync/scan-format/fixtures/manifest.json'), 'utf8'
)) as Fixture[];

it.each(manifest)('shared fixture $file: $reason', ({ file, expected, output }) => {
	const raw: unknown = JSON.parse(fs.readFileSync(require.resolve(`@papersync/scan-format/fixtures/${file}`), 'utf8'));
	const result = validateScanFile(raw);
	if (expected === 'ok') {
		expect(result).not.toHaveProperty('error');
		expect(result).toHaveProperty('version', 1);
		// The manifest defines the complete JSON-serializable normalized view.
		expect(JSON.parse(JSON.stringify(result))).toEqual(output);
	} else {
		expect(result).toHaveProperty('error');
		if ('error' in result) {
			expect(result.error).toContain(expected === 'unsupported_version'
				? 'update the Papersync plugin'
				: 'Invalid Papersync scan file:');
		}
	}
});
