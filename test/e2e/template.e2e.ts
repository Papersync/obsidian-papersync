describe('Template editor', function () {
	beforeEach(async function () {
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-open-settings');
		await browser.pause(1000);
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('template textarea is editable', async function () {
		const textarea = await browser.$('.papersynced-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		// Store original value
		const original = await textarea.getValue();
		expect(original.length).toBeGreaterThan(0);

		// Clear and type new content
		await textarea.clearValue();
		await textarea.setValue('## Test\n\n{{markdown}}');
		const newValue = await textarea.getValue();
		expect(newValue).toContain('## Test');

		// Restore original
		await textarea.clearValue();
		await textarea.setValue(original);
	});

	it('template contains default variables', async function () {
		const textarea = await browser.$('.papersynced-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();

		expect(value).toContain('{{time}}');
		expect(value).toContain('{{markdown}}');
		expect(value).toContain('{{image_file}}');
		expect(value).toContain('{{separator}}');
	});

	it('template has proper styling', async function () {
		const textarea = await browser.$('.papersynced-template-editor');
		await textarea.waitForExist({ timeout: 3000 });

		expect(await textarea.isDisplayed()).toBe(true);

		// Should be full-width
		const size = await textarea.getSize();
		expect(size.width).toBeGreaterThan(200);
		expect(size.height).toBeGreaterThan(100);
	});
});
