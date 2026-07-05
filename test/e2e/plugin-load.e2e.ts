describe('PaperSync plugin', function () {
	it('loads without errors', async function () {
		const title = await browser.getTitle();
		expect(title).toBeDefined();
	});

	it('registers the sync now command', async function () {
		await browser.executeObsidianCommand('obsidian-papersync:sync-now');
	});

	it('registers the open settings command', async function () {
		await browser.executeObsidianCommand('obsidian-papersync:open-settings');
		await browser.pause(500);
		await browser.keys('Escape');
	});

	it('shows PaperSync in status bar', async function () {
		await browser.pause(500);
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('PaperSync');
	});
});
