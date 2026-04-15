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
	templateString: '{{separator}}\n\n## {{time}}\n\n{{markdown}}\n\n> [!abstract]- Original scan\n> ![[{{image_file}}]]',
	targetFolder: 'PaperSynced',
	attachmentsFolder: 'attachments/papersynced',
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
			'PaperSynced/2026-04-12.md',
			expect.stringContaining('# Integration Test')
		);
	});

	it('saves the scan image to the attachments folder', async () => {
		await engine.forceSyncNow();

		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'attachments/papersynced/papersynced-2026-04-12-143000.jpg',
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

	it('skips scans without an image path', async () => {
		const refNoImage: ScanReference = { id: 'no-image', jsonPath: '/path.json', imagePath: '' };
		backend = createMockBackend([refNoImage]);
		engine = new SyncEngine(backend, { vault: mockVault, internalPlugins: { getPluginById: () => null } } as any, noteConfig, errorHandler, new SyncState(''));

		await engine.forceSyncNow();

		expect(backend.fetchScan).not.toHaveBeenCalled();
		expect(backend.markSyncedCalls).toHaveLength(0);
	});

	it('does not mark synced if fetch fails', async () => {
		(backend.fetchScan as jest.Mock).mockRejectedValue(new Error('Network error'));

		await engine.forceSyncNow();

		expect(backend.markSyncedCalls).toHaveLength(0);
	});
});
