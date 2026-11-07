import { sanitizeSettings } from '@/settings-validation';
import { clampPollInterval } from '@/utils/poll-interval';
import { DEFAULT_SETTINGS } from '@/settings';
import { MAX_POLL_INTERVAL_S, MIN_POLL_INTERVAL_S } from '@/config';

describe('clampPollInterval', () => {
	it.each([
		[0, MIN_POLL_INTERVAL_S],
		[-30, MIN_POLL_INTERVAL_S],
		[4.4, MIN_POLL_INTERVAL_S],
		[12.6, 13],
		[MAX_POLL_INTERVAL_S * 10, MAX_POLL_INTERVAL_S],
		[Number.NaN, DEFAULT_SETTINGS.drivePollInterval],
		[Number.POSITIVE_INFINITY, DEFAULT_SETTINGS.drivePollInterval],
		['30s', DEFAULT_SETTINGS.drivePollInterval],
		[null, DEFAULT_SETTINGS.drivePollInterval],
	])('clamps %p to %p', (value, expected) => {
		expect(clampPollInterval(value)).toBe(expected);
	});
});

describe('sanitizeSettings', () => {
	it('keeps every valid field', () => {
		const valid = {
			...DEFAULT_SETTINGS,
			setupComplete: true,
			backendType: 'folder',
			drivePollInterval: 60,
			folderPath: '/x',
			templateString: '{{ps_markdown}}',
			downloadImages: false,
			lastSyncTimestamp: '2026-10-22T10:00:00.123Z',
			lastSyncAt: 1_700_000_000_000,
		};
		expect(sanitizeSettings({ ...valid })).toEqual(valid);
	});

	it('falls back per field for wrong types and bad values, and drops unknown keys', () => {
		const settings = sanitizeSettings({
			setupComplete: 'yes',
			backendType: 'icloud',
			drivePollInterval: '30s',
			folderPath: 42,
			templateString: { text: 'x' },
			downloadImages: 1,
			lastSyncTimestamp: "2026' or name contains '",
			lastSyncAt: -5,
			saveTo: 'weekly',
			customFolder: 3,
			settingsVersion: Number.NaN,
			somethingElse: true,
		});
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect('somethingElse' in settings).toBe(false);
	});

	it('clamps a poll interval that would poll Drive in a tight loop', () => {
		expect(sanitizeSettings({ drivePollInterval: 0 }).drivePollInterval).toBe(MIN_POLL_INTERVAL_S);
	});

	it('keeps a valid scan destination', () => {
		expect(sanitizeSettings({ saveTo: 'daily', customFolder: 'Inbox', customFileName: 'Scans' }))
			.toMatchObject({ saveTo: 'daily', customFolder: 'Inbox', customFileName: 'Scans' });
	});
});
