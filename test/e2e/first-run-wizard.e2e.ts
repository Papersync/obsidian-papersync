describe('First-run wizard', function () {
	it('shows wizard modal on fresh install', async function () {
		// Set setupComplete to false to trigger wizard
		await browser.execute(async () => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void> }> } } }).app;
			const plugin = app.plugins.plugins['obsidian-papersynced'];
			if (!plugin) return;
			plugin.settings.setupComplete = false;
			await plugin.saveSettings();
		});

		// Reload the plugin to trigger first-run check
		await browser.execute(async () => {
			const app = (window as unknown as { app: { plugins: { disablePlugin: (id: string) => Promise<void>; enablePlugin: (id: string) => Promise<void> } } }).app;
			await app.plugins.disablePlugin('obsidian-papersynced');
			await app.plugins.enablePlugin('obsidian-papersynced');
		});

		// Wait for wizard modal to appear
		await browser.waitUntil(
			async () => (await (await browser.$('body')).getText()).includes('Welcome to PaperSynced'),
			{ timeout: 5000, timeoutMsg: 'Wizard modal did not appear' }
		);

		const text = await (await browser.$('body')).getText();
		// Step count varies: 4 for Drive, 5 for Folder — on welcome it shows the Drive count
		expect(text).toContain('Step 1 of 4');
	});

	it('wizard has Next button on welcome step', async function () {
		const body = await browser.$('body');
		const text = await body.getText();
		if (text.includes('Welcome to PaperSynced')) {
			expect(text).toContain('Next');
		}
	});

	it('closing wizard does not set setupComplete', async function () {
		// Close the modal
		await browser.keys('Escape');
		await browser.waitUntil(
			async () => !(await (await browser.$('body')).getText()).includes('Welcome to PaperSynced'),
			{ timeout: 3000, timeoutMsg: 'Modal did not close' }
		);

		const result = await browser.execute(() => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: { setupComplete: boolean } }> } } }).app;
			const plugin = app.plugins.plugins['obsidian-papersynced'];
			return plugin?.settings.setupComplete;
		});
		expect(result).toBe(false);

		// Restore setupComplete for other tests
		await browser.execute(async () => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void> }> } } }).app;
			const plugin = app.plugins.plugins['obsidian-papersynced'];
			if (!plugin) return;
			plugin.settings.setupComplete = true;
			await plugin.saveSettings();
		});
	});
});
