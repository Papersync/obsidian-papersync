import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { obsidianBetaAvailable } from 'wdio-obsidian-service';

const cacheDir = path.resolve('.obsidian-cache');

// The plugin is installed from a staging folder holding only the release files,
// never from the repo root: obsidian-launcher also copies a data.json it finds next
// to main.js into the test vault, and a local checkout can hold one (a dev vault's
// live settings), so every spec would start from those settings instead of a clean
// install. CI has no data.json, so there the vault gets the same files as before.
// One folder per checkout (keyed by its path), so parallel worktrees never share
// it. Each file is written to a temp name and renamed, because wdio loads this
// config again in every worker and a reader must never see a half-written file.
function stagePlugin(): string {
	const root = path.resolve('.');
	const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
	const dir = path.join(os.tmpdir(), `papersync-e2e-plugin-${key}`);
	fs.mkdirSync(dir, { recursive: true });
	fs.rmSync(path.join(dir, 'data.json'), { force: true });
	for (const [file, required] of [['main.js', true], ['manifest.json', true], ['styles.css', false]] as const) {
		const src = path.join(root, file);
		const dest = path.join(dir, file);
		if (!fs.existsSync(src)) {
			if (required) { throw new Error(`${file} missing: run npm run build first`); }
			fs.rmSync(dest, { force: true });
			continue;
		}
		const tmp = `${dest}.${process.pid}.tmp`;
		fs.copyFileSync(src, tmp);
		fs.renameSync(tmp, dest);
	}
	return dir;
}

const pluginDir = stagePlugin();

// Run the suite against the minAppVersion floor (earliest, read from
// manifest.json) AND latest, so a floor-specific break (an API newer than the
// floor, or a version-specific behaviour) is caught here instead of only on
// latest. installerVersion pins the Electron installer independently of the app
// JS version. latest-beta is added only when Obsidian insider credentials are
// present. Do NOT hardcode version numbers: "earliest" tracks manifest.json.
const versions: [string, string][] = [
	['earliest', 'earliest'],
	['latest', 'latest'],
];
if (await obsidianBetaAvailable(cacheDir)) {
	versions.push(['latest-beta', 'latest']);
}

export const config = {
	runner: 'local',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: 1,
	cacheDir,

	capabilities: versions.map(([appVersion, installerVersion]) => ({
		browserName: 'obsidian',
		browserVersion: appVersion,
		'wdio:obsidianOptions': {
			installerVersion,
			vault: './test/vault',
			// Periodic Notes is installed (disabled) only for periodic-notes.e2e.ts,
			// which enables it: Papersync copies its daily settings on first setup.
			plugins: [pluginDir, { id: 'periodic-notes', version: '0.0.17', enabled: false }],
		},
	})),

	services: ['obsidian'],
	framework: 'mocha',
	reporters: ['spec', 'obsidian'],

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000,
		// No retries. A retry cannot tell a transient flake from a real intermittent
		// defect, so it turns the latter into a green run; it also reruns in the
		// state the failed attempt left behind, and a hang costs 3 x the timeout.
		// A red is a red: find the mechanism and fix it (same policy as the app's
		// E2E lanes). Tests that need longer than the timeout set it at SUITE level:
		// wdio arms its per-test timer at test start, so an in-test this.timeout()
		// cannot extend it.
		retries: 0,
	},
};
