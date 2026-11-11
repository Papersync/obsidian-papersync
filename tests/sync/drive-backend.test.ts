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
			// First call: find Papersync folder
			// Second call: list files
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
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

		it('does not pair a JSON with a prefix-only image name (exact extension match, #5)', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: 'abc.json', createdTime: '2026-04-12T14:30:00Z' },
							// 'abcd.jpg' shares the 'abc' prefix but is a DIFFERENT scan.
							{ id: 'img-x', name: 'abcd.jpg' },
						],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toHaveLength(1);
			expect(refs[0].imagePath).toBe('');
		});

		it('returns refs with empty imagePath when a companion image is missing', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
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

		it('finds a companion created before the cursor by name when its JSON landed after it', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: { files: [{ id: 'json-1', name: "o'brien.json", createdTime: '2026-04-12T14:30:05Z' }] },
				} as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'img-1', name: "o'brien.jpg" }] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-04-12T14:30:02Z');
			const refs = await backend.discoverUnsynced();

			expect(refs[0].imagePath).toBe('img-1');
			const lookup = decodeURIComponent(mockedRequestUrl.mock.calls[2][0].url);
			expect(lookup).toContain("'papersync-folder' in parents and trashed = false and (name = 'o\\'brien.jpg' or name = 'o\\'brien.jpeg' or name = 'o\\'brien.png')");
			expect(lookup).not.toContain('createdTime >');
		});

		it('looks companions up in batches of 30 scans and leaves still-missing ones empty', async () => {
			const jsons = Array.from({ length: 31 }, (_, i) => ({ id: `json-${i}`, name: `s${i}.json`, createdTime: '2026-04-12T14:30:05Z' }));
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: jsons } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'img-0', name: 's0.png' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-04-12T14:30:02Z');
			const refs = await backend.discoverUnsynced();

			expect(mockedRequestUrl).toHaveBeenCalledTimes(4);
			expect(decodeURIComponent(mockedRequestUrl.mock.calls[2][0].url)).toContain("name = 's29.png'");
			expect(decodeURIComponent(mockedRequestUrl.mock.calls[3][0].url)).toContain("name = 's30.jpg'");
			expect(refs.find((r) => r.id === 's0')?.imagePath).toBe('img-0');
			expect(refs.find((r) => r.id === 's30')?.imagePath).toBe('');
		});

		it('escapes backslashes in companion lookup names', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'json-1', name: 'a\\b.json', createdTime: '2026-04-12T14:30:05Z' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-04-12T14:30:02Z');
			await backend.discoverUnsynced();

			expect(decodeURIComponent(mockedRequestUrl.mock.calls[2][0].url)).toContain("name = 'a\\\\b.jpg'");
		});

		it('keeps discovering when the by-name companion lookup fails', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: 'a.json', createdTime: '2026-04-12T14:30:05Z' },
							{ id: 'json-2', name: 'b.json', createdTime: '2026-04-12T14:30:06Z' },
							{ id: 'img-2', name: 'b.jpg', createdTime: '2026-04-12T14:30:06Z' },
						],
					},
				} as never)
				.mockResolvedValueOnce({ status: 400, json: { error: { message: 'Invalid Value' } }, text: '' } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-04-12T14:30:02Z');
			const refs = await backend.discoverUnsynced();

			expect(refs.map((r) => [r.id, r.imagePath])).toEqual([
				['a', ''],
				['b', 'img-2'],
			]);
		});

		it('skips the companion lookup when every scan is already paired under a cursor', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: 'a.json', createdTime: '2026-04-12T14:30:05Z' },
							{ id: 'img-1', name: 'a.jpg', createdTime: '2026-04-12T14:30:04Z' },
						],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-04-12T14:30:02Z');
			const refs = await backend.discoverUnsynced();

			expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
			expect(refs[0].imagePath).toBe('img-1');
		});

		it('returns empty when Papersync folder is missing', async () => {
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
				.mockResolvedValueOnce({ json: {} } as never); // list call: no `files` key

			const backend = new DriveBackend(makeOAuthManager(), 30);
			const refs = await backend.discoverUnsynced();
			expect(refs).toEqual([]);
		});

		it('applies an explicit constructor lastSyncTimestamp to the query (?? provided side)', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, '2026-02-02T00:00:00Z');
			await backend.discoverUnsynced();

			const listCall = mockedRequestUrl.mock.calls[1][0];
			expect(decodeURIComponent(listCall.url)).toContain("createdTime > '2026-02-02T00:00:00Z'");
		});

		it('paginates through Drive listings when nextPageToken is present', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-1', name: 'a.json' },
							{ id: 'img-1', name: 'a.jpg' },
						],
						nextPageToken: 'page-2',
					},
				} as never)
				.mockResolvedValueOnce({
					json: {
						files: [
							{ id: 'json-2', name: 'b.json' },
							{ id: 'img-2', name: 'b.jpg' },
						],
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

		it('throws scan_newer_version for a scan from a newer app', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ json: { version: 99, markdown: 'x' } } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);

			await expect(
				backend.fetchScan({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' })
			).rejects.toMatchObject({ type: 'scan_newer_version', retriable: false });
		});
	});

	describe('fetchImage', () => {
		it('returns the raw arrayBuffer for the image', async () => {
			const buf = new ArrayBuffer(42);
			mockedRequestUrl.mockResolvedValueOnce({ arrayBuffer: buf } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);

			const out = await backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'img-1' });
			expect(out!.byteLength).toBe(42);
		});

		it('returns null when imagePath is empty', async () => {
			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(
				backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: '' })
			).resolves.toBeNull();
		});
	});

	describe('markSynced', () => {
		it('re-fetches the RAW JSON and PATCHes synced:true, preserving unmodeled fields + types (#4)', async () => {
			// version is a NUMBER and there is an extra unmodeled field: a zod-parse round
			// trip would coerce version to a string and drop `note`. The raw re-fetch must not.
			const rawJson = { ...validScanJson, version: 1, note: 'user-added', synced: false };
			mockedRequestUrl
				.mockResolvedValueOnce({ json: rawJson } as never) // GET ?alt=media (raw)
				.mockResolvedValueOnce({ json: {} } as never);      // PATCH

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

			expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
			expect(mockedRequestUrl.mock.calls[0][0].url).toContain('alt=media');
			const patchCall = mockedRequestUrl.mock.calls[1][0];
			expect(patchCall.method).toBe('PATCH');
			const body = JSON.parse(patchCall.body as string);
			expect(body.synced).toBe(true);
			expect(body.markdown).toBe('# Sample');
			expect(body.version).toBe(1); // number preserved (no String() coercion)
			expect(body.note).toBe('user-added'); // unmodeled field preserved
		});

		it('tolerates a null raw body on re-fetch (?? {} guard)', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: null } as never) // GET raw returns null
				.mockResolvedValueOnce({ json: {} } as never);  // PATCH

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

			const body = JSON.parse(mockedRequestUrl.mock.calls[1][0].body as string);
			expect(body).toEqual({ synced: true });
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
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			backend.updateLastSyncTimestamp('2026-01-01T00:00:00Z');
			await backend.discoverUnsynced();

			const listCall = mockedRequestUrl.mock.calls[1][0];
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
			(backend as unknown as { running: boolean }).running = true;

			// Drive's poll() is private but exposed via start(). Invoke it directly
			// via reflection so we don't have to manage setInterval timers.
			await (backend as unknown as { poll: () => Promise<void> }).poll();

			expect(onDiscovered).toHaveBeenCalledTimes(1);
			const refs = onDiscovered.mock.calls[0][0];
			expect(refs).toHaveLength(1);
			expect(refs[0].id).toBe('a');
			expect(refs[0].imagePath).toBe('img-1');
		});

		it('does not hand over scans from a poll that finished after stop()', async () => {
			jest.useFakeTimers();
			let finish!: (token: string) => void;
			const oauth = { getValidAccessToken: jest.fn().mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; })).mockResolvedValue('t') };
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'json-1', name: 'a.json' }] } } as never);
			const backend = new DriveBackend(oauth as unknown as OAuthManager, 30);
			const onDiscovered = jest.fn();
			backend.setOnScanDiscovered(onDiscovered);
			backend.start();
			backend.stop();
			finish('t');
			await jest.advanceTimersByTimeAsync(0);
			expect(onDiscovered).not.toHaveBeenCalled();
		});

		it('logs a failed import instead of leaving its promise unhandled', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [{ id: 'json-1', name: 'a.json' }] } } as never);
			const backend = new DriveBackend(makeOAuthManager(), 30);
			backend.setOnScanDiscovered(jest.fn().mockRejectedValue(new Error('import blew up')));
			(backend as unknown as { running: boolean }).running = true;
			await expect((backend as unknown as { poll: () => Promise<void> }).poll()).resolves.toBeUndefined();
		});

		it('does not invoke onScanDiscovered when no unsynced refs are found', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
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
				.mockResolvedValueOnce({
					json: {
						files: [{ id: 'json-1', name: 'a.json', createdTime: '2026-04-12T14:30:00Z' }],
					},
				} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			(backend as unknown as { running: boolean }).running = true;
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
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await backend.discoverUnsynced();
			expect(mockedRequestUrl).toHaveBeenCalledTimes(2);

			// Second discover: cached folder id → ONLY the list call
			mockedRequestUrl.mockResolvedValueOnce({ json: { files: [] } } as never);
			await backend.discoverUnsynced();
			expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
		});

		it('defaults lastSyncTimestamp to empty string when constructor arg is undefined', async () => {
			mockedRequestUrl
				.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
				.mockResolvedValueOnce({ json: { files: [] } } as never);

			const backend = new DriveBackend(makeOAuthManager(), 30, undefined);
			await backend.discoverUnsynced();

			// The list-query `q` param should NOT include a `createdTime >` filter
			// when the timestamp defaulted to empty. (The URL still references
			// createdTime in `fields=` and `orderBy=` — that's structural.)
			const listCall = mockedRequestUrl.mock.calls[1][0];
			expect(listCall.url).not.toContain('createdTime%20%3E');
		});
	});

	describe('driveRequest error capture', () => {
		it("surfaces Google's error.message on a 4xx so the real reason is preserved", async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 403,
				json: {
					error: {
						message:
							'Google Drive API has not been used in project 401509475922 before or it is disabled.',
					},
				},
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

		it('carries the status, Drive reason and Retry-After for the classifier', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 403,
				headers: { 'Retry-After': '9' },
				json: { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } },
			} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toMatchObject({
				status: 403,
				reason: 'userRateLimitExceeded',
				retryAfter: '9',
			});
		});

		it('ignores a non-string error message and reason', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 400,
				json: { error: { message: 7, errors: [{ reason: 1 }] } },
			} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toMatchObject({
				message: 'Drive request failed (400): status 400',
				reason: undefined,
				retryAfter: undefined,
			});
		});

		it('turns a request that got no response into a retriable network error', async () => {
			mockedRequestUrl.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'));

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.discoverUnsynced()).rejects.toMatchObject({ type: 'network_timeout', retriable: true });
		});

		it('reports a scan body that is not JSON as a schema mismatch', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				status: 200,
				get json() { throw new SyntaxError('Unexpected end of JSON input'); },
			} as never);

			const backend = new DriveBackend(makeOAuthManager(), 30);
			await expect(backend.fetchScan({ id: 's', jsonPath: 'j', imagePath: '' })).rejects.toMatchObject({
				type: 'schema_mismatch',
				retriable: false,
			});
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

