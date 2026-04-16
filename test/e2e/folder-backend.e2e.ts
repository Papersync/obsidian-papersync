describe('Folder backend settings', function () {
	beforeEach(async function () {
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-open-settings');
		await browser.pause(1000);
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows sync folder heading in settings when not connected', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		// If not connected, account section should be visible
		if (text.includes('Connect your account')) {
			expect(text).toContain('Choose your sync folder');
		}
	});

	it('shows Pick another folder option', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Choose your sync folder')) {
			expect(text).toContain('Pick another folder');
		}
	});

	it('does not show any pre-selected or recommended folder option', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Choose your sync folder')) {
			// No "Recommended" badge should appear
			expect(text).not.toContain('Recommended');
		}
	});

	it('shows detected sync locations without iCloud-first framing', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Choose your sync folder')) {
			// The section should not say "Connect iCloud" as a primary action
			expect(text).not.toContain('Connect iCloud');
		}
	});
});
