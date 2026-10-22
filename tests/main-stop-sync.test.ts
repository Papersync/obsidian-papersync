// Disconnecting forgets the engine, and a startSync that finishes after unload
// starts nothing.
import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';

type TestPlugin = PaperSyncPlugin & { saveData: jest.Mock };

function makePlugin(): TestPlugin {
	const app = { internalPlugins: { getPluginById: () => null } };
	const plugin = new PaperSyncPlugin(app as never, {} as never) as TestPlugin;
	plugin.app = app as never;
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	plugin.settings = { ...DEFAULT_SETTINGS, backendType: 'folder', folderPath: '/nonexistent-papersync-test', setupComplete: true };
	return plugin;
}

describe('PaperSyncPlugin sync lifecycle', () => {
	it('stopSync stops the engine and forgets it', () => {
		const plugin = makePlugin();
		const stop = jest.fn();
		plugin.syncEngine = { stop } as never;
		plugin.stopSync();
		expect(stop).toHaveBeenCalledTimes(1);
		expect(plugin.syncEngine).toBeNull();
	});

	it('does not start an engine when the plugin was unloaded during startSync', async () => {
		const plugin = makePlugin();
		let release!: () => void;
		plugin.saveData.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
		const starting = plugin.startSync(); // waits on the first-run Notes folder save
		plugin.onunload();
		release();
		await starting;
		expect(plugin.syncEngine).toBeNull();
	});
});
