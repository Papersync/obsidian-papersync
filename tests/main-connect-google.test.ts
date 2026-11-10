// Connect and Disconnect for Google Drive: the Drive cursor starts over for every
// new connection, and a sign-in that is cancelled or fails leaves the previous
// storage exactly as it was.
import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';
import { createSyncError } from '@/errors/sync-error';
import type { PluginSettings } from '@/settings';

type TestPlugin = PaperSyncPlugin & { saveData: jest.Mock };

const FOLDER_SETUP: PluginSettings = {
	...DEFAULT_SETTINGS,
	backendType: 'folder',
	folderPath: '/Users/me/Library/Mobile Documents/Papersync',
	folderType: 'icloud',
	setupComplete: true,
	saveTo: 'custom',
	lastSyncTimestamp: '2026-11-01T10:00:00.000Z',
};

function makePlugin(startAuthFlow: jest.Mock): { plugin: TestPlugin; disconnect: jest.Mock; startSync: jest.SpyInstance } {
	const app = { internalPlugins: { getPluginById: () => null } };
	const plugin = new PaperSyncPlugin(app as never, {} as never) as TestPlugin;
	plugin.app = app as never;
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	plugin.settings = { ...FOLDER_SETUP };
	const disconnect = jest.fn().mockResolvedValue(undefined);
	plugin.oauthManager = { startAuthFlow, disconnect } as never;
	const startSync = jest.spyOn(plugin, 'startSync').mockResolvedValue(undefined);
	return { plugin, disconnect, startSync };
}

describe('PaperSyncPlugin Google connection', () => {
	it('switches to Drive and starts the cursor over once the sign-in succeeds', async () => {
		const { plugin, startSync } = makePlugin(jest.fn().mockResolvedValue({}));
		const stop = jest.fn();
		plugin.syncEngine = { stop } as never;

		await expect(plugin.connectGoogle()).resolves.toBe('connected');

		expect(stop).toHaveBeenCalledTimes(1);
		expect(plugin.settings).toMatchObject({ backendType: 'drive', setupComplete: true, lastSyncTimestamp: '' });
		expect(plugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({ backendType: 'drive', lastSyncTimestamp: '' }));
		expect(startSync).toHaveBeenCalledTimes(1);
	});

	it('leaves the folder setup untouched, and still syncing, when the sign-in is cancelled', async () => {
		const denied = createSyncError('token_revoked', 'Sign-in was cancelled at Google (access_denied)');
		const { plugin, startSync } = makePlugin(jest.fn().mockRejectedValue(denied));
		const stop = jest.fn();
		plugin.syncEngine = { stop } as never;

		await expect(plugin.connectGoogle()).rejects.toBe(denied);

		expect(plugin.settings).toEqual(FOLDER_SETUP);
		expect(plugin.saveData).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(startSync).not.toHaveBeenCalled();
	});

	it('changes nothing when a newer Connect replaced this sign-in', async () => {
		const superseded = Object.assign(createSyncError('token_expired', 'Sign-in was restarted'), { superseded: true });
		const { plugin } = makePlugin(jest.fn().mockRejectedValue(superseded));
		await expect(plugin.connectGoogle()).resolves.toBe('superseded');
		expect(plugin.settings).toEqual(FOLDER_SETUP);
		expect(plugin.saveData).not.toHaveBeenCalled();
	});

	it('Disconnect clears the cursor, and a batch the old engine finishes later cannot bring it back', async () => {
		const { plugin, disconnect } = makePlugin(jest.fn());
		// The real startSync (no backend here): it subscribes to a live sync state.
		jest.restoreAllMocks();
		plugin.settings = { ...FOLDER_SETUP, backendType: 'none' };
		await plugin.startSync();
		const oldState = plugin.syncState;

		await plugin.disconnectGoogle();
		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(plugin.settings).toMatchObject({ backendType: 'none', setupComplete: false, lastSyncTimestamp: '' });

		oldState.advanceTimestamp('2026-11-02T10:00:00.000Z');
		oldState.recordSyncCompleted(0);
		expect(plugin.settings.lastSyncTimestamp).toBe('');
	});
});
