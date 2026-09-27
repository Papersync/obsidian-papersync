import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openPluginSettings, closeSettings, configureFolderBackend, focusSettingsUI, switchToMainWindow, isoStamp } from './helpers';
import { STRINGS } from '../../src/utils/strings';

describe('Folder backend settings', function () {
	beforeEach(async function () {
		await openPluginSettings();
	});

	afterEach(async function () {
		await closeSettings();
	});

	it('shows storage section with folder and drive options when not connected', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (!text.includes('Change Storage')) {
			expect(text).toContain('Google Drive');
			expect(text).toContain('Select your Papersync folder');
		}
	});

	it('shows Browse button for folder selection', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (!text.includes('Change Storage')) {
			expect(text).toContain('Browse');
		}
	});

	it('does not show any pre-selected or recommended option', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).not.toContain('Recommended');
	});

	it('does not use iCloud-first framing', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).not.toContain('Connect iCloud');
	});
});

// A configured folder that is gone (deleted, renamed, drive unplugged) must read
// as "not connected": the storage picker, under a warning that names the folder.
// Never the connected row with a raw absolute-path error under a green checkmark,
// which is what a failed sync used to leave on screen. Covers both render paths:
// the modal (display(), Obsidian 1.11.4) and the settings window
// (getSettingDefinitions(), 1.13+).
describe('Missing Papersync folder', function () {
	// The recovery case waits for the backend's 5 s re-arm poll plus a sync pass.
	this.timeout(120_000);

	let dir: string;

	beforeEach(async function () {
		dir = path.join(os.tmpdir(), `papersync-e2e-missing-${isoStamp()}`);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'MissingTest', attachmentsFolder: 'MissingTest/attachments' });
	});

	afterEach(async function () {
		await closeSettings();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	// What the storage section shows, read in whichever window hosts the settings.
	// Scoped to elements, not body text: on 1.11.4 the error Notice shares the
	// modal's document and would match a text search on its own.
	async function storageUi(): Promise<{ warning: string | null; connectedRow: boolean; buttons: string[] }> {
		await focusSettingsUI();
		return browser.execute(() => {
			// Visible only: the 1.13+ declarative renderer keeps rows whose visible()
			// is false in the DOM, just hidden, so bare existence proves nothing.
			const shown = (el: Element | null): el is HTMLElement =>
				!!el && (el as HTMLElement).getClientRects().length > 0;
			const warn = document.querySelector('.papersync-folder-missing');
			return {
				warning: shown(warn) ? warn.innerText.replace(/\s+/g, ' ').trim() : null,
				connectedRow: shown(document.querySelector('.papersync-storage-active')),
				buttons: Array.from(document.querySelectorAll('button')).filter(shown).map((b) => (b.textContent ?? '').trim()),
			};
		});
	}

	async function forceSyncStatus(): Promise<{ status?: string; lastError?: string | null }> {
		await switchToMainWindow();
		return browser.execute(async () => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
				syncEngine?: { forceSyncNow: () => Promise<void> };
				syncState?: { status: string; lastError: string | null };
			}> } } }).app.plugins.plugins;
			const plugin = ps['papersync'] ?? ps['obsidian-papersync'];
			await plugin?.syncEngine?.forceSyncNow();
			return { status: plugin?.syncState?.status, lastError: plugin?.syncState?.lastError };
		});
	}

	function expectPicker(ui: { warning: string | null; connectedRow: boolean; buttons: string[] }): void {
		expect(ui.warning).toContain(`"${path.basename(dir)}" is missing`);
		expect(ui.warning).toContain(STRINGS.SETTINGS_FOLDER_MISSING_DESC);
		expect(ui.warning).not.toContain(dir); // names the folder, never its absolute path
		expect(ui.connectedRow).toBe(false);
		expect(ui.buttons).toContain('Browse');
		expect(ui.buttons).not.toContain('Change Storage');
		expect(ui.buttons).not.toContain('Sync now');
	}

	it('opens on the storage picker with a warning when the folder is already gone', async function () {
		fs.rmSync(dir, { recursive: true, force: true });
		await openPluginSettings();
		expectPicker(await storageUi());
	});

	it('switches open settings to the picker when a sync finds the folder gone', async function () {
		await openPluginSettings();
		expect((await storageUi()).connectedRow).toBe(true);

		fs.rmSync(dir, { recursive: true, force: true });
		// Polled: forceSyncNow() no-ops while another sync is in flight.
		let st: { status?: string; lastError?: string | null } = {};
		await browser.waitUntil(async () => (st = await forceSyncStatus()).status === 'error', { timeout: 20_000, interval: 1000 });
		expect(st.lastError).toBe(STRINGS.NOTICE_FOLDER_MISSING);

		await browser.waitUntil(async () => (await storageUi()).warning !== null, {
			timeout: 10_000, interval: 250, timeoutMsg: 'open settings never switched to the missing-folder picker',
		});
		expectPicker(await storageUi());
	});

	it('switches open settings to the picker when the folder is deleted, without any sync', async function () {
		await openPluginSettings();
		expect((await storageUi()).connectedRow).toBe(true);

		// Only the backend's watcher can notice this: nobody presses Sync now.
		fs.rmSync(dir, { recursive: true, force: true });
		await browser.waitUntil(async () => (await storageUi()).warning !== null, {
			timeout: 15_000, interval: 250, timeoutMsg: 'folder deletion never reached the open settings',
		});
		expectPicker(await storageUi());
	});

	it('returns to the connected row by itself once the folder is back', async function () {
		await openPluginSettings();
		fs.rmSync(dir, { recursive: true, force: true });
		await browser.waitUntil(async () => (await forceSyncStatus()).status === 'error', { timeout: 20_000, interval: 1000 });
		await browser.waitUntil(async () => (await storageUi()).warning !== null, { timeout: 10_000, interval: 250 });

		// "Reconnect the drive it lives on": the backend's re-arm poll finds the
		// folder, runs a pass, the error clears, and the open tab flips back.
		fs.mkdirSync(dir, { recursive: true });
		await browser.waitUntil(async () => {
			const ui = await storageUi();
			return ui.warning === null && ui.connectedRow;
		}, { timeout: 30_000, interval: 500, timeoutMsg: 'settings never returned to the connected row after the folder came back' });

		await switchToMainWindow();
		const state = await browser.execute(() => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { syncState?: { status: string } }> } } }).app.plugins.plugins;
			return (ps['papersync'] ?? ps['obsidian-papersync'])?.syncState?.status;
		});
		expect(state).toBe('synced');
	});
});
