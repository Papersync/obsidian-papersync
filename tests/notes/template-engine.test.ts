import { renderTemplate, TemplateContext } from '@/notes/template-engine';

const defaultContext: TemplateContext = {
	ps_scan_date: '2026-04-12T14:30:00.000Z',
	ps_scan_date_short: '2026-04-12',
	ps_scan_time: '2:30 PM',
	ps_scan_time_24h: '14:30',
	ps_confidence: 87,
	ps_provider: 'claude',
	ps_model: 'claude-sonnet-4',
	ps_title: 'Meeting Notes',
	ps_summary: 'Roadmap and action items',
	ps_image_file: 'attachments/papersync/scan-001.jpg',
	ps_markdown: '# Meeting Notes\n\n- Discussed roadmap\n- Action items assigned',
	ps_separator: '',
};

describe('renderTemplate', () => {
	it('replaces all known ps_ variables', () => {
		const template = '{{ps_scan_date}} {{ps_scan_date_short}} {{ps_confidence}} {{ps_provider}} {{ps_model}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe(
			'2026-04-12T14:30:00.000Z 2026-04-12 87 claude claude-sonnet-4'
		);
	});

	it('renders the default template with scan time and collapsible image', () => {
		const template = `{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Original scan
> ![[{{ps_image_file}}]]
`;
		const result = renderTemplate(template, defaultContext);
		expect(result).toContain('## 2:30 PM');
		expect(result).toContain('# Meeting Notes');
		expect(result).toContain('> ![[attachments/papersync/scan-001.jpg]]');
	});

	it('leaves un-prefixed names for Obsidian Templates to fill', () => {
		const template =
			'{{time}} | {{time_24h}} | {{date}} | {{date_short}} | {{confidence}} | {{provider}} | {{model}} | {{image_file}} | {{markdown}} | {{separator}}';
		expect(renderTemplate(template, defaultContext)).toBe(template);
	});

	it('leaves inherited object keys literal', () => {
		expect(renderTemplate('{{toString}} {{constructor}}', defaultContext)).toBe('{{toString}} {{constructor}}');
	});

	it('preserves unknown variables as-is', () => {
		const template = '{{ps_scan_date}} {{unknown_var}} {{ps_confidence}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('2026-04-12T14:30:00.000Z {{unknown_var}} 87');
	});

	it('handles template with no variables', () => {
		const template = 'Just plain text with no variables';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('Just plain text with no variables');
	});

	it('handles empty template', () => {
		const result = renderTemplate('', defaultContext);
		expect(result).toBe('');
	});

	it('handles multiple occurrences of the same variable', () => {
		const template = '{{ps_scan_date_short}} notes from {{ps_scan_date_short}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('2026-04-12 notes from 2026-04-12');
	});

	it('renders confidence as a number, not a string', () => {
		const template = 'confidence: {{ps_confidence}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('confidence: 87');
	});
});

 it('renders new tokens as single-line literal Markdown without recursive substitution', () => {
	const value = '[[Page#Heading|Alias]]\n# Title **bold** <tag> \r\n{{ps_model}}';
	const escaped = String.raw`\[\[Page\#Heading\|Alias\]\] \# Title \*\*bold\*\* \<tag\>  \{\{ps\_model\}\}`;
	expect(renderTemplate('{{ps_title}} | {{ps_summary}}', {
		...defaultContext, ps_title: value, ps_summary: value,
	})).toBe(`${escaped} | ${escaped}`);
	expect(renderTemplate('{{ps_markdown}}', { ...defaultContext, ps_markdown: value })).toBe(value);
	expect(renderTemplate('{{ps_provider}}|{{ps_model}}', {
		...defaultContext, ps_provider: 'a\nb', ps_model: 'm <%* x %>',
	})).toBe('a b|m <\u200B%* x %\u200B>');
 });

it('neutralizes executable syntax in the scan markdown', () => {
	expect(renderTemplate('{{ps_markdown}}', { ...defaultContext, ps_markdown: '<%* app.vault %>' }))
		.toBe('<\u200B%* app.vault %\u200B>');
});
