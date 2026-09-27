<h1 align="center">Papersync for Obsidian</h1>

<p align="center">
  <b>Handwritten notes on paper. Searchable Markdown in your vault.</b><br>
  Snap a page on your phone and it arrives in Obsidian as a note. No typing and no Papersync server: scans go from your phone to the AI provider you choose, then into your own storage.
</p>

## What you need

- **The Papersync mobile app.** It captures and transcribes your pages; this plugin files them into your vault. Get it from [papersync.ai](https://papersync.ai).
- **An API key for the AI provider you choose** (Anthropic, OpenAI, Google Gemini, OpenRouter and others, or a self-hosted endpoint such as Ollama). You enter it in the app and pay that provider directly at its own rates.
- **Obsidian 1.13.4 or later, on desktop.** The plugin does not run on Obsidian mobile.
- **For Google Drive sync only:** the same Google account you use in the app. Folder sync needs no account.

<!--
STORE LAUNCH (the go-public PR): replace "Get it from papersync.ai" in the first bullet with
"Get it on:" and paste the block below right after this list. Show a badge ONLY for a store
that is live; for the other one, drop its <a> and add the line
"Coming soon to Google Play (or the App Store): see papersync.ai."
Badges: the unmodified official SVGs (Apple Marketing Tools, Google Partner Marketing Hub),
committed to .github/assets/, App Store first, both at height 40. Replace ASC_APP_ID with the
numeric Apple ID from App Store Connect. Open both URLs logged out before merging.
Also uncomment the trademark line above "## License".

<p>
  <a href="https://apps.apple.com/app/idASC_APP_ID"><img alt="Download on the App Store" src=".github/assets/app-store-badge.svg" height="40"></a>&nbsp;&nbsp;
  <a href="https://play.google.com/store/apps/details?id=ai.papersync.app"><img alt="Get it on Google Play" src=".github/assets/google-play-badge.svg" height="40"></a>
</p>
-->

## How it works

1. **Capture** a handwritten page with the Papersync app.
2. The app sends the photo straight from your phone to your AI provider, using your own key, and gets Markdown back.
3. It saves the scan to your Google Drive, or to a folder your computer syncs (iCloud Drive, Dropbox, OneDrive, Syncthing or anything else).
4. **This plugin** picks up new scans and writes them into your vault as one note per day, appending each new scan. With the default template, each scan sits under its time, with the original page in a collapsed Source callout.

## Privacy and network use

- **This plugin never sees your AI key and does no AI processing.** The key stays in the phone app, which sends each scan directly to the provider you picked.
- **Folder sync makes no network requests.**
- **Google Drive sync talks only to Google:** `accounts.google.com` and `oauth2.googleapis.com` to sign in and keep you signed in, and `www.googleapis.com` to read the scans the app uploaded and mark them as synced. Access uses the `drive.file` scope: only the Papersync folder and files Papersync created, never the rest of your Drive. The sign-in token is kept in your OS credential vault through Obsidian's secret storage, not in the plugin's settings. Details in [SECURITY.md](SECURITY.md).
- **No telemetry, no analytics, no Papersync server.** This plugin collects nothing. For the mobile app, see the [Papersync privacy policy](https://papersync.ai/privacy).

## Installation

<!-- GO PUBLIC: once the plugin is listed, replace the first sentence with:
In Obsidian, open **Settings → Community plugins → Browse** and search for **Papersync**.
and start the next one with "To install manually, download". -->
Papersync is not in Obsidian's community plugin directory yet. To install it, download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/papersync/`.

## Setup

1. In the Papersync app, choose where scans are saved: Google Drive or a folder.
2. Enable the plugin. Its settings open automatically on first run.
3. Optional: edit the note template in the **Template** section before you connect, since scans already waiting are imported as soon as you do. A live preview renders a sample scan beside the editor.
4. Connect storage in the **Sync** section. Syncing starts right away.
   - **Google Drive:** click **Connect** and sign in with the same Google account you use in the app. Do this once on each computer. Drive is checked every 30 seconds by default; change it under **Advanced**.
   - **Folder sync:** pick a detected location (iCloud Drive on macOS, or a Dropbox, OneDrive, Syncthing or macOS cloud-storage folder that already holds a Papersync folder), or **Browse** to the folder your phone saves into. The plugin watches it for new scans.
5. Notes go to the **Notes folder** shown under Sync. With Daily Notes on, it starts as your Daily Notes folder (`/` when that is the vault root), so scans are appended to your daily note, named in your Daily Notes date format. With Daily Notes off, it starts as `Papersync`.

Settings changes apply from the next scan on, with no restart. A field you are still typing in counts once you leave it or close Settings.

## Template variables

Use the `ps_` names below. Anything else in double braces, such as `{{date}}`, is left in the note as written.

| Variable                 | Description                                                         | Example                               |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------- |
| `{{ps_markdown}}`        | Transcribed Markdown                                                | `## Meeting notes\n- ...`             |
| `{{ps_scan_time}}`       | 12-hour local scan time                                             | `2:30 PM`                             |
| `{{ps_scan_time_24h}}`   | 24-hour local scan time                                             | `14:30`                               |
| `{{ps_scan_date}}`       | Full ISO 8601 timestamp, in UTC                                     | `2026-04-12T14:30:00.000Z`            |
| `{{ps_scan_date_short}}` | Date in your Daily Notes format                                     | `2026-04-12`                          |
| `{{ps_image_file}}`      | Vault path to the saved scan image (`.jpg`, or `.png` for PNG scans); empty when image saving is off | `attachments/papersync-<scan-id>.jpg` |
| `{{ps_separator}}`       | `***` when appending to an existing note, empty on a new one        | `***`                                 |
| `{{ps_confidence}}`      | AI confidence score, 0 to 100                                       | `87`                                  |
| `{{ps_provider}}`        | AI provider used for the scan                                       | `claude`                              |
| `{{ps_model}}`           | Model ID used for the scan                                          | `claude-sonnet-4`                     |

The Notes folder also supports date tokens (`YYYY`, `MM`, `DD`), so `Journal/YYYY/MM` files notes under `Journal/2026/04/`.

### Default template

```markdown
{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Source
> ![[{{ps_image_file}}]]
```

When image saving is off, the empty embed line is removed from the note.

## Support

Found a bug or have an idea? [Open an issue](https://github.com/Papersync/obsidian-papersync/issues). Report security problems as described in [SECURITY.md](SECURITY.md).

## Contributing

Build and test instructions are in [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- STORE LAUNCH: uncomment once a store badge is shown.
<sub>App Store is a service mark of Apple Inc., registered in the U.S. and other countries. Google Play and the Google Play logo are trademarks of Google LLC.</sub>
-->

## License

[MIT](LICENSE)
