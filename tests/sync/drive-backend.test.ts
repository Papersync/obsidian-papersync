import { requestUrl } from 'obsidian';

import { DriveBackend } from '@/sync/drive-backend';
import type { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function makeOAuthManager(token = 'test-token'): OAuthManager {
	return {
		getValidAccessToken: jest.fn().mockResolvedValue(token),
	} as unknown as OAuthManager;
}

const validScanJson = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Sample',
	confidence: 91,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName: '2026-04-12-143000.jpg',
};

describe('DriveBackend', () => {
	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	describe('discoverUnsynced', () => {
		it('returns refs paired with image files (jpg/jpeg/png all accepted)', async () => {
			// First call: find PaperSync folder root
			// Second call: find scans subfolder
			// Third call: list files
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: '2026-04-12-143000.json', createdTime: '2026-04-12T14:30:00Z' },
							{ id: 'img-1', name: '2026-04-12-143000.jpg' },
							{ id: 'json-2', name: '2026-04-13-143000.json', createdTime: '2026-04-13T14:30:00Z' },
							{ id: 'img-2', name: '2026-04-13-143000.png' },
							{ id: 'json-3', name: '2026-04-14-143000.json', createdTime: '2026-04-14T14:30:00Z' },
							{ id: 'img-3', name: '2026-04-14-143000.jpeg' },
						],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();

			expect(refs).toHaveLength(3);
			expect(refs.map((r) => r.imagePath).sort()).toEqual(['img-1', 'img-2', 'img-3']);
		});

		it('returns refs with empty imagePath when a companion image is missing', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: '2026-04-12-143000.json', createdTime: '2026-04-12T14:30:00Z' },
							// no companion image
						],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toHaveLength(1);
			expect(refs[0].imagePath).toBe('');
		});

		it('returns empty when PaperSync folder is missing', async () => {
			// First findScansFolder call returns no folder
			mockedRequestUrl.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toEqual([]);
		});

		it('returns empty when a folder-search response omits the files array (files ?? [])', async () => {
			// findScansFolder's first hop returns `{}` with no `files` key.
			mockedRequestUrl.mockResolvedValueOnce({ json: {} } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toEqual([]);
		});

		it('treats a file-listing response with no files array as empty (files ?? [])', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: {} } as never); // list call: no `files` key

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toEqual([]);
		});

		it('applies an explicit constructor lastSyncTimestamp to the query (?? provided side)', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-02-02T00:00:00Z');
			await backend.discoverUnsynced();

			const listCall = mockedRequestUrl.mock.calls[2][0];
			expect(decodeURIComponent(listCall.url)).toContain("createdTime > '2026-02-02T00:00:00Z'");
		});

		it('paginates through Drive listings when nextPageToken is present', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [{ id: 'json-1', name: 'a.json' }, { id: 'img-1', name: 'a.jpg' }],
						nextPageToken: 'page-2',
					},
				} as never)
				.mockResolvedValueOnce({
					json: {
						files: [{ id: 'json-2', name: 'b.json' }, { id: 'img-2', name: 'b.jpg' }],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toHaveLength(2);
		});
	});

	describe('fetchScan', () => {
		it('returns a validated ScanFile for a well-formed payload', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ json: validScanJson } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);

			const scan = await backend.fetchScan({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });
			expect(scan.markdown).toBe('# Sample');
		});

		it('throws schema_mismatch for invalid payloads', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ json: { version: 'BAD' } } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);

			await expect(
				backend.fetchScan({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' })
			).rejects.toMatchObject({ type: 'schema_mismatch' });
		});
	});

	describe('fetchImage', () => {
		it('returns the raw arrayBuffer for the image', async () => {
			const buf = new ArrayBuffer(42);
			mockedRequestUrl.mockResolvedValueOnce({ arrayBuffer: buf } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);

			const out = await backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'img-1' });
			expect(out.byteLength).toBe(42);
		});

		it('throws vault_write_failed when imagePath is empty', async () => {
			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(
				backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: '' })
			).rejects.toMatchObject({ type: 'vault_write_failed' });
		});
	});

	describe('markSynced', () => {
		it('PATCHes the JSON with synced:true and preserves other fields', async () => {
			// markSynced calls fetchScan if scanData not provided → 1 GET + 1 PATCH
			mockedRequestUrl
				.mockResolvedValueOnce({ json: validScanJson } as never)
				.mockResolvedValueOnce({ json: {} } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

			const patchCall = mockedRequestUrl.mock.calls[1][0];
			expect(patchCall.method).toBe('PATCH');
			const body = JSON.parse(patchCall.body as string);
			expect(body.synced).toBe(true);
			expect(body.markdown).toBe('# Sample');
		});

		it('uses provided scanData to skip the extra fetch', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ json: {} } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.markSynced(
				{ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' },
				{ ...validScanJson, synced: false }
			);

			expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
			const body = JSON.parse(mockedRequestUrl.mock.calls[0][0].body as string);
			expect(body.synced).toBe(true);
		});
	});

	describe('lifecycle', () => {
		it('start() and stop() do not throw and are idempotent', () => {
			const backend = new DriveBackend(makeOAuthManager(), 30);
			expect(() => backend.start()).not.toThrow();
			expect(() => backend.stop()).not.toThrow();
			expect(() => backend.stop()).not.toThrow();
		});

		it('updateLastSyncTimestamp influences subsequent query', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			backend.updateLastSyncTimestamp('2026-01-01T00:00:00Z');
			await backend.discoverUnsynced();

			const listCall = mockedRequestUrl.mock.calls[2][0];
			expect(listCall.url).toContain('createdTime');
		});

		it('setOnScanDiscovered sets the callback without throwing', () => {
			const backend = new DriveBackend(makeOAuthManager(), 30);
			expect(() => backend.setOnScanDiscovered(jest.fn())).not.toThrow();
		});
	});

	describe('poll callback wiring', () => {
		afterEach(() => {
			jest.useRealTimers();
		});

		it('invokes onScanDiscovered with the discovered refs on poll success', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: 'a.json', createdTime: '2026-04-12T14:30:00Z' },
							{ id: 'img-1', name: 'a.jpg' },
						],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const onDiscovered = jest.fn();
			backend.setOnScanDiscovered(onDiscovered);

			// Drive's poll() is private but exposed via start(). Invoke it directly
			// via reflection so we don't have to manage setInterval timers.
			await (backend as unknown as { poll: () => Promise<void> }).poll();

			expect(onDiscovered).toHaveBeenCalledTimes(1);
			const refs = onDiscovered.mock.calls[0][0];
			expect(refs).toHaveLength(1);
			expect(refs[0].id).toBe('a');
			expect(refs[0].imagePath).toBe('img-1');
		});

		it('does not invoke onScanDiscovered when no unsynced refs are found', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const onDiscovered = jest.fn();
			backend.setOnScanDiscovered(onDiscovered);

			await (backend as unknown as { poll: () => Promise<void> }).poll();
			expect(onDiscovered).not.toHaveBeenCalled();
		});

		it('swallows discoverUnsynced errors in poll() so the interval keeps running', async () => {
			mockedRequestUrl.mockRejectedValueOnce(new Error('network is down'));

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const onDiscovered = jest.fn();
			backend.setOnScanDiscovered(onDiscovered);

			await expect(
				(backend as unknown as { poll: () => Promise<void> }).poll()
			).resolves.toBeUndefined();
			expect(onDiscovered).not.toHaveBeenCalled();
		});

		it('swallows non-Error rejections in poll() (formats via String())', async () => {
			mockedRequestUrl.mockRejectedValueOnce('string error, not an Error');

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(
				(backend as unknown as { poll: () => Promise<void> }).poll()
			).resolves.toBeUndefined();
		});

		it('does not throw when poll() finds refs but no callback is registered', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [{ id: 'json-1', name: 'a.json', createdTime: '2026-04-12T14:30:00Z' }],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			// No setOnScanDiscovered call — the `?.` optional chain must short-circuit safely.
			await expect(
				(backend as unknown as { poll: () => Promise<void> }).poll()
			).resolves.toBeUndefined();
		});
	});

	describe('findScansFolder caching', () => {
		it('caches the folder id across discoverUnsynced calls (no re-search)', async () => {
			// First discover: 2 folder searches + 1 list
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.discoverUnsynced();
			expect(mockedRequestUrl).toHaveBeenCalledTimes(3);

			// Second discover: cached folder id → ONLY the list call
			mockedRequestUrl.mockResolvedValueOnce({ json: { files: [] } } as never);
			await backend.discoverUnsynced();
			expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
		});

		it('defaults lastSyncTimestamp to empty string when constructor arg is undefined', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, undefined);
			await backend.discoverUnsynced();

			// The list-query `q` param should NOT include a `createdTime >` filter
			// when the timestamp defaulted to empty. (The URL still references
			// createdTime in `fields=` and `orderBy=` — that's structural.)
			const listCall = mockedRequestUrl.mock.calls[2][0];
			expect(listCall.url).not.toContain('createdTime%20%3E');
		});
	});

	describe('driveRequest error capture', () => {
		it("surfaces Google's error.message on a 4xx so the real reason is preserved", async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 403,
				json: { error: { message: 'Google Drive API has not been used in project 401509475922 before or it is disabled.' } },
			} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toThrow(
				/Drive request failed \(403\).*Google Drive API has not been used/
			);
		});

		it('falls back to a status-only detail when the error body has no message', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toThrow(
				/Drive request failed \(500\): status 500/
			);
		});

		it('falls back to a status-only detail when the error body is null', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 404, json: null } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toThrow(
				/Drive request failed \(404\): status 404/
			);
		});

		it('keeps the status detail when the error body is not JSON', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 502,
				get json() { throw new Error('not json'); },
			} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toThrow(/Drive request failed \(502\)/);
		});
	});
});
