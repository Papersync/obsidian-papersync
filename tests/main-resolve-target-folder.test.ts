// resolveTargetFolder picks the Notes folder on first setup. With Daily Notes on,
// scans must land in the real daily note, including one at the vault root.

import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';

type ResolvablePlugin = PaperSyncPlugin & { saveData: jest.Mock };

function makePlugin(dailyNotes: unknown, targetFolder = ''): ResolvablePlugin {
	const app = { internalPlugins: { getPluginById: () => dailyNotes } };
	const plugin = new PaperSyncPlugin(app as never, {} as never) as ResolvablePlugin;
	plugin.app = app as never; // the obsidian mock's Plugin does not keep its constructor args
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	plugin.settings = { ...DEFAULT_SETTINGS, targetFolder };
	return plugin;
}

describe('PaperSyncPlugin.resolveTargetFolder', () => {
	it('uses the Daily Notes folder when Daily Notes is on', async () => {
		const plugin = makePlugin({ enabled: true, instance: { options: { folder: 'Journal', format: 'YYYY-MM-DD' } } });

		await plugin.resolveTargetFolder();

		expect(plugin.settings.targetFolder).toBe('Journal');
		expect(plugin.saveData).toHaveBeenCalledTimes(1);
	});

	it('uses the vault root when Daily Notes is on with no folder', async () => {
		const plugin = makePlugin({ enabled: true, instance: { options: { folder: '', format: 'YYYY-MM-DD' } } });

		await plugin.resolveTargetFolder();

		expect(plugin.settings.targetFolder).toBe('/');
	});

	it('uses a Papersync folder when Daily Notes is off', async () => {
		const plugin = makePlugin({ enabled: false });

		await plugin.resolveTargetFolder();

		expect(plugin.settings.targetFolder).toBe('Papersync');
	});

	it('keeps a folder the user already chose', async () => {
		const plugin = makePlugin({ enabled: true, instance: { options: { folder: 'Journal' } } }, 'Inbox');

		await plugin.resolveTargetFolder();

		expect(plugin.settings.targetFolder).toBe('Inbox');
		expect(plugin.saveData).not.toHaveBeenCalled();
	});
});
