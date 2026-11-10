// How the engine treats failed scans across syncs: a permanently bad scan must not
// pin the Drive cursor or toast on every poll; the "waiting for download" count
// holds only scans that are really waiting on the network; a folder needs no
// network; and a failing background Drive poll reaches the sync state.
import * as obsidian from 'obsidian';
import { requestUrl } from 'obsidian';
import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import { DriveBackend } from '@/sync/drive-backend';
import { createSyncError } from '@/errors/sync-error';
import type { SyncError } from '@/errors/sync-error';
import { STRINGS } from '@/utils/strings';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import type { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

const scan = (id: string, synced = false): ScanFile =>
	({
		version: 1,
		createdAt: '2026-10-17T12:00:00Z',
		markdown: `# ${id}`,
		confidence: 90,
		provider: 'p',
		model: 'm',
		imageFileName: `${id}.jpg`,
		...(synced ? { synced: true } : {}),
	}) as ScanFile;

const app = {
	vault: {
		getAbstractFileByPath: () => null,
		create: () => Promise.resolve({ path: 'P/note.md' }),
		createBinary: () => Promise.resolve(),
		createFolder: () => Promise.resolve(),
		adapter: { read: () => Promise.resolve(''), write: () => Promise.resolve() },
	},
	metadataCache: { getFileCache: () => null },
	fileManager: { processFrontMatter: async () => undefined },
};
const noteConfig = {
	templateString: '{{ps_markdown}}',
	saveTo: 'custom' as const, customFolder: 'PaperSync', customFileName: 'YYYY-MM-DD',
	attachmentsFolder: 'attachments/PaperSync',
	downloadImages: false,
};

const ref = (id: string, createdTime?: string, revision?: string): ScanReference => ({
	id, jsonPath: `j-${id}`, imagePath: '', createdTime, revision,
});

interface FakeBackend extends SyncBackend {
	refs: ScanReference[];
	failures: Map<string, SyncError>;
	synced: Set<string>;
	updateLastSyncTimestamp: jest.Mock;
}

function makeBackend(extra: Partial<SyncBackend> = {}): FakeBackend {
	const backend: FakeBackend = {
		refs: [],
		failures: new Map(),
		synced: new Set(),
		discoverUnsynced: jest.fn(() => Promise.resolve(backend.refs.slice())),
		fetchScan: jest.fn((r: ScanReference) => {
			const failure = backend.failures.get(r.id);
			return failure ? Promise.reject(failure) : Promise.resolve(scan(r.id, backend.synced.has(r.id)));
		}),
		fetchImage: jest.fn(() => Promise.resolve(null)),
		markSynced: jest.fn((r: ScanReference) => {
			backend.synced.add(r.id);
			return Promise.resolve();
		}),
		start: jest.fn(),
		stop: jest.fn(),
		updateLastSyncTimestamp: jest.fn(),
		...extra,
	};
	return backend;
}

describe('SyncEngine failure handling across syncs', () => {
	let notices: string[];
	beforeEach(() => {
		jest.useFakeTimers();
		notices = [];
		jest.spyOn(obsidian, 'Notice').mockImplementation(function (msg: string) {
			notices.push(msg);
		} as never);
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
	});
	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	function engineFor(backend: SyncBackend): { engine: SyncEngine; state: SyncState } {
		const state = new SyncState('');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, app as any, noteConfig, new ErrorHandler(), state);
		return { engine, state };
	}

	// Runs a sync to completion through the error handler's retry backoff.
	async function sync(engine: SyncEngine, quiet = true): Promise<void> {
		const done = engine.forceSyncNow({ quiet });
		await jest.advanceTimersByTimeAsync(10_000);
		await done;
	}

	describe('a permanently bad scan (item 1)', () => {
		const T1 = '2026-11-01T10:00:00.000Z';
		const T2 = '2026-11-01T11:00:00.000Z';

		it('lets the cursor advance past it and notifies once, not on every poll', async () => {
			const backend = makeBackend();
			backend.refs = [ref('bad', T1, 'rev1'), ref('good', T2, 'rev1')];
			backend.failures.set('bad', createSyncError('schema_mismatch', 'Unsupported scan version 9'));
			const { engine, state } = engineFor(backend);

			await sync(engine);
			expect(notices.filter((n) => n === STRINGS.NOTICE_SCHEMA_MISMATCH)).toHaveLength(1);
			expect(state.lastSyncTimestamp).toBe(T2);
			expect(backend.updateLastSyncTimestamp).toHaveBeenLastCalledWith(T2);

			// The next polls still list it (e.g. a reload before the cursor was saved):
			// no new download of it, no new notice.
			notices = [];
			await sync(engine);
			await sync(engine);
			expect(notices).toEqual([]);
			expect((backend.fetchScan as jest.Mock).mock.calls.filter(([r]) => (r as ScanReference).id === 'bad')).toHaveLength(1);
			expect(state.status).toBe('synced');
			engine.stop();
		});

		it('retries it once its file changes', async () => {
			const backend = makeBackend();
			backend.refs = [ref('bad', T1, 'rev1')];
			backend.failures.set('bad', createSyncError('scan_too_large', 'bad.json is 30 MB'));
			const { engine } = engineFor(backend);
			await sync(engine);
			expect(notices).toContain(STRINGS.NOTICE_SCAN_TOO_LARGE);

			// Fixed on the phone: a new revision imports.
			backend.failures.delete('bad');
			backend.refs = [ref('bad', T1, 'rev2')];
			await sync(engine);
			expect(backend.markSynced).toHaveBeenCalledTimes(1);
			engine.stop();
		});

		it('forgets it once a listing no longer has it, and remembers a scan without a revision', async () => {
			const backend = makeBackend();
			backend.refs = [ref('bad', T1)];
			backend.failures.set('bad', createSyncError('schema_mismatch', 'not a scan'));
			const { engine } = engineFor(backend);
			await sync(engine);
			await sync(engine);
			const fetchesOfBad = (): number => (backend.fetchScan as jest.Mock).mock.calls.filter(([r]) => (r as ScanReference).id === 'bad').length;
			expect(fetchesOfBad()).toBe(1);

			// Gone from one listing (moved away), back in a later one: tried again.
			backend.refs = [ref('other', T2)];
			await sync(engine);
			backend.refs = [ref('bad', T1)];
			await sync(engine);
			expect(fetchesOfBad()).toBe(2);
			engine.stop();
		});

		it('still holds the cursor behind a retriable failure', async () => {
			const backend = makeBackend();
			backend.refs = [ref('slow', T1, 'rev1'), ref('good', T2, 'rev1')];
			backend.failures.set('slow', createSyncError('network_timeout', 'timeout'));
			const { engine, state } = engineFor(backend);
			await sync(engine);
			expect(state.lastSyncTimestamp).toBe('');
			await sync(engine);
			// A retriable failure is retried on every sync.
			expect((backend.fetchScan as jest.Mock).mock.calls.filter(([r]) => (r as ScanReference).id === 'slow').length).toBeGreaterThan(3);
			engine.stop();
		});
	});

	describe('the waiting-for-download count (items 5 and 8)', () => {
		it('does not count a failure that is not a download wait', async () => {
			const backend = makeBackend();
			backend.refs = [ref('locked')];
			backend.failures.set('locked', createSyncError('folder_access', 'Cannot access locked.json (EACCES)', false));
			const { engine, state } = engineFor(backend);
			await sync(engine);
			expect(notices.some((n) => n.startsWith('Papersync: waiting'))).toBe(false);
			expect(state.pendingCount).toBe(0);
			engine.stop();
		});

		it('drops a waiting scan that the next listing no longer has', async () => {
			const backend = makeBackend();
			backend.refs = [ref('cloud')];
			backend.failures.set('cloud', createSyncError('icloud_offloaded', 'not downloaded'));
			const { engine, state } = engineFor(backend);
			await sync(engine);
			expect(notices).toContain(STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(1));
			expect(state.pendingCount).toBe(1);

			// Imported elsewhere (another vault): gone from the listing.
			notices = [];
			backend.refs = [ref('other')];
			await sync(engine);
			expect(notices.some((n) => n.startsWith('Papersync: waiting'))).toBe(false);
			expect(state.pendingCount).toBe(0);
			engine.stop();
		});

		it('drops a waiting scan that turns out to be already synced', async () => {
			const backend = makeBackend();
			backend.refs = [ref('cloud')];
			backend.failures.set('cloud', createSyncError('icloud_offloaded', 'not downloaded'));
			const { engine, state } = engineFor(backend);
			await sync(engine);
			expect(state.pendingCount).toBe(1);

			backend.failures.delete('cloud');
			backend.synced.add('cloud');
			notices = [];
			await sync(engine);
			expect(notices.some((n) => n.startsWith('Papersync: waiting'))).toBe(false);
			expect(state.pendingCount).toBe(0);
			engine.stop();
		});
	});

	describe('offline (item 10)', () => {
		it('keeps a folder backend syncing while the computer is offline', async () => {
			Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
			const backend = makeBackend();
			backend.refs = [ref('local')];
			const { engine, state } = engineFor(backend);
			engine.start();
			expect(backend.start).toHaveBeenCalledTimes(1);
			expect(state.status).not.toBe('offline');

			await sync(engine, false);
			expect(notices).not.toContain(STRINGS.NOTICE_OFFLINE);
			expect(backend.markSynced).toHaveBeenCalledTimes(1);

			// Going offline does not stop it either.
			window.dispatchEvent(new Event('offline'));
			expect(backend.stop).not.toHaveBeenCalled();
			engine.stop();
		});

		it('pauses a backend that needs the network', async () => {
			Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
			const backend = makeBackend({ needsNetwork: true });
			const { engine, state } = engineFor(backend);
			engine.start();
			expect(backend.start).not.toHaveBeenCalled();
			expect(state.status).toBe('offline');
			engine.stop();
		});
	});
});

