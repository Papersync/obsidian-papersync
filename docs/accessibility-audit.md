# Accessibility Audit

## Environment

- **Date:** (pending manual audit)
- **Tools:** VoiceOver (macOS), Obsidian Dev Tools
- **Plugin version:** 1.0.0

## Status Bar

All states use both color AND text label (FR29 / NFR20):
- `Papersync: synced` 
- `Papersync: X pending`
- `Papersync: error`
- `Papersync: offline`

## Settings Tab

| Element | VoiceOver | Keyboard | Tap Target |
|---------|-----------|----------|------------|
| Backend selector | — | — | — |
| Connect/Disconnect buttons | — | — | — |
| Template textarea | — | — | — |
| Folder path input | — | — | — |

## Wizard Modal

| Step | VoiceOver | Keyboard | Notes |
|------|-----------|----------|-------|
| Welcome | — | — | — |
| Backend Pick | — | — | — |
| Auth/Folder | — | — | — |
| Template | — | — | — |
| Target Folder | — | — | — |

## Notice Toasts

Obsidian's `Notice` component uses ARIA live regions by default (NFR23). Verify announcement timing ≤ 2s.

## Remediation

(pending audit results)
