describe('Folder backend settings', function () {
	beforeEach(async function () {
		await browser.executeObsidianCommand('papersync:open-settings');
		await browser.pause(1000);
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows storage section with folder and drive options when not connected', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (!text.includes('Change Storage')) {
			expect(text).toContain('Google Drive');
			expect(text).toContain('Select your PaperSync folder');
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
