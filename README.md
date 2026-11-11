<p align="center">
  <img src=".github/assets/wordmark.svg" alt="Papersync" width="280">
</p>

<h1 align="center">Papersync for Obsidian</h1>

<p align="center">
  <a href="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/Papersync/obsidian-papersync/actions/workflows/verify.yml/badge.svg"></a>
  <a href="https://github.com/Papersync/obsidian-papersync/releases/latest"><img alt="Version 0.1.8" src="https://img.shields.io/badge/version-0.1.8-blue"></a>
  <img alt="License MIT" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="Obsidian 1.13.4+" src="https://img.shields.io/badge/Obsidian-1.13.4%2B-7c3aed">
  <img alt="Desktop" src="https://img.shields.io/badge/platform-desktop-lightgrey">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-success">
</p>

Snap a handwritten page with the [Papersync app](https://play.google.com/store/apps/details?id=ai.papersync.app), and it lands in today's daily note as Markdown.

## What you need

- The Papersync app (Android now, iPhone soon).
- An API key from an AI provider you pick in the app. Some providers charge for use.
- Obsidian on desktop.

## Setup

1. In the app, choose where scans go: Google Drive, or a synced folder (iCloud Drive, Dropbox, OneDrive, Syncthing).
2. In the plugin settings, connect the same place.

Scans waiting there import right away. Edit the template first if you want a different layout.

## Privacy

- No Papersync server, no account, no telemetry.
- **Folder sync** reads your chosen folder outside the vault. On macOS, reading an iCloud file that was offloaded asks iCloud to download it. The plugin makes no network requests.
- **Google Drive** talks only to Google, with the `drive.file` scope. The sign-in token stays in Obsidian's secret storage. See [SECURITY.md](SECURITY.md).

## Install

Search **Papersync** in **Settings › Community plugins**. Or copy `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Papersync/obsidian-papersync/releases/latest) into `<vault>/.obsidian/plugins/papersync/`.

## Help

[Discussions](https://github.com/Papersync/obsidian-papersync/discussions/categories/q-a) for questions, [issues](https://github.com/Papersync/obsidian-papersync/issues/new/choose) for bugs. Building from source: [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).

<sub>Google Play is a trademark of Google LLC.</sub>
