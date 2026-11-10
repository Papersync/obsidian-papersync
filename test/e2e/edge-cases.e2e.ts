import * as fs from 'fs';
import * as path from 'path';
import { openPluginSettings, closeSettings, clickButtonWhenPresent, configureFolderBackend, switchToMainWindow, vaultBasePath, waitForSyncIdle, writeScan, readNotes, isoStamp } from './helpers';

interface PluginView {
	backendType: string;
	folderPath: string;
	setupComplete: boolean;
	attachmentsFolder: string;
	customFolder: string;
	engine: boolean;
}

async function pluginView(): Promise<PluginView> {
	await switchToMainWindow();
	return browser.execute(() => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; syncEngine: unknown }> } } }).app.plugins.plugins;
		const p = ps['papersync']!;
		return {
			backendType: String(p.settings.backendType),
			folderPath: String(p.settings.folderPath),
			setupComplete: p.settings.setupComplete === true,
			attachmentsFolder: String(p.settings.attachmentsFolder),
			customFolder: String(p.settings.customFolder),
			engine: p.syncEngine !== null,
		};
	});
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('Edge cases and error handling', function () {
	const SCANS = 'Papersync-edge-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'EdgeTest', attachmentsFolder: 'EdgeTest/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('imports each scan exactly once when Sync now is fired three times at once', async function () {
		const stamp = isoStamp();
		const markers = [`RAPID_A_${stamp}`, `RAPID_B_${stamp}`];
		markers.forEach((marker, i) => writeScan(dir, `rapid-${i}-${stamp}`, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `rapid-${i}-${stamp}.jpg`,
		}));

		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.waitUntil(async () => {
			const notes = await readNotes('EdgeTest');
			return markers.every((m) => notes.includes(m));
		}, { timeout: 20_000, interval: 250, timeoutMsg: 'the rapid-fire scans never imported' });
		await waitForSyncIdle();

		const notes = await readNotes('EdgeTest');
		for (const m of markers) { expect(occurrences(notes, `# ${m}`)).toBe(1); }
	});

	it('leaves no Settings window or modal behind after opening and closing it five times', async function () {
		for (let i = 0; i < 5; i++) {
			await openPluginSettings();
			await closeSettings();
		}
		await switchToMainWindow();
		expect((await browser.getWindowHandles()).length).toBe(1);
		expect(await browser.execute(() => !!document.querySelector('.mod-settings'))).toBe(false);
		// And it still opens on the Papersync tab afterwards.
		await openPluginSettings();
		await closeSettings();
	});

	it('Reset settings restores the defaults, keeps the folder connected and restarts sync', async function () {
		const before = await pluginView();
		expect(before.attachmentsFolder).toBe('EdgeTest/attachments');

		await openPluginSettings();
		await clickButtonWhenPresent('Reset settings');
		await closeSettings();

		await browser.waitUntil(async () => (await pluginView()).attachmentsFolder === '', {
			timeout: 5000, interval: 100, timeoutMsg: 'Reset settings never reset the attachments folder',
		});
		const after = await pluginView();
		expect(after.backendType).toBe('folder');
		expect(after.folderPath).toBe(dir);
		expect(after.setupComplete).toBe(true);
		expect(after.customFolder).toBe('Papersync');
		await browser.waitUntil(async () => (await pluginView()).engine, {
			timeout: 5000, interval: 100, timeoutMsg: 'sync never restarted after Reset settings',
		});
	});

	it('logs no severe console errors from the plugin', async function () {
		// getLogs is typed as object[], so the shape has to be asserted rather than
		// annotated on the predicate.
		const logs = (await browser.getLogs('browser')) as Array<{ level: string; message: string }>;
		const pluginErrors = logs.filter(
			(log) => log.level === 'SEVERE' && log.message.toLowerCase().includes('papersync')
		);
		expect(pluginErrors).toEqual([]);
	});

	it('ships no development commands in the production build', async function () {
		await switchToMainWindow();
		const ids = await browser.execute(() => Object.keys(
			(window as unknown as { app: { commands: { commands: Record<string, unknown> } } }).app.commands.commands
		));
		expect(ids).toContain('papersync:sync-now');
		expect(ids.filter((id) => id.startsWith('papersync:dev-'))).toEqual([]);
	});
});
