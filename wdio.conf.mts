import path from 'node:path';
import { obsidianBetaAvailable } from 'wdio-obsidian-service';

const cacheDir = path.resolve('.obsidian-cache');

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
			plugins: ['.'],
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
