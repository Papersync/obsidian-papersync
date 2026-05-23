import { STRINGS } from '@/utils/strings';

describe('STRINGS template functions', () => {
	it('STATUS_PENDING renders the pending count', () => {
		expect(STRINGS.STATUS_PENDING(3)).toBe('PaperSync: 3 pending');
	});

	it('NOTICE_SYNCING renders the in-flight count', () => {
		expect(STRINGS.NOTICE_SYNCING(7)).toBe('Syncing 7 scans...');
	});

	it('NOTICE_SYNC_COMPLETE renders the synced count', () => {
		expect(STRINGS.NOTICE_SYNC_COMPLETE(12)).toBe('Synced 12 new notes');
	});
});
