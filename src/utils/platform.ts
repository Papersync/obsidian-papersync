import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { MAX_SCAN_JSON_BYTES } from '@/config';

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
 * folder is deleted. iCloud Drive does run on Windows, but the offload nudge
 * (`triggerICloudDownload`) is only proven on macOS, so a Windows row would
 * promise handling nobody has verified there; those users go through Browse.
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

// A scan is a JSON file carrying markdown. Cheap structural check, deliberately
// not full schema validation: this only has to tell a scans folder apart from an
// arbitrary folder that happens to contain JSON.
function looksLikeScan(filePath: string): boolean {
	try {
		// Never read a huge (or non-regular) file on the main thread just to sniff it.
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > MAX_SCAN_JSON_BYTES) {return false;}
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
		return typeof parsed === 'object' && parsed !== null && 'markdown' in parsed;
	} catch {
		return false;
	}
}

const SNIFF_LIMIT = 5; // enough to identify the folder, cheap on a large one

function holdsScans(dir: string): boolean {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return false;
	}
	let checked = 0;
	for (const entry of entries) {
		if (!entry.endsWith('.json')) {continue;}
		if (looksLikeScan(path.join(dir, entry))) {return true;}
		if (++checked >= SNIFF_LIMIT) {break;}
	}
	return false;
}

function subdirectories(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
			.map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}

/**
 * Works out which folder actually holds the scans, from wherever the user
 * pointed. There is no guidance step and nothing to read: the OS folder dialog
 * cannot be labelled, so rather than asking the user to land on the exact level,
 * we find it.
 *
 * Resolution is by CONTENT first. A folder holding scan JSON is the answer
 * whatever it is called, which covers renamed folders, localized names and the
 * legacy `Papersync/scans` layout without special-casing any of them. Name rules
 * are only the fallback for a folder that is correct but still empty, since a
 * brand-new setup has nothing to sniff.
 *
 * Searches two levels down, which reaches `<root>/Papersync` and
 * `<root>/Papersync/scans` from a provider root. Deeper is left alone rather
 * than guessed at.
 */
export function resolvePickedFolder(picked: string): string {
	const normalized = picked.replace(/[/\\]+$/, '');

	// 1. The pick is already right.
	if (holdsScans(normalized)) {return normalized;}

	// 2. Look downward for the real thing, nearest first.
	let frontier = [normalized];
	for (let depth = 0; depth < 2; depth++) {
		const next: string[] = [];
		for (const dir of frontier) {
			for (const child of subdirectories(dir)) {
				if (holdsScans(child)) {return child;}
				next.push(child);
			}
		}
		frontier = next;
	}

	// 3. Nothing to sniff (an empty but correctly-named folder). Fall back to
	//    names: climb out of a legacy scans folder, or descend into Papersync.
	if (path.basename(normalized) === 'scans') {
		const parent = path.dirname(normalized);
		if (path.basename(parent) === PAPERSYNC_FOLDER) {return parent;}
	}
	const child = path.join(normalized, PAPERSYNC_FOLDER);
	if (probe(child)) {return child;}

	// 4. Take the user at their word.
	return normalized;
}
