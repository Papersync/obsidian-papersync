import * as fs from 'fs';
import * as path from 'path';
import { closeSettings, switchToMainWindow, vaultBasePath } from './helpers';
import { getDestination, scanAndWait, setDailyNotes, today } from './destination-helpers';

// Upgrading from 0.1.5 (settingsVersion 4, a "Notes folder" = targetFolder): the
// plugin is loaded over a seeded 0.1.5 data.json, and the next scan must land in
// the very file 0.1.5 would have written it to. The 0.1.5 paths below are written
// out by hand from its rules: the folder ran through the Y/M/D replacer (empty
// = the Daily notes folder, or Papersync with Daily notes off) and the file was
// named with the Daily notes format (YYYY-MM-DD with Daily notes off).

const PLUGIN_DIR = '.obsidian/plugins/papersync';

// Disable Papersync, write a 0.1.5 data.json, enable it again (a real load,
// migration included).
async function loadWith015Settings(dir: string, targetFolder: string): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (folder: string, target: string, pluginDir: string) => {
		const app = (window as unknown as { app: {
			plugins: { disablePlugin: (id: string) => Promise<void>; enablePlugin: (id: string) => Promise<void> };
			vault: { adapter: { write: (p: string, c: string) => Promise<void> } };
		} }).app;
		await app.plugins.disablePlugin('papersync');
		await app.vault.adapter.write(`${pluginDir}/data.json`, JSON.stringify({
			settingsVersion: 4,
			setupComplete: true,
			backendType: 'folder',
			drivePollInterval: 30,
			folderPath: folder,
			folderType: 'custom',
			targetFolder: target,
			attachmentsFolder: 'MigAttachments',
			templateString: '{{ps_separator}}\n\n## {{ps_scan_time}}\n\n{{ps_markdown}}\n',
			downloadImages: false,
			lastSyncTimestamp: '',
			lastSyncAt: 0,
		}));
		await app.plugins.enablePlugin('papersync');
	}, dir, targetFolder, PLUGIN_DIR);
	await browser.waitUntil(async () => browser.execute(() => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { syncEngine: unknown } | undefined> } } }).app.plugins.plugins;
		return !!ps['papersync']?.syncEngine;
	}), { timeout: 15_000, interval: 250, timeoutMsg: 'Papersync never started sync after load' });
}

async function persisted(): Promise<Record<string, unknown>> {
	await switchToMainWindow();
	const raw = await browser.execute(async (pluginDir: string) => {
		const app = (window as unknown as { app: { vault: { adapter: { read: (p: string) => Promise<string> } } } }).app;
		return app.vault.adapter.read(`${pluginDir}/data.json`);
	}, PLUGIN_DIR);
	return JSON.parse(raw) as Record<string, unknown>;
}

