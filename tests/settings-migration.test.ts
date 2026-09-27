import { migrateSettings } from '@/settings';

describe('migrateSettings', () => {
	it('migrates v1 icloud settings through the cascade to v4 folder settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 1,
			backendType: 'icloud',
			icloudFolderPath: '/Users/me/Library/Mobile Documents/iCloud~papersync',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		// v1 cascades through the v2 (icloud→folder), v3 (token strip) and v4 steps.
		expect(result.settingsVersion).toBe(4);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBe('/Users/me/Library/Mobile Documents/iCloud~papersync');
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('migrates fresh install with no settingsVersion to v4', () => {
		const input: Record<string, unknown> = {
			backendType: 'none',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(4);
	});

	it('strips a legacy plaintext oauthRefreshToken and bumps to v4', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 2,
			backendType: 'drive',
			oauthRefreshToken: 'legacy-plaintext-refresh-token',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(4);
		expect(result).not.toHaveProperty('oauthRefreshToken');
		expect(result.backendType).toBe('drive'); // the rest of the data survives
	});

	it('does not modify already-migrated v4 settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 4,
			templateString: '{{ps_markdown}} {{date}}',
			backendType: 'folder',
			folderPath: '/some/path',
			setupComplete: true,
		};

		const result = migrateSettings({ ...input });

		expect(result).toEqual(input);
	});

	it('migrates icloud backend with missing icloudFolderPath', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 1,
			backendType: 'icloud',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(4);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBeUndefined();
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('rewrites un-prefixed template tokens to their ps_ names and bumps to v4', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 3,
			templateString:
				'{{separator}}\n## {{time}} ({{time_24h}}) {{date}} {{date_short}}\n{{markdown}}\n' +
				'{{confidence}} {{provider}} {{model}} ![[{{image_file}}]] {{ps_markdown}} {{title}} {{ markdown }}',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(4);
		expect(result.templateString).toBe(
			'{{ps_separator}}\n## {{ps_scan_time}} ({{ps_scan_time_24h}}) {{ps_scan_date}} {{ps_scan_date_short}}\n{{ps_markdown}}\n' +
			'{{ps_confidence}} {{ps_provider}} {{ps_model}} ![[{{ps_image_file}}]] {{ps_markdown}} {{title}} {{ markdown }}',
		);
	});

	it('bumps to v4 without a saved template', () => {
		const result = migrateSettings({ settingsVersion: 3, backendType: 'drive' });

		expect(result.settingsVersion).toBe(4);
		expect(result).not.toHaveProperty('templateString');
	});
});
