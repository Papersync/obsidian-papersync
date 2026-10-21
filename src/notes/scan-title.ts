// Ported from app/src/lib/drive/history.ts. Keep title fallback behavior in sync.
/**
 * Extract a human-readable title from markdown content.
 * Looks for the first heading (# / ## / ###) or falls back to the first non-empty line.
 */
export function extractTitle(markdown: string, fallbackName: string): string {
	// Both paths go through the preview cleaner, so a title never shows raw
	// Markdown syntax ("**Groceries**", "- [x] wake up at 7").
	const heading = markdown.match(/^#{1,3}\s+(.+)/m)?.[1];
	if (heading) {
		const cleaned = cleanMarkdownPreview(heading);
		if (cleaned) {
			return cleaned;
		}
	}
	const firstLine = markdown.split('\n').find((l) => l.trim());
	if (firstLine) {
		const cleaned = cleanMarkdownPreview(firstLine);
		if (cleaned) {
			return cleaned.slice(0, 60);
		}
	}
	return fallbackName;
}

/**
 * Strip markdown syntax to produce clean plain-text for preview display.
 */
export function cleanMarkdownPreview(markdown: string): string {
	return (
		markdown
			.replace(/^#{1,6}\s+/gm, '') // headings
			.replace(/\*\*(.+?)\*\*/g, '$1') // bold
			.replace(/\*(.+?)\*/g, '$1') // italic
			.replace(/_(.+?)_/g, '$1') // underscore emphasis
			.replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
			.replace(/~~(.+?)~~/g, '$1') // strikethrough
			// Task checkboxes: "- [ ] ", "- [x] " and one-character custom statuses
			// ("- [>] " migrated, "- [-] " cancelled) are dropped, never shown raw.
			.replace(/^\s*[-*+]\s+\[[^\]\n]\]\s+/gm, '')
			.replace(/^\s*[-*+]\s+/gm, '') // list markers (nested too)
			.replace(/^>\s+/gm, '') // blockquotes
			.replace(/`(.+?)`/g, '$1') // inline code
			.replace(/\n+/g, ' ') // newlines to spaces
			.replace(/\s+/g, ' ') // collapse whitespace
			.trim()
			.slice(0, 200)
	);
}
