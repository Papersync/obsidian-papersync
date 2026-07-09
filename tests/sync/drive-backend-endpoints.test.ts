// Endpoint-override seam: DriveBackend resolves its API/upload bases through the
// SAME call-time supplier form OAuthManager uses (main.ts hands one supplier to
// both), so the token and Drive legs of a sync can never split-brain across two
// snapshots of the seam. With no supplier every request URL must be byte-identical
// to today's hardcoded Google bases; a loopback override wins, independently per
// key; non-loopback overrides are ignored (resolver matrix:
// tests/google-endpoints.test.ts).

import { requestUrl } from 'obsidian';

import { DriveBackend } from '@/sync/drive-backend';
import { DEFAULT_GOOGLE_ENDPOINTS } from '@/config';
import type { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function makeOAuthManager(token = 'test-token'): OAuthManager {
	return {
		getValidAccessToken: jest.fn().mockResolvedValue(token),
	} as unknown as OAuthManager;
}

function mockFolderChainAndEmptyList(): void {
	mockedRequestUrl
		.mockResolvedValueOnce({ json: { files: [{ id: 'papersync-folder' }] } } as never)
		.mockResolvedValueOnce({ json: { files: [{ id: 'scans-folder' }] } } as never)
		.mockResolvedValueOnce({ json: { files: [] } } as never);
}

describe('DriveBackend endpoint resolution', () => {
	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	it('builds every discovery URL on the production Drive base when no supplier is given', async () => {
		mockFolderChainAndEmptyList();

		const backend = new DriveBackend(makeOAuthManager(), 30);
		await backend.discoverUnsynced();

		for (const call of mockedRequestUrl.mock.calls) {
			expect(call[0].url.startsWith('https://www.googleapis.com/drive/v3/files')).toBe(true);
		}
	});

	it('defaults both bases when the supplier yields an empty overrides object', async () => {
		mockFolderChainAndEmptyList();

		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => ({}));
		await backend.discoverUnsynced();

		expect(mockedRequestUrl.mock.calls[0]![0].url.startsWith(DEFAULT_GOOGLE_ENDPOINTS.driveApiBase)).toBe(true);
	});

	it('uses the override API base for discovery, fetch, and the markSynced re-fetch', async () => {
		const endpoints = { driveApiBase: 'http://127.0.0.1:9/drive/v3', driveUploadBase: 'http://127.0.0.1:9/upload/drive/v3' };
		mockFolderChainAndEmptyList();

		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => endpoints);
		await backend.discoverUnsynced();
		for (const call of mockedRequestUrl.mock.calls) {
			expect(call[0].url.startsWith('http://127.0.0.1:9/drive/v3/files')).toBe(true);
		}

		mockedRequestUrl.mockResolvedValueOnce({ arrayBuffer: new ArrayBuffer(1) } as never);
		await backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'img-1' });
		expect(mockedRequestUrl.mock.calls[3]![0].url).toBe('http://127.0.0.1:9/drive/v3/files/img-1?alt=media');
	});

	it('PATCHes markSynced to the override upload base', async () => {
		const endpoints = { driveApiBase: 'http://127.0.0.1:9/drive/v3', driveUploadBase: 'http://127.0.0.1:9/upload/drive/v3' };
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { synced: false } } as never) // GET ?alt=media (raw)
			.mockResolvedValueOnce({ json: {} } as never);               // PATCH

		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => endpoints);
		await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe('http://127.0.0.1:9/drive/v3/files/json-1?alt=media');
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe('http://127.0.0.1:9/upload/drive/v3/files/json-1?uploadType=media');
	});

	it('resolves each base independently for a partial override (API overridden, upload default)', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { synced: false } } as never) // GET raw
			.mockResolvedValueOnce({ json: {} } as never);               // PATCH

		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => ({ driveApiBase: 'http://127.0.0.1:9/drive/v3' }));
		await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe('http://127.0.0.1:9/drive/v3/files/json-1?alt=media');
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe('https://www.googleapis.com/upload/drive/v3/files/json-1?uploadType=media');
	});

	it('ignores non-loopback override bases and stays on production (credential-redirect hardening)', async () => {
		mockedRequestUrl
			.mockResolvedValueOnce({ json: { synced: false } } as never) // GET raw
			.mockResolvedValueOnce({ json: {} } as never);               // PATCH

		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => ({
			driveApiBase: 'https://attacker.example.com/drive/v3',
			driveUploadBase: 'https://attacker.example.com/upload/drive/v3',
		}));
		await backend.markSynced({ id: 'a', jsonPath: 'json-1', imagePath: 'img-1' });

		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe('https://www.googleapis.com/drive/v3/files/json-1?alt=media');
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe('https://www.googleapis.com/upload/drive/v3/files/json-1?uploadType=media');
	});

	it('resolves the supplier at CALL time — a late-written override takes effect mid-lifetime', async () => {
		let overrides: { driveApiBase?: string } | undefined;
		const backend = new DriveBackend(makeOAuthManager(), 30, undefined, () => overrides);

		mockedRequestUrl.mockResolvedValueOnce({ arrayBuffer: new ArrayBuffer(1) } as never);
		await backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'img-1' });
		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe(`${DEFAULT_GOOGLE_ENDPOINTS.driveApiBase}/files/img-1?alt=media`);

		overrides = { driveApiBase: 'http://127.0.0.1:9/drive/v3' };
		mockedRequestUrl.mockResolvedValueOnce({ arrayBuffer: new ArrayBuffer(1) } as never);
		await backend.fetchImage({ id: 'a', jsonPath: 'j', imagePath: 'img-1' });
		expect(mockedRequestUrl.mock.calls[1]![0].url).toBe('http://127.0.0.1:9/drive/v3/files/img-1?alt=media');
	});
});