it('waits 5 minutes from createdTime for a missing companion photo', () => {
	expect(new DriveBackend({} as unknown as OAuthManager, 30).companionGraceMs).toBe(300_000);
});

describe('Drive companion absence classification', () => {
	it('returns null for a missing companion but preserves permission failures', async () => {
		mockedRequestUrl.mockReset();
		const backend = new DriveBackend(makeOAuthManager(), 30);
		const ref = { id: 'scan', jsonPath: 'json', imagePath: 'photo' };
		mockedRequestUrl.mockResolvedValueOnce({ status: 404, json: {} } as never);
		await expect(backend.fetchImage(ref)).resolves.toBeNull();
		mockedRequestUrl.mockResolvedValueOnce({ status: 403, json: {} } as never);
		await expect(backend.fetchImage(ref)).rejects.toThrow('403');
		mockedRequestUrl.mockResolvedValueOnce({ status: 404, json: {} } as never);
		await expect(backend.fetchScan(ref)).rejects.toMatchObject({ type: 'scan_missing' });
	});
});

describe('Drive poll Retry-After', () => {
	afterEach(() => { jest.useRealTimers(); });

	it('skips polls until a Retry-After from a failed poll has passed', async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-10-22T10:00:00Z'));
		mockedRequestUrl.mockReset();
		const backend = new DriveBackend(makeOAuthManager(), 30);
		const poll = (): Promise<void> => (backend as unknown as { poll: () => Promise<void> }).poll();
		mockedRequestUrl.mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '120' }, json: {} } as never);
		await poll();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);

		jest.setSystemTime(new Date('2026-10-22T10:01:00Z'));
		await poll();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(1);

		jest.setSystemTime(new Date('2026-10-22T10:02:01Z'));
		mockedRequestUrl.mockResolvedValueOnce({ json: { files: [] } } as never);
		await poll();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
	});

	it('keeps polling after a failure without Retry-After', async () => {
		mockedRequestUrl.mockReset();
		const backend = new DriveBackend(makeOAuthManager(), 30);
		const poll = (): Promise<void> => (backend as unknown as { poll: () => Promise<void> }).poll();
		mockedRequestUrl.mockResolvedValueOnce({ status: 500, json: {} } as never);
		await poll();
		mockedRequestUrl.mockRejectedValueOnce(new Error('offline'));
		await poll();
		mockedRequestUrl.mockResolvedValueOnce({ json: { files: [] } } as never);
		await poll();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
	});
});
