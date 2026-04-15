export interface TemplateContext {
	date: string;
	date_short: string;
	time: string;
	time_24h: string;
	confidence: number;
	provider: string;
	model: string;
	image_file: string;
	markdown: string;
	separator: string;
}

export function renderTemplate(template: string, context: TemplateContext): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		if (key in context) {
			return String(context[key as keyof TemplateContext]);
		}
		return match;
	});
}
