<h1 align="center">PaperSync for Obsidian</h1>

<p align="center">
  <b>Handwritten notes on paper. Searchable Markdown in your vault.</b><br>
  One tap on your phone, one note in Obsidian, about forty-five seconds. No typing, no backend, no third party reads your notes.
</p>

<p align="center">
  <a href="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml/badge.svg"></a>
  <img alt="Coverage 100%" src="https://img.shields.io/badge/coverage-100%25-brightgreen">
  <a href="https://github.com/Papersync/obsidian-papersync/releases/latest"><img alt="Version" src="https://img.shields.io/github/manifest-json/v/Papersync/obsidian-papersync?label=version"></a>
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Obsidian 1.11.4+" src="https://img.shields.io/badge/Obsidian-1.11.4%2B-7c3aed">
  <img alt="Desktop" src="https://img.shields.io/badge/platform-desktop-lightgrey">
  <!-- After community-registry approval, add the official download count:
  <img alt="Obsidian downloads" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=7c3aed&label=downloads&query=$['papersync'].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json"> -->
</p>

<p align="center">
  <img alt="Bring your own key" src="https://img.shields.io/badge/API%20keys-BYOK-success">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-success">
  <img alt="Local-first" src="https://img.shields.io/badge/data-local--first-success">
  <img alt="Least-privilege OAuth" src="https://img.shields.io/badge/OAuth-PKCE%20%C2%B7%20drive.file-success">
</p>

## How it works

1. **Capture** handwritten notes with the [PaperSync mobile app](https://github.com/papersync)
2. The app converts them to Markdown using **your own** LLM API key (BYOK) — inference happens on your phone
3. Scans land in your Google Drive or a sync folder (iCloud, Dropbox, OneDrive, Syncthing, Obsidian Sync)
4. **This plugin** picks them up and writes vault notes automatically

Your handwriting stays yours: the AI key never leaves your phone, and the plugin never sends your notes anywhere except the Google account you connect.

## Features

- **Two backends** — Google Drive polling (configurable interval) or folder watching for any sync tool
- **Zero-config folder detection** — auto-detects iCloud, Dropbox, OneDrive, Syncthing, and Obsidian Sync paths
- **Live template preview** — a side-by-side editor and rendered preview in Settings, so you see the note before it syncs
- **Namespaced template variables** (`ps_*`) that won't collide with Obsidian's core `{{date}}`/`{{time}}`
- **Append-only daily notes** — multiple scans on the same day flow into the same note, matching your Daily Notes filename exactly
- **Embedded scan images** — saved to Obsidian's own attachment folder by default
- **Status-bar indicator + ribbon icon** for sync state and force-sync

## Installation

### BRAT (recommended during registry review)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian
2. Add this repo: `Papersync/obsidian-papersync`
3. Enable **PaperSync** in Community Plugins

### Community Plugin Registry

Search "PaperSync" in **Settings → Community Plugins → Browse** (available after registry approval).

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/papersync/`.

## Setup

1. Enable the plugin — Settings open automatically on first run
2. Choose your sync backend:
   - **Google Drive** — click **Connect** and authorize (PKCE desktop flow, scoped to files the app creates)
   - **Folder sync** — pick an auto-detected sync folder, or any folder you like
3. Tune your note template in the **Template** tab (with live preview) and pick a target folder
4. Scans start syncing automatically

## Template Variables

All variables are namespaced under `ps_` so they never clash with Obsidian's core template tokens.

| Variable                  | Description                                                  | Example                        |
| ------------------------- | ----------------------------------------------------------- | ------------------------------ |
| `{{ps_markdown}}`         | Converted Markdown content                                  | `## Meeting notes\n- ...`      |
| `{{ps_image_file}}`       | Vault path to the scan image                                | `attachments/papersync-01.jpg` |
| `{{ps_scan_time}}`        | 12-hour scan time with AM/PM                                | `2:30 PM`                      |
| `{{ps_scan_time_24h}}`    | 24-hour scan time                                           | `14:30`                        |
| `{{ps_scan_date}}`        | Full ISO 8601 timestamp                                     | `2026-04-12T14:30:00.000Z`     |
| `{{ps_scan_date_short}}`  | Date formatted per your Daily Notes setting                 | `2026-04-12`                   |
| `{{ps_separator}}`        | `***` when appending to an existing note, empty on a new one | `***` or ``                   |
| `{{ps_confidence}}`       | AI confidence score (0–100)                                 | `87`                           |

> Legacy un-namespaced tokens (`{{markdown}}`, `{{time}}`, `{{date}}`, …) still work as aliases, so older templates keep rendering.

### Default template

```markdown
{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Source
> ![[{{ps_image_file}}]]
```

- **`{{ps_scan_time}}`** is 12h by default — swap for `{{ps_scan_time_24h}}` if you prefer 24h
- **`{{ps_separator}}`** emits `***` (a divider that's safe anywhere, unlike `---`, which Markdown can read as a heading underline or frontmatter) only when appending, keeping the day's first entry clean
- **`{{ps_image_file}}`** is a raw vault path — wrap it in `![[...]]` for an embed, or `> ![[...]]` inside a callout for a collapsible one. With image saving off, the plugin drops the embed line rather than writing a broken `![[]]`
- **Notes folder** supports date tokens (`YYYY`, `MM`, `DD`) — e.g. `Journal/YYYY/MM` files notes under `Journal/2026/04/`

## Privacy & Security

- **BYOK** — the plugin stores **zero** LLM API keys; all AI inference happens on your mobile device
- **Least-privilege Google access** — OAuth via **PKCE** (RFC 8252 desktop-app flow), scoped to `drive.file` (only files the app itself creates); the single refresh token is stored in Obsidian's OS-integrated secret storage (macOS Keychain, Windows Credential Manager, Linux Secret Service), **not** in plaintext `data.json` — it never leaves your machine (there is no PaperSync server) (see [SECURITY.md](SECURITY.md))
- **Folder path stores no credentials** at all
- **Minimal network surface** — requests go only to `googleapis.com` and `accounts.google.com`
- **No telemetry, no analytics** — nothing about you or your notes is collected
- **Open source (MIT)** — every line is auditable

## Quality

Trust comes from evidence, not promises. Every commit runs the full gate in CI:

- **Lint** (ESLint + the official `eslint-plugin-obsidianmd` rules) and **strict TypeScript** (`strict` + `noUncheckedIndexedAccess`)
- **Unit tests at 100% coverage** — statements, branches, functions, and lines are all enforced at 100%; the build fails if coverage drops
- **End-to-end tests against a real Obsidian instance** (WebdriverIO + `wdio-obsidian-service`)

## Requirements

- Obsidian **v1.11.4+**
- The **PaperSync mobile app**, installed and configured
- A Google Drive account or a sync folder matching your mobile setup

## Development

```bash
npm install
npm run dev        # watch build
npm test           # unit tests + coverage
npm run test:e2e   # end-to-end against a real Obsidian
npm run build      # production build
```

## License

[MIT](LICENSE)
