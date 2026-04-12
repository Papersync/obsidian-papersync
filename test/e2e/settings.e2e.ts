describe('Settings tab', function () {
	beforeEach(async function () {
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-open-settings');
		await browser.pause(1000);
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows account section with connect or connected state', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		const hasAccount = text.includes('Connect your account') || text.includes('Google Drive');
		expect(hasAccount).toBe(true);
	});

	it('shows notes folder setting', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Notes folder');
		expect(text).toContain('date tokens');
	});

	it('shows attachments folder setting', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Attachments folder');
	});

	it('shows note template section with variable list', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Note Template');
		expect(text).toContain('{{markdown}}');
		expect(text).toContain('{{image_file}}');
		expect(text).toContain('{{time}}');
	});

	it('shows template editor textarea', async function () {
		const textarea = await browser.$('.papersynced-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();
		expect(value).toContain('{{markdown}}');
	});

	it('shows sync now button', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Sync now');
	});

	it('shows debug logging toggle', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Debug logging');
	});

	it('shows reset buttons in advanced section', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Reset settings');
		expect(text).toContain('Full reset');
	});

	it('shows poll interval when connected to Drive', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		// Only visible when Drive backend is configured
		if (text.includes('Google Drive')) {
			expect(text).toContain('Poll interval');
		}
	});
});
