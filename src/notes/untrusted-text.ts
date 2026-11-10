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
// What a fence can open inside on its line: indentation, block quotes and list
// items (bullet or numbered), in any nesting. A list marker needs the space or tab
// after it, as in Markdown; without one the line is a paragraph, not a fence.
const CONTAINER_PREFIX = String.raw`(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*`;
const EXECUTABLE_FENCE = new RegExp(
	`^(${CONTAINER_PREFIX}(?:\`{3,}|~{3,})[ \\t]*)(?=(?:${EXECUTABLE_FENCE_LANGUAGES.join('|')})(?:[\\s{]|$))`,
	'gim'
);
// Dataview's inline JS query: `$= ...`.
const INLINE_JS_QUERY = /(`+[ \t]*\$)(?==)/g;
// The comment the plugin once wrote as an import receipt (`%% papersync:<id> %%`,
// see note-creator.ts). Scan text must never be able to author one.
const IMPORT_RECEIPT = /%%(?=[ \t]*papersync:)/gi;
// CommonMark's limit for a link label; a longer image text is not parsed.
const MAX_IMAGE_TEXT = 999;
// HTML tags that load a resource or embed a page.
const EMBEDDING_HTML_TAG = /<(?=\/?(?:img|image|iframe|frame|frameset|video|audio|source|track|embed|object|picture|svg|link|style|base|meta|input)\b)/gi;

// Longest title and summary a note gets, the limits the app writes them with.
export const MAX_TITLE_CHARS = 80;
export const MAX_SUMMARY_CHARS = 200;

/** At most `limit` characters (code points), ending in an ellipsis when cut. */
export function clampLength(value: string, limit: number): string {
	const chars = Array.from(value);
	return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

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

// Punctuation a model or provider name normally holds ('-', '.', '/', ':', '@',
// '_') stays as written: none of it starts code, an embed or a tag on its own.
const METADATA_PUNCTUATION = /([!"#$%&'()*+,;<=>?[\\\]^`{|}~])/g;

/**
 * A metadata value (provider, model): one line of plain text. Every mark that
 * could start code (Dataview's inline JS), an image or embed, HTML, a Templater
 * tag or an import receipt is escaped.
 */
export function escapeMetadataValue(value: string): string {
	return flattenLine(value).replace(METADATA_PUNCTUATION, '\\$1');
}

// Index of the `]` closing the `[` at `open`, or -1 when there is none within
// MAX_IMAGE_TEXT characters. Backslash escapes are skipped, nested pairs counted.
function closingBracket(text: string, open: number): number {
	let depth = 0;
	const end = Math.min(text.length, open + MAX_IMAGE_TEXT + 2);
	for (let i = open; i < end; i++) {
		const char = text[i];
		if (char === '\\') {
			i++;
		} else if (char === '[') {
			depth++;
		} else if (char === ']' && --depth === 0) {
			return i;
		}
	}
	return -1;
}

// The rest of an inline image after its `(`: the destination (in `<...>`, or
// with no space, parenthesis or angle bracket), an optional one-line title, `)`.
// Whitespace may hold one line break, never a blank line. Anything else does not
// parse, and is then read as a reference image, as Markdown would.
const INLINE_IMAGE_TAIL = /[ \t]*\n?[ \t]*(<[^<>\n]*>|[^\s()<>]*)(?:(?:[ \t]+\n?|\n)[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\n?[ \t]*\)/y;

// The destination of the inline image whose `(` is just before `start`, or null.
function inlineDestination(text: string, start: number): string | null {
	INLINE_IMAGE_TAIL.lastIndex = start;
	const match = INLINE_IMAGE_TAIL.exec(text);
	return match ? String(match[1]).replace(/^<(.*)>$/, '$1') : null;
}

// A target that is a vault file. Markdown decodes backslash escapes and HTML
// entities in a destination, and Obsidian percent-decoding, so each is undone (or,
// for entities, refused) before the check. A scheme needs ':', a network path
// starts with '//' or '\\'; vault paths never hold ':' or '\\'.
function isVaultTarget(destination: string): boolean {
	const unescaped = destination.replace(/\\([!-/:-@[-`{-~])/g, '$1');
	if (/&[#a-z0-9]+;/i.test(unescaped)) {
		return false;
	}
	let decoded: string;
	try {
		decoded = decodeURIComponent(unescaped);
	} catch {
		return false;
	}
	return !/[:\\]/.test(decoded) && !decoded.startsWith('//');
}

// Whether the image whose `[` is at `open` stays an image: an inline image with a
// vault target, or a wikilink embed (`![[file]]`). Reference and shortcut images
// are not kept (their definition can point anywhere), nor is anything unparsed.
function keepsImage(text: string, open: number): boolean {
	const close = closingBracket(text, open);
	if (close === -1) {
		return false;
	}
	if (text[close + 1] !== '(') {
		return text[open + 1] === '[';
	}
	const destination = inlineDestination(text, close + 2);
	return destination !== null && isVaultTarget(destination);
}

/** Every image but a vault one becomes a plain link: `!` gets a zero-width space. */
function neutralizeImages(markdown: string): string {
	let out = '';
	let copied = 0;
	for (let bang = markdown.indexOf('!['); bang !== -1; bang = markdown.indexOf('![', bang + 1)) {
		if (!keepsImage(markdown, bang + 1)) {
			out += `${markdown.slice(copied, bang + 1)}${ZERO_WIDTH_SPACE}`;
			copied = bang + 1;
		}
	}
	return out + markdown.slice(copied);
}

/**
 * Scan markdown: ordinary Markdown is kept, but Templater tags, executable code
 * blocks (in list and quote containers too), Dataview inline JS, every image but a
 * vault one, embedding HTML and import receipts are made inert.
 */
export function neutralizeMarkdown(markdown: string): string {
	return neutralizeImages(neutralizeTemplater(markdown))
		.replace(EXECUTABLE_FENCE, `$1${ZERO_WIDTH_SPACE}`)
		.replace(INLINE_JS_QUERY, `$1${ZERO_WIDTH_SPACE}`)
		.replace(IMPORT_RECEIPT, `%%${ZERO_WIDTH_SPACE}`)
		.replace(EMBEDDING_HTML_TAG, `<${ZERO_WIDTH_SPACE}`);
}
