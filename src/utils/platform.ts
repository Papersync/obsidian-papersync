import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export type SyncLocationType = 'icloud' | 'folder';

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
const ICLOUD_DRIVE_MACOS = ['Library', 'Mobile Documents', 'com~apple~CloudDocs'];

function probe(candidate: string): boolean {
	try {
		fs.accessSync(candidate, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Roots that a sync client might own. Scanned ONLY to see whether a Papersync
 * folder already sits inside one — never listed on their own.
 */
function candidateRoots(home: string): string[] {
	const roots = [path.join(home, 'Dropbox'), path.join(home, 'OneDrive'), path.join(home, 'Sync')];

	// macOS Ventura+ keeps File Provider clients here, one directory per account.
	// Enumerated rather than name-matched: we cannot predict what a user has
	// mounted, and a hard-coded list fails closed on the provider we forgot.
	const cloudStorage = path.join(home, 'Library', 'CloudStorage');
	try {
		for (const entry of fs.readdirSync(cloudStorage, { withFileTypes: true })) {
			if (entry.isDirectory()) {roots.push(path.join(cloudStorage, entry.name));}
		}
	} catch {
		// absent on Windows, Linux, and pre-Ventura macOS
	}
	return roots;
}

// `OneDrive-Personal` reads as `OneDrive (Personal)`. Labelling only.
function labelFor(dirName: string): string {
	const dash = dirName.indexOf('-');
	return dash > 0 ? `${dirName.slice(0, dash)} (${dirName.slice(dash + 1)})` : dirName;
}

function toLocation(type: SyncLocationType, displayName: string, basePath: string): SyncLocation {
	const scansPath = path.join(basePath, PAPERSYNC_FOLDER);
	return { type, displayName, path: scansPath, basePath, exists: probe(scansPath) };
}

/**
 * The storage picker offers Google Drive, iCloud Drive, and Browse. Drive has its
 * own OAuth backend; this covers the iCloud row plus one useful extra.
 *
 * The extra: any other location that ALREADY CONTAINS a Papersync folder. That
 * is evidence the mobile app has written there, so it is the folder the user
 * actually wants, not a guess. Locations without one stay out of the list —
 * Dropbox, OneDrive and the rest are all reachable through Browse, and listing
 * them speculatively would add rows to explain without adding capability.
 *
 * iCloud is macOS-only and always offered, so the option never vanishes when its
 * folder is deleted. iCloud Drive does run on Windows, but the offload nudge is
 * `brctl`, a macOS binary with no Windows counterpart, so a Windows row would
 * promise handling that is not there; those users go through Browse.
 */
export function detectSyncLocations(): SyncLocation[] {
	const home = os.homedir();
	const locations: SyncLocation[] = [];

	if (Platform.isMacOS) {
		locations.push(toLocation('icloud', 'iCloud Drive', path.join(home, ...ICLOUD_DRIVE_MACOS)));
	}

	// No de-dupe against the iCloud row is needed: the iCloud container lives under
	// Mobile Documents, which is never one of the candidate roots.
	for (const root of candidateRoots(home)) {
		const candidate = toLocation('folder', labelFor(path.basename(root)), root);
		if (candidate.exists) {locations.push(candidate);}
	}

	return locations;
}

export function isOnline(): boolean {
	return navigator.onLine;
}

/**
 * The OS folder dialog cannot be labelled, so a user can land one level off in
 * either direction. Correct the two cases identifiable with certainty and leave
 * anything else exactly as picked, rather than guessing at intent:
 *
 *   <root>                   -> <root>/Papersync      when that child exists
 *   <root>/Papersync/scans   -> <root>/Papersync      the pre-flat layout
 */
export function resolvePickedFolder(picked: string): string {
	const normalized = picked.replace(/[/\\]+$/, '');

	if (path.basename(normalized) === 'scans') {
		const parent = path.dirname(normalized);
		if (path.basename(parent) === PAPERSYNC_FOLDER) {return parent;}
	}

	const child = path.join(normalized, PAPERSYNC_FOLDER);
	if (probe(child)) {return child;}

	return normalized;
}
