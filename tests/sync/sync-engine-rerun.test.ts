// A discovery that lands while a batch runs is not dropped, and a scan that
// failed with a retriable error is retried on a schedule when the backend does
// not poll on its own.
import { SyncEngine, RETRY_SCHEDULE_MS } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import { createSyncError } from '@/errors/sync-error';
import type { ScanReference, SyncBackend } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';

const scan: ScanFile = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: 'text',
	confidence: 90,
	provider: 'p',
	model: 'm',
	imageFileName: 'a.jpg',
	synced: false,
};

const app = {
	vault: {
		getAbstractFileByPath: () => null,
		create: jest.fn().mockResolvedValue({ path: 'P/note.md' }),
		createBinary: jest.fn().mockResolvedValue(undefined),
		createFolder: jest.fn().mockResolvedValue(undefined),
	},
	internalPlugins: { getPluginById: () => null },
	metadataCache: { getFileCache: () => null },
	fileManager: { processFrontMatter: async () => undefined },
};

const noteConfig = { templateString: '{{ps_markdown}}', saveTo: 'custom' as const, customFolder: 'P', customFileName: 'YYYY-MM-DD', attachmentsFolder: '', downloadImages: false };

type Backend = SyncBackend & { discovered: (refs: ScanReference[]) => Promise<void> };

function makeBackend(polls = false): Backend {
	let callback: ((refs: ScanReference[]) => Promise<void> | void) | null = null;
	const backend = {
		polls,
		discoverUnsynced: jest.fn().mockResolvedValue([]),
		fetchScan: jest.fn().mockResolvedValue(scan),
		fetchImage: jest.fn().mockResolvedValue(null),
		markSynced: jest.fn().mockResolvedValue(undefined),
		start: jest.fn(),
		stop: jest.fn(),
		setOnScanDiscovered(cb: (refs: ScanReference[]) => Promise<void> | void) { callback = cb; },
		discovered: (refs: ScanReference[]) => Promise.resolve(callback?.(refs)),
	};
	return backend as unknown as Backend;
}

const ref = (id: string): ScanReference => ({ id, jsonPath: `/f/${id}.json`, imagePath: '' });

function makeEngine(backend: Backend): SyncEngine {
	const state = new SyncState('');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new SyncEngine(backend, app as any, noteConfig, new ErrorHandler(), state);
}

