import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath } from './helpers';

// The Template tab only renders once a backend is connected, so this spec
// connects the folder backend itself rather than skipping when it happens to
// find one. It previously gated on `text.includes('Change Storage')` and called
// this.skip() — a condition a clean test vault never satisfies, so all three
// tests silently never ran while the suite still reported the file as passed.
async function clickTab(label: string): Promise<void> {
	await browser.execute((l: string) => {
		const btn = Array.from(document.querySelectorAll('.papersync-tab')).find((b) => b.textContent === l);
		if (btn) { (btn as HTMLElement).click(); }
	}, label);
	await browser.pause(200);
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
		await browser.executeObsidianCommand('papersync:open-settings');
		await browser.pause(1000);
		await clickTab('Template');
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('reaches the Template tab with a backend connected', async function () {
		// Guards the setup itself: if connecting ever stops surfacing the tab, this
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
});
