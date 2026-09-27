<h1 align="center">Papersync for Obsidian</h1>

<p align="center">
  <b>Handwritten notes on paper. Searchable Markdown in your vault.</b><br>
  One tap on your phone, one note in Obsidian. No typing, no backend, no third party reads your notes.
</p>

<p align="center">
  <a href="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/Papersync/obsidian-papersync/releases/latest"><img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-blue"></a>
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Obsidian 1.13.4+" src="https://img.shields.io/badge/Obsidian-1.13.4%2B-7c3aed">
  <img alt="Desktop" src="https://img.shields.io/badge/platform-desktop-lightgrey">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-success">
  <!-- After community-registry approval, add the official download count:
  <img alt="Obsidian downloads" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=7c3aed&label=downloads&query=$['papersync'].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json"> -->
</p>

## How it works

1. **Capture** handwritten notes with the [Papersync mobile app](https://papersync.ai)
2. The app converts them to Markdown using **your own** LLM API key, so inference happens on your phone
3. Scans land in your Google Drive, iCloud Drive, or any folder your computer syncs (Dropbox, OneDrive, Syncthing, anything else)
4. **This plugin** picks them up and writes vault notes automatically

## Features

- **Two backends** — Google Drive polling (configurable interval) or folder watching for any sync tool
- **Finds your folder for you** — offers iCloud Drive, plus any synced location that already holds a Papersync folder, whichever provider put it there
- **Live template preview** — a side-by-side editor and rendered preview in Settings, so you see the note before it syncs
- **Append-only daily notes** — multiple scans on the same day flow into the same note, matching your Daily Notes filename exactly

## Installation

Search "Papersync" in **Settings → Community Plugins → Browse** (available after registry approval).

To install manually, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/papersync/`.

## Setup

1. Enable the plugin — Settings open automatically on first run
2. Choose your sync backend:
   - **Google Drive** — click **Connect** and authorize (PKCE desktop flow, scoped to files the app creates)
   - **Folder sync** — pick an auto-detected sync folder, or any folder you like
3. Tune your note template in the **Template** tab (with live preview) and pick a target folder
4. Scans start syncing automatically

## Template Variables

All variables are namespaced under `ps_` so they never clash with Obsidian's core template tokens. The notes folder also supports date tokens (`YYYY`, `MM`, `DD`), so `Journal/YYYY/MM` files notes under `Journal/2026/04/`.

| Variable                 | Description                                                  | Example                        |
| ------------------------ | ------------------------------------------------------------ | ------------------------------ |
| `{{ps_markdown}}`        | Converted Markdown content                                   | `## Meeting notes\n- ...`      |
| `{{ps_image_file}}`      | Vault path to the scan image                                 | `attachments/papersync-01.jpg` |
| `{{ps_scan_time}}`       | 12-hour scan time with AM/PM                                 | `2:30 PM`                      |
| `{{ps_scan_time_24h}}`   | 24-hour scan time                                            | `14:30`                        |
| `{{ps_scan_date}}`       | Full ISO 8601 timestamp                                      | `2026-04-12T14:30:00.000Z`     |
| `{{ps_scan_date_short}}` | Date formatted per your Daily Notes setting                  | `2026-04-12`                   |
| `{{ps_separator}}`       | `***` when appending to an existing note, empty on a new one | `***` or ``                    |
| `{{ps_confidence}}`      | AI confidence score (0–100)                                  | `87`                           |

### Default template

```markdown
{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Source
> ![[{{ps_image_file}}]]
```

## Privacy

- **Your API key never reaches this plugin** — it stores zero LLM keys, and all AI inference happens on your mobile device
- **Least-privilege Google access** — PKCE OAuth scoped to `drive.file` (only files the app itself creates), with the refresh token in your OS credential vault and never in plaintext. Details in [SECURITY.md](SECURITY.md)
- **No telemetry, no analytics, no Papersync server** — requests go only to `googleapis.com` and `accounts.google.com`

## Development

```bash
npm install
npm run dev        # watch build
npm test           # unit tests
npm run test:coverage  # unit tests + the 100% coverage gate CI enforces
npm run test:e2e   # end-to-end against a real Obsidian
npm run build      # production build
```

## License

[MIT](LICENSE)
