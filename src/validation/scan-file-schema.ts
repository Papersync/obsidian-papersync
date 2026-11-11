import { parseScanFile } from '@papersync/scan-format';
import type { ScanFile } from '@papersync/scan-format';
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

export type { ScanFile } from '@papersync/scan-format';

// `newerVersion`: the file is a valid scan from a newer app (updating the plugin
// imports it), not a damaged or foreign file.
export function validateScanFile(raw: unknown): ScanFile | { error: string; newerVersion: boolean } {
	const result = parseScanFile(raw);
	if (result.ok) {
		return result.file;
	}
	const newerVersion = result.kind === 'unsupported_version';
	return {
		error: newerVersion ? `${result.message} Please update the Papersync plugin.` : result.message,
		newerVersion,
	};
}
