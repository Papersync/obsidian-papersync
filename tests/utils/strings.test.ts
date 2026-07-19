import { STRINGS } from '@/utils/strings';

describe('STRINGS template functions', () => {
	it('STATUS_PENDING renders the pending count', () => {
		expect(STRINGS.STATUS_PENDING(3)).toBe('Papersync: 3 pending');
	});

	it('NOTICE_SYNCING renders the in-flight count', () => {
		expect(STRINGS.NOTICE_SYNCING(7)).toBe('Syncing 7 scans...');
	});

	it('NOTICE_SYNC_COMPLETE renders the synced count', () => {
		expect(STRINGS.NOTICE_SYNC_COMPLETE(12)).toBe('Synced 12 new notes');
	});

	it('NOTICE_PROVIDER_UNAVAILABLE names the provider', () => {
		expect(STRINGS.NOTICE_PROVIDER_UNAVAILABLE('iCloud Drive')).toBe(
			'iCloud Drive is not available on this computer. Sign in and enable it, then select it again.'
		);
	});

	it('NOTICE_FOLDER_CREATE_FAILED names the folder path', () => {
		expect(STRINGS.NOTICE_FOLDER_CREATE_FAILED('/x/PaperSync/scans')).toBe(
			'Could not create /x/PaperSync/scans. Check the folder permissions and try again.'
		);
	});
});
