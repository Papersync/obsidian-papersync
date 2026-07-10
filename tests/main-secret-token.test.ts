// The Google OAuth refresh token is persisted in Obsidian's OS secret storage
// (app.secretStorage), never in plaintext data.json. These tests exercise the main.ts
// wiring: write-on-token-change, restore-from-secret, the one-time legacy migration
// (write-first, strip-only-after-success), disconnect clearing, and graceful degrade
// when the OS backend is unavailable. main.ts is excluded from coverage; these verify
// behavior, not coverage.

import PaperSyncPlugin from '@/main';
import { OAuthManager } from '@/auth/oauth-manager';
import { SecretStorage } from 'obsidian';
import type { App } from 'obsidian';
import { OAUTH_TOKEN_SECRET_ID } from '@/config';

type TestPlugin = PaperSyncPlugin & {
	loadData: jest.Mock;
	saveData: jest.Mock;
};

function makePlugin(loaded: unknown, storage: SecretStorage): TestPlugin {
	const plugin = new PaperSyncPlugin({} as never, {} as never) as TestPlugin;
	plugin.loadData = jest.fn().mockResolvedValue(loaded);
	plugin.saveData = jest.fn().mockResolvedValue(undefined);
	(plugin as unknown as { app: App }).app = { secretStorage: storage } as unknown as App;
	// Isolate the secret-storage wiring from the heavy sync bootstrap.
	plugin.startSync = jest.fn(async () => { /* stubbed */ });
	return plugin;
}

async function initAsync(plugin: PaperSyncPlugin): Promise<void> {
	await (plugin as unknown as { initAsync(): Promise<void> }).initAsync();
}

function makeUnavailable(storage: SecretStorage): void {
	(storage as unknown as { unavailable: boolean }).unavailable = true;
}

function makeAvailable(storage: SecretStorage): void {
	(storage as unknown as { unavailable: boolean }).unavailable = false;
}

function lastSavePayload(plugin: TestPlugin): Record<string, unknown> {
	const calls = plugin.saveData.mock.calls;
	return calls[calls.length - 1]![0] as Record<string, unknown>;
}

function noSaveCarriedToken(plugin: TestPlugin): boolean {
	return plugin.saveData.mock.calls.every(
		(c) => !('oauthRefreshToken' in (c[0] as Record<string, unknown>))
	);
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe('refresh token in secret storage', () => {
	it('writes a new token to secret storage on token change, never to data.json', async () => {
		let captured: ((token: string) => void) | undefined;
		jest.spyOn(OAuthManager.prototype, 'setOnTokenChange').mockImplementation((cb) => {
			captured = cb;
		});
		const storage = new SecretStorage();
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		captured!('fresh-refresh-token');

		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBe('fresh-refresh-token');
		expect(noSaveCarriedToken(plugin)).toBe(true);
	});

	it('restores an existing secret on load and authenticates Drive', async () => {
		const storage = new SecretStorage();
		storage.setSecret(OAUTH_TOKEN_SECRET_ID, 'stored-refresh-token');
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);

		expect(plugin.oauthManager?.isAuthenticated).toBe(true);
	});

	it('does not authenticate when no secret is present', async () => {
		const storage = new SecretStorage();
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);

		expect(plugin.oauthManager?.isAuthenticated).toBe(false);
	});

	it('migrates a legacy plaintext token: secret written, data.json stripped, Drive restored', async () => {
		const storage = new SecretStorage();
		const plugin = makePlugin(
			{ settingsVersion: 2, setupComplete: true, backendType: 'drive', oauthRefreshToken: 'legacy-token' },
			storage
		);

		await plugin.loadSettings();
		await initAsync(plugin);

		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBe('legacy-token'); // migrated into secret storage
		expect(plugin.oauthManager?.isAuthenticated).toBe(true); // restored for the session
		expect('oauthRefreshToken' in lastSavePayload(plugin)).toBe(false); // stripped from data.json at rest
	});

	it('keeps the plaintext token when the secret write fails, for a next-load retry', async () => {
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin(
			{ settingsVersion: 2, setupComplete: true, backendType: 'drive', oauthRefreshToken: 'legacy-token' },
			storage
		);

		await plugin.loadSettings();
		await initAsync(plugin);

		// The failed write must NOT strip data.json — the token is retained for retry.
		expect(lastSavePayload(plugin).oauthRefreshToken).toBe('legacy-token');
		// In-memory restore still works this session (fallback to the legacy value).
		expect(plugin.oauthManager?.isAuthenticated).toBe(true);
		// Nothing was actually persisted to the (unavailable) backend.
		makeAvailable(storage);
		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBeNull();
	});

	it('loads without crashing when secret storage is unavailable', async () => {
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();

		await expect(initAsync(plugin)).resolves.toBeUndefined();
		expect(plugin.oauthManager?.isAuthenticated).toBe(false);
	});

	it('does not throw on token change when secret storage is unavailable', async () => {
		let captured: ((token: string) => void) | undefined;
		jest.spyOn(OAuthManager.prototype, 'setOnTokenChange').mockImplementation((cb) => {
			captured = cb;
		});
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);

		expect(() => captured!('some-token')).not.toThrow();
	});

	it('clears the secret to empty on disconnect', async () => {
		const storage = new SecretStorage();
		storage.setSecret(OAUTH_TOKEN_SECRET_ID, 'stored-refresh-token');
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		plugin.oauthManager?.disconnect();

		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBe('');
	});
});