describe('SyncEngine reruns and retries', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.clearAllMocks();
	});
	afterEach(() => { jest.useRealTimers(); });

	it('runs one more discovery after a batch when another arrived meanwhile', async () => {
		const backend = makeBackend();
		let release!: () => void;
		(backend.fetchScan as jest.Mock).mockImplementationOnce(() => new Promise<ScanFile>((resolve) => { release = () => resolve(scan); }));
		(backend.discoverUnsynced as jest.Mock).mockResolvedValue([ref('late')]);
		const engine = makeEngine(backend);

		const first = backend.discovered([ref('early')]);
		await jest.advanceTimersByTimeAsync(0);
		await backend.discovered([ref('late')]); // dropped before: the lock is held
		await engine.forceSyncNow(); // a Sync now during the batch asks for the same rerun
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();

		release();
		await first;
		await jest.advanceTimersByTimeAsync(0);

		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(1);
		expect((backend.fetchScan as jest.Mock).mock.calls.map(([r]) => (r as ScanReference).id)).toEqual(['early', 'late']);
		engine.stop();
	});

	it('retries a scan waiting for download on a growing schedule until it imports', async () => {
		const backend = makeBackend();
		const offloaded = createSyncError('icloud_offloaded', 'File not yet downloaded: a.json');
		(backend.fetchScan as jest.Mock).mockRejectedValue(offloaded);
		(backend.discoverUnsynced as jest.Mock).mockResolvedValue([ref('a')]);
		const engine = makeEngine(backend);
		engine.start();

		const pass = backend.discovered([ref('a')]);
		await jest.advanceTimersByTimeAsync(4_000); // the in-batch 1 s + 3 s retries
		await pass;
		expect(backend.fetchScan).toHaveBeenCalledTimes(3);

		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[0] + 4_000);
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(1);
		expect(backend.fetchScan).toHaveBeenCalledTimes(6);

		(backend.fetchScan as jest.Mock).mockResolvedValue(scan);
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[0]);
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(1); // the second step is longer
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[1] - RETRY_SCHEDULE_MS[0]);
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(2);
		expect(backend.markSynced).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] * 2);
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(2);
		expect(jest.getTimerCount()).toBe(0);
		engine.stop();
	});

	it('stays at the last step of the schedule', async () => {
		const backend = makeBackend();
		(backend.fetchScan as jest.Mock).mockRejectedValue(createSyncError('icloud_offloaded', 'x'));
		(backend.discoverUnsynced as jest.Mock).mockResolvedValue([ref('a')]);
		const engine = makeEngine(backend);
		const pass = backend.discovered([ref('a')]);
		const total = RETRY_SCHEDULE_MS.reduce((sum, ms) => sum + ms + 4_000, 0);
		await jest.advanceTimersByTimeAsync(4_000 + total + RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] + 4_000);
		await pass;
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(RETRY_SCHEDULE_MS.length + 1);
		engine.stop();
	});

	it('drops a retry when discovery no longer lists the scan', async () => {
		const backend = makeBackend();
		(backend.fetchScan as jest.Mock).mockRejectedValueOnce(createSyncError('folder_access', 'busy', true))
			.mockRejectedValueOnce(createSyncError('folder_access', 'busy', true))
			.mockRejectedValueOnce(createSyncError('folder_access', 'busy', true));
		const engine = makeEngine(backend);
		const pass = backend.discovered([ref('a')]);
		await jest.advanceTimersByTimeAsync(4_000);
		await pass;
		// The next background pass lists another scan only: 'a' was synced elsewhere.
		await backend.discovered([ref('b')]);
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[0] * 4);
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
		engine.stop();
	});

	it('forgets retries when a full discovery finds nothing', async () => {
		const backend = makeBackend();
		(backend.fetchScan as jest.Mock).mockRejectedValue(createSyncError('icloud_offloaded', 'x'));
		const engine = makeEngine(backend);
		const pass = backend.discovered([ref('a')]);
		await jest.advanceTimersByTimeAsync(4_000);
		await pass;
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[0]); // discovery now lists nothing
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] * 2);
		expect(backend.discoverUnsynced).toHaveBeenCalledTimes(1);
		engine.stop();
	});

	it('does not schedule retries for a backend that polls, or for a non-retriable failure', async () => {
		for (const [polls, error] of [
			[true, createSyncError('icloud_offloaded', 'x')],
			[false, createSyncError('folder_access', 'read-only', false)],
		] as const) {
			const backend = makeBackend(polls);
			(backend.fetchScan as jest.Mock).mockRejectedValue(error);
			const engine = makeEngine(backend);
			const pass = backend.discovered([ref('a')]);
			await jest.advanceTimersByTimeAsync(4_000);
			await pass;
			expect(jest.getTimerCount()).toBe(0);
			engine.stop();
		}
	});

	it('runs no rerun or retry once stopped', async () => {
		const backend = makeBackend();
		let release!: () => void;
		(backend.fetchScan as jest.Mock)
			.mockImplementationOnce(() => new Promise<ScanFile>((_resolve, reject) => {
				release = () => reject(createSyncError('icloud_offloaded', 'x'));
			}))
			.mockRejectedValue(createSyncError('icloud_offloaded', 'x'));
		const engine = makeEngine(backend);
		const pass = backend.discovered([ref('a')]);
		await jest.advanceTimersByTimeAsync(0);
		await backend.discovered([ref('b')]);
		engine.stop();
		release();
		await jest.advanceTimersByTimeAsync(4_000);
		await pass;
		await jest.advanceTimersByTimeAsync(RETRY_SCHEDULE_MS[RETRY_SCHEDULE_MS.length - 1] * 2);
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(0);
	});

	it('a stopped engine neither syncs nor imports a late discovery, and stops mid-batch', async () => {
		const backend = makeBackend();
		const engine = makeEngine(backend);
		engine.stop();
		await engine.forceSyncNow();
		await backend.discovered([ref('a')]);
		expect(backend.discoverUnsynced).not.toHaveBeenCalled();
		expect(backend.fetchScan).not.toHaveBeenCalled();

		engine.start();
		(backend.fetchScan as jest.Mock).mockImplementationOnce(async () => { engine.stop(); return scan; });
		await backend.discovered([ref('a'), ref('b')]);
		expect(backend.fetchScan).toHaveBeenCalledTimes(1);
	});
});
