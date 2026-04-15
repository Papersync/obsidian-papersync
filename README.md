# PaperSynced for Obsidian

Syncs handwritten scans from [PaperSynced](https://github.com/papersynced) mobile app into your Obsidian vault as markdown notes.

One tap on your phone, one note in your vault, forty-five seconds. No typing, no backend, no third party reads your notes.

## How it works

1. **Capture** handwritten notes with the PaperSynced mobile app
2. The app converts them to markdown using your own LLM API key (BYOK)
3. Scans are saved to your Google Drive or iCloud Drive
4. **This plugin** picks them up and creates vault notes automatically

## Features

- Google Drive polling (30s interval) or iCloud Drive folder watching
- Configurable note template with frontmatter (Dataview/Bases-ready)
- Embedded scan images in your vault
- Append-only: multiple scans on the same day go into the same note
- Status bar indicator + ribbon icon for force-sync
- OAuth PKCE for Google Drive (no client secret needed)
- iCloud path auto-detection on macOS

## Installation

### BRAT (recommended during registry review)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) in Obsidian
2. Add this repo: `Papersync/obsidian-papersynced`
3. Enable PaperSynced in Community Plugins

### Community Plugin Registry

Search "PaperSynced" in Obsidian Settings > Community Plugins > Browse (available after registry approval).

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersynced/releases/latest) into `<vault>/.obsidian/plugins/obsidian-papersynced/`.

## Setup

1. Enable the plugin
2. Settings will open automatically on first run
3. Choose your sync backend:
   - **Google Drive**: Click "Connect" and authorize with your Google account
   - **iCloud Drive**: The plugin auto-detects your iCloud folder on macOS
4. Configure your note template and target folder
5. Scans start syncing automatically

## Template Variables

| Variable         | Description                                                 | Example                                |
| ---------------- | ----------------------------------------------------------- | -------------------------------------- |
| `{{markdown}}`   | Converted markdown content                                  | `# Meeting Notes\n- Action items...`   |
| `{{image_file}}` | Vault path to the scan image                                | `attachments/papersynced/scan-001.jpg` |
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

- The plugin stores **zero LLM API keys** (all AI runs on your phone)
- Google Drive: one OAuth token stored in your OS keychain via Obsidian's Secret Storage API
- iCloud: no authentication needed (local filesystem)
- No telemetry, no analytics, no outbound requests except to Google APIs
- MIT licensed, fully open source

## Requirements

- Obsidian v1.11.4 or later (for Secret Storage API)
- PaperSynced mobile app installed and configured
- Google Drive or iCloud Drive account matching your mobile app setup

## Development

```bash
npm install
npm run dev      # watch mode
npm test         # run tests
npm run build    # production build
```

## License

MIT
