// Stand-in artwork for the scan image in the note-template live preview. The
// real embed can't render here (the sample path points at no vault file), so
// the preview shows this instead: a sheet of handwriting whose shape mirrors
// PREVIEW_CONTEXT.ps_markdown — two prose lines, then four checklist items with
// the first ticked — so the user sees the embed sitting where their photo will.
//
// Colors come from Obsidian theme variables (never baked hex) so it adapts to
// any light or dark theme, matching the WORDMARK_SVG approach.
export const SCAN_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 190" role="img" aria-label="Preview of a handwritten scan">
  <rect x="6" y="4" width="288" height="182" rx="6"
        style="fill:var(--background-secondary);stroke:var(--background-modifier-border)" stroke-width="1.5" />

  <g style="stroke:var(--text-muted)" stroke-width="2.4" stroke-linecap="round" fill="none" opacity="0.75">
    <path d="M28 36 q7 -7 14 -1 t14 -1 t13 1 t14 -2 t13 1 t14 0 t13 -1 t14 1 t13 0 t14 -1" />
    <path d="M28 56 q7 -6 14 -1 t14 -1 t13 1 t14 -2 t13 1 t14 0 t13 -1 t14 1 t9 0" />
  </g>

  <g stroke-linecap="round" stroke-linejoin="round" fill="none">
    <rect x="28" y="82" width="13" height="13" rx="2.5"
          style="stroke:var(--interactive-accent)" stroke-width="2" />
    <path d="M31 88.5 l3.5 3.5 l6 -7" style="stroke:var(--interactive-accent)" stroke-width="2.4" />
    <path d="M52 89 q7 -6 14 -1 t14 -1 t13 1 t14 -2 t13 1 t14 0 t13 -1"
          style="stroke:var(--text-muted)" stroke-width="2.4" opacity="0.55" />

    <rect x="28" y="108" width="13" height="13" rx="2.5"
          style="stroke:var(--text-muted)" stroke-width="2" opacity="0.7" />
    <path d="M52 115 q7 -6 14 -1 t14 -1 t13 1 t14 -2 t13 1 t14 0"
          style="stroke:var(--text-muted)" stroke-width="2.4" opacity="0.75" />

    <rect x="28" y="134" width="13" height="13" rx="2.5"
          style="stroke:var(--text-muted)" stroke-width="2" opacity="0.7" />
    <path d="M52 141 q7 -6 14 -1 t14 -1 t13 1 t14 -2 t13 1 t14 0 t13 -1 t9 1"
          style="stroke:var(--text-muted)" stroke-width="2.4" opacity="0.75" />

    <rect x="28" y="160" width="13" height="13" rx="2.5"
          style="stroke:var(--text-muted)" stroke-width="2" opacity="0.7" />
    <path d="M52 167 q7 -6 14 -1 t14 -1 t13 1 t14 -2 t10 1"
          style="stroke:var(--text-muted)" stroke-width="2.4" opacity="0.75" />
  </g>
</svg>`;
