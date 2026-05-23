import { SyncState } from '@/sync/sync-state';

describe('SyncState', () => {
	it('initializes with the provided lastSyncTimestamp and idle status', () => {
		const s = new SyncState('2026-01-01T00:00:00Z');
		expect(s.status).toBe('idle');
		expect(s.lastSyncTimestamp).toBe('2026-01-01T00:00:00Z');
		expect(s.pendingCount).toBe(0);
		expect(s.isSyncing).toBe(false);
	});

	it('snapshot reflects current values', () => {
		const s = new SyncState('');
		s.setStatus('syncing', 3);
		expect(s.snapshot).toEqual({
			status: 'syncing',
			pendingCount: 3,
			lastSyncTimestamp: '',
			isSyncing: false,
		});
	});

	it('notifies subscribers on changes, not on no-ops', () => {
		const s = new SyncState('');
		const listener = jest.fn();
		s.subscribe(listener);

		s.setStatus('synced', 0);
		s.setStatus('synced', 0); // no-op
		s.setStatus('synced', 5); // pendingCount changed → notify

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('subscribe returns an unsubscribe function', () => {
		const s = new SyncState('');
		const listener = jest.fn();
		const unsub = s.subscribe(listener);
		unsub();
		s.setStatus('syncing', 1);
		expect(listener).not.toHaveBeenCalled();
	});

	it('tryStartSync claims the lock once', () => {
		const s = new SyncState('');
		expect(s.tryStartSync()).toBe(true);
		expect(s.tryStartSync()).toBe(false);
		s.setSyncing(false);
		expect(s.tryStartSync()).toBe(true);
	});

	it('advanceTimestamp only moves forward', () => {
		const s = new SyncState('2026-04-12T14:30:00Z');
		s.advanceTimestamp('2026-04-12T14:31:00Z');
		expect(s.lastSyncTimestamp).toBe('2026-04-12T14:31:00Z');

		s.advanceTimestamp('2026-04-12T14:00:00Z'); // earlier — should not move backward
		expect(s.lastSyncTimestamp).toBe('2026-04-12T14:31:00Z');
	});
});
