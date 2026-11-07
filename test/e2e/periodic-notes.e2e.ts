import * as fs from 'fs';
import * as path from 'path';
import { closeSettings, focusSettingsUI, openPluginSettings, switchToMainWindow, vaultBasePath } from './helpers';
import { getDestination, scanAndWait, setDailyNotes, setDestination, waitForDestinationUI } from './destination-helpers';

// First setup copies Periodic Notes' daily folder and format into the custom
// fields, ahead of core Daily notes, when Periodic Notes (0.0.17, the real
// community plugin) has daily notes on. A one-time copy: never followed after.

type PeriodicDaily = { enabled: boolean; folder?: string; format?: string };

// The way the Community plugins toggle does it (enabledPlugins updated and saved).
async function setPeriodicPlugin(on: boolean): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (enable: boolean) => {
		const plugins = (window as unknown as { app: { plugins: {
			enablePluginAndSave: (id: string) => Promise<void>; disablePluginAndSave: (id: string) => Promise<void>;
		} } }).app.plugins;
		await (enable ? plugins.enablePluginAndSave('periodic-notes') : plugins.disablePluginAndSave('periodic-notes'));
	}, on);
	await browser.waitUntil(async () => browser.execute((enable: boolean) => {
		const p = (window as unknown as { app: { plugins: { plugins: Record<string, { settings?: unknown } | undefined> } } }).app.plugins.plugins;
		return enable ? !!p['periodic-notes']?.settings : !p['periodic-notes'];
	}, on), { timeout: 10_000, interval: 200, timeoutMsg: `Periodic Notes never turned ${on ? 'on' : 'off'}` });
}

async function setPeriodicDaily(daily: PeriodicDaily): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (d: PeriodicDaily) => {
		// Periodic Notes' own settings path (saves, and registers its daily commands).
		const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>; updateSettings: (val: Record<string, unknown>) => Promise<void>;
		}> } } }).app.plugins.plugins['periodic-notes']!;
		await plugin.updateSettings({ ...plugin.settings, daily: { ...(plugin.settings.daily as object), ...d } });
	}, daily);
}

// First setup the way the settings tab does it: storage chosen, nothing chosen yet
// for where scans go, then startSync.
async function firstSetup(dir: string): Promise<void> {
	await setDestination({ saveTo: '', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
	await switchToMainWindow();
	await browser.execute(async (folder: string) => {
		const plugin = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>; saveSettings: () => Promise<void>; startSync: () => Promise<void>;
		}> } } }).app.plugins.plugins['papersync']!;
		Object.assign(plugin.settings, {
			backendType: 'folder', folderPath: folder, folderType: 'custom', setupComplete: true,
			lastSyncTimestamp: '', attachmentsFolder: 'PeriodicAttachments',
		});
		await plugin.saveSettings();
		await plugin.startSync();
	}, dir);
}

// Periodic Notes' own "open today's daily note" command; returns the note it opened.
async function periodicOpensToday(): Promise<string> {
	await switchToMainWindow();
	await browser.executeObsidianCommand('periodic-notes:open-daily-note');
	let opened = '';
	await browser.waitUntil(async () => {
		opened = await browser.execute(() =>
			(window as unknown as { app: { workspace: { getActiveFile: () => { path: string } | null } } }).app.workspace.getActiveFile()?.path ?? '');
		return opened.startsWith('Journal/Daily/');
	}, { timeout: 10_000, interval: 250 }).catch(async () => {
		const files = await browser.execute(() =>
			(window as unknown as { app: { vault: { getFiles: () => Array<{ path: string }> } } }).app.vault.getFiles()
				.map((f) => f.path).filter((p) => !p.startsWith('Papersync-periodic-scans')));
		throw new Error(`Periodic Notes never opened its daily note (active: "${opened}", files: ${JSON.stringify(files)})`);
	});
	return opened;
}

