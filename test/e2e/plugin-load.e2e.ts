import * as fs from 'fs';
import * as path from 'path';
import { openPluginSettings, closeSettings, focusSettingsUI, switchToMainWindow, waitForPlugin } from './helpers';

const manifest = JSON.parse(fs.readFileSync(path.resolve('manifest.json'), 'utf-8')) as { id: string; version: string };

describe('Papersync plugin', function () {
	before(async function () {
		await waitForPlugin();
	});

	it('loads the built plugin at the manifest version', async function () {
		const loaded = await browser.execute((id: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { manifest: { version: string } }> } } }).app.plugins.plugins;
			return ps[id]?.manifest.version ?? null;
		}, manifest.id);
		expect(loaded).toBe(manifest.version);
	});

	it('starts from a clean install: no stored settings, first-run Settings opened', async function () {
		// Every spec relies on this. wdio.conf.mts installs the plugin from a staging
		// folder with no data.json; a data.json copied in from a checkout would load
		// someone's live settings (a backend, setupComplete) instead.
		const settings = await browser.execute((id: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: { setupComplete: boolean; backendType: string } }> } } }).app.plugins.plugins;
			const s = ps[id]!.settings;
			return { setupComplete: s.setupComplete, backendType: s.backendType };
		}, manifest.id);
		expect(settings).toEqual({ setupComplete: false, backendType: 'none' });
		// First run opens Settings (after a 500 ms delay) on the Papersync tab.
		await browser.waitUntil(() => focusSettingsUI(), { timeout: 10_000, interval: 200, timeoutMsg: 'first-run Settings never opened' });
		await closeSettings();
	});

	it('registers the Sync now and Open settings commands', async function () {
		await switchToMainWindow();
		const ids = await browser.execute(() => Object.keys(
			(window as unknown as { app: { commands: { commands: Record<string, unknown> } } }).app.commands.commands
		).filter((k) => k.startsWith('papersync:')));
		expect(ids).toContain('papersync:sync-now');
		expect(ids).toContain('papersync:open-settings');
	});

	it('Open settings opens the Papersync tab', async function () {
		// openPluginSettings waits for the Papersync tab's own template editor.
		await openPluginSettings();
		await closeSettings();
	});

	it('adds a status bar item', async function () {
		await switchToMainWindow();
		const count = await browser.execute((id: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { statusBarEl: HTMLElement | null }> } } }).app.plugins.plugins;
			const el = ps[id]?.statusBarEl;
			return el ? Number(document.querySelector('.status-bar')?.contains(el)) : 0;
		}, manifest.id);
		expect(count).toBe(1);
	});
});
