import { renderTemplate, TemplateContext } from '@/notes/template-engine';

const defaultContext: TemplateContext = {
	date: '2026-04-12T14:30:00.000Z',
	date_short: '2026-04-12',
	time: '14:30',
	confidence: 87,
	provider: 'claude',
	model: 'claude-sonnet-4',
	image_file: 'attachments/papersynced/scan-001.jpg',
	markdown: '# Meeting Notes\n\n- Discussed roadmap\n- Action items assigned',
	separator: '',
};

describe('renderTemplate', () => {
	it('replaces all known variables', () => {
		const template = '{{date}} {{date_short}} {{confidence}} {{provider}} {{model}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe(
			'2026-04-12T14:30:00.000Z 2026-04-12 87 claude claude-sonnet-4'
		);
	});

	it('renders the default template with time and collapsible image', () => {
		const template = `{{separator}}

## {{time}}

{{markdown}}

> [!abstract]- Original scan
> ![[{{image_file}}]]
`;
		const result = renderTemplate(template, defaultContext);
		expect(result).toContain('## 14:30');
		expect(result).toContain('# Meeting Notes');
		expect(result).toContain('> ![[attachments/papersynced/scan-001.jpg]]');
	});

	it('preserves unknown variables as-is', () => {
		const template = '{{date}} {{unknown_var}} {{confidence}}';
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
		const template = '{{date_short}} notes from {{date_short}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('2026-04-12 notes from 2026-04-12');
	});

	it('renders confidence as a number, not a string', () => {
		const template = 'confidence: {{confidence}}';
		const result = renderTemplate(template, defaultContext);
		expect(result).toBe('confidence: 87');
	});
});
