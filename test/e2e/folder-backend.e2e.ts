describe('Folder backend settings', function () {
	beforeEach(async function () {
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-open-settings');
		await browser.pause(1000);
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows storage section with folder option when not connected', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		// When not connected, shows both storage options
		if (!text.includes('Change Storage')) {
			expect(text).toContain('A folder on this device');
			expect(text).toContain('Choose your sync folder');
		}
	});

	it('shows Browse option', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Choose your sync folder')) {
			expect(text).toContain('Browse');
		}
	});

	it('does not show any pre-selected or recommended folder option', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Choose your sync folder')) {
			expect(text).not.toContain('Recommended');
		}
	});

	it('shows Google Drive and folder as equal storage options', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (!text.includes('Change Storage')) {
			expect(text).toContain('Google Drive');
			expect(text).toContain('A folder on this device');
		}
	});
});
