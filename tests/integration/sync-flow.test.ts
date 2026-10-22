import { TFile } from 'obsidian';
import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';

const validScanFile: ScanFile = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Integration Test\n\nHandwritten notes converted.',
	confidence: 92,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName: '2026-04-12-143000.jpg',
	synced: false,
};

const scanRef: ScanReference = {
	id: '2026-04-12-143000',
	jsonPath: '/mock/path/2026-04-12-143000.json',
	imagePath: '/mock/path/2026-04-12-143000.jpg',
};

function createMockBackend(scans: ScanReference[] = [scanRef]): SyncBackend & {
	setOnScanDiscovered: (cb: (refs: ScanReference[]) => void) => void;
	markSyncedCalls: ScanReference[];
} {
	const markSyncedCalls: ScanReference[] = [];
	let onDiscover: ((refs: ScanReference[]) => void) | null = null;

	return {
		markSyncedCalls,
		discoverUnsynced: jest.fn().mockResolvedValue(scans),
		fetchScan: jest.fn().mockResolvedValue(validScanFile),
		fetchImage: jest.fn().mockResolvedValue(new ArrayBuffer(100)),
		markSynced: jest.fn().mockImplementation(async (ref: ScanReference) => {
			markSyncedCalls.push(ref);
		}),
		start: jest.fn(),
		stop: jest.fn(),
		setOnScanDiscovered(cb: (refs: ScanReference[]) => void) {
			onDiscover = cb;
		},
	};
}

const mockVault = {
	getAbstractFileByPath: jest.fn().mockReturnValue(null),
	create: jest.fn().mockResolvedValue(undefined),
	createBinary: jest.fn().mockResolvedValue(undefined),
	createFolder: jest.fn().mockResolvedValue(undefined),
	adapter: {
		read: jest.fn().mockResolvedValue(''),
		write: jest.fn().mockResolvedValue(undefined),
	},
};

const noteConfig = {
	templateString: '{{ps_separator}}\n\n## {{ps_scan_time}}\n\n{{ps_markdown}}\n\n> [!abstract]- Original scan\n> ![[{{ps_image_file}}]]',
	targetFolder: 'PaperSync',
	attachmentsFolder: 'attachments/papersync',
	downloadImages: true,
};

