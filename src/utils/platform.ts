import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export type SyncLocationType =
	| 'icloud'
	| 'dropbox'
	| 'onedrive'
	| 'syncthing';

export interface SyncLocation {
	type: SyncLocationType;
	displayName: string;
	path: string;
	/** Provider root that must exist before the scans path can be created inside it. */
	basePath: string;
	/** Whether the scans path itself already exists. */
	exists: boolean;
}

const PAPERSYNC_FOLDER = 'Papersync';

function probe(candidate: string): boolean {
	try {
		fs.accessSync(candidate, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function makeLocation(type: SyncLocationType, displayName: string, basePath: string): SyncLocation {
	const scansPath = path.join(basePath, PAPERSYNC_FOLDER);
	return { type, displayName, path: scansPath, basePath, exists: probe(scansPath) };
}

// A provider is offered whenever its ROOT folder exists — the scans folder
// inside it may not exist yet (the plugin can be set up before the app has
// written anything) and is created on select. iCloud Drive is offered
// unconditionally on platforms that support it, so the option never vanishes
// when the scans folder is deleted; select re-creates it (or explains when
// iCloud Drive itself is unavailable).
export function detectSyncLocations(): SyncLocation[] {
	const locations: SyncLocation[] = [];
	const home = os.homedir();

	if (Platform.isMacOS) {
		locations.push(makeLocation('icloud', 'iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')));
	} else if (Platform.isWin) {
		locations.push(makeLocation('icloud', 'iCloud Drive', path.join(home, 'iCloudDrive')));
	}

	// Dropbox (same path on every platform)
	const dropboxBase = path.join(home, 'Dropbox');
	if (probe(dropboxBase)) {
		locations.push(makeLocation('dropbox', 'Dropbox', dropboxBase));
	}

	// OneDrive (same path on Windows and macOS; Linux excluded)
	if (Platform.isWin || Platform.isMacOS) {
		const oneDriveBase = path.join(home, 'OneDrive');
		if (probe(oneDriveBase)) {
			locations.push(makeLocation('onedrive', 'OneDrive', oneDriveBase));
		}
	}

	// Syncthing
	const syncthingBase = path.join(home, 'Sync');
	if (probe(syncthingBase)) {
		locations.push(makeLocation('syncthing', 'Syncthing', syncthingBase));
	}

	// Obsidian Sync is deliberately NOT offered: it syncs the vault between
	// Obsidian clients, and the mobile app is not one, so it cannot deliver
	// scans there. A vault-internal folder is reachable via Browse instead.

	return locations;
}

export function isOnline(): boolean {
	return navigator.onLine;
}
