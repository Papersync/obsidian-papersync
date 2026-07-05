// Pin the timezone so Date-derived assertions (note timestamps, daily-note
// filenames) are deterministic across dev machines and CI. Set at config-load
// time so forked workers inherit UTC before their first Date call.
process.env.TZ = 'UTC';

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom',
	roots: ['<rootDir>/tests'],
	coverageProvider: 'v8',
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/main.ts',
		'!src/config.ts',
		'!src/sync/sync-backend.ts',
		'!src/ui/first-run-modal.ts',
		'!src/utils/dev-tools.ts',
		// settings.ts is the Obsidian Setting-tab renderer; covered by E2E (test/e2e/settings.e2e.ts)
		// rather than unit tests, which would require mocking the entire Obsidian Setting API surface.
		'!src/settings.ts',
	],
	coverageThreshold: {
		global: {
			statements: 100,
			branches: 100,
			functions: 100,
			lines: 100,
		},
	},
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/src/$1',
		'^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
	},
	setupFiles: ['<rootDir>/tests/setup.ts'],
	transform: {
		'^.+\\.ts$': ['ts-jest', {
			tsconfig: {
				strict: true,
				module: 'ESNext',
				target: 'ES2018',
				moduleResolution: 'node',
				allowSyntheticDefaultImports: true,
				esModuleInterop: true,
				baseUrl: '.',
				paths: {
					'@/*': ['src/*'],
				},
			},
		}],
	},
};
