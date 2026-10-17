import * as obsidian from 'obsidian';


import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import { createSyncError } from '@/errors/sync-error';
import { STRINGS } from '@/utils/strings';
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
	templateString: '{{ps_markdown}}',
	targetFolder: 'PaperSync',
	attachmentsFolder: 'attachments/PaperSync',
	downloadImages: false,
};

function makeApp(): {
	vault: {
		getAbstractFileByPath: () => null;
		create: () => Promise<void>;
		createBinary: () => Promise<void>;
		createFolder: () => Promise<void>;
		adapter: { read: () => Promise<string>; write: () => Promise<void> };
	};
} {
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

	it('skips a scan removed between discovery and fetch, without retries or an error', async () => {
		const backend = makeBackend();
		const ref = { id: 'gone', jsonPath: '/x/gone.json', imagePath: '/x/gone.jpg' };
		(backend.discoverUnsynced as jest.Mock).mockResolvedValue([ref]);
		(backend.fetchScan as jest.Mock).mockRejectedValue(createSyncError('scan_missing', 'File removed from scans folder: gone.json'));
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(backend.fetchScan).toHaveBeenCalledTimes(1);
		expect(backend.markSynced).not.toHaveBeenCalled();
		expect(state.status).toBe('synced');
		expect(state.lastError).toBeNull();
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

	it('a quiet forceSyncNow (the photo-wait retry) shows no notice when offline or when nothing is new', async () => {
		// A plain function: jest-mock calls the implementation without `new`.
		const notice = jest.spyOn(obsidian, 'Notice').mockImplementation(function () {} as never);
		try {
			const backend = makeBackend();
			backend.discoverUnsynced = jest.fn().mockResolvedValue([]);
			const state = new SyncState('');
			const eh = new ErrorHandler(state);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

			await engine.forceSyncNow({ quiet: true });
			expect(state.status).toBe('synced');
			Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
			await engine.forceSyncNow({ quiet: true });
			expect(notice).not.toHaveBeenCalled();

			await engine.forceSyncNow();
			expect(notice).toHaveBeenCalledTimes(1);
		} finally {
			Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
			notice.mockRestore();
		}
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

	it('forceSyncNow with nothing new still advances the completion stamp and notifies (already-synced state)', async () => {
		jest.useFakeTimers().setSystemTime(new Date('2026-07-19T10:00:00Z'));
		try {
			const backend = makeBackend();
			backend.discoverUnsynced = jest.fn().mockResolvedValue([]);
			const state = new SyncState('');
			const eh = new ErrorHandler(state);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

			await engine.forceSyncNow();
			const firstStamp = state.lastSyncCompletedAt;
			expect(firstStamp).toBe(Date.parse('2026-07-19T10:00:00Z'));

			const listener = jest.fn();
			state.subscribe(listener);
			jest.setSystemTime(new Date('2026-07-19T10:05:00Z'));
			await engine.forceSyncNow(); // status stays 'synced', 0 pending — the old setStatus path stayed silent here

			expect(listener).toHaveBeenCalledTimes(1);
			expect(state.lastSyncCompletedAt).toBe(Date.parse('2026-07-19T10:05:00Z'));
		} finally {
			jest.useRealTimers();
		}
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

	it('forceSyncNow records plain-language guidance, not the raw path, when the folder is missing', async () => {
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockRejectedValue(
			createSyncError('folder_missing', 'Papersync folder not found: /Volumes/Gone/Papersync')
		);
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(state.status).toBe('error');
		expect(state.lastError).toBe(STRINGS.NOTICE_FOLDER_MISSING);
		expect(state.lastError).not.toContain('/Volumes/Gone');
	});

	it('forceSyncNow keeps the real reason for a non-folder failure', async () => {
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockRejectedValue(new Error('boom'));
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();
		expect(state.lastError).toBe('boom');
	});

	it('records a source the backend reports unavailable, in plain language', () => {
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			setOnUnavailable: jest.Mock;
		};
		backend.setOnUnavailable = jest.fn();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		const report = backend.setOnUnavailable.mock.calls[0]![0] as (e: unknown) => void;
		report(createSyncError('folder_missing', 'Papersync folder not found: /Volumes/Gone/Papersync'));
		expect(state.status).toBe('error');
		expect(state.lastError).toBe(STRINGS.NOTICE_FOLDER_MISSING);
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

	it('keeps the error when the source vanishes while a batch is still in flight', async () => {
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			setOnUnavailable: jest.Mock;
		};
		backend.setOnUnavailable = jest.fn();
		backend.discoverUnsynced = jest
			.fn()
			.mockResolvedValue([{ id: 'r1', jsonPath: 'j1', imagePath: 'i1' }]);
		let releaseFetch!: () => void;
		backend.fetchScan = jest.fn(
			() =>
				new Promise((resolve) => {
					releaseFetch = () => resolve({ ...validScan, synced: true });
				})
		);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);
		const report = backend.setOnUnavailable.mock.calls[0]![0] as (e: unknown) => void;

		const sync = engine.forceSyncNow();
		await new Promise((r) => setTimeout(r, 0)); // discovery resolved, fetch still pending
		expect(backend.fetchScan).toHaveBeenCalledTimes(1);
		report(createSyncError('folder_missing', 'Papersync folder not found: /gone'));
		releaseFetch();
		await sync;

		expect(state.status).toBe('error');
		expect(state.lastError).toBe(STRINGS.NOTICE_FOLDER_MISSING);
	});

	it('clears that hold on the next pass the backend delivers (the folder is back)', async () => {
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			setOnUnavailable: jest.Mock;
			setOnScanDiscovered: jest.Mock;
		};
		backend.setOnUnavailable = jest.fn();
		backend.setOnScanDiscovered = jest.fn();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);
		const report = backend.setOnUnavailable.mock.calls[0]![0] as (e: unknown) => void;
		const discovered = backend.setOnScanDiscovered.mock.calls[0]![0] as (refs: unknown[]) => Promise<void>;

		report(createSyncError('folder_missing', 'Papersync folder not found: /gone'));
		expect(state.status).toBe('error');
		await discovered([]); // the recovery pass: empty, but proof the folder is readable again
		expect(state.status).toBe('synced');
		expect(state.lastError).toBeNull();
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

	it('imports older image-less refs as text when images are enabled', async () => {
		jest.useFakeTimers();
		const refs = [
			{ id: 'with', jsonPath: 'j1', imagePath: 'i1' },
			{ id: 'without', jsonPath: 'j2', imagePath: '' },
		];
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue(refs);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.fetchImage = jest
			.fn()
			.mockImplementation(async (ref) => (ref.imagePath ? new ArrayBuffer(4) : null));
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// downloadImages ON → an image-less ref cannot produce an embed, so it is dropped.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(
			backend,
			makeApp() as any,
			{ ...noteConfig, downloadImages: true },
			eh,
			state
		);

		await engine.forceSyncNow();
		(backend.discoverUnsynced as jest.Mock).mockResolvedValue([refs[1]]);
		jest.setSystemTime(Date.now() + 60_000);
		await engine.forceSyncNow();
		engine.stop();
		jest.useRealTimers();

		expect(backend.markSynced).toHaveBeenCalledTimes(2);
		expect(backend.markSynced).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'with' }),
			expect.anything()
		);
	});

	it('keeps image-less refs when downloadImages is off (#11)', async () => {
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
		// noteConfig.downloadImages is false → the empty-imagePath ref still produces a note.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(backend.markSynced).toHaveBeenCalledTimes(2);
		expect(backend.fetchImage).not.toHaveBeenCalled();
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

	it('returns immediately when a sync is already in flight (tryStartSync guard)', async () => {
		const backend = makeBackend();
		backend.fetchScan = jest.fn();
		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		// Occupy the sync lock so processBatch's `!tryStartSync()` guard trips.
		expect(state.tryStartSync()).toBe(true);

		await (engine as unknown as { processBatch(refs: unknown[]): Promise<void> }).processBatch([
			{ id: 'r', jsonPath: 'j', imagePath: 'i' },
		]);

		expect(backend.fetchScan).not.toHaveBeenCalled();
	});

	// A non-retriable failure fails fast (no backoff sleep) — ideal for cursor-contiguity tests.
	const nonRetriable = { type: 'schema_mismatch', message: 'nope', retriable: false };

	it('does not advance the cursor to or past an earlier FAILED scan (#2)', async () => {
		// A (earlier) fails, B (later) succeeds. Advancing to B would strand A forever
		// because Drive re-queries `createdTime > cursor` and A lives only in memory.
		const refA = { id: 'A', jsonPath: 'jA', imagePath: 'iA', createdTime: '2026-05-01T10:00:00Z' };
		const refB = { id: 'B', jsonPath: 'jB', imagePath: 'iB', createdTime: '2026-05-02T10:00:00Z' };
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			updateLastSyncTimestamp: jest.Mock;
		};
		backend.updateLastSyncTimestamp = jest.fn();
		// Deliberately out of createdTime order — the engine must sort before advancing.
		backend.discoverUnsynced = jest.fn().mockResolvedValue([refB, refA]);
		backend.fetchScan = jest.fn().mockImplementation(async (ref: { id: string }) => {
			if (ref.id === 'A') {
				throw nonRetriable;
			}
			return validScan;
		});
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(state.lastSyncTimestamp).toBe('');
		expect(backend.updateLastSyncTimestamp).not.toHaveBeenCalled();
	});

	it('advances the cursor only up to the last success BEFORE the first failure (#2)', async () => {
		const refA = { id: 'A', jsonPath: 'jA', imagePath: 'iA', createdTime: '2026-05-01T10:00:00Z' }; // ok
		const refB = { id: 'B', jsonPath: 'jB', imagePath: 'iB', createdTime: '2026-05-02T10:00:00Z' }; // fail
		const refC = { id: 'C', jsonPath: 'jC', imagePath: 'iC', createdTime: '2026-05-03T10:00:00Z' }; // ok
		const backend = makeBackend() as ReturnType<typeof makeBackend> & {
			updateLastSyncTimestamp: jest.Mock;
		};
		backend.updateLastSyncTimestamp = jest.fn();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([refC, refA, refB]);
		backend.fetchScan = jest.fn().mockImplementation(async (ref: { id: string }) => {
			if (ref.id === 'B') {
				throw nonRetriable;
			}
			return validScan;
		});
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		// C succeeded but is after B's failure → cursor holds at A, not C.
		expect(state.lastSyncTimestamp).toBe('2026-05-01T10:00:00Z');
		expect(backend.updateLastSyncTimestamp).toHaveBeenLastCalledWith('2026-05-01T10:00:00Z');
	});

	it('keeps the cursor pinned to the earliest of MULTIPLE failures (#2)', async () => {
		// A and B both fail (A earliest), C succeeds after both → cursor never advances.
		const refA = { id: 'A', jsonPath: 'jA', imagePath: 'iA', createdTime: '2026-05-01T10:00:00Z' };
		const refB = { id: 'B', jsonPath: 'jB', imagePath: 'iB', createdTime: '2026-05-02T10:00:00Z' };
		const refC = { id: 'C', jsonPath: 'jC', imagePath: 'iC', createdTime: '2026-05-03T10:00:00Z' };
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([refA, refB, refC]);
		backend.fetchScan = jest.fn().mockImplementation(async (ref: { id: string }) => {
			if (ref.id === 'A' || ref.id === 'B') {throw nonRetriable;}
			return validScan;
		});
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(state.lastSyncTimestamp).toBe('');
	});

	it('ignores a failed ref that has no createdTime for cursor purposes (#2)', async () => {
		// Folder-backend refs carry no createdTime — a failure there must not touch the cursor.
		const ref = { id: 'no-ts', jsonPath: 'j', imagePath: 'i' };
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
		backend.fetchScan = jest.fn().mockRejectedValue(nonRetriable);

		const state = new SyncState('2026-01-01T00:00:00Z');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(state.lastSyncTimestamp).toBe('2026-01-01T00:00:00Z');
		expect(state.pendingCount).toBe(1);
	});

	it('does not double-advance when two successes share a createdTime (#2 tie)', async () => {
		const t = '2026-06-01T00:00:00Z';
		const refA = { id: 'A', jsonPath: 'jA', imagePath: 'iA', createdTime: t };
		const refB = { id: 'B', jsonPath: 'jB', imagePath: 'iB', createdTime: t };
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([refA, refB]);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await engine.forceSyncNow();

		expect(state.lastSyncTimestamp).toBe(t);
	});

	it('releases the sync lock via finally even when the batch body throws (#12)', async () => {
		const ref = { id: 'r', jsonPath: 'j', imagePath: 'i', createdTime: '2026-04-12T14:30:00Z' };
		const backend = makeBackend();
		backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
		backend.fetchScan = jest.fn().mockResolvedValue(validScan);
		backend.markSynced = jest.fn().mockResolvedValue(undefined);

		const state = new SyncState('');
		const eh = new ErrorHandler(state);
		// Force a throw from the tail of the try block (after the sync lock was taken).
		jest.spyOn(eh, 'resetRetries').mockImplementation(() => { throw new Error('boom in body'); });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, makeApp() as any, noteConfig, eh, state);

		await expect(
			(engine as unknown as { processBatch(refs: unknown[]): Promise<void> }).processBatch([ref])
		).rejects.toThrow('boom in body');

		// finally released the lock despite the throw → a future sync isn't deadlocked.
		expect(state.isSyncing).toBe(false);
	});

	describe('missing companion grace per backend', () => {
		const NOW = new Date('2026-10-17T12:00:00Z').getTime();
		const imagesOn = { ...noteConfig, downloadImages: true };
		function pendingEngine(createdTime: string | undefined, companionGraceMs?: number, override?: () => unknown) {
			const backend = makeBackend() as ReturnType<typeof makeBackend> & { companionGraceMs?: number };
			if (companionGraceMs !== undefined) {
				backend.companionGraceMs = companionGraceMs;
			}
			const ref = { id: 'json-first', jsonPath: 'j', imagePath: '', createdTime };
			backend.discoverUnsynced = jest.fn().mockResolvedValue([ref]);
			backend.fetchScan = jest.fn().mockResolvedValue({
				version: 1, createdAt: '2026-10-17T12:00:00Z', markdown: '# t', confidence: 90,
				provider: 'p', model: 'm', imageFileName: 'json-first.jpg',
			});
			backend.fetchImage = jest.fn().mockResolvedValue(null);
			backend.markSynced = jest.fn().mockResolvedValue(undefined);
			const state = new SyncState('');
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const engine = new SyncEngine(backend, makeApp() as any, imagesOn, new ErrorHandler(state), state, override);
			return { engine, backend };
		}
		beforeEach(() => {
			jest.useFakeTimers();
		});
		afterEach(() => jest.useRealTimers());

		it('holds a Drive JSON until 5 minutes after its createdTime', async () => {
			const { engine, backend } = pendingEngine(new Date(NOW).toISOString(), 300_000);
			jest.setSystemTime(NOW + 240_000); // 4 min after upload: past the old 60 s window
			await engine.forceSyncNow();
			jest.setSystemTime(NOW + 299_999);
			await engine.forceSyncNow();
			expect(backend.markSynced).not.toHaveBeenCalled();
			jest.setSystemTime(NOW + 300_000);
			await engine.forceSyncNow();
			expect(backend.markSynced).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('keeps the 60 s first-sight grace for backends without their own window', async () => {
			const { engine, backend } = pendingEngine(undefined);
			jest.setSystemTime(NOW);
			await engine.forceSyncNow();
			jest.setSystemTime(NOW + 59_999);
			await engine.forceSyncNow();
			expect(backend.markSynced).not.toHaveBeenCalled();
			jest.setSystemTime(NOW + 60_000);
			await engine.forceSyncNow();
			expect(backend.markSynced).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('honours the test-only override supplier', async () => {
			const { engine, backend } = pendingEngine(new Date(NOW).toISOString(), 300_000, () => 2000);
			jest.setSystemTime(NOW);
			await engine.forceSyncNow();
			jest.setSystemTime(NOW + 2000);
			await engine.forceSyncNow();
			expect(backend.markSynced).toHaveBeenCalledTimes(1);
			engine.stop();
		});
	});
});
