import * as fs from 'fs';
import * as path from 'path';
import {
	openPluginSettings,
	closeSettings,
	switchToMainWindow,
	configureFolderBackend,
	vaultBasePath,
	visibleSettingNames,
} from './helpers';

// The Settings tab in both of its shapes. The connected rows are checked with a
// folder backend this spec connects itself: the tests used to return early when
// no backend happened to be configured, which on a clean test vault (CI) is
// always, so they passed without asserting anything.
//
// Rows are found by their name (.setting-item-name), visible rows only: Obsidian
// renders every definition and hides the ones whose visible() is false.

// Drive-only rows (Poll interval) need a signed-in Drive backend; that is the
// fake Google server's job and lives in drive-oauth-sync.e2e.ts.

async function disconnect(): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async () => {
		const app = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>; saveSettings: () => Promise<void>; stopSync: () => void;
		}> } } }).app;
		const plugin = app.plugins.plugins['papersync'];
		if (!plugin) { throw new Error('Plugin not loaded'); }
		plugin.stopSync();
		plugin.settings.backendType = 'none';
		plugin.settings.folderPath = '';
		plugin.settings.folderType = '';
		plugin.settings.setupComplete = false;
		await plugin.saveSettings();
	});
}

describe('Settings tab', function () {
	const SCANS = 'Papersync-settings-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	describe('with a folder backend connected', function () {
		before(async function () {
			await configureFolderBackend({ folderPath: dir, targetFolder: 'SettingsTest', attachmentsFolder: 'SettingsTest/attachments' });
			// A clean vault opens Settings on first run; close it so every test below
			// opens a fresh render of the connected state.
			await closeSettings();
		});

		beforeEach(async function () {
			await openPluginSettings();
		});

		afterEach(async function () {
			await closeSettings();
		});

		it('shows the connected folder with Sync now and Change storage, and no picker', async function () {
			const names = await visibleSettingNames();
			expect(names).toContain('✓ Folder sync');
			expect(names).not.toContain('Select your Papersync folder');
			expect(names).not.toContain('Google Drive');

			const buttons = await browser.execute(() => Array.from(
				document.querySelectorAll('.papersync-storage-active button')
			).map((b) => b.textContent?.trim() ?? ''));
			expect(buttons).toContain('Sync now');
			expect(buttons).toContain('Change storage');
		});

		it('shows the Save scans to, Save scan images and Attachments folder rows', async function () {
			const names = await visibleSettingNames();
			expect(names).toContain('Save scans to');
			expect(names).toContain('Save scan images');
			expect(names).toContain('Attachments folder');
			// configureFolderBackend picks the custom folder and file, so both show.
			expect(names).toContain('Folder');
			expect(names).toContain('File name');
		});

		it('shows the Note template row with its variables and editor', async function () {
			const names = await visibleSettingNames();
			expect(names).toContain('Note template');

			const tokens = await browser.execute(() => Array.from(
				document.querySelectorAll('.papersync-var-token')
			).map((el) => el.textContent?.trim() ?? ''));
			expect(tokens).toContain('{{ps_markdown}}');
			expect(tokens).toContain('{{ps_image_file}}');
			expect(tokens).toContain('{{ps_scan_time}}');

			const textarea = await browser.$('.papersync-template-editor');
			await textarea.waitForExist({ timeout: 3000 });
			expect(await textarea.getValue()).toContain('{{ps_markdown}}');
		});

		it('renders a live preview of the template with sample values', async function () {
			const editor = await browser.$('.papersync-template-editor');
			await editor.waitForExist({ timeout: 3000 });
			const original = await editor.getValue();

			// Type a template that uses two tokens; the preview should substitute a sample
			// scan and render the result as markdown.
			await editor.clearValue();
			await editor.setValue('## {{ps_scan_time}}\n\n{{ps_markdown}}');
			await browser.waitUntil(
				async () => {
					const text = await (await browser.$('.papersync-template-preview')).getText();
					return text.includes('2:30 PM') && text.includes('Grocery');
				},
				{ timeout: 5000, interval: 100, timeoutMsg: 'preview never rendered the sample time and body' }
			);

			// A correctly-written image embed is swapped for the handwriting stand-in.
			// Waited for rather than slept on: the debounce plus an async markdown render
			// plus SVG generation has no fixed duration, and a bare pause turns CPU
			// contention during a full-suite run into a spurious failure.
			await editor.clearValue();
			await editor.setValue('![[{{ps_image_file}}]]');
			await browser.waitUntil(
				async () => (await browser.$('.papersync-preview-scan')).isExisting(),
				{ timeout: 5000, interval: 100, timeoutMsg: 'scan stand-in never rendered for a valid embed' }
			);

			// A malformed embed (empty {{}} token stays literal) must NOT get the stand-in.
			// Gate on the literal token appearing first, so this proves the preview
			// re-rendered rather than passing vacuously before the render even started.
			await editor.clearValue();
			await editor.setValue('![[{{}}]]');
			await browser.waitUntil(
				async () => (await (await browser.$('.papersync-template-preview')).getText()).includes('{{}}'),
				{ timeout: 5000, interval: 100, timeoutMsg: 'preview never re-rendered the malformed embed' }
			);
			expect(await (await browser.$('.papersync-preview-scan')).isExisting()).toBe(false);

			await editor.clearValue();
			await editor.setValue(original);
			await browser.waitUntil(
				async () => (await (await browser.$('.papersync-template-preview')).getText()).includes('Grocery'),
				{ timeout: 5000, interval: 100, timeoutMsg: 'preview never re-rendered the restored template' }
			);
		});

		it('shows Reset settings and Full reset, and no Drive poll interval', async function () {
			const names = await visibleSettingNames();
			expect(names).toContain('Reset settings');
			const buttons = await browser.execute(() => Array.from(document.querySelectorAll('button'))
				.filter((b) => b.offsetParent !== null)
				.map((b) => b.textContent?.trim() ?? ''));
			expect(buttons).toContain('Reset settings');
			expect(buttons).toContain('Full reset');
			// Poll interval is Drive-only; a folder backend watches the filesystem.
			expect(names).not.toContain('Poll interval (seconds)');
		});
	});

	describe('with no backend connected', function () {
		before(async function () {
			await disconnect();
		});

		afterEach(async function () {
			await closeSettings();
		});

		it('shows the storage picker and hides the connected-only rows', async function () {
			await openPluginSettings();
			const names = await visibleSettingNames();
			expect(names).toContain('Google Drive');
			expect(names).toContain('Select your Papersync folder');
			expect(names).not.toContain('✓ Folder sync');
			expect(names).not.toContain('Save scans to');
			expect(names).not.toContain('Save scan images');
			expect(names).not.toContain('Attachments folder');
			// The template is not tied to a backend: it is shown either way (it was its
			// own tab before the 1.13 declarative settings, too).
			expect(names).toContain('Note template');
		});

		it('hides the connected-only rows in the drive-intent-without-auth half-state', async function () {
			// Regression test for settings.ts display-gate fix.
			// Pre-fix, the gate was `backendType !== 'none'`, so a user mid-flow
			// (backendType set to 'drive' but auth never completed) saw the
			// Save scans to and Sync now rows even though no sync engine existed.
			// Post-fix the gate requires either Google auth or Folder setupComplete.
			// State is changed from the main window: window.app only exists there; on
			// 1.13+ the settings UI is in its own window.
			await switchToMainWindow();
			await browser.execute(async () => {
				const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void>; oauthManager?: { disconnect: () => void } }> } } }).app;
				const plugin = app.plugins.plugins['papersync'];
				if (!plugin) { throw new Error('Plugin not loaded'); }

				// disconnect() clears the LIVE oauthManager (isGoogleConnected reads it, not
				// settings) and the refresh token in secret storage, so the half-state is
				// reachable whatever was restored at load.
				plugin.oauthManager?.disconnect();
				plugin.settings.backendType = 'drive';
				plugin.settings.setupComplete = false;
				plugin.settings.oauthExpiresAt = 0;
				await plugin.saveSettings();
			});

			await openPluginSettings();
			const names = await visibleSettingNames();

			// The storage picker MUST still render: it's where the user fixes the half-state.
			expect(names).toContain('Google Drive');
			// But the connected-only rows MUST NOT: there is no working sync.
			expect(names).not.toContain('Save scans to');
			expect(names).not.toContain('Save scan images');
			expect(names.some((n) => n.startsWith('✓'))).toBe(false);
			const buttons = await browser.execute(() => Array.from(document.querySelectorAll('button'))
				.filter((b) => b.offsetParent !== null)
				.map((b) => b.textContent?.trim() ?? ''));
			expect(buttons).not.toContain('Sync now');
			expect(buttons).not.toContain('Change storage');
		});
	});
});
