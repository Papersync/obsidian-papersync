import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export type SyncLocationType =
	| 'icloud'
	| 'dropbox'
	| 'onedrive'
	| 'syncthing'
	| 'obsidian-sync';

export interface SyncLocation {
	type: SyncLocationType;
	displayName: string;
	path: string;
}

const PAPERSYNC_SCANS_FOLDER = path.join('PaperSync', 'scans');

function probe(candidate: string): boolean {
	try {
		fs.accessSync(candidate, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

export function detectSyncLocations(vaultPath?: string): SyncLocation[] {
	const locations: SyncLocation[] = [];
	const home = os.homedir();

	// iCloud Drive
	if (Platform.isMacOS) {
		const icloudMacBase = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
		const p = path.join(icloudMacBase, PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'icloud', displayName: 'iCloud Drive', path: p });
		}
	} else if (Platform.isWin) {
		const p = path.join(home, 'iCloudDrive', PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'icloud', displayName: 'iCloud Drive', path: p });
		}
	}

	// Dropbox (same path on every platform)
	const dropboxPath = path.join(home, 'Dropbox', PAPERSYNC_SCANS_FOLDER);
	if (probe(dropboxPath)) {
		locations.push({ type: 'dropbox', displayName: 'Dropbox', path: dropboxPath });
	}

	// OneDrive (same path on Windows and macOS; Linux excluded)
	if (Platform.isWin || Platform.isMacOS) {
		const p = path.join(home, 'OneDrive', PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'onedrive', displayName: 'OneDrive', path: p });
		}
	}

	// Syncthing
	const syncthingPath = path.join(home, 'Sync', PAPERSYNC_SCANS_FOLDER);
	if (probe(syncthingPath)) {
		locations.push({ type: 'syncthing', displayName: 'Syncthing', path: syncthingPath });
	}

	// Obsidian Sync (vault-relative)
	if (vaultPath) {
		const p = path.join(vaultPath, PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'obsidian-sync', displayName: 'Obsidian Sync', path: p });
		}
	}

	return locations;
}

export function isOnline(): boolean {
	return navigator.onLine;
}
