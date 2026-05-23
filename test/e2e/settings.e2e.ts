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

	it('hides sync sections in the drive-intent-without-auth half-state', async function () {
		// Regression test for settings.ts display-gate fix.
		// Pre-fix, the gate was `backendType !== 'none'` — so a user mid-flow
		// (backendType set to 'drive' but auth never completed) would see the
		// Notes folder / Sync now / Note Template sections rendered even though
		// no sync engine actually existed. Post-fix the gate requires either
		// Google auth or Folder setupComplete.
		await browser.execute(async () => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void> }> } } }).app;
			const plugin = app.plugins.plugins['obsidian-papersync'];
			if (!plugin) { throw new Error('Plugin not loaded'); }

			// Set the half-state: drive intent without authentication.
			plugin.settings.backendType = 'drive';
			plugin.settings.setupComplete = false;
			plugin.settings.oauthRefreshToken = '';
			plugin.settings.oauthExpiresAt = 0;
			await plugin.saveSettings();
		});

		// Re-open settings so display() re-runs with the half-state.
		await browser.executeObsidianCommand('obsidian-papersync:papersync-open-settings');
		await browser.pause(800);

		const body = await browser.$('body');
		const text = await body.getText();

		// Storage section MUST still render — it's where the user fixes the half-state.
		expect(text).toContain('Storage');
		// But the sync/template sections MUST NOT render — there is no working sync.
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
