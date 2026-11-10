import { STRINGS } from '@/utils/strings';

describe('STRINGS template functions', () => {
	it('STATUS_PENDING renders the pending count', () => {
		expect(STRINGS.STATUS_PENDING(3)).toBe('Papersync: 3 pending');
	});

	it('NOTICE_SYNCING names the plugin and pluralises the in-flight count', () => {
		expect(STRINGS.NOTICE_SYNCING(7)).toBe('Papersync: syncing 7 scans\u2026');
		expect(STRINGS.NOTICE_SYNCING(1)).toBe('Papersync: syncing 1 scan\u2026');
	});

	it('NOTICE_SYNC_COMPLETE names the plugin and pluralises the synced count', () => {
		expect(STRINGS.NOTICE_SYNC_COMPLETE(12)).toBe('Papersync: synced 12 new notes');
		expect(STRINGS.NOTICE_SYNC_COMPLETE(1)).toBe('Papersync: synced 1 new note');
	});

	it('NOTICE_NOTHING_NEW names the plugin', () => {
		expect(STRINGS.NOTICE_NOTHING_NEW).toBe('Papersync: all synced, nothing new');
	});

	it('NOTICE_WAITING_FOR_DOWNLOAD names the plugin and pluralises the count', () => {
		expect(STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(3)).toBe('Papersync: 3 scans waiting for download');
		expect(STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(1)).toBe('Papersync: 1 scan waiting for download');
	});

	it('OAUTH_SIGN_IN_ENDED says a Cancel at Google plainly and names any other error', () => {
		expect(STRINGS.OAUTH_SIGN_IN_ENDED('access_denied')).toBe('Sign-in was cancelled at Google (access_denied)');
		expect(STRINGS.OAUTH_SIGN_IN_ENDED('admin_policy_enforced')).toBe('Google did not finish the sign-in (admin_policy_enforced)');
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

	it('SETTINGS_FOLDER_MISSING_TITLE names the missing folder, not its path', () => {
		expect(STRINGS.SETTINGS_FOLDER_MISSING_TITLE('Papersync')).toBe('\u26A0 Your Papersync folder "Papersync" is missing');
	});
});
