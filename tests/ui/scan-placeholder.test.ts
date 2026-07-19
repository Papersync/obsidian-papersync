import { buildScanPlaceholderSvg } from '@/ui/scan-placeholder';

const countPaths = (svg: string): number => (svg.match(/<path d="M/g) ?? []).length;
const countBoxes = (svg: string): number => (svg.match(/<rect x="26"/g) ?? []).length;

describe('buildScanPlaceholderSvg', () => {
	it('draws one squiggle per word of prose', () => {
		const svg = buildScanPlaceholderSvg('one two three four');
		expect(countPaths(svg)).toBe(4);
	});

	it('scales a word squiggle with its length', () => {
		const short = buildScanPlaceholderSvg('hi');
		const long = buildScanPlaceholderSvg('extraordinarily');
		// More characters means more wave segments in the path data.
		const segs = (s: string): number => (s.match(/ q/g) ?? []).length;
		expect(segs(long)).toBeGreaterThan(segs(short));
	});

	it('enforces a minimum width so one-letter words stay visible', () => {
		const svg = buildScanPlaceholderSvg('a');
		expect(countPaths(svg)).toBe(1);
		expect(svg).toContain(' q');
	});

	it('renders a checkbox per task line and a tick only for checked ones', () => {
		const svg = buildScanPlaceholderSvg('- [x] done thing\n- [ ] todo thing\n- [ ] other thing');
		expect(countBoxes(svg)).toBe(3);
		// The tick is the only accent-stroked path.
		const ticks = (svg.match(/stroke:var\(--interactive-accent\)" stroke-width="2.4"/g) ?? []).length;
		expect(ticks).toBe(1);
	});

	it('accepts an uppercase [X] as checked', () => {
		const svg = buildScanPlaceholderSvg('- [X] done');
		const ticks = (svg.match(/stroke:var\(--interactive-accent\)" stroke-width="2.4"/g) ?? []).length;
		expect(ticks).toBe(1);
	});

	it('treats an asterisk bullet as a task line too', () => {
		const svg = buildScanPlaceholderSvg('* [ ] starred task');
		expect(countBoxes(svg)).toBe(1);
	});

	it('skips blank lines without emitting rows', () => {
		const withBlanks = buildScanPlaceholderSvg('alpha\n\n\nbeta');
		const without = buildScanPlaceholderSvg('alpha\nbeta');
		expect(countPaths(withBlanks)).toBe(countPaths(without));
	});

	it('skips a line that has no words after its marker', () => {
		const svg = buildScanPlaceholderSvg('- [ ]   \nreal words here');
		expect(countBoxes(svg)).toBe(0);
		expect(countPaths(svg)).toBe(3);
	});

	it('strips heading markers so the hashes are not drawn as a word', () => {
		expect(countPaths(buildScanPlaceholderSvg('## Title here'))).toBe(2);
	});

	it('wraps a long line onto additional rows and grows the canvas', () => {
		const oneLine = buildScanPlaceholderSvg('short line');
		const manyWords = buildScanPlaceholderSvg(new Array(40).fill('wordy').join(' '));
		const height = (s: string): number => Number(/viewBox="0 0 300 (\d+)"/.exec(s)![1]);
		expect(height(manyWords)).toBeGreaterThan(height(oneLine));
		expect(countPaths(manyWords)).toBe(40);
	});

	it('produces a self-contained svg with no baked hex colors', () => {
		const svg = buildScanPlaceholderSvg('- [x] a task\nsome prose');
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
		expect(svg).toContain('role="img"');
		expect(svg).toContain('aria-label=');
		expect(svg).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
	});

	it('returns a valid empty sheet for empty markdown', () => {
		const svg = buildScanPlaceholderSvg('');
		expect(countPaths(svg)).toBe(0);
		expect(svg).toContain('<svg');
	});
});
