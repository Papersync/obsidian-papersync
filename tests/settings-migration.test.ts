import { migrateSettings } from '@/settings';

describe('migrateSettings', () => {
	it('migrates v1 icloud settings through the cascade to v5 folder settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 1,
			backendType: 'icloud',
			icloudFolderPath: '/Users/me/Library/Mobile Documents/iCloud~papersync',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		// v1 cascades through the v2 (icloud→folder), v3 (token strip), v4 and v5 steps.
		expect(result.settingsVersion).toBe(5);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBe('/Users/me/Library/Mobile Documents/iCloud~papersync');
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('migrates fresh install with no settingsVersion to v5', () => {
		const input: Record<string, unknown> = {
			backendType: 'none',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(5);
	});

	it('strips a legacy plaintext oauthRefreshToken and bumps to v5', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 2,
			backendType: 'drive',
			oauthRefreshToken: 'legacy-plaintext-refresh-token',
			setupComplete: true,
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(5);
		expect(result).not.toHaveProperty('oauthRefreshToken');
		expect(result.backendType).toBe('drive'); // the rest of the data survives
	});

	it('does not modify already-migrated v5 settings', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 5,
			saveTo: 'custom',
			customFolder: 'Inbox',
			customFileName: 'Scans',
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

		expect(result.settingsVersion).toBe(5);
		expect(result.backendType).toBe('folder');
		expect(result.folderPath).toBeUndefined();
		expect(result).not.toHaveProperty('icloudFolderPath');
	});

	it('rewrites un-prefixed template tokens to their ps_ names and bumps to v5', () => {
		const input: Record<string, unknown> = {
			settingsVersion: 3,
			templateString:
				'{{separator}}\n## {{time}} ({{time_24h}}) {{date}} {{date_short}}\n{{markdown}}\n' +
				'{{confidence}} {{provider}} {{model}} ![[{{image_file}}]] {{ps_markdown}} {{title}} {{ markdown }}',
		};

		const result = migrateSettings(input);

		expect(result.settingsVersion).toBe(5);
		expect(result.templateString).toBe(
			'{{ps_separator}}\n## {{ps_scan_time}} ({{ps_scan_time_24h}}) {{ps_scan_date}} {{ps_scan_date_short}}\n{{ps_markdown}}\n' +
			'{{ps_confidence}} {{ps_provider}} {{ps_model}} ![[{{ps_image_file}}]] {{ps_markdown}} {{title}} {{ markdown }}',
		);
	});

	it('bumps to v5 without a saved template', () => {
		const result = migrateSettings({ settingsVersion: 3, backendType: 'drive' });

		expect(result.settingsVersion).toBe(5);
		expect(result).not.toHaveProperty('templateString');
	});

	describe('v5: Notes folder becomes Save scans to', () => {
		const dailyOn = (folder: string, format = 'YYYY-MM-DD') => ({ enabled: true, folder, format });
		const dailyOff = { enabled: false, folder: '', format: 'YYYY-MM-DD' };
		const v4 = (targetFolder?: unknown): Record<string, unknown> =>
			targetFolder === undefined ? { settingsVersion: 4 } : { settingsVersion: 4, targetFolder };

		it.each([
			['the same folder', 'Daily', 'Daily'],
			['a trailing slash', 'Daily/', 'Daily'],
			['a leading slash', '/Daily', 'Daily/'],
			['the vault root as /', '/', ''],
			['the vault root as empty', '', ''],
			['an unset folder (0.1.5 resolved it to the daily folder)', '', 'Journal'],
		])('picks Daily note when Daily notes is on and the folder is %s', (_label, target, dailyFolder) => {
			const result = migrateSettings(v4(target), dailyOn(dailyFolder, 'MMMM D, YYYY'));

			expect(result.saveTo).toBe('daily');
			expect(result.settingsVersion).toBe(5);
			expect(result).not.toHaveProperty('targetFolder');
		});

		it('keeps a different folder as Custom with the Daily notes format', () => {
			const result = migrateSettings(v4('Journal/YYYY/MM'), dailyOn('Daily', 'YYYY/MM/YYYY-MM-DD'));

			expect(result).toMatchObject({ saveTo: 'custom', customFolder: 'Journal/YYYY/MM', customFileName: 'YYYY/MM/YYYY-MM-DD' });
			expect(result).not.toHaveProperty('targetFolder');
		});

		it('keeps a folder with date tokens as Custom even when it reads like the daily folder', () => {
			// 0.1.5 turned "MM" into the month; the daily folder is used literally.
			const result = migrateSettings(v4('Notes/MM'), dailyOn('Notes/MM'));

			expect(result).toMatchObject({ saveTo: 'custom', customFolder: 'Notes/MM', customFileName: 'YYYY-MM-DD' });
		});

		it('keeps the folder as Custom with YYYY-MM-DD when Daily notes is off', () => {
			expect(migrateSettings(v4('Inbox'), dailyOff)).toMatchObject({ saveTo: 'custom', customFolder: 'Inbox', customFileName: 'YYYY-MM-DD' });
			expect(migrateSettings(v4('/'), dailyOff)).toMatchObject({ saveTo: 'custom', customFolder: '/', customFileName: 'YYYY-MM-DD' });
		});

		it('uses Papersync for an unset folder when Daily notes is off', () => {
			expect(migrateSettings(v4(''), dailyOff)).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
			expect(migrateSettings(v4(), dailyOff)).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync' });
			expect(migrateSettings(v4(7), dailyOff)).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync' });
		});

		it('treats Daily notes as off when no config is passed', () => {
			expect(migrateSettings(v4('Daily'))).toMatchObject({ saveTo: 'custom', customFolder: 'Daily', customFileName: 'YYYY-MM-DD' });
		});
	});
});
