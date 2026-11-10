import { escapeMetadataValue, escapePlainText, neutralizeMarkdown } from '@/notes/untrusted-text';

export interface TemplateContext {
	ps_scan_date: string;
	ps_scan_date_short: string;
	ps_scan_time: string;
	ps_scan_time_24h: string;
	ps_confidence: number;
	ps_provider: string;
	ps_model: string;
	ps_title: string;
	ps_summary: string;
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
	// Every scan-supplied value is untrusted (see untrusted-text.ts). Title and
	// summary are plain text, flattened and escaped; provider and model too, keeping
	// the punctuation model names use; the markdown keeps its formatting but loses
	// anything executable. The other values are made by the plugin (dates from a
	// validated ISO time, the photo path from a sanitized name).
	// Do this here so saved notes and the settings preview use the same policy.
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		// Own properties only, so {{toString}} and friends stay literal.
		if (!Object.prototype.hasOwnProperty.call(context, key)) {
			return match;
		}
		const value = String(context[key as keyof TemplateContext]);
		switch (key) {
			case 'ps_title':
			case 'ps_summary':
				return escapePlainText(value);
			case 'ps_provider':
			case 'ps_model':
				return escapeMetadataValue(value);
			case 'ps_markdown':
				return neutralizeMarkdown(value);
			default:
				return value;
		}
	});
}
