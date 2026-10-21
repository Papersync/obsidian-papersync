// Local Markdown preview policy. This is not part of the shared scan contract.
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
