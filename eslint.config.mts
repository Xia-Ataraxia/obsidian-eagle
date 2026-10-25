// Repo-local ESLint baseline for obsidian-eagle-plugin.
import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import vitestPlugin from '@vitest/eslint-plugin';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.nodeBuiltin },
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'vitest.config.ts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Disable depend/ban-dependencies -- too aggressive for the plugin ecosystem
	// (flags legitimate devDeps like lint-staged, builtin-modules).
	{
		rules: {
			'depend/ban-dependencies': 'off',
		},
	},
	// Ban common async/type hazards in non-test TypeScript code.
	{
		files: ['**/*.ts', '**/*.mts'],
		ignores: [
			'test/**/*.ts',
			'__tests__/**/*.ts',
			'**/*.d.ts',
			'*.config.ts',
			'*.config.mts',
			'*.config.js',
			'*.config.mjs',
			'**/*.config.ts',
			'**/*.config.mts',
			'**/*.config.js',
			'**/*.config.mjs',
		],
		plugins: { '@typescript-eslint': tseslint.plugin },
		rules: {
			'@typescript-eslint/no-misused-promises': ['error', {
				checksConditionals: true,
				checksSpreads: true,
				checksVoidReturn: {
					arguments: true,
					attributes: true,
					properties: true,
					returns: false,
					variables: true,
				},
			}],
			'@typescript-eslint/no-redundant-type-constituents': 'error',
			'@typescript-eslint/require-await': 'error',
		},
	},
	// Layer enforcement: domain/, types/, utils/ must not import from obsidian.
	{
		files: ['src/domain/**/*.ts', 'src/types/**/*.ts', 'src/utils/**/*.ts'],
		ignores: ['**/*.d.ts'],
		rules: {
			'no-restricted-imports': ['error', {
				patterns: [{
					group: ['obsidian', 'obsidian/*'],
					message: 'domain/, types/, and utils/ layers must not import from obsidian. Move this code to ui/ or inject the dependency.',
				}],
			}],
		},
	},
	// Worker files: run in Web Worker / Node-like context, need node globals (Buffer, process).
	{
		files: ['worker/**/*.ts'],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	// Config files: legitimately import Node.js built-in modules.
	{
		files: ['*.config.ts', '*.config.mts', '*.config.js', '*.config.mjs'],
		rules: {
			'import/no-nodejs-modules': 'off',
		},
	},
	// Script files (.mjs): Node CLI scripts outside tsconfig; untyped lint, console output is their UI.
	{
		files: ['scripts/**/*.mjs', 'tooling/**/*.mjs', '*.mjs'],
		extends: [tseslint.configs.disableTypeChecked],
		languageOptions: {
			globals: { ...globals.node },
			parserOptions: { projectService: false },
		},
		rules: {
			'import/no-nodejs-modules': 'off',
			'no-console': 'off',
			'obsidianmd/rule-custom-message': 'off',
			// Node has no `window`; the autofix would break these scripts.
			'obsidianmd/prefer-window-timers': 'off',
		},
	},
	// Test files: relax rules that don't apply to test code.
	{
		files: ['test/**/*.ts', '__tests__/**/*.ts'],
		plugins: { vitest: vitestPlugin },
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			'vitest/expect-expect': 'error',
			'vitest/no-disabled-tests': 'warn',
			'vitest/no-conditional-tests': 'error',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
			'@typescript-eslint/no-redundant-type-constituents': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/unbound-method': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'import/no-nodejs-modules': 'off',
		},
	},
	globalIgnores(['**/main.js', 'dist/', 'node_modules/', 'coverage/']),
);
