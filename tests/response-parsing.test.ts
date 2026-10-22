// Google responses are parsed defensively: a missing name, a non-JSON body or
// an odd token payload never surfaces as a raw TypeError or SyntaxError.
import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';

import { DriveBackend } from '@/sync/drive-backend';
import { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;
const oauth = { getValidAccessToken: jest.fn().mockResolvedValue('t') } as unknown as OAuthManager;
const notJson = (status = 200) => ({ status, get json(): unknown { throw new SyntaxError('Unexpected token <'); } });

describe('Drive list parsing', () => {
	beforeEach(() => mockedRequestUrl.mockReset());
	afterEach(() => jest.useRealTimers());

	it('skips entries without a string id or name and ignores an odd page token', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [null, { name: 'x' }, { id: 'folder' }] } } as never)
			.mockResolvedValueOnce({ json: { files: [{ id: 'j', name: 'a.json' }, { id: 'k' }, { id: 7, name: 'b.json' }, null], nextPageToken: 5 } } as never);
		const refs = await new DriveBackend(oauth, 30).discoverUnsynced();
		expect(refs.map((r) => r.id)).toEqual(['a']);
		expect(mockedRequestUrl).toHaveBeenCalledTimes(2);
	});

	it('treats a non-array files field as empty', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: 'nope' } } as never);
		await expect(new DriveBackend(oauth, 30).discoverUnsynced()).resolves.toEqual([]);
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'folder' }] } } as never)
			.mockResolvedValueOnce({ json: null } as never);
		await expect(new DriveBackend(oauth, 30).discoverUnsynced()).resolves.toEqual([]);
	});

	it('turns a listing that is not JSON into a retriable network error', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'folder' }] } } as never)
			.mockResolvedValueOnce(notJson() as never);
		await expect(new DriveBackend(oauth, 30).discoverUnsynced()).rejects.toMatchObject({ type: 'network_timeout', retriable: true });
	});

	it('looks the Papersync folder up oldest first and again after ten minutes', async () => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-10-22T10:00:00Z'));
		const backend = new DriveBackend(oauth, 30);
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'old' }] } } as never)
			.mockResolvedValueOnce({ json: { files: [] } } as never)
			.mockResolvedValueOnce({ json: { files: [] } } as never);
		await backend.discoverUnsynced();
		await backend.discoverUnsynced();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(3);
		expect(mockedRequestUrl.mock.calls[0]![0].url).toContain('orderBy=createdTime');

		jest.setSystemTime(new Date('2026-10-22T10:10:01Z'));
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { files: [{ id: 'new' }] } } as never)
			.mockResolvedValueOnce({ json: { files: [] } } as never);
		await backend.discoverUnsynced();
		expect(mockedRequestUrl).toHaveBeenCalledTimes(5);
		expect(mockedRequestUrl.mock.calls[4]![0].url).toContain(encodeURIComponent("'new' in parents"));
	});
});

describe('token refresh parsing', () => {
	beforeEach(() => mockedRequestUrl.mockReset());

	function manager(): OAuthManager {
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		mgr.restoreFromToken('refresh');
		return mgr;
	}

	it('keeps the refresh token when a 2xx body is not JSON', async () => {
		mockedRequestUrl.mockResolvedValueOnce(notJson() as never);
		const mgr = manager();
		await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
		expect(mgr.isAuthenticated).toBe(true);
	});

	it('keeps the refresh token when an error body is not JSON', async () => {
		mockedRequestUrl.mockResolvedValueOnce(notJson(502) as never);
		const mgr = manager();
		await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
		expect(mgr.isAuthenticated).toBe(true);
	});

	it('rejects a non-string access token and defaults an odd expires_in to an hour', async () => {
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: { access_token: 5 } } as never);
		const mgr = manager();
		await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });

		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: { access_token: 'a', expires_in: 'soon' } } as never);
		const before = Date.now();
		await expect(mgr.getValidAccessToken()).resolves.toBe('a');
		const expiresAt = (mgr as unknown as { expiresAt: number }).expiresAt;
		expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
	});
});
