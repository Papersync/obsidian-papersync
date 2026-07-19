// Stand-in artwork for the scan image in the note-template live preview. The
// real embed can't render (the sample path points at no vault file), so the
// preview draws the sample scan's own text as masked handwriting: one squiggle
// per word, sized from that word's length, wrapped and laid out like the real
// note. It reads as the same note the preview shows beside it, illegible the way
// a thumbnail of someone's handwriting is.
//
// Derived from the markdown rather than hand-drawn so the artwork cannot drift
// out of sync with the sample text. Colors come from Obsidian theme variables
// (never baked hex) so it adapts to light and dark, matching WORDMARK_SVG.

const VIEW_W = 300;
const PAD_X = 26;
const CONTENT_W = VIEW_W - PAD_X * 2;
const CHAR_W = 3.5;        // approximate ink width contributed per character
const WORD_GAP = 5;
const MIN_WORD_W = 7;
const PROSE_LINE_H = 19;
const TASK_LINE_H = 25;
const BOX = 13;            // checkbox edge
const BOX_GAP = 11;
const TOP = 30;
const BOTTOM_PAD = 22;

interface Row {
	words: number[];       // pixel width per word
	checked: boolean | null; // null = prose (no checkbox)
}

function wordWidth(word: string): number {
	return Math.max(MIN_WORD_W, word.length * CHAR_W);
}

// A wave whose crests alternate, phase-shifted per word so neighbouring squiggles
// don't line up into an obviously synthetic ripple.
function squiggle(x: number, y: number, width: number, phase: number): string {
	const segments = Math.max(2, Math.round(width / 7));
	const step = width / segments;
	let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
	for (let i = 0; i < segments; i++) {
		const rise = (i + phase) % 2 === 0 ? -3.1 : 2.3;
		d += ` q${(step / 2).toFixed(1)} ${rise} ${step.toFixed(1)} 0`;
	}
	return d;
}

// Splits markdown into rows of word widths. Task lines keep their checked state
// and drop the `- [x] ` marker; everything else is prose. Blank lines are skipped.
function toRows(markdown: string): Row[] {
	const rows: Row[] = [];
	for (const rawLine of markdown.split('\n')) {
		const line = rawLine.trim();
		if (line === '') {continue;}

		const task = /^[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
		const checked = task ? task[1]!.toLowerCase() === 'x' : null;
		const body = task ? task[2]! : line.replace(/^#+\s*/, '');
		const words = body.split(/\s+/).filter((w) => w !== '').map(wordWidth);
		if (words.length === 0) {continue;}

		rows.push({ words, checked });
	}
	return rows;
}

export function buildScanPlaceholderSvg(markdown: string): string {
	const rows = toRows(markdown);
	const strokes: string[] = [];
	const boxes: string[] = [];
	let y = TOP;
	let phase = 0;

	for (const row of rows) {
		const indent = row.checked === null ? 0 : BOX + BOX_GAP;
		const lineH = row.checked === null ? PROSE_LINE_H : TASK_LINE_H;
		let x = PAD_X + indent;
		let firstLineOfRow = true;

		if (row.checked !== null) {
			boxes.push(
				`<rect x="${PAD_X}" y="${(y - BOX + 4).toFixed(1)}" width="${BOX}" height="${BOX}" rx="2.5" style="stroke:${row.checked ? 'var(--interactive-accent)' : 'var(--text-muted)'}" stroke-width="2" fill="none"${row.checked ? '' : ' opacity="0.7"'} />`
			);
			if (row.checked) {
				const cy = y - BOX + 4;
				boxes.push(`<path d="M${PAD_X + 3} ${(cy + 6.5).toFixed(1)} l3.5 3.5 l6 -7" style="stroke:var(--interactive-accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" />`);
			}
		}

		for (const w of row.words) {
			// Wrap when the word would overflow; continuation lines keep the indent
			// so a wrapped task still hangs under its checkbox.
			if (x + w > PAD_X + CONTENT_W && !firstLineOfRow) {
				y += PROSE_LINE_H;
				x = PAD_X + indent;
			}
			strokes.push(`<path d="${squiggle(x, y, w, phase)}" />`);
			x += w + WORD_GAP;
			phase++;
			firstLineOfRow = false;
		}
		y += lineH;
	}

	const height = Math.round(y + BOTTOM_PAD);

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${height}" role="img" aria-label="Preview of the scan as handwriting">
  <rect x="5" y="4" width="${VIEW_W - 10}" height="${height - 10}" rx="6" style="fill:var(--background-secondary);stroke:var(--background-modifier-border)" stroke-width="1.5" />
  <g style="stroke:var(--text-muted)" stroke-width="2.4" stroke-linecap="round" fill="none" opacity="0.72">
    ${strokes.join('\n    ')}
  </g>
  <g stroke-linecap="round" stroke-linejoin="round">
    ${boxes.join('\n    ')}
  </g>
</svg>`;
}
