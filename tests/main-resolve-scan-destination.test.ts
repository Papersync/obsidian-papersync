// resolveScanDestination picks where scans go on first setup (and after Reset
// settings), once: a copy of Periodic Notes' daily settings, else core Daily
// notes, else the Papersync defaults.

import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';
import type { SaveTo } from '@/notes/scan-destination';

type ResolvablePlugin = PaperSyncPlugin & { saveData: jest.Mock };

function makePlugin(dailyNotes: unknown, periodic: unknown = null, saveTo: SaveTo = ''): ResolvablePlugin {
	const app = {
		internalPlugins: { getPluginById: () => dailyNotes },
		plugins: {
			enabledPlugins: new Set(periodic ? ['periodic-notes'] : []),
			getPlugin: () => periodic,
		},
	};
	const plugin = new PaperSyncPlugin(app as never, {} as never) as ResolvablePlugin;
	plugin.app = app as never; // the obsidian mock's Plugin does not keep its constructor args
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	plugin.settings = { ...DEFAULT_SETTINGS, saveTo };
	return plugin;
}

const periodicDaily = { settings: { daily: { enabled: true, folder: 'Journal/Daily', format: 'YYYY-MM-DD dddd' } } };

describe('PaperSyncPlugin.resolveScanDestination', () => {
	it('picks Daily note when core Daily notes is on and Periodic Notes is not', async () => {
		const plugin = makePlugin({ enabled: true, instance: { options: { folder: 'Daily' } } });

		await plugin.resolveScanDestination();

		expect(plugin.settings.saveTo).toBe('daily');
		expect(plugin.saveData).toHaveBeenCalledTimes(1);
	});

	it('copies Periodic Notes daily settings even when core Daily notes is on', async () => {
		const plugin = makePlugin({ enabled: true, instance: { options: { folder: 'Daily' } } }, periodicDaily);

		await plugin.resolveScanDestination();

		expect(plugin.settings).toMatchObject({ saveTo: 'custom', customFolder: 'Journal/Daily', customFileName: 'YYYY-MM-DD dddd' });
	});

	it('copies Periodic Notes daily settings into Custom when Daily notes is off', async () => {
		const plugin = makePlugin({ enabled: false }, periodicDaily);

		await plugin.resolveScanDestination();

		expect(plugin.settings).toMatchObject({ saveTo: 'custom', customFolder: 'Journal/Daily', customFileName: 'YYYY-MM-DD dddd' });
	});

	it('uses the Papersync defaults otherwise', async () => {
		const plugin = makePlugin({ enabled: false });

		await plugin.resolveScanDestination();

		expect(plugin.settings).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
	});

	it('keeps a choice already made', async () => {
		const plugin = makePlugin({ enabled: true }, null, 'custom');

		await plugin.resolveScanDestination();

		expect(plugin.settings.saveTo).toBe('custom');
		expect(plugin.saveData).not.toHaveBeenCalled();
	});
});
