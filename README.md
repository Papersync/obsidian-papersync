# PaperSync for Obsidian

Syncs handwritten scans from [PaperSync](https://github.com/papersync) mobile app into your Obsidian vault as markdown notes.

One tap on your phone, one note in your vault, forty-five seconds. No typing, no backend, no third party reads your notes.

## How it works

1. **Capture** handwritten notes with the PaperSync mobile app
2. The app converts them to markdown using your own LLM API key (BYOK)
3. Scans are saved to your Google Drive or sync folder (iCloud, Dropbox, OneDrive, Syncthing, Obsidian Sync)
4. **This plugin** picks them up and creates vault notes automatically

## Features

- Google Drive polling (30s interval) or folder watching (any sync tool)
- Auto-detects iCloud, Dropbox, OneDrive, Syncthing, and Obsidian Sync paths
- Configurable note template with frontmatter (Dataview/Bases-ready)
- Embedded scan images in your vault
- Append-only: multiple scans on the same day go into the same note
- Status bar indicator + ribbon icon for force-sync
- Google Drive OAuth via PKCE (desktop-app flow); scoped to its own files, and your tokens stay on your device

## Installation

### BRAT (recommended during registry review)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian
2. Add this repo: `Papersync/obsidian-papersync`
3. Enable PaperSync in Community Plugins

### Community Plugin Registry

Search "PaperSync" in Obsidian Settings > Community Plugins > Browse (available after registry approval).

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/obsidian-papersync/`.

## Setup

1. Enable the plugin
2. Settings will open automatically on first run
3. Choose your sync backend:
   - **Google Drive**: Click "Connect" and authorize with your Google account
   - **Folder sync**: The plugin auto-detects iCloud, Dropbox, OneDrive, Syncthing, and Obsidian Sync — or pick any folder
4. Configure your note template and target folder
5. Scans start syncing automatically

## Template Variables

| Variable         | Description                                                 | Example                                |
| ---------------- | ----------------------------------------------------------- | -------------------------------------- |
| `{{markdown}}`   | Converted markdown content                                  | `# Meeting Notes\n- Action items...`   |
| `{{image_file}}` | Vault path to the scan image                                | `attachments/papersync/scan-001.jpg` |
| `{{time}}`       | 12-hour time with AM/PM                                     | `2:30 PM`                              |
| `{{time_24h}}`   | 24-hour time                                                | `14:30`                                |
| `{{separator}}`  | `---` when appending to an existing note, empty on new file | `---` or ``                            |
| `{{date}}`       | Full ISO 8601 timestamp                                     | `2026-04-12T14:30:00.000Z`             |
| `{{date_short}}` | Date formatted per Daily Notes setting                      | `2026-04-12`                           |
| `{{confidence}}` | AI confidence score (0-100)                                 | `87`                                   |

### Default Template

```markdown
{{separator}}

## {{time}}

{{markdown}}

> [!abstract]- Source
> ![[{{image_file}}]]
```

- **`{{time}}`** is 12h by default — swap with `{{time_24h}}` if you prefer 24h format
- **`{{separator}}`** renders `---` only when appending to an existing note — keeps the first entry clean
- **`{{image_file}}`** is a raw vault path — wrap it in `![[...]]` for an embed, or `> ![[...]]` inside a callout for collapsible
- **Notes folder** supports date tokens (`YYYY`, `MM`, `DD`) — e.g., `Journal/YYYY/MM` creates `Journal/2026/04/`

## Privacy

PaperSync stores zero LLM API keys (all AI inference happens on your mobile device). On the Google Drive path, a single OAuth refresh token is stored in Obsidian's OS-backed Secret Storage. On the Folder path, no credentials are stored. The plugin makes network requests only to googleapis.com and accounts.google.com. No telemetry, no analytics.

## Requirements

- Obsidian v1.11.4 or later (for Secret Storage API)
- PaperSync mobile app installed and configured
- Google Drive or a sync folder matching your mobile app setup

## Development

```bash
npm install
npm run dev      # watch mode
npm test         # run tests
npm run build    # production build
```

## License

MIT
