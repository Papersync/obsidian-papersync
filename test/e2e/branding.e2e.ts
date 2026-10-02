import * as fs from 'node:fs';
import * as path from 'node:path';
import { openPluginSettings, closeSettings } from './helpers';

describe('Settings brand signature', function () {
	before(async function () {
		await openPluginSettings();
	});

	after(async function () {
		await closeSettings();
	});

	it('keeps the complete local wordmark accessible and bounded in both host themes at large text sizes', async function () {
		const logo = await browser.$('.papersync-brand-intro svg');
		await logo.waitForDisplayed({ timeout: 5000 });
		expect(await logo.getAttribute('role')).toBe('img');
		expect(await logo.getAttribute('aria-label')).toBe('Papersync');
		expect(await logo.getAttribute('viewBox')).toBe('0 0 600 185');
		const original = await browser.execute(() => ({
			className: document.body.className,
			style: document.body.getAttribute('style'),
		}));
		const artifactDir = process.env.PAPERSYNC_BRAND_ARTIFACT_DIR;
		try {
			for (const theme of ['light', 'dark']) {
				for (const scale of [1, 1.3, 2]) {
					const result = await browser.execute((mode: string, factor: number) => {
						document.body.classList.remove('theme-light', 'theme-dark');
						document.body.classList.add(`theme-${mode}`);
						document.body.style.setProperty('--font-ui-small', `${13 * factor}px`);
						document.body.style.setProperty('--font-ui-medium', `${15 * factor}px`);
						const intro = document.querySelector<HTMLElement>('.papersync-brand-intro')!;
						// Constrain this row to a narrow settings content pane, without
						// changing any real settings definitions or the host's window.
						intro.style.maxWidth = '240px';
						const svg = intro.querySelector<SVGSVGElement>('svg')!;
						const bounds = svg.getBoundingClientRect();
						const pane = intro.getBoundingClientRect();
						const paths = Array.from(svg.querySelectorAll('path'));
						return {
							width: bounds.width,
							height: bounds.height,
							fits: bounds.left >= pane.left && bounds.right <= pane.right + 0.5,
							letters: paths.length,
							ink: getComputedStyle(paths[0]!).fill,
							accent: getComputedStyle(paths[1]!).fill,
							hostInk: getComputedStyle(document.body).getPropertyValue('--text-normal').trim(),
							name: intro.querySelector('.setting-item-name')?.textContent,
							resources: svg.querySelectorAll('image, text, use, script, foreignObject').length,
							groups: Array.from(document.querySelectorAll('.setting-item-heading')).map((el) => el.textContent),
						};
					}, theme, scale);
					expect(result.width).toBeGreaterThan(0);
					expect(result.width).toBeLessThanOrEqual(240);
					expect(result.height / result.width).toBeCloseTo(185 / 600, 2);
					expect(result.fits).toBe(true);
					expect(result.letters).toBe(2);
					expect(result.resources).toBe(0);
					expect(result.name).toBe('');
					expect(result.ink).not.toBe(result.accent);
					expect(result.groups.join(' ')).toContain('Sync');
					expect(result.groups.join(' ')).toContain('Template');
					expect(result.groups.join(' ')).toContain('Advanced');
					if (artifactDir) {
						fs.mkdirSync(artifactDir, { recursive: true });
						const version = browser.capabilities.browserVersion;
						await browser.saveScreenshot(path.join(artifactDir, `obsidian-${version}-${theme}-${scale}x.png`));
					}
				}
			}
		} finally {
			await browser.execute((saved: { className: string; style: string | null }) => {
				document.body.className = saved.className;
				if (saved.style === null) { document.body.removeAttribute('style'); }
				else { document.body.setAttribute('style', saved.style); }
				document.querySelector<HTMLElement>('.papersync-brand-intro')!.style.removeProperty('max-width');
			}, original);
		}
	});
});
