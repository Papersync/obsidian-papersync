import { migrateSettings } from '@/settings';

describe('migrateSettings', () => {
	it('migrates v1 icloud settings through the cascade to v3 folder settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 1,
			backendType: 'icloud',
			icloudFolderPath: '/Users/me/Library/Mobile Documents/iCloud~papersync',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		// v1 cascades through the v2 (icloud→folder) and v3 (token strip) steps.
		expect(result.settingsVersion).toBe(3);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBe('/Users/me/Library/Mobile Documents/iCloud~papersync');
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('migrates fresh install with no settingsVersion to v3', () => {
		const input: Record<string, unknown> = {
			backendType: 'none',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(3);
	});

	it('strips a legacy plaintext oauthRefreshToken and bumps to v3', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 2,
			backendType: 'drive',
			oauthRefreshToken: 'legacy-plaintext-refresh-token',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(3);
		expect(result).not.toHaveProperty('oauthRefreshToken');
		expect(result.backendType).toBe('drive'); // the rest of the data survives
	});

	it('does not modify already-migrated v3 settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 3,
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

		expect(result.settingsVersion).toBe(3);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBeUndefined();
		expect(result).not.toHaveProperty('icloudFolderPath');
	});
});
