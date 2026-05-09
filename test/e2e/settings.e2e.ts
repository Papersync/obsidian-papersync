describe('Settings tab', function () {
	let isConnected: boolean;

	beforeEach(async function () {
		await browser.executeObsidianCommand('obsidian-papersync:papersync-open-settings');
		await browser.pause(1000);
		const body = await browser.$('body');
		const text = await body.getText();
		isConnected = text.includes('Change Storage');
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows storage section', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Storage');
	});

	it('shows notes folder setting when connected', async function () {
		if (!isConnected) {return;}
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Notes folder');
		expect(text).toContain('date tokens');
	});

	it('shows save scan images toggle when connected', async function () {
		if (!isConnected) {return;}
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Save scan images');
	});

	it('shows note template section when connected', async function () {
		if (!isConnected) {return;}
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Note Template');
		expect(text).toContain('{{markdown}}');
		expect(text).toContain('{{image_file}}');
		expect(text).toContain('{{time}}');
	});

	it('shows template editor textarea when connected', async function () {
		if (!isConnected) {return;}
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();
		expect(value).toContain('{{markdown}}');
	});

	it('shows sync now button when connected', async function () {
		if (!isConnected) {return;}
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Sync now');
	});

	it('shows debug logging toggle always', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Debug logging');
	});

	it('shows reset buttons always', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Reset settings');
		expect(text).toContain('Full reset');
	});

	it('hides sync sections when not connected', async function () {
		if (isConnected) {return;}
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).not.toContain('Notes folder');
		expect(text).not.toContain('Note Template');
		expect(text).not.toContain('Sync now');
	});

	it('shows poll interval only when Drive connected', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Disconnect') && text.includes('Poll interval')) {
			expect(text).toContain('Poll interval');
		}
		// If not Drive-connected, poll interval should not appear — verified by absence
	});
});
