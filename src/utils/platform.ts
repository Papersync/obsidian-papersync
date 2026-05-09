import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface SyncLocation {
	type: string;
	displayName: string;
	path: string;
	detected: boolean;
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
			locations.push({ type: 'icloud', displayName: 'iCloud Drive', path: p, detected: true });
		}
	} else if (Platform.isWin) {
		const p = path.join(home, 'iCloudDrive', PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'icloud', displayName: 'iCloud Drive', path: p, detected: true });
		}
	}

	// Dropbox
	const dropboxCandidates = Platform.isWin
		? [path.join(home, 'Dropbox', PAPERSYNC_SCANS_FOLDER)]
		: [path.join(home, 'Dropbox', PAPERSYNC_SCANS_FOLDER)];
	for (const p of dropboxCandidates) {
		if (probe(p)) {
			locations.push({ type: 'dropbox', displayName: 'Dropbox', path: p, detected: true });
			break;
		}
	}

	// OneDrive
	if (Platform.isWin) {
		const p = path.join(home, 'OneDrive', PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'onedrive', displayName: 'OneDrive', path: p, detected: true });
		}
	} else if (Platform.isMacOS) {
		const p = path.join(home, 'OneDrive', PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'onedrive', displayName: 'OneDrive', path: p, detected: true });
		}
	}

	// Syncthing
	const syncthingPath = path.join(home, 'Sync', PAPERSYNC_SCANS_FOLDER);
	if (probe(syncthingPath)) {
		locations.push({ type: 'syncthing', displayName: 'Syncthing', path: syncthingPath, detected: true });
	}

	// Obsidian Sync (vault-relative)
	if (vaultPath) {
		const p = path.join(vaultPath, PAPERSYNC_SCANS_FOLDER);
		if (probe(p)) {
			locations.push({ type: 'obsidian-sync', displayName: 'Obsidian Sync', path: p, detected: true });
		}
	}

	return locations;
}

export function isOnline(): boolean {
	return navigator.onLine;
}
