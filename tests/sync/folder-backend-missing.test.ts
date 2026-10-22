// Deleted-source and iCloud-eviction recovery paths: the watched folder or a
// discovered scan disappearing must surface typed SyncErrors (folder_missing /
// scan_missing), and `.name.icloud` placeholders must stay discoverable and
// recoverable. triggerICloudDownload is mocked so eviction recovery is
// deterministic; everything else runs against the real filesystem.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@/sync/icloud-offload', () => {
	const actual = jest.requireActual('@/sync/icloud-offload');
	return {
		...actual,
		triggerICloudDownload: jest.fn().mockResolvedValue(false),
	};
});

import { FolderBackend, isENOENT } from '@/sync/folder-backend';
import { triggerICloudDownload } from '@/sync/icloud-offload';
import { isSyncError } from '@/errors/error-handler';

const mockedTrigger = triggerICloudDownload as jest.MockedFunction<typeof triggerICloudDownload>;

const baseScan = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Sample',
	confidence: 90,
	provider: 'claude',
	model: 'claude-sonnet-4',
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backend-missing-'));
}

function writePlaceholder(dir: string, realName: string): void {
	fs.writeFileSync(path.join(dir, `.${realName}.icloud`), 'stub');
}

async function expectSyncErrorType(promise: Promise<unknown>, type: string): Promise<void> {
	try {
		await promise;
		throw new Error('expected promise to reject');
	} catch (err) {
		if (!isSyncError(err)) {throw err;}
		expect(err.type).toBe(type);
	}
}

describe('isENOENT', () => {
	it('matches only errors carrying the ENOENT code', () => {
		expect(isENOENT({ code: 'ENOENT' })).toBe(true);
		expect(isENOENT(new Error('no code'))).toBe(false);
		expect(isENOENT(null)).toBe(false);
		expect(isENOENT(undefined)).toBe(false);
	});
});

describe('FolderBackend — missing folder', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		mockedTrigger.mockReset();
		mockedTrigger.mockResolvedValue(false);
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('discoverUnsynced throws folder_missing when the watched folder is gone', async () => {
		fs.rmSync(tmp, { recursive: true, force: true });
		await expectSyncErrorType(backend.discoverUnsynced(), 'folder_missing');
	});

	it('discoverUnsynced reports a non-ENOENT readdir error as folder access with its code', async () => {
		fs.rmSync(tmp, { recursive: true, force: true });
		fs.writeFileSync(tmp, 'a file where the folder should be');
		try {
			await expect(backend.discoverUnsynced()).rejects.toMatchObject({
				type: 'folder_access',
				retriable: false,
				message: expect.stringContaining('(ENOTDIR)'),
			});
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	});
});

describe('FolderBackend — scan removed after discovery', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		mockedTrigger.mockReset();
		mockedTrigger.mockResolvedValue(false);
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('fetchScan throws scan_missing when the JSON is gone with no placeholder', async () => {
		const ref = {
			id: 'gone',
			jsonPath: path.join(tmp, 'gone.json'),
			imagePath: path.join(tmp, 'gone.jpg'),
		};
		await expectSyncErrorType(backend.fetchScan(ref), 'scan_missing');
	});

	it('fetchImage returns null when the image is gone with no placeholder', async () => {
		const ref = {
			id: 'gone',
			jsonPath: path.join(tmp, 'gone.json'),
			imagePath: path.join(tmp, 'gone.jpg'),
		};
		await expect(backend.fetchImage(ref)).resolves.toBeNull();
	});

	it('markSynced throws scan_missing when the JSON is gone with no placeholder', async () => {
		const ref = { id: 'gone', jsonPath: path.join(tmp, 'gone.json'), imagePath: '' };
		await expectSyncErrorType(backend.markSynced(ref), 'scan_missing');
	});

	it('reports a non-ENOENT read error as folder access with its code', async () => {
		const dirAsJson = path.join(tmp, 'dir.json');
		fs.mkdirSync(dirAsJson);
		const ref = { id: 'dir', jsonPath: dirAsJson, imagePath: '' };
		await expect(backend.fetchScan(ref)).rejects.toMatchObject({ type: 'folder_access', retriable: false });
	});

	it('rethrows a read error that carries no errno code untouched', async () => {
		const jsonPath = path.join(tmp, 'odd.json');
		fs.writeFileSync(jsonPath, '{}');
		const spy = jest.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('no code'));
		try {
			await backend.fetchScan({ id: 'odd', jsonPath, imagePath: '' }).then(
				() => { throw new Error('expected rejection'); },
				(err: unknown) => { expect(isSyncError(err)).toBe(false); }
			);
		} finally {
			spy.mockRestore();
		}
	});

	it('reports a scan JSON that is not valid JSON as a schema mismatch, not a retry', async () => {
		const jsonPath = path.join(tmp, 'half.json');
		fs.writeFileSync(jsonPath, '{"version": 1, "mark');
		await expect(backend.fetchScan({ id: 'half', jsonPath, imagePath: '' })).rejects.toMatchObject({
			type: 'schema_mismatch',
			retriable: false,
		});
		await expect(backend.markSynced({ id: 'half', jsonPath, imagePath: '' })).rejects.toMatchObject({ type: 'schema_mismatch' });
	});

	it('reports a scan JSON it cannot write back as folder access', async () => {
		const jsonPath = path.join(tmp, 'locked.json');
		fs.writeFileSync(jsonPath, '{}');
		const spy = jest.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('busy'), { code: 'EBUSY' }));
		try {
			await expect(backend.markSynced({ id: 'locked', jsonPath, imagePath: '' })).rejects.toMatchObject({
				type: 'folder_access',
				retriable: true,
			});
		} finally {
			spy.mockRestore();
		}
	});
});

