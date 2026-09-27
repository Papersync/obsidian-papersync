import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, openPluginSettings, closeSettings, focusSettingsUI, switchToMainWindow, writeScan, triggerSyncNow, waitForNotes, isoStamp } from './helpers';

// The Template section only renders once a backend is connected, so this spec
// connects the folder backend itself rather than skipping when it happens to
// find one. It previously gated on `text.includes('Change Storage')` and called
// this.skip() — a condition a clean test vault never satisfies, so all three
// tests silently never ran while the suite still reported the file as passed.

// Leave a settings field the way a user does, by clicking elsewhere (its row's
// label). A WebDriver Tab key does not move focus on the Electron 28 row, so it
// cannot stand in for leaving the field.
async function leaveField(name: string): Promise<void> {
	await (await browser.$(`.setting-item*=${name}`).$('.setting-item-name')).click();
	await browser.waitUntil(async () => browser.execute(() => document.activeElement?.tagName !== 'INPUT'), {
		timeout: 3000, interval: 100, timeoutMsg: `focus never left the ${name} field`,
	});
}

describe('Template editor', function () {
	const SCANS = 'Papersync-template-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({
			folderPath: dir,
			targetFolder: 'TemplateTest',
			attachmentsFolder: 'TemplateTest/attachments',
		});
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	beforeEach(async function () {
		await openPluginSettings();
	});

	afterEach(async function () {
		await closeSettings();
	});

	it('reaches the Template section with a backend connected', async function () {
		// Guards the setup itself: if connecting ever stops surfacing the section, this
		// fails loudly instead of the suite quietly skipping as it used to.
		const editor = await browser.$('.papersync-template-editor');
		expect(await editor.isExisting()).toBe(true);
	});

	it('template textarea is editable', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		const original = await textarea.getValue();
		expect(original.length).toBeGreaterThan(0);

		await textarea.clearValue();
		await textarea.setValue('## Test\n\n{{ps_markdown}}');
		const newValue = await textarea.getValue();
		expect(newValue).toContain('## Test');

		await textarea.clearValue();
		await textarea.setValue(original);
	});

	it('template contains default variables', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();

		expect(value).toContain('{{ps_scan_time}}');
		expect(value).toContain('{{ps_markdown}}');
		expect(value).toContain('{{ps_image_file}}');
		expect(value).toContain('{{ps_separator}}');
	});

	it('template has proper styling', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		expect(await textarea.isDisplayed()).toBe(true);

		const size = await textarea.getSize();
		expect(size.width).toBeGreaterThan(200);
		expect(size.height).toBeGreaterThan(100);
	});

	it('renders the scan stand-in as an inline SVG, not ASCII art', async function () {
		const preview = await browser.$('.papersync-template-preview');
		await preview.waitForExist({ timeout: 3000 });

		const svg = await browser.$('.papersync-preview-scan svg');
		await svg.waitForExist({ timeout: 3000 });
		expect(await svg.isExisting()).toBe(true);

		// The default template embeds the image, so the stand-in must be present and
		// must no longer be the old monospace tilde block.
		const previewText = await preview.getText();
		expect(previewText).not.toContain('~~~~');
	});

	it('warns under Sync when saving is off but the template still embeds the image', async function () {
		// The warning row used to carry the template editor's `papersync-image-warning`
		// class, which is display:none until the editor adds is-visible, so it never
		// showed. The default template embeds the image, so turning saving off must
		// surface it; turning saving back on must hide it again.
		const warningShown = async (): Promise<boolean> => {
			await focusSettingsUI();
			return browser.execute(() => {
				const row = document.querySelector('.papersync-warning-row') as HTMLElement | null;
				return !!row && row.getClientRects().length > 0 && (row.textContent ?? '').includes('still embeds the scan image');
			});
		};
		const toggleSaveImages = async (): Promise<void> => {
			await focusSettingsUI();
			const clicked = await browser.execute(() => {
				const item = Array.from(document.querySelectorAll('.setting-item'))
					.find((el) => el.querySelector('.setting-item-name')?.textContent?.trim() === 'Save scan images');
				const toggle = item?.querySelector('.checkbox-container') as HTMLElement | null;
				toggle?.click();
				return !!toggle;
			});
			expect(clicked).toBe(true);
		};

		expect(await warningShown()).toBe(false);
		await toggleSaveImages(); // off
		await browser.waitUntil(warningShown, { timeout: 10_000, interval: 250, timeoutMsg: 'the image warning row never became visible' });

		// Editing the template follows the row too: Obsidian cannot see the
		// template textarea, so the row only tracks it because the editor re-runs
		// the visibility predicates after each (debounced) edit.
		const editor = await browser.$('.papersync-template-editor');
		const original = await editor.getValue();
		await editor.setValue(original.split('\n').filter((l) => !l.includes('{{ps_image_file}}')).join('\n'));
		await browser.waitUntil(async () => !(await warningShown()), { timeout: 10_000, interval: 250, timeoutMsg: 'the row stayed up after the image line was removed' });
		await editor.setValue(original);
		await browser.waitUntil(warningShown, { timeout: 10_000, interval: 250, timeoutMsg: 'the row did not come back when the image line was restored' });

		await toggleSaveImages(); // back on
		await browser.waitUntil(async () => !(await warningShown()), { timeout: 10_000, interval: 250, timeoutMsg: 'the image warning row did not hide again' });
	});

	it('applies template and Notes folder edits to the next scan without restarting sync', async function () {
		// startSync() used to hand the engine a COPY of these settings, so an edit in
		// Settings changed the live preview but not the notes until Obsidian
		// restarted. Edit both through the real UI, never call startSync(), then sync.
		// The engine takes an edit once the field is left (not per keystroke), so
		// each edit ends by moving focus on, as a user would.
		const stamp = isoStamp();
		const marker = `LIVE_TEMPLATE_${stamp}`;
		const folder = `TemplateLive${stamp.replace(/[^0-9]/g, '')}`;

		const editor = await browser.$('.papersync-template-editor');
		await editor.waitForExist({ timeout: 10_000 });
		const original = await editor.getValue();
		await editor.setValue(`## ${marker}\n\n{{ps_markdown}}`);

		await focusSettingsUI();
		const notesFolder = await browser.execute(() => {
			const item = Array.from(document.querySelectorAll('.setting-item'))
				.find((el) => el.querySelector('.setting-item-name')?.textContent?.trim() === 'Notes folder');
			return !!item?.querySelector('input');
		});
		expect(notesFolder).toBe(true);
		const input = await browser.$('.setting-item*=Notes folder').$('input');
		await input.setValue(folder); // focusing this field left the template editor
		await leaveField('Notes folder');

		// Both edits persisted and reached the engine.
		await switchToMainWindow();
		await browser.waitUntil(async () => browser.execute((f: string, m: string) => {
			type Cfg = { targetFolder: string; templateString: string };
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Cfg; engineConfig: Cfg }> } } }).app.plugins.plugins;
			const p = ps['papersync'] ?? ps['obsidian-papersync'];
			return p?.settings.targetFolder === f && p.settings.templateString.includes(m)
				&& p.engineConfig.targetFolder === f && p.engineConfig.templateString.includes(m);
		}, folder, marker), { timeout: 10_000, interval: 250, timeoutMsg: 'the settings edits never reached the sync engine' });

		const id = `live-${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `Body for ${marker}`,
			confidence: 90,
			provider: 'claude',
			model: 'claude-sonnet-4',
			imageFileName: `${id}.jpg`,
		});
		await triggerSyncNow();
		const notes = await waitForNotes(folder, marker, 30_000);
		expect(notes).toContain(`## ${marker}`);

		// Restore for the rest of the file.
		await focusSettingsUI();
		await (await browser.$('.papersync-template-editor')).setValue(original);
		await (await browser.$('.setting-item*=Notes folder').$('input')).setValue('TemplateTest');
		await leaveField('Notes folder');
		await switchToMainWindow();
		await browser.waitUntil(async () => browser.execute(() => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { engineConfig: { targetFolder: string } }> } } }).app.plugins.plugins;
			return (ps['papersync'] ?? ps['obsidian-papersync'])?.engineConfig.targetFolder === 'TemplateTest';
		}), { timeout: 10_000, interval: 250 });
	});
});

