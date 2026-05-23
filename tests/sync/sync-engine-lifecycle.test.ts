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