describe('background Drive polls report to the sync state (item 15)', () => {
	const oauth = { getValidAccessToken: jest.fn(() => Promise.resolve('tok')) } as unknown as OAuthManager;
	const response = (status: number, json: unknown = {}): never =>
		({ status, json, headers: {}, arrayBuffer: new ArrayBuffer(0) }) as never;

	beforeEach(() => {
		jest.useFakeTimers();
		mockedRequestUrl.mockReset();
		jest.spyOn(obsidian, 'Notice').mockImplementation(function () { /* silent */ } as never);
		Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
	});
	afterEach(() => {
		jest.restoreAllMocks();
		jest.useRealTimers();
	});

	function start(): { engine: SyncEngine; state: SyncState } {
		const backend = new DriveBackend(oauth, 30, '');
		const state = new SyncState('');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, app as any, noteConfig, new ErrorHandler(), state);
		engine.start();
		return { engine, state };
	}

	const folderFound = (): never => response(200, { files: [{ id: 'folder' }] });

	it('shows a permission error, then clears it on the next good poll', async () => {
		mockedRequestUrl.mockResolvedValueOnce(response(403, { error: { message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }] } }));
		const { engine, state } = start();
		await jest.advanceTimersByTimeAsync(0);
		expect(state.status).toBe('error');
		expect(state.lastError).toContain('does not have permission');

		mockedRequestUrl.mockResolvedValueOnce(folderFound()).mockResolvedValueOnce(response(200, { files: [] }));
		await jest.advanceTimersByTimeAsync(30_000);
		expect(state.status).toBe('synced');
		expect(state.lastError).toBeNull();

		// A quiet empty poll after that records nothing new.
		const listener = jest.fn();
		state.subscribe(listener);
		mockedRequestUrl.mockResolvedValueOnce(response(200, { files: [] }));
		await jest.advanceTimersByTimeAsync(30_000);
		expect(listener).not.toHaveBeenCalled();
		engine.stop();
	});

	it('shows repeated server errors, not a single one', async () => {
		mockedRequestUrl.mockResolvedValue(response(503, { error: { message: 'Backend Error' } }));
		const { engine, state } = start();
		await jest.advanceTimersByTimeAsync(0);
		expect(state.status).not.toBe('error');
		await jest.advanceTimersByTimeAsync(60_000);
		expect(state.status).toBe('error');
		expect(state.lastError).toContain('Backend Error');
		engine.stop();
	});

	it('shows a revoked sign-in at once', async () => {
		const revoked = { getValidAccessToken: jest.fn(() => Promise.reject(createSyncError('token_revoked', 'Refresh token revoked. Reconnect in settings'))) } as unknown as OAuthManager;
		const backend = new DriveBackend(revoked, 30, '');
		const state = new SyncState('');
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const engine = new SyncEngine(backend, app as any, noteConfig, new ErrorHandler(), state);
		engine.start();
		await jest.advanceTimersByTimeAsync(0);
		expect(state.status).toBe('error');
		expect(state.lastError).toContain('Reconnect');
		engine.stop();
	});
});
