import { clampLength, escapeMetadataValue, escapePlainText, flattenLine, neutralizeMarkdown, neutralizeTemplater } from '@/notes/untrusted-text';

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

describe('untrusted scan text: container fences, receipts and every image form', () => {
	it.each([
		['- ```dataviewjs\n  dv.span(1)\n  ```', `- \`\`\`${Z}dataviewjs\n  dv.span(1)\n  \`\`\``],
		['* ~~~dataview\n  LIST\n  ~~~', `* ~~~${Z}dataview\n  LIST\n  ~~~`],
		['+\t```js-engine', `+\t\`\`\`${Z}js-engine`],
		['1. ```dataviewjs', `1. \`\`\`${Z}dataviewjs`],
		['12) ```tasks', `12) \`\`\`${Z}tasks`],
		['> - ```dataviewjs', `> - \`\`\`${Z}dataviewjs`],
		['- > 1. ```dataviewjs', `- > 1. \`\`\`${Z}dataviewjs`],
		['>>- ```button', `>>- \`\`\`${Z}button`],
		['    ```dataviewjs', `    \`\`\`${Z}dataviewjs`],
		['- [ ] item\n  ```dataviewjs', `- [ ] item\n  \`\`\`${Z}dataviewjs`],
	])('renames an executable fence inside list and quote containers (%j)', (input, expected) => {
		expect(neutralizeMarkdown(input)).toBe(expected);
	});

	it('keeps ordinary fences inside list and quote containers', () => {
		const md = '- ```python\n  print(1)\n  ```\n> 1. ```js\n> x\n> ```\n-```dataviewjs\n1.```dataviewjs';
		expect(neutralizeMarkdown(md)).toBe(md);
	});

	it.each([
		['%% papersync:victim %%', `%%${Z} papersync:victim %%`],
		['%%papersync:victim%%', `%%${Z}papersync:victim%%`],
		['> %%  PaperSync:victim %%', `> %%${Z}  PaperSync:victim %%`],
	])('breaks a forged legacy import receipt (%j)', (input, expected) => {
		expect(neutralizeMarkdown(input)).toBe(expected);
	});

	it('keeps other Obsidian comments', () => {
		expect(neutralizeMarkdown('%% note to self %%')).toBe('%% note to self %%');
	});

	it.each([
		['![tracking]\n\n[tracking]: https://evil.test/p.png', `!${Z}[tracking]\n\n[tracking]: https://evil.test/p.png`],
		['![c][]', `!${Z}[c][]`],
		['![a [b] c](https://evil.test/p.png)', `!${Z}[a [b] c](https://evil.test/p.png)`],
		['![x](https&#58;//evil.test/p.png)', `!${Z}[x](https&#58;//evil.test/p.png)`],
		['![x](https&colon;//evil.test/p.png)', `!${Z}[x](https&colon;//evil.test/p.png)`],
		['![x](https\\://evil.test/p.png)', `!${Z}[x](https\\://evil.test/p.png)`],
		['![x](https%3A//evil.test/p.png)', `!${Z}[x](https%3A//evil.test/p.png)`],
		['![x](%2F%2Fevil.test/p.png)', `!${Z}[x](%2F%2Fevil.test/p.png)`],
		['![x]( <\\\\evil\\share\\p.png> )', `!${Z}[x]( <\\\\evil\\share\\p.png> )`],
		['![x](\n//evil.test/p.png)', `!${Z}[x](\n//evil.test/p.png)`],
		['![[local.png]](https://evil.test/p.png)', `!${Z}[[local.png]](https://evil.test/p.png)`],
		['![unclosed', `!${Z}[unclosed`],
		['![x](bad%ZZ)', `!${Z}[x](bad%ZZ)`],
	])('turns every remote, reference or unprovable image into text (%j)', (input, expected) => {
		expect(neutralizeMarkdown(input)).toBe(expected);
	});

	it('keeps vault images and embeds, escaped brackets included', () => {
		const md = '![ok](img/a.png) ![ok](<my img.png> "t") ![a \\] b](img/b.png) ![[local.png]] ![[x.png|300]] ![](a%20b.png)';
		expect(neutralizeMarkdown(md)).toBe(md);
	});
});

describe('untrusted scan text: images Markdown would read as references', () => {
	it.each([
		'![x](local.png',
		'![x](\n\nlocal.png)',
		'![x](local.png "title\n")',
		'![x](a(1).png)',
		'![x](<local.png)',
	])('treats an inline image that does not parse as a reference image (%j)', (input) => {
		expect(neutralizeMarkdown(input)).toBe(`!${Z}${input.slice(1)}`);
	});

	it('keeps a vault image with a title on the next line', () => {
		const md = "![x](local.png\n'title')";
		expect(neutralizeMarkdown(md)).toBe(md);
	});
});

describe('untrusted metadata values', () => {
	it('keeps ordinary model and provider names as written', () => {
		for (const name of ['claude-sonnet-4', 'google/gemini-2.5-pro', 'meta-llama/llama-4:free', 'gpt_4o@2026', 'custom']) {
			expect(escapeMetadataValue(name)).toBe(name);
		}
	});

	it('escapes inline JS, images, embeds, HTML, Templater tags and receipts', () => {
		expect(escapeMetadataValue('`$= dv.span(1)` ![x](https://e/p.png) ![[a.png]] <img src=x> <%* y %>\n%% papersync:v %%')).toBe(
			String.raw`\`\$\= dv.span\(1\)\` \!\[x\]\(https://e/p.png\) \!\[\[a.png\]\] \<img src\=x\> \<\%\* y \%\> \%\% papersync:v \%\%`
		);
	});
});
