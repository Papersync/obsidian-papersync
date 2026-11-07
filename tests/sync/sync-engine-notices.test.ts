// While a Drive scan waits for its photo the cursor stays behind it, so every poll
// re-lists that scan plus every newer, already-synced one. Those re-checks must not
// toast "syncing N scans" (N counting scans that are only skipped).
import * as obsidian from 'obsidian';
import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import { STRINGS } from '@/utils/strings';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';

const T0 = new Date('2026-10-17T12:00:00Z').getTime();
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
	downloadImages: true,
};

// A Drive-like backend: `waiting` has no photo yet, `newer` imports on first sight
// and is re-listed (already synced) on every later poll because the cursor is held.
function makeDrive(): {
	backend: SyncBackend & { companionGraceMs: number };
	syncedIds: Set<string>;
	photoArrived: { value: boolean };
	refs: ScanReference[];
} {
	const syncedIds = new Set<string>();
	const photoArrived = { value: false };
	const refs: ScanReference[] = [
		{ id: 'waiting', jsonPath: 'jw', imagePath: '', createdTime: new Date(T0).toISOString() },
		{ id: 'newer', jsonPath: 'jn', imagePath: 'in', createdTime: new Date(T0 + 1000).toISOString() },
	];
	const backend = {
		companionGraceMs: 300_000,
		discoverUnsynced: jest.fn(() => Promise.resolve(refs.slice())),
		fetchScan: jest.fn((ref: ScanReference) => Promise.resolve(scan(ref.id, syncedIds.has(ref.id)))),
		fetchImage: jest.fn((ref: ScanReference) =>
			Promise.resolve(ref.id === 'waiting' && !photoArrived.value ? null : new ArrayBuffer(4))
		),
		markSynced: jest.fn((ref: ScanReference) => {
			syncedIds.add(ref.id);
			return Promise.resolve();
		}),
		start: jest.fn(),
		stop: jest.fn(),
	};
	return { backend, syncedIds, photoArrived, refs };
}

describe('syncing notice counts only scans that will do work', () => {
	let notices: string[];
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(T0 + 10_000);
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
		const engine = new SyncEngine(backend, app as any, noteConfig, new ErrorHandler(state), state);
		return { engine, state };
	}
	const syncing = () => notices.filter((n) => n.startsWith('Papersync: syncing'));

	it('stays silent on background re-checks while a scan waits for its photo', async () => {
		const { backend, photoArrived } = makeDrive();
		const { engine } = engineFor(backend);
		await engine.forceSyncNow({ quiet: true }); // first sight: real work
		expect(syncing()).toEqual([STRINGS.NOTICE_SYNCING(2)]);
		expect(notices).toContain(STRINGS.NOTICE_SYNC_COMPLETE(1));
		notices = [];
		for (let poll = 1; poll <= 9; poll++) {
			jest.setSystemTime(T0 + 10_000 + poll * 30_000);
			await engine.forceSyncNow({ quiet: true });
		}
		expect(notices).toEqual([]);
		// The photo arrives: the waiting scan imports and says so.
		photoArrived.value = true;
		await engine.forceSyncNow({ quiet: true });
		expect(syncing()).toEqual([]);
		expect(notices).toEqual([STRINGS.NOTICE_SYNC_COMPLETE(1)]);
		expect(backend.markSynced).toHaveBeenCalledTimes(2);
		engine.stop();
	});

	it('announces the text-only import when the grace deadline passes', async () => {
		const { backend } = makeDrive();
		const { engine } = engineFor(backend);
		await engine.forceSyncNow({ quiet: true });
		notices = [];
		jest.setSystemTime(T0 + 300_000);
		await engine.forceSyncNow({ quiet: true });
		expect(notices).toEqual([STRINGS.NOTICE_SYNC_COMPLETE(1)]);
		engine.stop();
	});

	it('counts a genuinely new scan, but not the waiting or already-synced ones', async () => {
		const { backend, refs } = makeDrive();
		const { engine } = engineFor(backend);
		await engine.forceSyncNow({ quiet: true });
		notices = [];
		refs.push({ id: 'fresh', jsonPath: 'jf', imagePath: 'if', createdTime: new Date(T0 + 5000).toISOString() });
		await engine.forceSyncNow({ quiet: true });
		expect(notices).toEqual([STRINGS.NOTICE_SYNCING(1), STRINGS.NOTICE_SYNC_COMPLETE(1)]);
		engine.stop();
	});

	it('a manual Sync now with only a waiting scan says it is waiting', async () => {
		const { backend } = makeDrive();
		const { engine } = engineFor(backend);
		await engine.forceSyncNow({ quiet: true });
		notices = [];
		await engine.forceSyncNow();
		expect(notices).toEqual([STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(1)]);
		engine.stop();
	});

	it('a manual Sync now with only already-synced re-lists says nothing new', async () => {
		const { backend, photoArrived } = makeDrive();
		photoArrived.value = true;
		const { engine } = engineFor(backend);
		await engine.forceSyncNow({ quiet: true });
		notices = [];
		await engine.forceSyncNow();
		expect(notices).toEqual([STRINGS.NOTICE_NOTHING_NEW]);
		notices = [];
		await engine.forceSyncNow({ quiet: true });
		expect(notices).toEqual([]);
		engine.stop();
	});

	it('a manual Sync now that first sees a photo-less scan says it is waiting', async () => {
		const { backend, refs } = makeDrive();
		refs.splice(1);
		const { engine } = engineFor(backend);
		await engine.forceSyncNow();
		expect(notices).toEqual([STRINGS.NOTICE_SYNCING(1), STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(1)]);
		engine.stop();
	});
});
