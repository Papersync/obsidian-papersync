import { renderTemplate, TemplateContext } from '@/notes/template-engine';

const defaultContext: TemplateContext = {
	ps_scan_date: '2026-04-12T14:30:00.000Z',
	ps_scan_date_short: '2026-04-12',
	ps_scan_time: '2:30 PM',
	ps_scan_time_24h: '14:30',
	ps_confidence: 87,
	ps_provider: 'claude',
	ps_model: 'claude-sonnet-4',
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

	it('resolves legacy un-namespaced tokens via aliases', () => {
		const template =
			'{{time}} | {{time_24h}} | {{date}} | {{date_short}} | {{confidence}} | {{provider}} | {{model}} | {{image_file}} | {{markdown}} | {{separator}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toContain('2:30 PM');
		expect(result).toContain('14:30');
		expect(result).toContain('2026-04-12T14:30:00.000Z');
		expect(result).toContain('2026-04-12');
		expect(result).toContain('87');
		expect(result).toContain('claude-sonnet-4');
		expect(result).toContain('attachments/papersync/scan-001.jpg');
		expect(result).toContain('# Meeting Notes');
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
