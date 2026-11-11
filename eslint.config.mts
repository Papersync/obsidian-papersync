import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
					]
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		// Node-only maintainer commands are exercised by test:release, not Obsidian UI rules.
		"scripts/release*.mjs",
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"tests/**",
		"test/**",
		"coverage/**",
		// The local E2E download cache (Obsidian, its plugins); never project source.
		".obsidian-cache/**",
		"jest.config.cjs",
		"wdio.conf.mts",
	]),
	{
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"obsidianmd/no-misused-promises": "error",
			"@typescript-eslint/only-throw-error": "error",
			"@typescript-eslint/prefer-promise-reject-errors": "error",
			"@typescript-eslint/no-explicit-any": "error",
			"curly": ["error", "all"],
		},
	},
);
