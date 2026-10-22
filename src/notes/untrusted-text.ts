// Scan text is untrusted: anyone who can write into the synced folder, or the
// author of a page someone scans, controls it. Other plugins execute code found
// in notes (Templater on file creation, Dataview JS queries on view), and remote
// embeds load on view. These helpers keep such text inert while leaving the
// visible text as it was.

// Inserted to break a token without changing what the reader sees.
const ZERO_WIDTH_SPACE = '\u200B';

const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;
const MARKDOWN_PUNCTUATION = /([!"#$%&'()*+,\-./:;<=>?@[\\\]^_{|}~`])/g;

// Code block languages that other plugins run as code or as actions.
const EXECUTABLE_FENCE_LANGUAGES = [
	'dataview',
	'dataviewjs',
	'js-engine',
	'js-engine-debug',
	'tasks',
	'meta-bind-js-view',
	'meta-bind-button',
	'button',
];
const EXECUTABLE_FENCE = new RegExp(
	`^([ \\t]*(?:>[ \\t]*)*(?:\`{3,}|~{3,})[ \\t]*)(?=(?:${EXECUTABLE_FENCE_LANGUAGES.join('|')})(?:[\\s{]|$))`,
	'gim'
);
// Dataview's inline JS query: `$= ...`.
const INLINE_JS_QUERY = /(`+[ \t]*\$)(?==)/g;
// Markdown images whose target has a scheme or is protocol-relative (remote, or
// anything else that is not a vault file), and reference-style images.
const REMOTE_IMAGE = /!(?=\[(?:[^\]\\\n]|\\.)*\]\(\s*<?(?:[a-z][a-z0-9+.-]*:|\/\/))/gi;
const REFERENCE_IMAGE = /!(?=\[(?:[^\]\\\n]|\\.)*\]\[)/g;
// HTML tags that load a resource or embed a page.
const EMBEDDING_HTML_TAG = /<(?=\/?(?:img|image|iframe|frame|frameset|video|audio|source|track|embed|object|picture|svg|link|style|base|meta|input)\b)/gi;

/** One line of plain text: line breaks become spaces. */
export function flattenLine(value: string): string {
	return value.replace(LINE_BREAKS, ' ');
}

/** Templater's command tags, broken so it never parses them. */
export function neutralizeTemplater(value: string): string {
	return value.replace(/<%/g, `<${ZERO_WIDTH_SPACE}%`).replace(/%>/g, `%${ZERO_WIDTH_SPACE}>`);
}

/**
 * A plain-text value (title, summary): one line, every Markdown punctuation mark
 * escaped so headings, wikilinks, table pipes, HTML and Templater tags stay literal.
 */
export function escapePlainText(value: string): string {
	return flattenLine(value).replace(MARKDOWN_PUNCTUATION, '\\$1');
}

/** A metadata value (provider, model): one line, no Templater tags. */
export function sanitizeInlineValue(value: string): string {
	return neutralizeTemplater(flattenLine(value));
}

/**
 * Scan markdown: ordinary Markdown is kept, but Templater tags, executable code
 * blocks, Dataview inline JS, remote images and embedding HTML are made inert.
 */
export function neutralizeMarkdown(markdown: string): string {
	return neutralizeTemplater(markdown)
		.replace(EXECUTABLE_FENCE, `$1${ZERO_WIDTH_SPACE}`)
		.replace(INLINE_JS_QUERY, `$1${ZERO_WIDTH_SPACE}`)
		.replace(REMOTE_IMAGE, `!${ZERO_WIDTH_SPACE}`)
		.replace(REFERENCE_IMAGE, `!${ZERO_WIDTH_SPACE}`)
		.replace(EMBEDDING_HTML_TAG, `<${ZERO_WIDTH_SPACE}`);
}