describe('SyncEngine integration', () => {
	let backend: ReturnType<typeof createMockBackend>;
	let engine: SyncEngine;
	let errorHandler: ErrorHandler;
	let syncState: SyncState;
	let stateChanges: Array<{ status: string; count: number }>;

	beforeEach(() => {
		jest.clearAllMocks();
		mockVault.getAbstractFileByPath.mockReturnValue(null);

		backend = createMockBackend();
		errorHandler = new ErrorHandler();
		syncState = new SyncState('');
		stateChanges = [];

		syncState.subscribe((snap) => {
			stateChanges.push({ status: snap.status, count: snap.pendingCount });
		});

		engine = new SyncEngine(backend, { vault: mockVault, internalPlugins: { getPluginById: () => null } } as any, noteConfig, errorHandler, syncState);
	});

	it('discovers, processes, and marks a scan as synced', async () => {
		await engine.forceSyncNow();

		expect(backend.discoverUnsynced).toHaveBeenCalled();
		expect(backend.fetchScan).toHaveBeenCalledWith(scanRef);
		expect(backend.fetchImage).toHaveBeenCalledWith(scanRef);
		expect(backend.markSyncedCalls).toHaveLength(1);
		expect(backend.markSyncedCalls[0]?.id).toBe('2026-04-12-143000');
	});

	it('creates a vault note with rendered template', async () => {
		await engine.forceSyncNow();

		const createdContent = mockVault.create.mock.calls[0]?.[1] as string;
		expect(createdContent).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
		expect(mockVault.create).toHaveBeenCalledWith(
			'PaperSync/2026-04-12.md',
			expect.stringContaining('# Integration Test')
		);
	});

	it('saves the scan image to the attachments folder', async () => {
		await engine.forceSyncNow();

		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'attachments/papersync/papersync-2026-04-12-143000.jpg',
			expect.any(ArrayBuffer)
		);
	});

	it('transitions state from syncing to synced', async () => {
		await engine.forceSyncNow();

		const statuses = stateChanges.map((s) => s.status);
		expect(statuses).toContain('syncing');
		expect(statuses[statuses.length - 1]).toBe('synced');
	});

	it('handles empty scan list gracefully', async () => {
		backend = createMockBackend([]);
		syncState = new SyncState('');
		engine = new SyncEngine(backend, { vault: mockVault, internalPlugins: { getPluginById: () => null } } as any, noteConfig, errorHandler, syncState);

		await engine.forceSyncNow();

		expect(backend.fetchScan).not.toHaveBeenCalled();
		expect(syncState.status).toBe('synced');
	});

	it('imports old scans without an image path as text', async () => {
		jest.useFakeTimers();
		const refNoImage: ScanReference = { id: 'no-image', jsonPath: '/path.json', imagePath: '' };
		backend = createMockBackend([refNoImage]);
		(backend.fetchImage as jest.Mock).mockResolvedValue(null);
		engine = new SyncEngine(
			backend,
			{ vault: mockVault, internalPlugins: { getPluginById: () => null } } as any,
			noteConfig,
			errorHandler,
			new SyncState('')
		);

		await engine.forceSyncNow();
		expect(backend.markSyncedCalls).toHaveLength(0);
		jest.setSystemTime(Date.now()+60_000);
		await engine.forceSyncNow();
		engine.stop();
		jest.useRealTimers();

		expect(backend.fetchScan).toHaveBeenCalled();
		expect(mockVault.createBinary).not.toHaveBeenCalled();
		expect(mockVault.create.mock.calls[0][1]).not.toContain('![[');
		expect(backend.markSyncedCalls).toHaveLength(1);
	});

	it('retries only the synced write-back after the note was written', async () => {
		jest.useFakeTimers();
		(backend.markSynced as jest.Mock)
			.mockRejectedValueOnce(new Error('Drive request failed (503): backend error'))
			.mockImplementation(async (ref: ScanReference) => { backend.markSyncedCalls.push(ref); });
		try {
			const sync = engine.forceSyncNow();
			await jest.advanceTimersByTimeAsync(5_000);
			await sync;
		} finally {
			engine.stop();
			jest.useRealTimers();
		}

		expect(mockVault.create).toHaveBeenCalledTimes(1);
		expect(backend.fetchScan).toHaveBeenCalledTimes(1);
		expect(backend.markSynced).toHaveBeenCalledTimes(2);
		expect(backend.markSyncedCalls).toHaveLength(1);
	});

	it('does not append a scan again when its synced write-back keeps failing', async () => {
		jest.useFakeTimers();
		// A vault that keeps what was written, so the next pass appends to it.
		let note: string | null = null;
		const notePath = 'PaperSync/2026-04-12.md';
		mockVault.getAbstractFileByPath.mockImplementation((path: string) =>
			path === notePath && note !== null ? Object.assign(new TFile(), { path }) : null
		);
		mockVault.create.mockImplementation(async (_p: string, content: string) => { note = content; });
		const process = jest.fn(async (_f: unknown, fn: (d: string) => string) => { note = fn(note ?? ''); });
		const vault = { ...mockVault, process };
		(backend.markSynced as jest.Mock).mockRejectedValue(new Error('Drive request failed (503): backend error'));
		engine = new SyncEngine(backend, { vault, internalPlugins: { getPluginById: () => null } } as any, noteConfig, errorHandler, syncState);
		try {
			for (let pass = 0; pass < 2; pass++) {
				const sync = engine.forceSyncNow();
				await jest.advanceTimersByTimeAsync(10_000);
				await sync;
			}
		} finally {
			engine.stop();
			jest.useRealTimers();
		}

		expect(mockVault.create).toHaveBeenCalledTimes(1);
		expect(process).toHaveBeenCalledTimes(1);
		expect(note!.match(/# Integration Test/g)).toHaveLength(1);
		expect(backend.markSynced).toHaveBeenCalledTimes(6);
		mockVault.create.mockReset().mockResolvedValue(undefined);
	});

	it('does not mark synced if fetch fails', async () => {
		(backend.fetchScan as jest.Mock).mockRejectedValue(new Error('Network error'));

		await engine.forceSyncNow();

		expect(backend.markSyncedCalls).toHaveLength(0);
	});
});

it('holds the Drive cursor below a fresh missing companion then imports it after grace', async () => {
	jest.useFakeTimers();
	jest.setSystemTime(new Date('2026-10-03T12:00:00Z'));
	const refs = [
		{ id: 'waiting', jsonPath: 'j', imagePath: '', createdTime: '2026-10-03T12:00:00Z' },
		{ id: 'later', jsonPath: 'j2', imagePath: 'img', createdTime: '2026-10-03T12:00:01Z' },
	];
	const backend = createMockBackend(refs);
	backend.fetchScan = jest
		.fn()
		.mockResolvedValue({ ...validScanFile, createdAt: new Date().toISOString() });
	backend.fetchImage = jest
		.fn()
		.mockImplementation(async (ref) => (ref.imagePath ? new ArrayBuffer(4) : null));
	const update = jest.fn();
	backend.updateLastSyncTimestamp = update;
	const state = new SyncState('');
	const engine = new SyncEngine(
		backend,
		{ vault: mockVault } as any,
		noteConfig,
		new ErrorHandler(state),
		state
	);
	try {
		await engine.forceSyncNow();
		expect(update).not.toHaveBeenCalled();
		expect(state.pendingCount).toBe(1);
		jest.setSystemTime(Date.now() + 60_000);
		await engine.forceSyncNow();
		expect(backend.markSyncedCalls.some((ref) => ref.id === 'waiting')).toBe(true);
		expect(update).toHaveBeenCalledWith('2026-10-03T12:00:01Z');
	} finally {
		engine.stop();
		jest.useRealTimers();
	}
});

it('stops companion polling when an expired wait hits a real image access error',async () => {
	jest.useFakeTimers();
	const backend=createMockBackend();
	(backend.fetchImage as jest.Mock).mockResolvedValue(null);
	const state=new SyncState('');
	const engine=new SyncEngine(backend,{vault:mockVault} as any,noteConfig,new ErrorHandler(state),state);
	try {
		await engine.forceSyncNow();
		jest.setSystemTime(Date.now()+60_000);
		(backend.fetchImage as jest.Mock).mockRejectedValue(new Error('permission denied'));
		await engine.forceSyncNow();
		const count=(backend.discoverUnsynced as jest.Mock).mock.calls.length;
		await jest.advanceTimersByTimeAsync(10_000);
		expect((backend.discoverUnsynced as jest.Mock).mock.calls.length).toBe(count);
		expect(jest.getTimerCount()).toBe(0);
		expect(backend.markSyncedCalls).toHaveLength(0);
	} finally{engine.stop();jest.useRealTimers();}
});

it('stops companion polling when discovery loses access to its source',async () => {
	jest.useFakeTimers();
	const backend=createMockBackend();
	(backend.fetchImage as jest.Mock).mockResolvedValue(null);
	const state=new SyncState('');
	const engine=new SyncEngine(backend,{vault:mockVault} as any,noteConfig,new ErrorHandler(state),state);
	try {
		await engine.forceSyncNow();
		(backend.discoverUnsynced as jest.Mock).mockRejectedValue(new Error('permission denied'));
		await jest.advanceTimersByTimeAsync(60_000);
		expect(jest.getTimerCount()).toBe(0);
		expect(state.status).toBe('error');
		expect(backend.markSyncedCalls).toHaveLength(0);
	}finally{engine.stop();jest.useRealTimers();}
});
