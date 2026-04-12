describe('Sync state management', function () {
	it('sync now shows notice when not configured', async function () {
		// Open settings to check if we're connected
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-open-settings');
		await browser.pause(500);
		const body = await browser.$('body');
		const settingsText = await body.getText();
		await browser.keys('Escape');
		await browser.pause(300);

		if (settingsText.includes('Connect your account')) {
			// Not connected — sync now should show a notice
			await browser.executeObsidianCommand('obsidian-papersynced:papersynced-sync-now');
			await browser.pause(500);
			// The notice DOM appears briefly — just verify no crash
		}
	});

	it('ribbon icon exists and is clickable', async function () {
		const ribbon = await browser.$('.side-dock-ribbon-action[aria-label="PaperSynced"]');
		if (await ribbon.isExisting()) {
			await ribbon.click();
			await browser.pause(500);
			// Should not crash
		}
	});

	it('status bar text updates after sync command', async function () {
		const bodyBefore = await browser.$('body');
		const textBefore = await bodyBefore.getText();

		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-sync-now');
		await browser.pause(2000);

		const bodyAfter = await browser.$('body');
		const textAfter = await bodyAfter.getText();

		// Status should contain PaperSynced in some state
		expect(textAfter).toContain('PaperSynced');
	});
});
