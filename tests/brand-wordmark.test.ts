import { BRAND_WORDMARK_SVG } from '@/ui/brand-wordmark';

describe('bundled brand source asset', () => {
	it('is an accessible, complete offline SVG using the host theme', () => {
		const doc = new DOMParser().parseFromString(BRAND_WORDMARK_SVG, 'image/svg+xml');
		const svg = doc.documentElement;
		expect(svg.tagName).toBe('svg');
		expect(svg.getAttribute('viewBox')).toBe('0 0 600 185');
		expect(svg.getAttribute('role')).toBe('img');
		expect(svg.getAttribute('aria-label')).toBe('Papersync');
		expect(svg.querySelector('title')?.textContent).toBe('Papersync');
		expect(svg.querySelectorAll('path')).toHaveLength(3);
		expect(BRAND_WORDMARK_SVG).toContain('var(--text-normal)');
		expect(BRAND_WORDMARK_SVG).toContain('var(--text-accent)');
		expect(svg.querySelector('text, image, use, style, script, foreignObject')).toBeNull();
		expect(BRAND_WORDMARK_SVG).not.toMatch(/(?:href=|url\(|font-family|#[a-f0-9]{6})/i);
	});
});
