// The connected settings live under tabs (Sync | Note template | Advanced); only the
// active tab's content is in the DOM, so activate a tab before asserting its content.
async function clickTab(label: string): Promise<void> {
	await browser.execute((l: string) => {
		const btn = Array.from(document.querySelectorAll('.papersync-tab')).find((b) => b.textContent === l);
		if (btn) { (btn as HTMLElement).click(); }
	}, label);
	await browser.pause(200);
}

describe('Settings tab', function () {
	let isConnected: boolean;

	beforeEach(async function () {
		await browser.executeObsidianCommand('papersync:open-settings');
		await browser.pause(1000);
		const body = await browser.$('body');
		const text = await body.getText();
		isConnected = text.includes('Change Storage');
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('shows the storage connection or picker in the Sync tab', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		// Storage lives in the Sync tab: a Change Storage button when connected (Drive
		// OR a local folder), or a Browse option in the picker when not connected.
		expect(text.includes('Change Storage') || text.includes('Browse')).toBe(true);
	});

	it('shows notes folder setting when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Sync');
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Notes folder');
		expect(text).toContain('date tokens');
	});

	it('shows save scan images toggle when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Sync');
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Save scan images');
	});

	it('shows the template tab variables when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Template');
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('{{ps_markdown}}');
		expect(text).toContain('{{ps_image_file}}');
		expect(text).toContain('{{ps_scan_time}}');
	});

	it('shows template editor textarea when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Template');
		const textarea = await browser.$('.papersync-template-editor');
		await textarea.waitForExist({ timeout: 3000 });
		const value = await textarea.getValue();
		expect(value).toContain('{{ps_markdown}}');
	});

	it('renders a live preview of the template with sample values', async function () {
		await clickTab('Template');
		const editor = await browser.$('.papersync-template-editor');
		await editor.waitForExist({ timeout: 3000 });
		const original = await editor.getValue();

		// Type a template that uses two tokens; the preview should substitute a sample
		// scan and render the result as markdown.
		await editor.clearValue();
		await editor.setValue('## {{ps_scan_time}}\n\n{{ps_markdown}}');
		await browser.pause(700); // debounce (250ms) + async markdown render

		const preview = await browser.$('.papersync-template-preview');
		await preview.waitForExist({ timeout: 3000 });
		const rendered = await preview.getText();
		expect(rendered).toContain('2:30 PM'); // {{ps_scan_time}} sample value
		expect(rendered).toContain('Grocery'); // {{ps_markdown}} body, rendered

		// A correctly-written image embed is swapped for the ASCII handwriting placeholder.
		await editor.clearValue();
		await editor.setValue('![[{{ps_image_file}}]]');
		await browser.pause(700);
		expect(await (await browser.$('.papersync-preview-scan')).isExisting()).toBe(true);

		// A malformed embed (empty {{}} token stays literal) must NOT get the placeholder.
		await editor.clearValue();
		await editor.setValue('![[{{}}]]');
		await browser.pause(700);
		expect(await (await browser.$('.papersync-preview-scan')).isExisting()).toBe(false);

		await editor.clearValue();
		await editor.setValue(original);
		await browser.pause(400);
	});

	it('shows sync now button when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Sync');
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Sync now');
	});

	it('shows reset buttons in the Advanced tab when connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Advanced');
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
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void>; oauthManager?: { disconnect: () => void } }> } } }).app;
			const plugin = app.plugins.plugins['papersync'];
			if (!plugin) { throw new Error('Plugin not loaded'); }

			// Set the half-state: drive intent without authentication.
			// disconnect() clears the LIVE oauthManager (isGoogleConnected reads it, not
			// settings). Without this the test is at the mercy of a persisted refresh
			// token restored at load (e.g. a dogfood data.json), which leaves the plugin
			// authenticated and the half-state unreachable.
			plugin.oauthManager?.disconnect();
			plugin.settings.backendType = 'drive';
			plugin.settings.setupComplete = false;
			plugin.settings.oauthRefreshToken = '';
			plugin.settings.oauthExpiresAt = 0;
			await plugin.saveSettings();
		});

		// Re-open settings so display() re-runs with the half-state.
		await browser.executeObsidianCommand('papersync:open-settings');
		await browser.pause(800);

		const body = await browser.$('body');
		const text = await body.getText();

		// The storage picker MUST still render — it's where the user fixes the half-state.
		expect(text).toContain('Google Drive');
		// But the sync/template sections MUST NOT render — there is no working sync.
		expect(text).not.toContain('Notes folder');
		expect(text).not.toContain('Note Template');
		expect(text).not.toContain('Sync now');
	});

	it('shows poll interval in the Advanced tab when Drive connected', async function () {
		if (!isConnected) {return;}
		await clickTab('Advanced');
		const body = await browser.$('body');
		const text = await body.getText();
		// Poll interval is Drive-only; folder backends watch the filesystem, so only
		// assert its presence when the connected backend is Google Drive.
		if (text.includes('Google Drive')) {
			expect(text).toContain('Poll interval');
		}
	});
});
