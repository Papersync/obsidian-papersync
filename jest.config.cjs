// Pin the timezone so Date-derived assertions (note timestamps, daily-note
// filenames) are deterministic across dev machines and CI. Set at config-load
// time so forked workers inherit UTC before their first Date call.
process.env.TZ = 'UTC';

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom',
	// The shared contract is ESM-only; transform its JS for Jest's CJS runner.
	transformIgnorePatterns: ['/node_modules/(?!@papersync/scan-format/)'],
	roots: ['<rootDir>/tests'],
	coverageProvider: 'v8',
	collectCoverageFrom: [
		'src/**/*.ts',
		'!src/main.ts',
		'!src/config.ts',
		'!src/sync/sync-backend.ts',
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
		'^@papersync/scan-format$': '<rootDir>/node_modules/@papersync/scan-format/dist/index.js',
		'^@/(.*)$': '<rootDir>/src/$1',
		'^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts',
	},
	setupFiles: ['<rootDir>/tests/setup.ts'],
	transform: {
		'^.+\\.[tj]s$': ['ts-jest', {
			tsconfig: {
				strict: true,
				allowJs: true,
				module: 'ESNext',
				target: 'ES2018',
				// 'bundler' + relative paths rather than the legacy 'node' resolution
				// and baseUrl: TypeScript 6 rejects both (TS5107 / TS5101).
				moduleResolution: 'bundler',
				// ts-jest emits (tsc -noEmit does not), and TypeScript 6 requires an
				// explicit rootDir for that (TS5011); src/ and tests/ share the root.
				rootDir: '.',
				allowSyntheticDefaultImports: true,
				esModuleInterop: true,
				paths: {
					'@/*': ['./src/*'],
				},
			},
		}],
	},
};
