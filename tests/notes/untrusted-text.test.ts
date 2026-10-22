import { clampLength, escapePlainText, flattenLine, neutralizeMarkdown, neutralizeTemplater, sanitizeInlineValue } from '@/notes/untrusted-text';

const Z = '​';

describe('untrusted scan text', () => {
	it('flattens line breaks', () => {
		expect(flattenLine('a\r\nb c')).toBe('a b c');
	});

	it('escapes plain text so no Markdown or Templater tag survives', () => {
		expect(escapePlainText('# x <%* y %>\n[[z]]')).toBe(String.raw`\# x \<\%\* y \%\> \[\[z\]\]`);
	});

	it('breaks Templater tags', () => {
		expect(neutralizeTemplater('<%= tp.date.now() %> and <%* code -%>')).toBe(
			`<${Z}%= tp.date.now() %${Z}> and <${Z}%* code -%${Z}>`
		);
		expect(sanitizeInlineValue('m\n<%x%>')).toBe(`m <${Z}%x%${Z}>`);
	});

	it.each([
		['```dataviewjs\ndv.span(1)\n```', `\`\`\`${Z}dataviewjs\ndv.span(1)\n\`\`\``],
		['~~~~ DataView\nLIST\n~~~~', `~~~~ ${Z}DataView\nLIST\n~~~~`],
		['> ```js-engine {x}\n> run\n> ```', `> \`\`\`${Z}js-engine {x}\n> run\n> \`\`\``],
		['```tasks\nfilter by function true\n```', `\`\`\`${Z}tasks\nfilter by function true\n\`\`\``],
	])('renames an executable code block language (%j)', (input, expected) => {
		expect(neutralizeMarkdown(input)).toBe(expected);
	});

	it('keeps ordinary code blocks and languages that only start with an executable name', () => {
		const md = '```python\nprint(1)\n```\n```dataview-notes\nx\n```\n```\nplain\n```';
		expect(neutralizeMarkdown(md)).toBe(md);
	});

	it('breaks Dataview inline JS queries only', () => {
		expect(neutralizeMarkdown('Total: `$= dv.pages().length` and `= this.file.name` and `` $=x ``')).toBe(
			`Total: \`$${Z}= dv.pages().length\` and \`= this.file.name\` and \`\` $${Z}=x \`\``
		);
	});

	it('turns remote and reference images into links but keeps vault images', () => {
		expect(neutralizeMarkdown('![pixel](https://evil.test/p.png) ![a](<http://x>) ![b](//cdn/x) ![c][ref] ![ok](img/a.png) ![[local.png]]')).toBe(
			`!${Z}[pixel](https://evil.test/p.png) !${Z}[a](<http://x>) !${Z}[b](//cdn/x) !${Z}[c][ref] ![ok](img/a.png) ![[local.png]]`
		);
	});

	it('breaks HTML tags that load resources but keeps other HTML', () => {
		expect(neutralizeMarkdown('<img src="https://x"> <IFRAME src=x></iframe> <b>bold</b> a < b')).toBe(
			`<${Z}img src="https://x"> <${Z}IFRAME src=x><${Z}/iframe> <b>bold</b> a < b`
		);
	});

	it('leaves ordinary Markdown untouched', () => {
		const md = '# Title\n\n- [ ] task\n> [!note] callout\n[[Link|alias]] **bold** 5% off, 3 < 4 > 2\n![[scan.jpg]]';
		expect(neutralizeMarkdown(md)).toBe(md);
	});

	it('clamps long text by code points with an ellipsis', () => {
		expect(clampLength('short', 80)).toBe('short');
		expect(clampLength('abcdef', 4)).toBe('abc\u2026');
		expect(clampLength('ab cdef', 4)).toBe('ab\u2026');
		expect(clampLength('😀😀😀😀😀', 3)).toBe('😀😀\u2026');
	});
});
