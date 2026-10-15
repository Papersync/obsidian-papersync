<p align="center">
  <img src=".github/assets/wordmark.svg" alt="Papersync" width="280">
</p>

<h1 align="center">Papersync for Obsidian</h1>

<p align="center">
  <a href="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/Papersync/obsidian-papersync/releases/latest"><img alt="Version 0.1.2" src="https://img.shields.io/badge/version-0.1.2-blue"></a>
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Obsidian 1.13.4+" src="https://img.shields.io/badge/Obsidian-1.13.4%2B-7c3aed">
  <img alt="Desktop" src="https://img.shields.io/badge/platform-desktop-lightgrey">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-success">
  <!-- After community-registry approval, add the official download count:
  <img alt="Obsidian downloads" src="https://img.shields.io/badge/dynamic/json?logo=obsidian&color=7c3aed&label=downloads&query=$['papersync'].downloads&url=https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json"> -->
</p>

Snap a handwritten page with the Papersync phone app, and this plugin files it into that day's note as Markdown.

## Before you start

You need the [Papersync app](https://papersync.ai) and an API key for the AI provider you pick in it (Anthropic, OpenAI, Gemini, OpenRouter, Ollama and others). The key stays in the app, which sends each page straight to that provider. There is no Papersync server.

<!--
STORE LAUNCH (the go-public PR): replace the papersync.ai link above with the block below.
Show a badge ONLY for a store that is live; for the other one, drop its <a> and add
"Coming soon to Google Play (or the App Store): see papersync.ai."
Badges: the unmodified official SVGs (Apple Marketing Tools, Google Partner Marketing Hub),
committed to .github/assets/, App Store first, both at height 40. Replace ASC_APP_ID with the
numeric Apple ID from App Store Connect. Open both URLs logged out before merging.
Also uncomment the trademark line at the end.

<p>
  <a href="https://apps.apple.com/app/idASC_APP_ID"><img alt="Download on the App Store" src=".github/assets/app-store-badge.svg" height="40"></a>&nbsp;&nbsp;
  <a href="https://play.google.com/store/apps/details?id=ai.papersync.app"><img alt="Get it on Google Play" src=".github/assets/google-play-badge.svg" height="40"></a>
</p>
-->

## Setup

1. In the app, choose where scans are saved: Google Drive, or a folder your computer syncs (iCloud Drive, Dropbox, OneDrive, Syncthing).
2. In the plugin's settings, connect the same place. For Google Drive, sign in with the Google account the app uses.

Scans already waiting are imported as soon as you connect, so edit the template first if you want a different layout.

If a scan's photo was moved or deleted, its text still imports without a broken image embed. When a photo is first absent, the plugin allows up to one minute for it to finish syncing, then rechecks automatically. Photo access or download errors remain retryable and do not mark the scan imported.

## Privacy

- Folder sync makes no network requests.
- Google Drive sync talks only to Google (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`) with the `drive.file` scope, so it sees only files Papersync created. The sign-in token is kept in Obsidian's secret storage, never in `data.json`. Details in [SECURITY.md](SECURITY.md).
- No telemetry or analytics.

<!-- GO PUBLIC: delete this section once the plugin is listed in the community directory. -->
## Installation

Papersync is not in the community plugin directory yet. Copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/papersync/`.

## Support

Questions go in [Discussions](https://github.com/Papersync/obsidian-papersync/discussions/categories/q-a). [Open an issue](https://github.com/Papersync/obsidian-papersync/issues/new/choose) for bugs and ideas. Security reports: [SECURITY.md](SECURITY.md). Building from source: [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- STORE LAUNCH: uncomment once a store badge is shown.
<sub>App Store is a service mark of Apple Inc., registered in the U.S. and other countries. Google Play and the Google Play logo are trademarks of Google LLC.</sub>
-->
