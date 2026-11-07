// The sync engine reads committed settings only, so a sync that lands while the
// user is still typing never files a note with a half-typed template or folder.

import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';

function makePlugin(): PaperSyncPlugin {
	const plugin = new PaperSyncPlugin({} as never, {} as never);
	(plugin as unknown as { loadData: () => Promise<unknown> }).loadData = () =>
		Promise.resolve({ settingsVersion: DEFAULT_SETTINGS.settingsVersion, templateString: 'SAVED', customFolder: 'Journal' });
	return plugin;
}

describe('PaperSyncPlugin.commitSettings', () => {
	it('hands loaded settings to the engine', async () => {
		const plugin = makePlugin();

		await plugin.loadSettings();

		expect(plugin.engineConfig.templateString).toBe('SAVED');
		expect(plugin.engineConfig.customFolder).toBe('Journal');
	});

	it('keeps edits from the engine until they are committed', async () => {
		const plugin = makePlugin();
		await plugin.loadSettings();

		plugin.settings.templateString = '{{ps_mark';
		plugin.settings.customFolder = 'Jour';
		plugin.settings.attachmentsFolder = 'Img';
		plugin.settings.downloadImages = false;
		plugin.settings.saveTo = 'custom';
		plugin.settings.customFileName = 'Scans';

		expect(plugin.engineConfig.templateString).toBe('SAVED');
		expect(plugin.engineConfig.customFolder).toBe('Journal');
		expect(plugin.engineConfig.attachmentsFolder).toBe('');
		expect(plugin.engineConfig.downloadImages).toBe(true);
		expect(plugin.engineConfig.saveTo).toBe('');
		expect(plugin.engineConfig.customFileName).toBe('YYYY-MM-DD');

		plugin.commitSettings();

		expect(plugin.engineConfig.templateString).toBe('{{ps_mark');
		expect(plugin.engineConfig.customFolder).toBe('Jour');
		expect(plugin.engineConfig.attachmentsFolder).toBe('Img');
		expect(plugin.engineConfig.downloadImages).toBe(false);
		expect(plugin.engineConfig.saveTo).toBe('custom');
		expect(plugin.engineConfig.customFileName).toBe('Scans');
	});
});
