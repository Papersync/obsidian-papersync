async function clickTab(label: string): Promise<void> {
	await browser.execute((l: string) => {
		const btn = Array.from(document.querySelectorAll('.papersync-tab')).find((b) => b.textContent === l);
		if (btn) { (btn as HTMLElement).click(); }
	}, label);
	await browser.pause(200);
}

describe('Template editor', function () {
	let isConnected: boolean;

	before(async function () {
		await browser.executeObsidianCommand('obsidian-papersync:open-settings');
		await browser.pause(1000);
		const body = await browser.$('body');
		const text = await body.getText();
		isConnected = text.includes('Change Storage');
		await browser.keys('Escape');
	});

	beforeEach(async function () {
		if (!isConnected) {
			this.skip();
			return;
		}
		await browser.executeObsidianCommand('obsidian-papersync:open-settings');
		await browser.pause(1000);
		await clickTab('PaperSync template');
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('template textarea is editable', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		const original = await textarea.getValue();
		expect(original.length).toBeGreaterThan(0);

		await textarea.clearValue();
		await textarea.setValue('## Test\n\n{{markdown}}');
		const newValue = await textarea.getValue();
		expect(newValue).toContain('## Test');

		await textarea.clearValue();
		await textarea.setValue(original);
	});

	it('template contains default variables', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();

		expect(value).toContain('{{time}}');
		expect(value).toContain('{{markdown}}');
		expect(value).toContain('{{image_file}}');
		expect(value).toContain('{{separator}}');
	});

	it('template has proper styling', async function () {
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		expect(await textarea.isDisplayed()).toBe(true);

		const size = await textarea.getSize();
		expect(size.width).toBeGreaterThan(200);
		expect(size.height).toBeGreaterThan(100);
	});
});
