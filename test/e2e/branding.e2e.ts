import { openPluginSettings, closeSettings } from './helpers';

describe('Settings layout', function () {
	before(async function () {
		await openPluginSettings();
	});

	after(async function () {
		await closeSettings();
	});

	it('starts with Sync without a brand introduction', async function () {
		const layout = await browser.execute(() => ({
			brandRows: document.querySelectorAll('.papersync-brand-intro').length,
			groups: Array.from(document.querySelectorAll('.setting-item-heading')).map((el) => el.textContent?.trim()),
		}));
		expect(layout.brandRows).toBe(0);
		expect(layout.groups).toEqual(['Sync', 'Template', 'Advanced']);
	});
});
