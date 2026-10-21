import { cleanMarkdownPreview, extractTitle } from '@/notes/scan-title';

describe('app-compatible scan titles', () => {
	it.each([
		['intro\n## **Heading**', 'Heading'],
		['### [Link](https://example.com)', 'Link'],
		['\n- [x] **Groceries**', 'Groceries'],
		['#### Fourth level', 'Fourth level'],
		['#     \nfirst text', 'first text'],
		['#     ', 'scan time'],
		['  \n\t', 'scan time'],
		['', 'scan time'],
		['x'.repeat(90), 'x'.repeat(60)],
		['# ' + 'x'.repeat(220), 'x'.repeat(200)],
	])('extracts %j', (markdown, title) => {
		expect(extractTitle(markdown, 'scan time')).toBe(title);
	});

	it('cleans all syntax handled by the app and collapses whitespace', () => {
		expect(cleanMarkdownPreview('# **Bold** *italic* _emphasis_ [link](url) ~~old~~\n- [ ] task\n  + [>] moved\n* list\n> quote `code`'))
			.toBe('Bold italic emphasis link old task moved list quote code');
	});
});
