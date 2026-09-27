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

// The pre-namespace token names, now only used to rewrite saved templates once
// (settings migration v4). They are NOT rendered: a bare {{date}} or {{time}} is
// left for Obsidian's own Templates plugin, which the ps_ namespace exists to
// avoid clashing with.
export const LEGACY_TOKENS: Record<string, keyof TemplateContext> = {
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
	// Own properties only, so {{toString}} and friends stay literal.
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(context, key) ? String(context[key as keyof TemplateContext]) : match);
}
