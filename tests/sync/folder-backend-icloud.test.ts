// fetchScan iCloud-offload branches are tested in isolation here so we can
// jest.mock('@/sync/icloud-offload') without disturbing the sibling suites
// that exercise the normal (non-iCloud) discovery + fetch paths.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@/sync/icloud-offload', () => {
	const actual = jest.requireActual('@/sync/icloud-offload');
	return {
		...actual,
		// Treat any path containing `icloud-fixture` as an iCloud-managed file.
		isICloudPath: jest.fn((p: string) => p.includes('icloud-fixture')),
		triggerICloudDownload: jest.fn().mockResolvedValue(true),
	};
});

import { FolderBackend } from '@/sync/folder-backend';
import { triggerICloudDownload } from '@/sync/icloud-offload';
import { createSyncError } from '@/errors/sync-error';

const baseScan = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Sample',
	confidence: 90,
	provider: 'claude',
	model: 'claude-sonnet-4',
};

const mockedTrigger = triggerICloudDownload as jest.MockedFunction<typeof triggerICloudDownload>;

function makeIcloudDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'icloud-fixture-'));
}

describe('FolderBackend.fetchScan — iCloud-offloaded JSON paths', () => {
	let dir: string;

	beforeEach(() => {
		mockedTrigger.mockReset();
		mockedTrigger.mockResolvedValue(true);
		dir = makeIcloudDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		jest.restoreAllMocks();
	});

	// An evicted iCloud file is "dataless": it keeps its name AND its logical
	// size, and only `blocks === 0` betrays that the content is not on disk. A
	// real filesystem can't produce that state on demand, so stat is stubbed.
	// (Verified against real macOS: before download `size=35 blocks=0
	// flags=compressed,dataless`, after `size=35 blocks=8`.)
	function stubDataless(target: string): void {
		const realStat = fs.promises.stat;
		jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, ...rest) => {
			const st = await (realStat as (...a: unknown[]) => Promise<fs.Stats>)(p, ...rest);
			if (p === target) {
				return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { blocks: 0 }) as fs.Stats;
			}
			return st;
		});
	}

	it('triggers download for a dataless JSON, then reads the materialized content', async () => {
		const jsonPath = path.join(dir, 'scan.json');
		// Non-zero size on disk: the old `size === 0` test could never have fired.
		fs.writeFileSync(jsonPath, JSON.stringify({ ...baseScan, imageFileName: 'scan.jpg' }));
		stubDataless(jsonPath);

		const backend = new FolderBackend(dir);
		const scan = await backend.fetchScan({
			id: 'scan',
			jsonPath,
			imagePath: path.join(dir, 'scan.jpg'),
		});
		expect(scan.markdown).toBe('# Sample');
		expect(mockedTrigger).toHaveBeenCalledWith(jsonPath);
	});

	it('throws icloud_offloaded when the dataless download fails', async () => {
		const jsonPath = path.join(dir, 'offline.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ ...baseScan, imageFileName: 'offline.jpg' }));
		stubDataless(jsonPath);
		mockedTrigger.mockResolvedValueOnce(false);

		const backend = new FolderBackend(dir);
		await expect(
			backend.fetchScan({ id: 'offline', jsonPath, imagePath: path.join(dir, 'offline.jpg') })
		).rejects.toMatchObject({ type: 'icloud_offloaded' });
	});

	it('does not treat a genuinely empty file as dataless', async () => {
		// size 0 with blocks 0 is just an empty file, not an eviction — the old
		// check inverted exactly this case.
		const jsonPath = path.join(dir, 'empty.json');
		fs.writeFileSync(jsonPath, '');

		const backend = new FolderBackend(dir);
		await expect(
			backend.fetchScan({ id: 'empty', jsonPath, imagePath: path.join(dir, 'empty.jpg') })
		).rejects.toMatchObject({ type: 'schema_mismatch' }); // JSON.parse of '': never an offload path
		expect(mockedTrigger).not.toHaveBeenCalled();
	});

	it('skips offload handling and reads directly when the file is already materialized', async () => {
		const jsonPath = path.join(dir, 'materialized.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ ...baseScan, imageFileName: 'm.jpg' }));

		const backend = new FolderBackend(dir);
		const scan = await backend.fetchScan({
			id: 'materialized',
			jsonPath,
			imagePath: path.join(dir, 'm.jpg'),
		});
		expect(scan.markdown).toBe('# Sample');
		// File had non-zero size → triggerICloudDownload should never be invoked.
		expect(mockedTrigger).not.toHaveBeenCalled();
	});

	it('falls through to readFile when stat throws a non-typed error', async () => {
		const jsonPath = path.join(dir, 'flaky.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ ...baseScan, imageFileName: 'flaky.jpg' }));

		// stat throws once → the catch swallows non-icloud errors → proceeds to readFile
		jest.spyOn(fs.promises, 'stat').mockRejectedValueOnce(new Error('EIO'));

		const backend = new FolderBackend(dir);
		const scan = await backend.fetchScan({
			id: 'flaky',
			jsonPath,
			imagePath: path.join(dir, 'flaky.jpg'),
		});
		expect(scan.markdown).toBe('# Sample');
	});

	it('rethrows a typed icloud_offloaded error raised inside the iCloud branch', async () => {
		const jsonPath = path.join(dir, 'preflight.json');
		fs.writeFileSync(jsonPath, JSON.stringify(baseScan));
		stubDataless(jsonPath); // dataless so the download branch is entered

		mockedTrigger.mockImplementationOnce(() => {
			throw createSyncError('icloud_offloaded', 'caller-supplied offload error');
		});

		const backend = new FolderBackend(dir);
		await expect(
			backend.fetchScan({ id: 'preflight', jsonPath, imagePath: path.join(dir, 'preflight.jpg') })
		).rejects.toMatchObject({ type: 'icloud_offloaded' });
	});

	it('does not exercise iCloud branch for non-iCloud paths', async () => {
		// Use a tmp dir whose path does NOT contain "icloud-fixture"
		const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-folder-'));
		const jsonPath = path.join(plainDir, 'plain.json');
		fs.writeFileSync(jsonPath, JSON.stringify({ ...baseScan, imageFileName: 'plain.jpg' }));

		const backend = new FolderBackend(plainDir);
		const scan = await backend.fetchScan({
			id: 'plain',
			jsonPath,
			imagePath: path.join(plainDir, 'plain.jpg'),
		});
		expect(scan.markdown).toBe('# Sample');
		expect(mockedTrigger).not.toHaveBeenCalled();

		fs.rmSync(plainDir, { recursive: true, force: true });
	});
});
