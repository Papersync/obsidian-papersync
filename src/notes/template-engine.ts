export interface TemplateContext {
	ps_scan_date: string;
	ps_scan_date_short: string;
	ps_scan_time: string;
	ps_scan_time_24h: string;
	ps_confidence: number;
	ps_provider: string;
	ps_model: string;
	ps_image_file: string;
	ps_markdown: string;
	ps_separator: string;
}

// Legacy un-namespaced tokens map to their ps_ replacements so templates written
// before the namespace rename keep rendering. New templates should use ps_ tokens.
const TOKEN_ALIASES: Record<string, keyof TemplateContext> = {
	date: 'ps_scan_date',
	date_short: 'ps_scan_date_short',
	time: 'ps_scan_time',
	time_24h: 'ps_scan_time_24h',
	confidence: 'ps_confidence',
	provider: 'ps_provider',
	model: 'ps_model',
	image_file: 'ps_image_file',
	markdown: 'ps_markdown',
	separator: 'ps_separator',
};

export function renderTemplate(template: string, context: TemplateContext): string {
	// Pure substitution: every newline the author wrote is preserved verbatim in the
	// note file (Markdown rendering still collapses blank runs at display time).
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		const field = key in context ? (key as keyof TemplateContext) : TOKEN_ALIASES[key];
		if (field !== undefined) {
			return String(context[field]);
		}
		return match;
	});
}
