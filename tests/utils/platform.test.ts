import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSyncLocations } from '@/utils/platform';

jest.mock('fs');
jest.mock('os');

const mockAccessSync = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

beforeEach(() => {
	jest.resetAllMocks();
	mockHomedir.mockReturnValue('/Users/test');
	mockAccessSync.mockImplementation(() => { throw new Error('ENOENT'); });
	(Platform as { isMacOS: boolean }).isMacOS = false;
	(Platform as { isWin: boolean }).isWin = false;
	(Platform as { isLinux: boolean }).isLinux = false;
});

function allowPath(allowed: string): void {
	mockAccessSync.mockImplementation((p) => {
		if (p === allowed) return;
		throw new Error('ENOENT');
	});
}

function allowPaths(paths: string[]): void {
	mockAccessSync.mockImplementation((p) => {
		if (paths.includes(p as string)) return;
		throw new Error('ENOENT');
	});
}

describe('detectSyncLocations', () => {
	it('returns empty array when no sync paths exist', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(detectSyncLocations()).toEqual([]);
	});

	it('detects iCloud Drive on macOS', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const expected = path.join('/Users/test', 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations();
		expect(result).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: expected, detected: true },
		]);
	});

	it('detects iCloud Drive on Windows', () => {
		(Platform as { isWin: boolean }).isWin = true;
		const expected = path.join('/Users/test', 'iCloudDrive', 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations();
		expect(result).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: expected, detected: true },
		]);
	});

	it('detects Dropbox', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const expected = path.join('/Users/test', 'Dropbox', 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations();
		expect(result).toEqual([
			{ type: 'dropbox', displayName: 'Dropbox', path: expected, detected: true },
		]);
	});

	it('detects OneDrive on Windows', () => {
		(Platform as { isWin: boolean }).isWin = true;
		const expected = path.join('/Users/test', 'OneDrive', 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations();
		expect(result).toEqual([
			{ type: 'onedrive', displayName: 'OneDrive', path: expected, detected: true },
		]);
	});

	it('detects Syncthing', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const expected = path.join('/Users/test', 'Sync', 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations();
		expect(result).toEqual([
			{ type: 'syncthing', displayName: 'Syncthing', path: expected, detected: true },
		]);
	});

	it('detects Obsidian Sync when vault path provided', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const vaultPath = '/Users/test/Documents/MyVault';
		const expected = path.join(vaultPath, 'PaperSynced', 'scans');
		allowPath(expected);

		const result = detectSyncLocations(vaultPath);
		expect(result).toEqual([
			{ type: 'obsidian-sync', displayName: 'Obsidian Sync', path: expected, detected: true },
		]);
	});

	it('does not probe Obsidian Sync when no vault path given', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const result = detectSyncLocations();
		expect(result.find(l => l.type === 'obsidian-sync')).toBeUndefined();
	});

	it('returns multiple locations when several sync tools detected', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const icloudPath = path.join('/Users/test', 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'PaperSynced', 'scans');
		const dropboxPath = path.join('/Users/test', 'Dropbox', 'PaperSynced', 'scans');
		allowPaths([icloudPath, dropboxPath]);

		const result = detectSyncLocations();
		expect(result).toHaveLength(2);
		expect(result[0].type).toBe('icloud');
		expect(result[1].type).toBe('dropbox');
	});
});
