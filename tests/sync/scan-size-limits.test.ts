// Oversized scan files are refused before they are read or downloaded.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { requestUrl } from 'obsidian';

import { FolderBackend } from '@/sync/folder-backend';
import { DriveBackend } from '@/sync/drive-backend';
import type { OAuthManager } from '@/auth/oauth-manager';
import { MAX_SCAN_IMAGE_BYTES, MAX_SCAN_JSON_BYTES } from '@/config';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;
const oauth = { getValidAccessToken: jest.fn().mockResolvedValue('t') } as unknown as OAuthManager;
const scan = { version: '1', createdAt: '2026-04-12T14:30:00.000Z', markdown: '# S', confidence: 90, provider: 'p', model: 'm', imageFileName: 'a.jpg' };

describe('FolderBackend size limits', () => {
	let dir: string;
	const realStat = fs.promises.stat;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-'));
	});
	afterEach(() => {
		jest.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// Report a fake size for one file; everything else stats normally.
	function fakeSize(file: string, size: number): void {
		jest.spyOn(fs.promises, 'stat').mockImplementation(async (p: fs.PathLike) => {
			const stat = await realStat(p);
			return String(p) === file ? Object.assign(stat, { size }) : stat;
		});
	}

	it('discovers an oversized JSON without reading it, then refuses to fetch it', async () => {
		const jsonPath = path.join(dir, 'big.json');
		fs.writeFileSync(jsonPath, JSON.stringify(scan));
		fakeSize(jsonPath, MAX_SCAN_JSON_BYTES + 1);
		const read = jest.spyOn(fs.promises, 'readFile');
		const backend = new FolderBackend(dir);

		const refs = await backend.discoverUnsynced();
		expect(refs.map((r) => r.id)).toEqual(['big']);
		expect(read).not.toHaveBeenCalled();

		await expect(backend.fetchScan(refs[0]!)).rejects.toMatchObject({ type: 'scan_too_large', retriable: false });
		await expect(backend.markSynced(refs[0]!)).rejects.toMatchObject({ type: 'scan_too_large' });
		expect(read).not.toHaveBeenCalled();
	});

	it('refuses an oversized photo', async () => {
		const imagePath = path.join(dir, 'a.jpg');
		fs.writeFileSync(imagePath, 'jpg');
		fakeSize(imagePath, MAX_SCAN_IMAGE_BYTES + 1);
		const backend = new FolderBackend(dir);
		await expect(backend.fetchImage({ id: 'a', jsonPath: '', imagePath })).rejects.toMatchObject({
			type: 'scan_too_large',
			message: expect.stringContaining('a.jpg is 50.0 MB, over the 50.0 MB limit'),
		});
	});

	it('reads files at the limit', async () => {
		const imagePath = path.join(dir, 'a.jpg');
		fs.writeFileSync(imagePath, 'jpg');
		fakeSize(imagePath, MAX_SCAN_IMAGE_BYTES);
		const backend = new FolderBackend(dir);
		await expect(backend.fetchImage({ id: 'a', jsonPath: '', imagePath })).resolves.toHaveProperty('byteLength', 3);
	});
});

describe('DriveBackend size limits', () => {
	beforeEach(() => { mockedRequestUrl.mockReset(); });

	it('lists file sizes and ignores a missing or malformed one', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'folder' }] } } as never)
			.mockResolvedValueOnce({ json: { files: [
				{ id: 'j1', name: 'a.json', size: '120' },
				{ id: 'i1', name: 'a.jpg', size: '5000' },
				{ id: 'j2', name: 'b.json', size: 'lots' },
				{ id: 'j3', name: 'c.json' },
			] } } as never);
		const refs = await new DriveBackend(oauth, 30).discoverUnsynced();
		expect(refs.map((r) => [r.id, r.jsonBytes, r.imageBytes])).toEqual([
			['a', 120, 5000],
			['b', undefined, undefined],
			['c', undefined, undefined],
		]);
		expect(mockedRequestUrl.mock.calls[1]![0].url).toContain('size');
	});

	it('refuses an oversized JSON or photo before downloading it', async () => {
		const backend = new DriveBackend(oauth, 30);
		const ref = { id: 'a', jsonPath: 'j', imagePath: 'i', jsonBytes: MAX_SCAN_JSON_BYTES + 1, imageBytes: MAX_SCAN_IMAGE_BYTES + 1 };
		await expect(backend.fetchScan(ref)).rejects.toMatchObject({ type: 'scan_too_large' });
		await expect(backend.markSynced(ref)).rejects.toMatchObject({ type: 'scan_too_large' });
		await expect(backend.fetchImage(ref)).rejects.toMatchObject({ type: 'scan_too_large' });
		expect(mockedRequestUrl).not.toHaveBeenCalled();
	});

	it('refuses a download that turns out to be oversized when no size was listed', async () => {
		const backend = new DriveBackend(oauth, 30);
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: scan, arrayBuffer: new ArrayBuffer(MAX_SCAN_JSON_BYTES + 1) } as never);
		await expect(backend.fetchScan({ id: 'a', jsonPath: 'j', imagePath: '' })).rejects.toMatchObject({ type: 'scan_too_large' });
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, arrayBuffer: new ArrayBuffer(MAX_SCAN_IMAGE_BYTES + 1) } as never);
		await expect(backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'i' })).rejects.toMatchObject({ type: 'scan_too_large' });
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: scan, arrayBuffer: new ArrayBuffer(10) } as never);
		await expect(backend.fetchScan({ id: 'a', jsonPath: 'j', imagePath: '' })).resolves.toMatchObject({ markdown: '# S' });
	});
});
