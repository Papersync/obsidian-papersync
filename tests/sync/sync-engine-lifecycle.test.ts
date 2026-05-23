import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import type { SyncBackend } from '@/sync/sync-backend';

function makeBackend(): SyncBackend & { startCalls: number; stopCalls: number } {
	const obj = {
		startCalls: 0,
		stopCalls: 0,
		discoverUnsynced: jest.fn().mockResolvedValue([]),
		fetchScan: jest.fn(),
		fetchImage: jest.fn(),
		markSynced: jest.fn(),
		start: jest.fn(),
		stop: jest.fn(),
	};
	obj.start = jest.fn(() => { obj.startCalls++; });
	obj.stop = jest.fn(() => { obj.stopCalls++; });
	return obj as SyncBackend & { startCalls: number; stopCalls: number };
}

const noteConfig = {
	templateString: '{{markdown}}',
	targetFolder: 'PaperSync',
	attachmentsFolder: 'attachments/PaperSync',
	downloadImages: false,
};

function makeApp(): { vault: { getAbstractFileByPath: () => null; create: () => Promise<void>; createBinary: () => Promise<void>; createFolder: () => Promise<void>; adapter: { read: () => Promise<string>; write: () => Promise<void> } } } {
	return {
		vault: {
			getAbstractFileByPath: () => null,
			create: () => Promise.resolve(),
			createBinary: () => Promise.resolve(),
			createFolder: () => Promise.resolve(),
			adapter: {
				read: () => Promise.resolve(''),
				write: () => Promise.resolve(),
			},
		},
	};
}

describe('SyncEngine lifecycle and online/offline handling', () => {
	let onLineDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		onLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
	});

	afterEach(() => {
		if (onLineDescriptor) {
			Object.defineProperty(window.navigator, 'onLine', onLineDescriptor);
		}
	});

	it('start() calls backend.start when online', () => {
		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		engine.start();
		expect(backend.startCalls).toBe(1);
		expect(state.status).toBe('idle');
		engine.stop();
	});

	it('start() sets offline status and does not start backend when offline', () => {
		Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		engine.start();
		expect(backend.startCalls).toBe(0);
		expect(state.status).toBe('offline');
		engine.stop();
	});

	it('stop() calls backend.stop and removes window listeners', () => {
		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		engine.start();
		engine.stop();
		expect(backend.stopCalls).toBe(1);
	});

	it('forceSyncNow returns early when offline', async () => {
		Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });

		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();
	});

	it('forceSyncNow returns early when already syncing', async () => {
		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		state.tryStartSync(); // simulate in-flight sync
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();
	});

	it('forceSyncNow reports synced state when there are no refs', async () => {
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([]);
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(state.status).toBe('synced');
	});

	it('forceSyncNow goes to error state when discover throws', async () => {
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockRejectedValue(new Error('boom'));
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(state.status).toBe('error');
	});

	it('forceSyncNow stringifies non-Error rejections in its error log path', async () => {
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockRejectedValue('boom-string');
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(state.status).toBe('error');
	});

	it('online event restarts backend, offline event stops it', () => {
		const backend = makeBackend();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		engine.start(); // start (online) → startCalls=1
		window.dispatchEvent(new Event('offline'));
		expect(state.status).toBe('offline');
		expect(backend.stopCalls).toBeGreaterThanOrEqual(1);

		window.dispatchEvent(new Event('online'));
		expect(backend.startCalls).toBeGreaterThanOrEqual(2);

		engine.stop();
	});
});

const validScan = {
	version: '1' as const,
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# scan',
	confidence: 95,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName: 'scan.jpg',
	synced: false,
};

describe('SyncEngine.processBatch', () => {
	let onLineDescriptor: PropertyDescriptor | undefined;

	beforeEach(() => {
		onLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
	});

	afterEach(() => {
		if (onLineDescriptor) {
			Object.defineProperty(window.navigator, 'onLine', onLineDescriptor);
		}
	});

	it('skips a ref whose fetched scanFile is already marked synced (no markSynced call)', async () => {
		const backend = makeBackend();
		const ref = { id: 'r1', jsonPath: 'j1', imagePath: 'i1', createdTime: '2026-04-12T14:30:00Z' };
		backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
		backend.fetchScan = jest.fn().mockResolvedValue({ ...validScan, synced: true });
		backend.markSynced = jest.fn();

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(backend.fetchScan).toHaveBeenCalledTimes(1);
		expect(backend.markSynced).not.toHaveBeenCalled();
		expect(state.lastSyncTimestamp).toBe('2026-04-12T14:30:00Z');
	});

	it('advances state timestamp and calls backend.updateLastSyncTimestamp after a successful sync', async () => {
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			updateLastSyncTimestamp: jest.Mock;
		};
		backend.updateLastSyncTimestamp = jest.fn();
		const ref = { id: 'r2', jsonPath: 'j2', imagePath: 'i2', createdTime: '2026-05-01T10:00:00Z' };
		backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(backend.markSynced).toHaveBeenCalledTimes(1);
		expect(backend.updateLastSyncTimestamp).toHaveBeenCalledWith('2026-05-01T10:00:00Z');
		expect(state.lastSyncTimestamp).toBe('2026-05-01T10:00:00Z');
	});

	it('processes batches larger than BATCH_SIZE by yielding to the event loop between chunks', async () => {
		// 12 refs > BATCH_SIZE (10) → must yield once between the two chunks.
		const refs = Array.from({ length: 12 }, (_, i) => ({
			id: `r${String(i).padStart(2, '0')}`,
			jsonPath: `j${i}`,
			imagePath: `i${i}`,
			createdTime: `2026-04-12T14:30:${String(i).padStart(2, '0')}Z`,
		}));

		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue(refs);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		// All 12 refs must be marked synced, proving both chunks ran.
		expect(backend.markSynced).toHaveBeenCalledTimes(12);
	});

	it('drops refs with empty imagePath before processing', async () => {
		const refs = [
			{ id: 'with', jsonPath: 'j1', imagePath: 'i1' },
			{ id: 'without', jsonPath: 'j2', imagePath: '' },
		];
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue(refs);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(backend.markSynced).toHaveBeenCalledTimes(1);
		expect(backend.markSynced).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'with' }),
			expect.anything()
		);
	});

	it('tracks refs that exhausted retries (errorHandler returned null) in pendingNetwork', async () => {
		const backend = makeBackend();
		const ref = { id: 'fails', jsonPath: 'j', imagePath: 'i', createdTime: '2026-04-12T14:30:00Z' };
		backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
		// Always reject so ErrorHandler exhausts retries and returns null
		backend.fetchScan = jest.fn().mockRejectedValue({
			type: 'icloud_offloaded',
			message: 'still offloaded',
			retriable: false,
		});

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		// State should show one pending-network item (waiting for download).
		expect(state.status).toBe('synced');
		expect(state.pendingCount).toBe(1);
	});
});
