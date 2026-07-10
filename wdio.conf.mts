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
		retries: 2,
	},
};
