// A Drive scan JSON deleted after listing reads as removed (scan_missing), the
// same as the folder backend, so the engine skips it instead of retrying it as a
// download failure. Refs carry Drive's modifiedTime as their revision.
import { requestUrl } from 'obsidian';
import { DriveBackend } from '@/sync/drive-backend';
import type { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;
const oauth = { getValidAccessToken: jest.fn().mockResolvedValue('tok') } as unknown as OAuthManager;
const ref = { id: 'gone', jsonPath: 'json-gone', imagePath: '' };

describe('DriveBackend removed and changed files', () => {
	beforeEach(() => mockedRequestUrl.mockReset());

	it('reports a scan JSON deleted since listing as scan_missing', async () => {
		mockedRequestUrl.mockResolvedValueOnce({ status: 404, json: { error: { message: 'File not found: json-gone' } }, headers: {} } as never);
		await expect(new DriveBackend(oauth, 30).fetchScan(ref)).rejects.toMatchObject({ type: 'scan_missing' });
	});

	it('passes other HTTP errors through for the classifier', async () => {
		mockedRequestUrl.mockResolvedValueOnce({ status: 500, json: {}, headers: {} } as never);
		await expect(new DriveBackend(oauth, 30).fetchScan(ref)).rejects.toMatchObject({ name: 'HttpStatusError', status: 500 });
	});

	it('polls with nothing listening without failing', async () => {
		jest.useFakeTimers();
		try {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);
			const backend = new DriveBackend(oauth, 30);
			backend.start();
			await jest.advanceTimersByTimeAsync(0);
			backend.stop();
			expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
		} finally {
			jest.useRealTimers();
		}
	});

	it('lists modifiedTime and uses it as the ref revision', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'folder' }] } } as never)
			.mockResolvedValueOnce({
				json: { files: [
					{ id: 'j1', name: 'a.json', createdTime: '2026-11-01T10:00:00Z', modifiedTime: '2026-11-02T10:00:00Z' },
					{ id: 'j2', name: 'b.json', createdTime: '2026-11-01T11:00:00Z', modifiedTime: 7 },
				] },
			} as never);
		const refs = await new DriveBackend(oauth, 30).discoverUnsynced();
		expect(refs.map((r) => r.revision)).toEqual(['2026-11-02T10:00:00Z', undefined]);
		const listUrl = String((mockedRequestUrl.mock.calls[1]![0] as { url: string }).url);
		expect(decodeURIComponent(listUrl)).toContain('fields=files(id,name,createdTime,modifiedTime,size)');
	});
});
