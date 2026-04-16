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
		await browser.pause(2000);

		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Welcome to PaperSynced');
		expect(text).toContain('Step 1 of 6');
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
		await browser.pause(500);

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
