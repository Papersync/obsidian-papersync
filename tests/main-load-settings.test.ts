// loadSettings must strip the endpointOverrides seam from whatever data.json holds:
// the seam is runtime-injected by E2E only, so a persisted (stale or tampered) copy
// must never survive a plugin load and steer OAuth/Drive traffic. The strip is
// in-memory — an unchanged settingsVersion triggers no re-persist.

import PaperSyncPlugin from '@/main';
import { DEFAULT_SETTINGS } from '@/settings';

type LoadablePlugin = PaperSyncPlugin & {
	loadData: jest.Mock;
	saveData: jest.Mock;
};

function makePlugin(loaded: unknown): LoadablePlugin {
	const plugin = new PaperSyncPlugin({} as never, {} as never) as LoadablePlugin;
	plugin.loadData = jest.fn().mockResolvedValue(loaded);
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	return plugin;
}

describe('PaperSyncPlugin.loadSettings endpoint-seam strip', () => {
	it('strips a persisted endpointOverrides seam without re-persisting', async () => {
		const plugin = makePlugin({
			settingsVersion: DEFAULT_SETTINGS.settingsVersion,
			targetFolder: 'Journal',
			endpointOverrides: { tokenUrl: 'http://127.0.0.1:9/token' },
		});

		await plugin.loadSettings();

		expect(plugin.settings.endpointOverrides).toBeUndefined();
		expect(plugin.settings.targetFolder).toBe('Journal'); // the rest of the data survives
		expect(plugin.saveData).not.toHaveBeenCalled(); // in-memory strip only
	});

	it('never persists the seam through the migration re-save either', async () => {
		const plugin = makePlugin({
			settingsVersion: 0, // forces a migration bump + saveData
			endpointOverrides: { tokenUrl: 'https://attacker.example.com/token' },
		});

		await plugin.loadSettings();

		expect(plugin.settings.endpointOverrides).toBeUndefined();
		expect(plugin.saveData).toHaveBeenCalledTimes(1);
		const persisted = plugin.saveData.mock.calls[0]![0] as Record<string, unknown>;
		expect('endpointOverrides' in persisted).toBe(false);
	});

	it('strips a persisted companion grace override too', async () => {
		const plugin = makePlugin({
			settingsVersion: DEFAULT_SETTINGS.settingsVersion,
			companionGraceOverrideMs: 1000,
		});

		await plugin.loadSettings();

		expect(plugin.settings.companionGraceOverrideMs).toBeUndefined();
		// The engine's call-time supplier reads the live (stripped) value.
		const supplier = (plugin as unknown as { graceOverride: () => unknown }).graceOverride;
		expect(supplier()).toBeUndefined();
		plugin.settings.companionGraceOverrideMs = 3000;
		expect(supplier()).toBe(3000);
	});

	it('falls back to defaults when nothing is persisted', async () => {
		const plugin = makePlugin(null);

		await plugin.loadSettings();

		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(plugin.settings.endpointOverrides).toBeUndefined();
	});
});