describe('FolderBackend — a read that fails on a not-yet-downloaded file', () => {
	let tmp: string;

	beforeEach(() => {
		mockedTrigger.mockReset();
		mockedTrigger.mockResolvedValue(false);
		// A PLAIN temp dir with no provider marker in its path: not-yet-downloaded
		// detection must work for any on-demand provider (Windows iCloud, OneDrive,
		// Dropbox), so it must not depend on recognising the folder.
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodl-'));
	});

	afterEach(() => {
		jest.restoreAllMocks();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('maps a non-ENOENT read failure on a dataless file to icloud_offloaded', async () => {
		// The real shape of an offline eviction: the file exists and stats fine,
		// but materializing its content fails, so readFile errors with something
		// other than ENOENT.
		const jsonPath = path.join(tmp, 'offline.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ a: 1 }));

		const realStat = fs.promises.stat;
		jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, ...rest) => {
			const st = await (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
			return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 }) as fs.Stats;
		});
		jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
			Object.assign(new Error('input/output error'), { code: 'EIO' })
		);

		const backend = new FolderBackend(tmp);
		await expectSyncErrorType(
			backend.fetchImage({ id: 'offline', jsonPath: '', imagePath: jsonPath }),
			'icloud_offloaded'
		);
	});

	it('reports a non-ENOENT read failure as folder access when the file is materialized', async () => {
		const jsonPath = path.join(tmp, 'broken.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ a: 1 }));
		jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
			Object.assign(new Error('input/output error'), { code: 'EIO' })
		);

		const backend = new FolderBackend(tmp);
		await backend.fetchImage({ id: 'broken', jsonPath: '', imagePath: jsonPath }).then(
			() => { throw new Error('expected rejection'); },
			(err: unknown) => { expect(err).toMatchObject({ type: 'folder_access', retriable: true }); }
		);
	});

	it('reports folder access when stat itself fails, since dataless is unknowable', async () => {
		const jsonPath = path.join(tmp, 'vanished.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ a: 1 }));
		jest.spyOn(fs.promises, 'readFile').mockRejectedValue(
			Object.assign(new Error('input/output error'), { code: 'EIO' })
		);
		jest.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('stat exploded'));

		const backend = new FolderBackend(tmp);
		await backend.fetchImage({ id: 'vanished', jsonPath: '', imagePath: jsonPath }).then(
			() => { throw new Error('expected rejection'); },
			(err: unknown) => { expect(err).toMatchObject({ type: 'folder_access', retriable: true }); }
		);
	});
});

describe('FolderBackend — iCloud eviction placeholders', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		mockedTrigger.mockReset();
		mockedTrigger.mockResolvedValue(false);
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('discovers a fully evicted scan (json + image placeholders only)', async () => {
		writePlaceholder(tmp, 'scan1.json');
		writePlaceholder(tmp, 'scan1.jpg');

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			id: 'scan1',
			jsonPath: path.join(tmp, 'scan1.json'),
			imagePath: path.join(tmp, 'scan1.jpg'),
		});
	});

	it('discovers an evicted json with a present real image', async () => {
		writePlaceholder(tmp, 'scan2.json');
		fs.writeFileSync(path.join(tmp, 'scan2.jpg'), 'blob');

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0]!.id).toBe('scan2');
	});

	it('discovers an evicted json with no companion image at all', async () => {
		writePlaceholder(tmp, 'scan3.json');
		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
	});

	it('fetchScan recovers an evicted json when the download succeeds', async () => {
		const jsonPath = path.join(tmp, 'scan4.json');
		writePlaceholder(tmp, 'scan4.json');
		mockedTrigger.mockImplementation(async (p: string) => {
			fs.writeFileSync(p, JSON.stringify({ ...baseScan, imageFileName: 'scan4.jpg' }));
			return true;
		});

		const scan = await backend.fetchScan({
			id: 'scan4',
			jsonPath,
			imagePath: path.join(tmp, 'scan4.jpg'),
		});
		expect(scan.markdown).toBe('# Sample');
		expect(mockedTrigger).toHaveBeenCalledWith(jsonPath);
	});

	it('fetchScan throws icloud_offloaded when the download does not materialize', async () => {
		writePlaceholder(tmp, 'scan5.json');
		const ref = { id: 'scan5', jsonPath: path.join(tmp, 'scan5.json'), imagePath: '' };
		await expectSyncErrorType(backend.fetchScan(ref), 'icloud_offloaded');
	});

	it('fetchImage recovers an evicted image when the download succeeds', async () => {
		const imagePath = path.join(tmp, 'scan6.jpg');
		writePlaceholder(tmp, 'scan6.jpg');
		mockedTrigger.mockImplementation(async (p: string) => {
			fs.writeFileSync(p, 'imagebytes');
			return true;
		});

		const buffer = await backend.fetchImage({ id: 'scan6', jsonPath: '', imagePath });
		expect(Buffer.from(buffer).toString('utf-8')).toBe('imagebytes');
	});
});
