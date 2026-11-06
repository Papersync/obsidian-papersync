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

	// iCloud Drive exists on Windows, but the offload nudge is only proven on macOS,
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

// resolvePickedFolder runs against the REAL filesystem (it sniffs file contents),
// so these use temp dirs rather than the mocked fs the detection tests use.
describe('resolvePickedFolder', () => {
	const realFs = jest.requireActual<typeof import('fs')>('fs');
	const realOs = jest.requireActual<typeof import('os')>('os');
	let root: string;

	const SCAN = JSON.stringify({ version: 1, markdown: '# hi', createdAt: '2026-01-01T00:00:00Z' });

	function mkdir(...segments: string[]): string {
		const dir = path.join(root, ...segments);
		realFs.mkdirSync(dir, { recursive: true });
		return dir;
	}
	function putScan(dir: string, name = 'scan.json'): void {
		realFs.writeFileSync(path.join(dir, name), SCAN);
	}

	beforeEach(() => {
		root = realFs.mkdtempSync(path.join(realOs.tmpdir(), 'pickres-'));
		// Route the module's fs calls at the real filesystem for this suite.
		for (const fn of ['readdirSync', 'readFileSync', 'accessSync', 'statSync'] as const) {
			(fs[fn] as unknown as jest.Mock).mockImplementation(
				(...args: unknown[]) => (realFs[fn] as (...a: unknown[]) => unknown)(...args)
			);
		}
	});

	afterEach(() => {
		realFs.rmSync(root, { recursive: true, force: true });
	});

	it('does not read an oversized JSON to decide whether a folder holds scans', () => {
		const dir = mkdir('Big', 'Stuff');
		realFs.writeFileSync(path.join(dir, 'huge.json'), JSON.stringify({ markdown: 'x'.repeat(1024 * 1024) }));
		(fs.readFileSync as unknown as jest.Mock).mockClear();
		expect(resolvePickedFolder(path.join(root, 'Big'))).toBe(path.join(root, 'Big'));
		expect(fs.readFileSync).not.toHaveBeenCalled();
	});

	it('keeps a pick that already holds scans', () => {
		const dir = mkdir('Papersync');
		putScan(dir);
		expect(resolvePickedFolder(dir)).toBe(dir);
	});

	// The case the user is most likely to hit: pointing at the provider root.
	it('descends from a provider root to the folder holding scans', () => {
		const dir = mkdir('OneDrive', 'Papersync');
		putScan(dir);
		expect(resolvePickedFolder(path.join(root, 'OneDrive'))).toBe(dir);
	});

	it('descends two levels into a legacy Papersync/scans layout', () => {
		const dir = mkdir('OneDrive', 'Papersync', 'scans');
		putScan(dir);
		expect(resolvePickedFolder(path.join(root, 'OneDrive'))).toBe(dir);
	});

	// Content beats naming: this is what makes renamed and localized folders work
	// without anyone hard-coding their names.
	it('finds a scans folder under a name nobody hard-coded', () => {
		const dir = mkdir('Sync', 'Mis Escaneos');
		putScan(dir);
		expect(resolvePickedFolder(path.join(root, 'Sync'))).toBe(dir);
	});

	it('prefers the nearest match when scans exist at two depths', () => {
		const near = mkdir('root', 'Papersync');
		putScan(near);
		putScan(mkdir('root', 'Papersync', 'scans'));
		expect(resolvePickedFolder(path.join(root, 'root'))).toBe(near);
	});

	it('ignores JSON that is not a scan', () => {
		const dir = mkdir('NotScans');
		realFs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
		expect(resolvePickedFolder(dir)).toBe(dir);
	});

	// Bounds the cost on a folder full of JSON: we stop sniffing after a handful
	// rather than reading an entire directory to decide it is not a scans folder.
	it('gives up after a handful of non-scan JSON files', () => {
		const dir = mkdir('JsonHeavy');
		for (let i = 0; i < 8; i++) {
			realFs.writeFileSync(path.join(dir, `f${i}.json`), JSON.stringify({ i }));
		}
		// A real scan sits past the sniff limit and is deliberately not found.
		putScan(dir, 'zz-late-scan.json');
		expect(resolvePickedFolder(dir)).toBe(dir);
	});

	it('ignores unreadable and malformed JSON without throwing', () => {
		const dir = mkdir('Broken');
		realFs.writeFileSync(path.join(dir, 'a.json'), '{not json');
		expect(resolvePickedFolder(dir)).toBe(dir);
	});

	it('skips dot-directories while searching', () => {
		const hidden = mkdir('Root', '.Trash');
		putScan(hidden);
		const picked = path.join(root, 'Root');
		expect(resolvePickedFolder(picked)).toBe(picked);
	});

	it('does not search deeper than two levels', () => {
		putScan(mkdir('Root', 'a', 'b', 'c'));
		const picked = path.join(root, 'Root');
		expect(resolvePickedFolder(picked)).toBe(picked);
	});

	// Empty-but-correct folders have nothing to sniff, so names are the fallback.
	it('climbs out of an empty legacy scans folder', () => {
		const papersync = mkdir('Papersync');
		const scansDir = mkdir('Papersync', 'scans');
		expect(resolvePickedFolder(scansDir)).toBe(papersync);
	});

	it('descends into an empty Papersync child', () => {
		const dir = mkdir('Root', 'Papersync');
		expect(resolvePickedFolder(path.join(root, 'Root'))).toBe(dir);
	});

	it('does not climb out of a scans folder with an unrelated parent', () => {
		const stray = mkdir('Archive', 'scans');
		expect(resolvePickedFolder(stray)).toBe(stray);
	});

	it('leaves an unrelated empty folder exactly as picked', () => {
		const dir = mkdir('Documents');
		expect(resolvePickedFolder(dir)).toBe(dir);
	});

	it('tolerates a trailing separator', () => {
		const dir = mkdir('Papersync');
		putScan(dir);
		expect(resolvePickedFolder(`${dir}${path.sep}`)).toBe(dir);
	});

	it('returns the pick when it does not exist at all', () => {
		const missing = path.join(root, 'nope');
		expect(resolvePickedFolder(missing)).toBe(missing);
	});
});
