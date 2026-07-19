import { Platform } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectSyncLocations, resolvePickedFolder } from '@/utils/platform';

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
	// Auto-mocked fs returns undefined; make the default match a real absent
	// directory so ~/Library/CloudStorage looks missing unless a test stubs it.
	(fs.readdirSync as unknown as jest.Mock).mockImplementation(() => { throw new Error('ENOENT'); });
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
	const cloudRoot = path.join(home, 'Library', 'CloudStorage');
	const icloudBase = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
	const scans = (base: string): string => path.join(base, 'Papersync');

	function stubCloudStorage(names: string[], files: string[] = []): void {
		const dirents = [
			...names.map((n) => ({ name: n, isDirectory: () => true })),
			...files.map((n) => ({ name: n, isDirectory: () => false })),
		];
		(fs.readdirSync as unknown as jest.Mock).mockImplementation((p: string) => {
			if (p === cloudRoot) {return dirents;}
			throw new Error('ENOENT');
		});
	}

	it('offers iCloud Drive on macOS even when its Papersync folder is absent', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(detectSyncLocations()).toEqual([
			{ type: 'icloud', displayName: 'iCloud Drive', path: scans(icloudBase), basePath: icloudBase, exists: false },
		]);
	});

	it('marks the iCloud row as existing once the folder is there', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		allowPaths([scans(icloudBase)]);
		expect(detectSyncLocations()[0]).toMatchObject({ type: 'icloud', exists: true });
	});

	it('offers nothing off macOS when no Papersync folder exists anywhere', () => {
		(Platform as { isWin: boolean }).isWin = true;
		expect(detectSyncLocations()).toEqual([]);
	});

	// iCloud Drive exists on Windows, but the offload nudge is brctl (macOS only),
	// so a Windows row would promise handling that is not there.
	it('does not offer an iCloud row on Windows', () => {
		(Platform as { isWin: boolean }).isWin = true;
		allowPaths([scans(path.join(home, 'iCloudDrive'))]);
		expect(detectSyncLocations().find((l) => l.type === 'icloud')).toBeUndefined();
	});

	describe('locations that already contain a Papersync folder', () => {
		it('surfaces a CloudStorage provider when Papersync is inside it', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			const od = path.join(cloudRoot, 'OneDrive-Personal');
			stubCloudStorage(['OneDrive-Personal']);
			allowPaths([scans(od)]);

			expect(detectSyncLocations().filter((l) => l.type === 'folder')).toEqual([
				{ type: 'folder', displayName: 'OneDrive (Personal)', path: scans(od), basePath: od, exists: true },
			]);
		});

		// The rule that keeps the list short: presence of the folder, not presence
		// of the provider. Browse still reaches anything not listed.
		it('stays silent about a provider with no Papersync folder', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			stubCloudStorage(['OneDrive-Personal', 'Dropbox']);
			expect(detectSyncLocations().filter((l) => l.type === 'folder')).toEqual([]);
		});

		it('finds a provider nobody hard-coded', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			const eg = path.join(cloudRoot, 'Egnyte-Acme');
			stubCloudStorage(['Egnyte-Acme']);
			allowPaths([scans(eg)]);
			expect(detectSyncLocations().map((l) => l.displayName)).toContain('Egnyte (Acme)');
		});

		it('finds legacy home-folder roots on any platform', () => {
			(Platform as { isLinux: boolean }).isLinux = true;
			const dropbox = path.join(home, 'Dropbox');
			allowPaths([scans(dropbox)]);
			expect(detectSyncLocations()).toEqual([
				{ type: 'folder', displayName: 'Dropbox', path: scans(dropbox), basePath: dropbox, exists: true },
			]);
		});

		it('keeps an account containing dashes intact', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			const od = path.join(cloudRoot, 'OneDrive-Contoso-Field-Ops');
			stubCloudStorage(['OneDrive-Contoso-Field-Ops']);
			allowPaths([scans(od)]);
			expect(detectSyncLocations().map((l) => l.displayName)).toContain('OneDrive (Contoso-Field-Ops)');
		});

		it('ignores stray files under CloudStorage', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			stubCloudStorage([], ['.DS_Store']);
			allowPaths([scans(path.join(cloudRoot, '.DS_Store'))]);
			expect(detectSyncLocations().filter((l) => l.type === 'folder')).toEqual([]);
		});

		it('never lists iCloud twice', () => {
			(Platform as { isMacOS: boolean }).isMacOS = true;
			allowPaths([scans(icloudBase)]);
			expect(detectSyncLocations().filter((l) => l.type === 'icloud')).toHaveLength(1);
		});
	});
});

describe('resolvePickedFolder', () => {
	const root = path.join(home, 'OneDrive-Personal');

	it('descends into a Papersync child when the user picks the root', () => {
		allowPaths([path.join(root, 'Papersync')]);
		expect(resolvePickedFolder(root)).toBe(path.join(root, 'Papersync'));
	});

	it('climbs out of a legacy scans folder', () => {
		const papersync = path.join(root, 'Papersync');
		expect(resolvePickedFolder(path.join(papersync, 'scans'))).toBe(papersync);
	});

	it('leaves a correct Papersync pick untouched', () => {
		const papersync = path.join(root, 'Papersync');
		expect(resolvePickedFolder(papersync)).toBe(papersync);
	});

	it('leaves an unrelated folder untouched rather than guessing', () => {
		const other = path.join(home, 'Documents');
		expect(resolvePickedFolder(other)).toBe(other);
	});

	it('does not climb out of a scans folder that is not under Papersync', () => {
		const stray = path.join(home, 'Archive', 'scans');
		expect(resolvePickedFolder(stray)).toBe(stray);
	});

	it('tolerates a trailing separator', () => {
		allowPaths([path.join(root, 'Papersync')]);
		expect(resolvePickedFolder(`${root}${path.sep}`)).toBe(path.join(root, 'Papersync'));
	});
});
