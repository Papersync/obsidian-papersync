import { migrateSettings } from '@/settings';

describe('migrateSettings', () => {
	it('migrates v1 icloud settings to v2 folder settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 1,
			backendType: 'icloud',
			icloudFolderPath: '/Users/me/Library/Mobile Documents/iCloud~papersynced',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(2);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBe('/Users/me/Library/Mobile Documents/iCloud~papersynced');
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('migrates fresh install with no settingsVersion to v2', () => {
		const input: Record<string, unknown> = {
			backendType: 'none',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(2);
	});

	it('does not modify already-migrated v2 settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 2,
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

		expect(result.settingsVersion).toBe(2);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBeUndefined();
		expect(result).not.toHaveProperty('icloudFolderPath');
	});
});
