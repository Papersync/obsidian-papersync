import { waitForPlugin } from './helpers';

// The guide modal exists because the OS folder dialog cannot be labelled and a
// wrong pick fails SILENTLY. These assertions run against real Obsidian, which
// is the only place its DOM actually renders.
async function openGuide(): Promise<void> {
	await browser.executeObsidianCommand('papersync:open-settings');
	await browser.pause(800);
	await browser.execute(() => {
		const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Browse');
		if (!btn) { throw new Error('Browse button not found'); }
		(btn as HTMLElement).click();
	});
	await browser.pause(400);
}

describe('Folder picker guide modal', function () {
	before(async function () {
		await waitForPlugin();
	});

	afterEach(async function () {
		await browser.keys('Escape');
		await browser.pause(300);
	});

	it('opens before the folder dialog rather than after a bad pick', async function () {
		await openGuide();
		const tree = await browser.$('.papersync-guide-tree');
		expect(await tree.isExisting()).toBe(true);
	});

	it('marks Papersync as the correct choice and the neighbours as wrong', async function () {
		await openGuide();

		const yes = await browser.$$('.papersync-guide-row.is-yes');
		expect(yes.length).toBe(1);
		expect(await yes[0].getText()).toContain('Papersync');

		// Both the too-high and too-deep levels must be marked, since either one
		// silently yields a folder that never receives scans.
		const no = await browser.$$('.papersync-guide-row.is-no');
		expect(no.length).toBe(2);
		expect(await (await browser.$('.papersync-guide-tree')).getText()).toContain('scans');
	});

	it('states the verdict in text, not colour alone', async function () {
		await openGuide();
		const text = await (await browser.$('.papersync-guide-tree')).getText();
		expect(text).toContain('choose this one');
		expect(text).toContain('too deep');
		expect(text).toContain('too high up');
	});

	it('can be dismissed without opening the folder dialog', async function () {
		await openGuide();
		await browser.execute(() => {
			const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel');
			(btn as HTMLElement | undefined)?.click();
		});
		await browser.pause(300);
		expect(await (await browser.$('.papersync-guide-tree')).isExisting()).toBe(false);
	});
});
