/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom',
	roots: ['<rootDir>/tests'],
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
