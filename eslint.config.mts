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
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
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
		"jest.config.cjs",
		"wdio.conf.mts",
	]),
	{
		files: ["src/**/*.ts"],
		rules: {
			"@typescript-eslint/no-misused-promises": "off",
			"@typescript-eslint/only-throw-error": "off",
			"@typescript-eslint/prefer-promise-reject-errors": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-explicit-any": "error",
			"curly": ["error", "all"],
		},
	},
);
