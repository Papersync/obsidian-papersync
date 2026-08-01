import { openPluginSettings, closeSettings, clickSettingsTab } from './helpers';

describe('Edge cases and error handling', function () {
	it('survives rapid sync now clicks', async function () {
		// Fire sync command 3 times rapidly — should not crash
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.pause(2000);

		// Plugin should still be functional
		const body = await browser.$('body');
		const text = await body.getText();
		expect(text).toContain('Papersync');
	});

	it('survives opening and closing settings rapidly', async function () {
		for (let i = 0; i < 5; i++) {
			await openPluginSettings();
			await closeSettings();
		}

		// Plugin should still be functional — verify workspace is intact
		const workspace = await browser.$('.workspace');
		expect(await workspace.isExisting()).toBe(true);
	});

	it('handles settings reset without crashing', async function () {
		await openPluginSettings();

		// Reset lives under the Advanced tab (no-op where there is no tab bar).
		await clickSettingsTab('Advanced');

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
			expect(text).toContain('Papersync');
		}

		await closeSettings();
	});

	it('no console errors from plugin on load', async function () {
		// getLogs is typed as object[], so the shape has to be asserted rather than
		// annotated on the predicate.
		const logs = (await browser.getLogs('browser')) as Array<{ level: string; message: string }>;
		const pluginErrors = logs.filter(
			(log) => log.level === 'SEVERE' && log.message.includes('papersync')
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
			await browser.executeObsidianCommand('papersync:dev-fake-scan');
		} catch {
			// Expected — command doesn't exist in production
		}
		await browser.pause(500);

		// Plugin should still be functional
		const workspace = await browser.$('.workspace');
		expect(await workspace.isExisting()).toBe(true);
	});
});
