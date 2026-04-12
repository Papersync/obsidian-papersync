import { Platform } from 'obsidian';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

const ICLOUD_MACOS_BASE = path.join(
	os.homedir(),
	'Library',
	'Mobile Documents',
	'com~apple~CloudDocs'
);

const PAPERSYNCED_SCANS_FOLDER = path.join('PaperSynced', 'scans');

export function detectICloudScansPath(): string | null {
	if (Platform.isMacOS) {
		const candidate = path.join(ICLOUD_MACOS_BASE, PAPERSYNCED_SCANS_FOLDER);
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			return null;
		}
	}

	if (Platform.isWin) {
		const icloudWinBase = path.join(os.homedir(), 'iCloudDrive');
		const candidate = path.join(icloudWinBase, PAPERSYNCED_SCANS_FOLDER);
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			return null;
		}
	}

	return null;
}

export function isOnline(): boolean {
	return navigator.onLine;
}
