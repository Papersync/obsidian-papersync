export const config = {
	runner: 'local',
	specs: ['./test/e2e/**/*.e2e.ts'],
	maxInstances: 1,

	capabilities: [
		{
			browserName: 'obsidian',
			'wdio:obsidianOptions': {
				vault: './test/vault',
				plugins: ['.'],
			},
		},
	],

	services: ['obsidian'],
	framework: 'mocha',
	reporters: ['spec', 'obsidian'],

	mochaOpts: {
		ui: 'bdd',
		timeout: 60000,
		retries: 2,
	},
};