describe('First setup with Periodic Notes', function () {
	this.timeout(120_000);
	const SCANS = 'Papersync-periodic-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await setPeriodicPlugin(true);
	});

	after(async function () {
		await closeSettings().catch(() => undefined);
		await setPeriodicPlugin(false).catch(() => undefined);
	});

	it('copies the Periodic Notes daily folder and format, and the scan lands in its daily note', async function () {
		await setDailyNotes(false);
		await setPeriodicDaily({ enabled: true, folder: 'Journal/Daily/', format: 'YYYY-MM-DD dddd' });
		await firstSetup(dir);

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Journal/Daily', customFileName: 'YYYY-MM-DD dddd' });
		await openPluginSettings();
		await focusSettingsUI();
		await waitForDestinationUI((u) => u.value === 'custom' && u.folderVisible, 'Custom');
		const fields = await browser.execute(() => ({
			folder: (document.querySelector('.papersync-custom-folder input') as HTMLInputElement | null)?.value,
			file: (document.querySelector('.papersync-custom-file input') as HTMLInputElement | null)?.value,
		}));
		expect(fields).toEqual({ folder: 'Journal/Daily', file: 'YYYY-MM-DD dddd' });
		await closeSettings();

		// Periodic Notes 0.0.17 does not create a missing folder (its create fails),
		// so the folder exists, as it does for anyone using it.
		await switchToMainWindow();
		await browser.execute(async () => {
			await (window as unknown as { app: { vault: { createFolder: (p: string) => Promise<unknown> } } }).app.vault.createFolder('Journal/Daily');
		});
		const periodicNote = await periodicOpensToday();
		expect(await scanAndWait(dir, `PERIODIC_${Date.now()}`)).toEqual([periodicNote]);
	});

	it('never follows Periodic Notes after first setup', async function () {
		const before = await getDestination();
		await setPeriodicDaily({ enabled: true, folder: 'Elsewhere', format: 'YYYY' });
		await openPluginSettings();
		await waitForDestinationUI((u) => u.value === 'custom', 'Custom');
		await closeSettings();

		expect(await getDestination()).toEqual(before);
		const hits = await scanAndWait(dir, `PERIODIC_AFTER_${Date.now()}`);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.startsWith('Journal/Daily/')).toBe(true);
	});

	it('prefers Periodic Notes over core Daily notes, month names included', async function () {
		// Both on: Periodic Notes is the one that makes the daily note, so its folder
		// and format win. The format nests a month-name folder, as real vaults do.
		await setDailyNotes(true, 'CoreDaily', 'YYYY-MM-DD');
		await setPeriodicDaily({ enabled: true, folder: 'Journal/Daily', format: 'YYYY/M-MMMM/YYYY-MM-DD' });
		await firstSetup(dir);

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Journal/Daily', customFileName: 'YYYY/M-MMMM/YYYY-MM-DD' });
		await switchToMainWindow();
		// Periodic Notes 0.0.17 does not create a missing folder, so make today's.
		const monthFolder = await browser.execute(async () => {
			const w = window as unknown as { moment: () => { format: (f: string) => string };
				app: { vault: { createFolder: (p: string) => Promise<unknown>; getAbstractFileByPath: (p: string) => unknown } } };
			const folder = `Journal/Daily/${w.moment().format('YYYY/M-MMMM')}`;
			if (!w.app.vault.getAbstractFileByPath(folder)) {await w.app.vault.createFolder(folder);}
			return folder;
		});
		expect(monthFolder).toMatch(/^Journal\/Daily\/\d{4}\/\d{1,2}-[A-Za-z]+$/);
		const periodicNote = await periodicOpensToday();
		expect(periodicNote.startsWith(`${monthFolder}/`)).toBe(true);
		expect(await scanAndWait(dir, `PERIODIC_BOTH_${Date.now()}`)).toEqual([periodicNote]);
	});

	it('uses the Papersync defaults when Periodic Notes daily notes is off', async function () {
		await setDailyNotes(false);
		await setPeriodicDaily({ enabled: false, folder: 'Journal/Daily', format: 'YYYY-MM-DD dddd' });
		await firstSetup(dir);

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
	});

	it('uses the Papersync defaults when the Periodic Notes plugin is off', async function () {
		await setDailyNotes(false);
		await setPeriodicDaily({ enabled: true, folder: 'Journal/Daily', format: 'YYYY-MM-DD dddd' });
		await setPeriodicPlugin(false);
		await firstSetup(dir);

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
		await setPeriodicPlugin(true);
	});
});
