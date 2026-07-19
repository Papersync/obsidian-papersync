import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSyncLocations } from '@/utils/platform';

jest.mock('fs');
jest.mock('os');

const mockAccessSync = fs.accessSync as jest.MockedFunction<typeof fs.accessSync>;
const mockHomedir = os.homedir as jest.MockedFunction<typeof os.homedir>;

const home = '/Users/test';
const scans = (base: string) => path.join(base, 'Papersync');
const macICloudBase = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const winICloudBase = path.join(home, 'iCloudDrive');
const dropboxBase = path.join(home, 'Dropbox');
const oneDriveBase = path.join(home, 'OneDrive');
const syncthingBase = path.join(home, 'Sync');

beforeEach(() => {
	jest.resetAllMocks();
	mockHomedir.mockReturnValue(home);
	mockAccessSync.mockImplementation(() => { throw new Error('ENOENT'); });
	(Platform as { isMacOS: boolean }).isMacOS = false;
	(Platform as { isWin: boolean }).isWin = false;
	(Platform as { isLinux: boolean }).isLinux = false;
});

function allowPaths(paths: string[]): void {
	mockAccessSync.mockImplementation((p) => {
		if (paths.includes(p as string)) return;
		throw new Error('ENOENT');
	});
}

describe('detectSyncLocations', () => {
	it('returns no locations on Linux when nothing is detected', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		expect(detectSyncLocations()).toEqual([]);
	});

	it('always offers iCloud Drive on macOS, even when nothing exists yet', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(detectSyncLocations()).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: scans(macICloudBase), basePath: macICloudBase, exists: false },
		]);
	});

	it('marks the iCloud scans folder as existing when present on macOS', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		allowPaths([scans(macICloudBase)]);
		expect(detectSyncLocations()).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: scans(macICloudBase), basePath: macICloudBase, exists: true },
		]);
	});

	it('always offers iCloud Drive on Windows', () => {
		(Platform as { isWin: boolean }).isWin = true;
		expect(detectSyncLocations()).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: scans(winICloudBase), basePath: winICloudBase, exists: false },
		]);
	});

	it('offers Dropbox when its root exists, before the scans folder does', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		allowPaths([dropboxBase]);
		expect(detectSyncLocations()).toEqual([
			{ type: 'dropbox', displayName: 'Dropbox', path: scans(dropboxBase), basePath: dropboxBase, exists: false },
		]);
	});

	it('marks an existing Dropbox scans folder', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		allowPaths([dropboxBase, scans(dropboxBase)]);
		expect(detectSyncLocations()).toEqual([
			{ type: 'dropbox', displayName: 'Dropbox', path: scans(dropboxBase), basePath: dropboxBase, exists: true },
		]);
	});

	it('hides Dropbox when its root folder is absent', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		expect(detectSyncLocations()).toEqual([]);
	});

	it('offers OneDrive on Windows when its root exists', () => {
		(Platform as { isWin: boolean }).isWin = true;
		allowPaths([oneDriveBase]);
		const oneDrive = detectSyncLocations().find((l) => l.type === 'onedrive');
		expect(oneDrive).toEqual(
			{ type: 'onedrive', displayName: 'OneDrive', path: scans(oneDriveBase), basePath: oneDriveBase, exists: false },
		);
	});

	it('offers OneDrive on macOS when its root exists', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		allowPaths([oneDriveBase, scans(oneDriveBase)]);
		const oneDrive = detectSyncLocations().find((l) => l.type === 'onedrive');
		expect(oneDrive).toEqual(
			{ type: 'onedrive', displayName: 'OneDrive', path: scans(oneDriveBase), basePath: oneDriveBase, exists: true },
		);
	});

	it('does not offer OneDrive on Linux even when its root exists', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		allowPaths([oneDriveBase]);
		expect(detectSyncLocations()).toEqual([]);
	});

	it('offers Syncthing when its root exists', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		allowPaths([syncthingBase]);
		expect(detectSyncLocations()).toEqual([
			{ type: 'syncthing', displayName: 'Syncthing', path: scans(syncthingBase), basePath: syncthingBase, exists: false },
		]);
	});

	it('always offers Obsidian Sync when a vault path is given', () => {
		(Platform as { isLinux: boolean }).isLinux = true;
		const vaultPath = '/Users/test/Documents/MyVault';
		expect(detectSyncLocations(vaultPath)).toEqual([
			{ type: 'obsidian-sync', displayName: 'Obsidian Sync', path: scans(vaultPath), basePath: vaultPath, exists: false },
		]);
	});

	it('does not offer Obsidian Sync when no vault path is given', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(detectSyncLocations().find((l) => l.type === 'obsidian-sync')).toBeUndefined();
	});

	it('returns multiple locations, iCloud first', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		allowPaths([dropboxBase, scans(dropboxBase)]);
		const result = detectSyncLocations();
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ type: 'icloud', exists: false });
		expect(result[1]).toMatchObject({ type: 'dropbox', exists: true });
	});
});