describe('Upgrade from 0.1.5 (Notes folder -> Save scans to)', function () {
	this.timeout(120_000);
	const SCANS = 'Papersync-migration-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
	});

	after(async function () {
		await closeSettings().catch(() => undefined);
	});

	it('Daily notes on and the Notes folder is its folder -> Daily note, same daily file', async function () {
		await setDailyNotes(true, 'MigDaily', 'MMMM D, YYYY');
		await loadWith015Settings(dir, 'MigDaily/');

		expect((await getDestination()).saveTo).toBe('daily');
		const data = await persisted();
		expect(data.settingsVersion).toBe(5);
		expect(data).not.toHaveProperty('targetFolder');
		expect(await scanAndWait(dir, `MIG_DAILY_${Date.now()}`)).toEqual([`MigDaily/${today('MMMM D, YYYY')}.md`]);
	});

	it('Daily notes on and the Notes folder is empty (0.1.5 used the daily folder) -> Daily note', async function () {
		await setDailyNotes(true, 'MigDailyEmpty', 'YYYY-MM-DD');
		await loadWith015Settings(dir, '');

		expect((await getDestination()).saveTo).toBe('daily');
		expect(await scanAndWait(dir, `MIG_EMPTY_ON_${Date.now()}`)).toEqual([`MigDailyEmpty/${today()}.md`]);
	});

	it('Daily notes on at the vault root and the Notes folder is / -> Daily note at the root', async function () {
		await setDailyNotes(true, '', '[MigRoot] YYYY-MM-DD');
		await loadWith015Settings(dir, '/');

		expect((await getDestination()).saveTo).toBe('daily');
		expect(await scanAndWait(dir, `MIG_ROOT_ON_${Date.now()}`)).toEqual([`MigRoot ${today()}.md`]);
	});

	it('Daily notes on and another folder -> Custom with that folder and the Daily notes format', async function () {
		await setDailyNotes(true, 'MigDaily', 'YYYY/MM/YYYY-MM-DD');
		await loadWith015Settings(dir, 'MigOther/YYYY');

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'MigOther/YYYY', customFileName: 'YYYY/MM/YYYY-MM-DD' });
		expect(await scanAndWait(dir, `MIG_OTHER_${Date.now()}`))
			.toEqual([`MigOther/${today('YYYY')}/${today('YYYY/MM/YYYY-MM-DD')}.md`]);
		// Daily notes changing later no longer moves these scans (they never followed it in a custom folder).
	});

	it('Daily notes off and an empty Notes folder -> Custom Papersync / YYYY-MM-DD', async function () {
		await setDailyNotes(false);
		await loadWith015Settings(dir, '');

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
		expect(await scanAndWait(dir, `MIG_EMPTY_OFF_${Date.now()}`)).toEqual([`Papersync/${today()}.md`]);
	});

	it('Daily notes off and the Notes folder is / -> Custom at the vault root', async function () {
		await setDailyNotes(false);
		await loadWith015Settings(dir, '/');

		expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: '/', customFileName: 'YYYY-MM-DD' });
		expect(await scanAndWait(dir, `MIG_ROOT_OFF_${Date.now()}`)).toEqual([`${today()}.md`]);
	});

	it('migrates on a cold Obsidian start too (core Daily notes is read at load)', async function () {
		// Persist Daily notes on disk (core-plugins.json + daily-notes.json), seed a
		// 0.1.5 data.json, then restart Obsidian: proves Daily notes is ready when
		// Papersync's settings load at startup, not only on a plugin toggle.
		await setDailyNotes(true, 'MigCold', 'YYYY-MM-DD');
		await switchToMainWindow();
		await browser.execute(async (folder: string, pluginDir: string) => {
			const app = (window as unknown as { app: {
				internalPlugins: { getPluginById: (id: string) => { instance?: { options?: Record<string, unknown>; saveData?: (d: unknown) => Promise<void> } } | null };
				vault: { adapter: { write: (p: string, c: string) => Promise<void> } };
				plugins: { disablePlugin: (id: string) => Promise<void> };
			} }).app;
			await app.vault.adapter.write('.obsidian/daily-notes.json', JSON.stringify({ folder: 'MigCold', format: 'YYYY-MM-DD' }));
			await app.plugins.disablePlugin('papersync');
			await app.vault.adapter.write(`${pluginDir}/data.json`, JSON.stringify({
				settingsVersion: 4, setupComplete: true, backendType: 'folder', drivePollInterval: 30,
				folderPath: folder, folderType: 'custom', targetFolder: 'MigCold', attachmentsFolder: 'MigAttachments',
				templateString: '{{ps_separator}}\n\n{{ps_markdown}}\n', downloadImages: false, lastSyncTimestamp: '', lastSyncAt: 0,
			}));
		}, dir, PLUGIN_DIR);
		await browser.reloadObsidian({ plugins: ['papersync'] });
		await browser.waitUntil(async () => browser.execute(() => {
			const ps = (window as unknown as { app?: { plugins?: { plugins?: Record<string, { syncEngine: unknown } | undefined> } } }).app?.plugins?.plugins;
			return !!ps?.['papersync']?.syncEngine;
		}), { timeout: 30_000, interval: 500, timeoutMsg: 'Papersync never started after the restart' });

		expect((await getDestination()).saveTo).toBe('daily');
		expect(await scanAndWait(dir, `MIG_COLD_${Date.now()}`)).toEqual([`MigCold/${today()}.md`]);
	});
});
