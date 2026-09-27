// The Google OAuth refresh token is persisted in Obsidian's OS secret storage
// (app.secretStorage), never in plaintext data.json. These tests exercise the main.ts
// wiring: write-on-token-change, restore-from-secret, disconnect clearing, the
// reconnect Notice when a token write cannot persist, and graceful degrade when the OS
// backend is unavailable. The plugin is unpublished, so there is NO legacy-plaintext
// migration to test. main.ts is excluded from coverage; these verify behavior.

import * as obsidian from 'obsidian';
import PaperSyncPlugin from '@/main';
import { OAuthManager } from '@/auth/oauth-manager';
import { SecretStorage } from 'obsidian';
import type { App } from 'obsidian';
import { OAUTH_TOKEN_SECRET_ID } from '@/config';
import { STRINGS } from '@/utils/strings';

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

function noSaveCarriedToken(plugin: TestPlugin): boolean {
	return plugin.saveData.mock.calls.every(
		(c) => !('oauthRefreshToken' in (c[0] as Record<string, unknown>))
	);
}

// Capture the token-change callback main.ts registers, so a test can fire it directly.
function captureTokenCallback(): () => ((token: string) => void) | undefined {
	let captured: ((token: string) => void) | undefined;
	jest.spyOn(OAuthManager.prototype, 'setOnTokenChange').mockImplementation((cb) => {
		captured = cb;
	});
	return () => captured;
}

afterEach(() => {
	jest.restoreAllMocks();
});

describe('refresh token in secret storage', () => {
	it('writes a new token to secret storage on token change, never to data.json', async () => {
		const getCallback = captureTokenCallback();
		const storage = new SecretStorage();
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		getCallback()!('fresh-refresh-token');

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

	it('discards a stray plaintext token from a legacy data.json without persisting it', async () => {
		const storage = new SecretStorage();
		const plugin = makePlugin(
			{ settingsVersion: 2, setupComplete: true, backendType: 'drive', oauthRefreshToken: 'stray-legacy-token' },
			storage
		);

		await plugin.loadSettings();
		await initAsync(plugin);

		// The stray plaintext is dropped, not migrated: nothing lands in secret storage,
		// nothing carries the field back to data.json, and Drive is simply not authenticated
		// (the dogfood device reconnects once).
		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBeNull();
		expect(noSaveCarriedToken(plugin)).toBe(true);
		expect(plugin.oauthManager?.isAuthenticated).toBe(false);
	});

	it('scrubs a stray plaintext token from an already-v3 data.json to disk, not just memory', async () => {
		const storage = new SecretStorage();
		const plugin = makePlugin(
			// Already at v3 (so migrateSettings runs no version-bump re-save) yet still
			// carrying a plaintext token — a tampered/corrupted file, or a prior failed
			// secret write.
			{ settingsVersion: 3, setupComplete: true, backendType: 'drive', oauthRefreshToken: 'stray-at-rest-token' },
			storage
		);

		await plugin.loadSettings();

		// The version did not change, but the stray plaintext forces a re-save so the
		// field is scrubbed from disk (data.json overwritten with this.settings), not
		// merely dropped from the in-memory settings.
		expect(plugin.saveData).toHaveBeenCalled();
		expect(noSaveCarriedToken(plugin)).toBe(true);
	});

	it('does not re-save on load for a clean current-version data.json (no stray token, no version bump)', async () => {
		const storage = new SecretStorage();
		const plugin = makePlugin({ settingsVersion: 4, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();

		// No version change and no stray plaintext to scrub, so load must not write.
		expect(plugin.saveData).not.toHaveBeenCalled();
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
		const getCallback = captureTokenCallback();
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);

		expect(() => getCallback()!('some-token')).not.toThrow();
	});

	it('shows a reconnect Notice when a non-empty token cannot persist', async () => {
		const getCallback = captureTokenCallback();
		const noticeSpy = jest.spyOn(obsidian, 'Notice').mockImplementation(() => undefined as never);
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		getCallback()!('cannot-persist-token');

		expect(noticeSpy).toHaveBeenCalledWith(STRINGS.NOTICE_SECRET_STORAGE_UNAVAILABLE, 0);
	});

	it('does NOT Notice when clearing an empty token fails (log-only, nothing to act on)', async () => {
		const getCallback = captureTokenCallback();
		const noticeSpy = jest.spyOn(obsidian, 'Notice').mockImplementation(() => undefined as never);
		const storage = new SecretStorage();
		makeUnavailable(storage);
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		getCallback()!(''); // disconnect / clear

		expect(noticeSpy).not.toHaveBeenCalled();
	});

	it('clears the secret to empty on disconnect', async () => {
		const storage = new SecretStorage();
		storage.setSecret(OAUTH_TOKEN_SECRET_ID, 'stored-refresh-token');
		const plugin = makePlugin({ settingsVersion: 3, setupComplete: true, backendType: 'drive' }, storage);

		await plugin.loadSettings();
		await initAsync(plugin);
		await plugin.oauthManager?.disconnect();

		expect(storage.getSecret(OAUTH_TOKEN_SECRET_ID)).toBe('');
	});
});
