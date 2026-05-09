describe('Edge cases and error handling', function () {
	it('survives rapid sync now clicks', async function () {
		// Fire sync command 3 times rapidly — should not crash
		await browser.executeObsidianCommand('obsidian-papersync:papersync-sync-now');
		await browser.executeObsidianCommand('obsidian-papersync:papersync-sync-now');
		await browser.executeObsidianCommand('obsidian-papersync:papersync-sync-now');
		await browser.pause(2000);

		// Plugin should still be functional
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('PaperSync');
	});

	it('survives opening and closing settings rapidly', async function () {
		for (let i = 0; i < 5; i++) {
			await browser.executeObsidianCommand('obsidian-papersync:papersync-open-settings');
			await browser.pause(200);
			await browser.keys('Escape');
			await browser.pause(200);
		}

		// Plugin should still be functional — verify workspace is intact
		const workspace = await browser.$('.workspace');
		expect(await workspace.isExisting()).toBe(true);
	});

	it('handles settings reset without crashing', async function () {
		await browser.executeObsidianCommand('obsidian-papersync:papersync-open-settings');
		await browser.pause(1000);

		// Find and click the "Reset settings" button (not full reset)
		const buttons = await browser.$$('button');
		let resetClicked = false;
		for (const btn of buttons) {
			const btnText = await btn.getText();
			if (btnText === 'Reset settings') {
				await btn.click();
				resetClicked = true;
				break;
			}
		}

		if (resetClicked) {
			await browser.pause(1000);
			// Plugin should still be functional after reset
			const body = await browser.$('body');
			const text = await body.getText();
			expect(text).toContain('PaperSync');
		}

		await browser.keys('Escape');
	});

	it('no console errors from plugin on load', async function () {
		const logs = await browser.getLogs('browser');
		const pluginErrors = logs.filter(
			(log: { level: string; message: string }) =>
				log.level === 'SEVERE' && log.message.includes('papersync')
		);
		expect(pluginErrors.length).toBe(0);
	});

	it('plugin does not block Obsidian startup', async function () {
		// Verify the main workspace loaded (not stuck on loading screen)
		const workspace = await browser.$('.workspace');
		await workspace.waitForExist({ timeout: 10000 });
		expect(await workspace.isDisplayed()).toBe(true);
	});

	it('handles missing DEV commands gracefully in production', async function () {
		// DEV_MODE is false in production builds — command won't exist
		try {
			await browser.executeObsidianCommand('obsidian-papersync:papersync-dev-fake-scan');
		} catch {
			// Expected — command doesn't exist in production
		}
		await browser.pause(500);

		// Plugin should still be functional
		const workspace = await browser.$('.workspace');
		expect(await workspace.isExisting()).toBe(true);
	});
});
