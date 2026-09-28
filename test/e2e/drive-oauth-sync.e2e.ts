import { createHash, randomBytes } from 'crypto';
import { FakeGoogle } from './fake-google';
import { MINIMAL_JPEG, waitForPlugin, triggerSyncNow, readNotes, isoStamp, switchToMainWindow, focusSettingsUI, closeSettings, clickButtonWhenPresent } from './helpers';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OAUTH_TOKEN_SECRET_ID } from '../../src/config';

// Drives the REAL Google Drive lane (PKCE OAuth + Drive v3 sync client) end-to-end
// against the in-repo fake-Google server (test/e2e/fake-google.ts), reached through
// the plugin's undocumented settings.endpointOverrides seam. Zero network egress to
// google.com: every request lands on 127.0.0.1.
//
// The Connect flow is driven through the real Settings-UI button. The only in-spec
// patch is window.open: the fake auth endpoint 302s straight back to the plugin's
// loopback callback, so a no-cors fetch of the auth URL (the request fires even
// though the response is CORS-opaque, and redirects are followed) stands in for
// the user's browser hop. The patch is scoped per test (restored in afterEach).
//
// loadSettings strips endpointOverrides on every plugin load (production vaults
// self-heal from a stale/tampered seam), so reloadPlugin re-injects the overrides
// after each reload — with setupComplete parked false across the reload so the
// auto-started poll can never race off toward real Google in between.
//
// Scenarios (spec I/O matrix): PKCE-mismatch guard, Connect happy path, sync round
// trip + markSynced PATCH, refresh grant after reload, transient-500 refresh (token
// kept), invalid_grant refresh (disconnect), and the mid-flow error surface.

interface PluginState {
	backendType: string;
	setupComplete: boolean;
	refreshToken: string;
	isAuthenticated: boolean;
}

describe('Drive OAuth + sync against fake Google', function () {
	const fake = new FakeGoogle();
	const TARGET_FOLDER = 'DriveTest';

	// Every helper below reads or mutates window.app, which only the main window
	// has — the 1.13+ settings window is an app-less about:blank document.
	async function state(): Promise<PluginState> {
		await switchToMainWindow();
		return browser.execute(() => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: { backendType: string; setupComplete: boolean };
				oauthManager: { isAuthenticated: boolean; refreshToken: string | null } | null;
			} | undefined;
			if (!plugin) { throw new Error('PaperSync plugin not loaded'); }
			return {
				backendType: plugin.settings.backendType,
				setupComplete: plugin.settings.setupComplete,
				// The refresh token now lives in Obsidian's secret storage, not settings/data.json.
				// The in-memory oauthManager.refreshToken is the ground truth for "a token is
				// present": after a reload it is non-empty only if restore succeeded from
				// secret storage. A stray plaintext token in data.json is discarded on load
				// (never restored to memory), so restore is secret-storage-only.
				refreshToken: plugin.oauthManager?.refreshToken ?? '',
				isAuthenticated: plugin.oauthManager?.isAuthenticated ?? false,
			};
		});
	}

	// Command resolved by suffix (same id-agnostic pattern as helpers.ts) so the
	// spec survives a manifest-id change.
	async function openSettings(): Promise<void> {
		await switchToMainWindow();
		await browser.execute(() => {
			const app = (window as unknown as { app: { commands: {
				commands: Record<string, unknown>;
				executeCommandById: (id: string) => void;
			} } }).app;
			const id = Object.keys(app.commands.commands).find((k) => k.endsWith(':open-settings'));
			if (!id) { throw new Error('open-settings command not found'); }
			app.commands.executeCommandById(id);
		});
		await browser.pause(800);
		// 1.13+ hosts the settings UI in its own window; leave the driver there.
		await focusSettingsUI();
	}

	// Patch window.open (in-spec only; afterEach restores it), then click the real
	// Connect button. The Connect handler is plugin code, which runs in the MAIN
	// window's JS realm even when the button's DOM sits in the 1.13+ settings
	// window — so the patch must land on the main window's global, and the click
	// on whichever window hosts the settings UI. Both awaits complete before the
	// handler can fire, so the patch is guaranteed in place for the click.
	async function clickConnectWithPatchedOpen(): Promise<void> {
		await switchToMainWindow();
		await browser.execute(() => {
			const w = window as unknown as { __psRealOpen?: typeof window.open };
			if (!w.__psRealOpen) { w.__psRealOpen = window.open; }
			window.open = ((url?: string | URL) => {
				// no-cors: the response is opaque but the request (and its 302 onto the
				// plugin's loopback callback) still fires. Swallow the rejection — an
				// aborted fetch would otherwise surface as an unhandled rejection in the
				// renderer.
				if (url) { fetch(String(url), { mode: 'no-cors' }).catch(() => undefined); }
				return null;
			}) as typeof window.open;
		});
		await focusSettingsUI();
		await clickButtonWhenPresent('Connect');
	}

	// Re-establish the "connected with a valid refresh token" precondition from
	// scratch, so every reload-based scenario (and any mocha retry of it) stands on
	// its own state instead of the previous test's leftovers — the invalid_grant
	// scenario clears the token, which used to make its own retry unrecoverable.
	async function seedConnectedState(): Promise<void> {
		const refreshToken = fake.issueRefreshToken();
		await switchToMainWindow();
		await browser.execute(async (token: string, secretId: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				app: { secretStorage: { setSecret: (id: string, value: string) => void } };
			} | undefined;
			if (!plugin) { throw new Error('PaperSync plugin not loaded'); }
			plugin.settings.backendType = 'drive';
			plugin.settings.setupComplete = true;
			// Seed the token into Obsidian's secret storage — the exact restore precondition
			// a reload reads from (the real restore path). There is no plaintext staging: the
			// token never lives in settings/data.json. The harness launches Obsidian with a
			// mock keychain, so no spec here touches the real OS key store.
			plugin.app.secretStorage.setSecret(secretId, token);
			await plugin.saveSettings();
		}, refreshToken, OAUTH_TOKEN_SECRET_ID);
	}

	// The token as Obsidian's secret storage holds it — distinct from the in-memory
	// oauthManager.refreshToken (which is set regardless of whether the secret-storage
	// write succeeded). getSecret answers from Obsidian's in-memory copy, so this shows
	// the plugin handed the token over, not that it reached disk.
	async function persistedSecret(): Promise<string | null> {
		await switchToMainWindow();
		return browser.execute((secretId: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				app: { secretStorage: { getSecret: (id: string) => string | null } };
			} | undefined;
			if (!plugin) { throw new Error('PaperSync plugin not loaded'); }
			return plugin.app.secretStorage.getSecret(secretId);
		}, OAUTH_TOKEN_SECRET_ID);
	}

	// Reload the plugin (Obsidian-restart equivalence: OAuthManager is rebuilt from
	// the persisted refresh token, with no access token in memory). loadSettings
	// strips the endpointOverrides seam on every load, so setupComplete is parked
	// false across the reload — the fresh instance takes the first-run path and
	// starts NO sync — then the seam is re-injected and sync restarted under it.
	// Without the parking, the auto-started poll would race off toward real Google
	// (egress, plus a real invalid_grant that would clear the seeded token).
	async function reloadPlugin(): Promise<void> {
		await switchToMainWindow();
		await browser.execute(async (overrides: Record<string, string>) => {
			const appPlugins = (window as unknown as { app: { plugins: {
				plugins: Record<string, unknown>;
				disablePlugin: (id: string) => Promise<void>;
				enablePlugin: (id: string) => Promise<void>;
			} } }).app.plugins;
			interface ReloadablePlugin {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				startSync: () => Promise<void>;
				firstRunTimeout: number | null;
			}
			// Same id-agnostic resolution as helpers.ts — never hardcode the manifest id.
			const id = ['papersync', 'obsidian-papersync'].find((k) => appPlugins.plugins[k]);
			if (!id) { throw new Error('PaperSync plugin not loaded'); }

			const current = appPlugins.plugins[id] as ReloadablePlugin;
			current.settings.setupComplete = false;
			await current.saveSettings();

			await appPlugins.disablePlugin(id);
			await appPlugins.enablePlugin(id);

			const plugin = appPlugins.plugins[id] as ReloadablePlugin;
			// The first-run path scheduled a deferred settings-open; cancel it so the
			// reload has no UI side effects.
			if (plugin.firstRunTimeout !== null) {
				window.clearTimeout(plugin.firstRunTimeout);
				plugin.firstRunTimeout = null;
			}
			plugin.settings.endpointOverrides = overrides;
			plugin.settings.setupComplete = true;
			await plugin.saveSettings();
			await plugin.startSync();
		}, fake.endpointOverrides);
		await waitForPlugin();
	}

	before(async function () {
		await fake.start();
		await waitForPlugin();

		// Point the plugin at the fake and normalize to a disconnected baseline. The
		// long poll interval keeps background polls from consuming token faults; every
		// startSync still runs one immediate poll, which is what the specs assert on.
		await browser.execute(async (overrides: Record<string, string>, target: string, secretId: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				oauthManager: { disconnect: () => void } | null;
				syncEngine: { stop: () => void } | null;
				app: { secretStorage: { setSecret: (id: string, value: string) => void } };
			} | undefined;
			if (!plugin) { throw new Error('PaperSync plugin not loaded'); }
			plugin.syncEngine?.stop();
			// Inject the loopback endpoint seam BEFORE the baseline disconnect: disconnect
			// now best-effort revokes any restored refresh token, and the override must be
			// in place so that revoke lands on the in-repo fake (127.0.0.1), never real
			// Google. With no token restored it is a no-op either way.
			plugin.settings.endpointOverrides = overrides;
			await plugin.oauthManager?.disconnect();
			plugin.settings.backendType = 'none';
			plugin.settings.setupComplete = false;
			// The refresh token lives only in secret storage; disconnect() already cleared it.
			// Belt-and-braces clear the secret so no token bleeds into the next spec file.
			try { plugin.app.secretStorage.setSecret(secretId, ''); } catch { /* backend absent */ }
			plugin.settings.lastSyncTimestamp = '';
			plugin.settings.targetFolder = target;
			plugin.settings.attachmentsFolder = `${target}/attachments`;
			plugin.settings.drivePollInterval = 300;
			await plugin.saveSettings();
		}, fake.endpointOverrides, TARGET_FOLDER, OAUTH_TOKEN_SECRET_ID);
	});

	afterEach(async function () {
		// A fault armed by a failed (or retried) test must not stay stranded and
		// poison the next test's token request.
		fake.clearFaults();
		// The window.open patch is scoped per Connect click — restore it here so no
		// later test (or retry) runs under a stale patch. The patch lives on the
		// MAIN window's global (where plugin code runs), so restore it there.
		await switchToMainWindow();
		await browser.execute(() => {
			const w = window as unknown as { __psRealOpen?: typeof window.open };
			if (w.__psRealOpen) { window.open = w.__psRealOpen; delete w.__psRealOpen; }
		});
	});

	after(async function () {
		// Leave no drive/oauth state behind for later spec files: strip the endpoint
		// seam and reset the connection baseline plus the folder/poll settings this
		// suite customized (the vault's data.json is shared across spec files).
		await closeSettings();
		await browser.execute(async (secretId: string) => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				oauthManager: { disconnect: () => void } | null;
				syncEngine: { stop: () => void } | null;
				app: { secretStorage: { setSecret: (id: string, value: string) => void } };
			} | undefined;
			if (!plugin) { return; }
			plugin.syncEngine?.stop();
			plugin.oauthManager?.disconnect();
			plugin.settings.backendType = 'none';
			plugin.settings.setupComplete = false;
			// Clear the token from its only home — secret storage (disconnect already
			// cleared it; this is belt-and-braces). The vault's data.json is shared across
			// spec files, so leave no drive credential behind.
			try { plugin.app.secretStorage.setSecret(secretId, ''); } catch { /* backend absent */ }
			plugin.settings.lastSyncTimestamp = '';
			plugin.settings.targetFolder = '';
			plugin.settings.attachmentsFolder = '';
			plugin.settings.drivePollInterval = 30;
			delete plugin.settings.endpointOverrides;
			await plugin.saveSettings();
		}, OAUTH_TOKEN_SECRET_ID);
		await fake.stop();
	});

	it('rejects a token exchange whose PKCE verifier does not hash to the challenge (server-side guard)', async function () {
		// The real UI flow cannot produce a mismatch (the plugin always sends the right
		// verifier), so prove the fake's guard directly: obtain a code for verifier A,
		// then redeem it with verifier B and expect Google's invalid_grant shape.
		const clientId = 'e2e-direct-client';
		const redirectUri = 'http://127.0.0.1:1/callback';
		const verifier = randomBytes(32).toString('base64url');
		const challenge = createHash('sha256').update(verifier).digest('base64url');

		const authorize = async (): Promise<string> => {
			const params = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: 'https://www.googleapis.com/auth/drive.file',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
			const res = await fetch(`${fake.endpointOverrides.authUrl}?${params.toString()}`, { redirect: 'manual' });
			expect(res.status).toBe(302);
			const code = new URL(res.headers.get('location') ?? '').searchParams.get('code');
			expect(code).toBeTruthy();
			return code!;
		};

		const redeem = async (code: string, codeVerifier: string): Promise<Response> =>
			fetch(fake.endpointOverrides.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: 'irrelevant',
					code,
					code_verifier: codeVerifier,
					grant_type: 'authorization_code',
					redirect_uri: redirectUri,
				}).toString(),
			});

		// Wrong verifier → Google-shaped 400 invalid_grant.
		const bad = await redeem(await authorize(), randomBytes(32).toString('base64url'));
		expect(bad.status).toBe(400);
		const badBody = await bad.json() as { error: string; error_description: string };
		expect(badBody.error).toBe('invalid_grant');
		expect(badBody.error_description).toContain('PKCE');

		// Control: the correct verifier succeeds — the guard is verifier-sensitive,
		// not an unconditional 400.
		const good = await redeem(await authorize(), verifier);
		expect(good.status).toBe(200);
		const goodBody = await good.json() as { access_token?: string; refresh_token?: string };
		expect(goodBody.access_token).toBeTruthy();
		expect(goodBody.refresh_token).toBeTruthy();
	});

	it('completes the real Settings-UI Connect flow end-to-end (PKCE happy path)', async function () {
		fake.clearRequests();

		// Normalize to disconnected in case of a mocha retry mid-suite.
		await switchToMainWindow();
		await browser.execute(async () => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				oauthManager: { disconnect: () => void } | null;
			};
			plugin.oauthManager?.disconnect();
			plugin.settings.backendType = 'none';
			plugin.settings.setupComplete = false;
			await plugin.saveSettings();
		});

		await openSettings();
		await clickConnectWithPatchedOpen();

		// Auth 302 → loopback callback → PKCE-verified exchange → tokens stored.
		await browser.waitUntil(async () => (await state()).isAuthenticated, {
			timeout: 15000, interval: 500,
			timeoutMsg: 'OAuth flow never reached authenticated state',
		});

		const s = await state();
		expect(s.backendType).toBe('drive');
		expect(s.setupComplete).toBe(true);
		expect(s.refreshToken.startsWith('refresh-')).toBe(true); // in-memory fake-issued token

		// Prove the token was handed to secret storage — not merely held by the plugin.
		// oauthManager.refreshToken is set the moment the token exchange returns,
		// regardless of whether the secretStorage write was accepted; reading the stored
		// secret back shows the plugin wrote it there and nowhere else.
		const persisted = await persistedSecret();
		expect(persisted).toBe(s.refreshToken);
		expect(persisted?.startsWith('refresh-')).toBe(true);

		// The plugin sent its real production identity + the full offline-access PKCE
		// contract to the issuer. Each param is asserted on the RECORDED request, so a
		// refactor that drops one (and would break real Google Connect) fails here
		// instead of staying green against the fake.
		const authReq = fake.requests.find((r) => r.path === '/o/oauth2/auth');
		expect(authReq).toBeDefined();
		expect(authReq!.query.client_id).toBe(GOOGLE_CLIENT_ID);
		expect(authReq!.query.code_challenge_method).toBe('S256');
		expect(authReq!.query.access_type).toBe('offline'); // without it Google issues no refresh token
		expect(authReq!.query.prompt).toBe('consent');      // re-consent guarantees a refresh token on reconnect
		expect(authReq!.query.scope).toBe('https://www.googleapis.com/auth/drive.file');
		expect(authReq!.responseStatus).toBe(302);

		const exchange = fake.tokenRequests().find((r) => r.params.get('grant_type') === 'authorization_code');
		expect(exchange).toBeDefined();
		expect(exchange!.responseStatus).toBe(200); // 200 ⇒ the fake's PKCE check passed
		expect(exchange!.params.get('client_secret')).toBe(GOOGLE_CLIENT_SECRET); // desktop-app clients still send it
		expect(exchange!.params.get('code_verifier')).toBeTruthy();

		// The settings UI re-rendered into the connected state. state() above moved
		// the driver to the main window; the settings DOM is elsewhere on 1.13+.
		await focusSettingsUI();
		await browser.waitUntil(async () => (await (await browser.$('body')).getText()).includes('Change Storage'), {
			timeout: 5000, interval: 250,
			timeoutMsg: 'Settings UI never showed the connected (Change Storage) state',
		});
		await closeSettings();
	});

	it('syncs a seeded Drive scan into the vault and PATCHes it back synced with all fields intact', async function () {
		const base = `drive-e2e-${isoStamp()}`;
		const scan = {
			version: '1',
			createdAt: new Date().toISOString(),
			markdown: '# Drive E2E Scan\n\nSynced from the fake Drive.',
			confidence: 93,
			provider: 'e2e-fake-google',
			model: 'mock-model',
			imageFileName: `${base}.jpg`,
			synced: false,
			// Unmodeled field: markSynced must round-trip the RAW JSON, not a zod re-parse.
			deviceNote: 'round-trip-me',
		};
		const { jsonId } = fake.seedScan(base, scan, MINIMAL_JPEG);

		await triggerSyncNow();

		// The markSynced PATCH is the round trip's final leg — poll for it (same
		// pattern as the other scenarios) instead of fixed pauses.
		await browser.waitUntil(
			async () => fake.requests.some((r) => r.method === 'PATCH' && r.path === `/upload/drive/v3/files/${jsonId}` && r.responseStatus === 200),
			{ timeout: 15000, interval: 250, timeoutMsg: 'markSynced PATCH never reached the fake Drive' }
		);

		const notes = await readNotes(TARGET_FOLDER);
		expect(notes).toContain('# Drive E2E Scan');
		expect(notes).toContain('Synced from the fake Drive.');

		// markSynced PATCHed the fake Drive copy: synced flipped, everything else intact.
		const patched = fake.fileJson(jsonId) as Record<string, unknown>;
		expect(patched.synced).toBe(true);
		expect(patched.markdown).toBe(scan.markdown);
		expect(patched.createdAt).toBe(scan.createdAt);
		expect(patched.confidence).toBe(93);
		expect(patched.provider).toBe('e2e-fake-google');
		expect(patched.model).toBe('mock-model');
		expect(patched.imageFileName).toBe(`${base}.jpg`);
		expect(patched.version).toBe('1');
		expect(patched.deviceNote).toBe('round-trip-me');

		const patchReq = fake.requests.find((r) => r.method === 'PATCH' && r.path === `/upload/drive/v3/files/${jsonId}`);
		expect(patchReq).toBeDefined();
		expect(patchReq!.query.uploadType).toBe('media');
		expect(patchReq!.responseStatus).toBe(200);
	});

	it('refreshes the access token via grant_type=refresh_token after a plugin reload', async function () {
		// Own precondition, not the Connect test's leftovers: a fresh fake-issued
		// refresh token seeded into settings, then a reload — which rebuilds
		// OAuthManager from the persisted token with no access token in memory, the
		// exact "expired/absent access token" state of the matrix.
		await seedConnectedState();
		fake.clearRequests();
		await reloadPlugin();

		await browser.waitUntil(
			async () => fake.tokenRequests().some((r) => r.params.get('grant_type') === 'refresh_token' && r.responseStatus === 200),
			{ timeout: 15000, interval: 500, timeoutMsg: 'No successful refresh_token grant reached the fake server' }
		);

		// Sync proceeded: the post-reload poll hit Drive with the new token.
		await browser.waitUntil(
			async () => fake.driveListRequests().some((r) => r.responseStatus === 200 && fake.isIssuedAccessToken(r.authorization)),
			{ timeout: 15000, interval: 500, timeoutMsg: 'No authenticated Drive list request followed the refresh' }
		);

		const s = await state();
		expect(s.isAuthenticated).toBe(true);
		expect(s.refreshToken.startsWith('refresh-')).toBe(true);
	});

	it('keeps the refresh token on a transient refresh 500 and recovers on the next sync', async function () {
		await seedConnectedState(); // retry-safe: precondition rebuilt from scratch
		fake.clearRequests();
		fake.failNextTokenRequest(500, { error: 'internal_failure' });

		await reloadPlugin();

		await browser.waitUntil(
			async () => fake.tokenRequests().some((r) => r.responseStatus === 500),
			{ timeout: 15000, interval: 500, timeoutMsg: 'The injected 500 refresh fault was never consumed' }
		);

		// A single 5xx must NOT disconnect: token kept, still authenticated.
		let s = await state();
		expect(s.isAuthenticated).toBe(true);
		expect(s.refreshToken.startsWith('refresh-')).toBe(true);

		// The next sync retries the refresh (fault consumed) and recovers.
		await triggerSyncNow();
		await browser.waitUntil(
			async () => fake.tokenRequests().some((r) => r.params.get('grant_type') === 'refresh_token' && r.responseStatus === 200),
			{ timeout: 15000, interval: 500, timeoutMsg: 'Refresh never recovered after the transient 500' }
		);
		await browser.waitUntil(
			async () => fake.driveListRequests().some((r) => r.responseStatus === 200),
			{ timeout: 15000, interval: 500, timeoutMsg: 'Sync never proceeded after the recovered refresh' }
		);

		s = await state();
		expect(s.isAuthenticated).toBe(true);
	});

	it('clears tokens and disconnects when a refresh comes back invalid_grant', async function () {
		// Retry-safe: this scenario destroys its own precondition (the stored token),
		// so it re-seeds a fresh one every run instead of leaning on a previous test.
		await seedConnectedState();
		fake.clearRequests();
		fake.failNextTokenRequest(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });

		await reloadPlugin();

		// The definitive revocation signal empties the persisted refresh token.
		await browser.waitUntil(async () => {
			const s = await state();
			return !s.isAuthenticated && s.refreshToken === '';
		}, { timeout: 15000, interval: 500, timeoutMsg: 'invalid_grant refresh never cleared the stored tokens' });

		// Read-back symmetry with the Connect happy path's persistedSecret() assertion:
		// prove the STORED secret was actually cleared to empty, not merely the in-memory
		// oauthManager.refreshToken. A cleared secret reads back as "" (or absent) since
		// the public SecretStorage API has no deleteSecret.
		const persistedAfterRevoke = await persistedSecret();
		expect(persistedAfterRevoke ?? '').toBe('');

		const faulted = fake.tokenRequests().find((r) => r.responseStatus === 400);
		expect(faulted).toBeDefined();
		expect(faulted!.params.get('grant_type')).toBe('refresh_token');

		// The settings UI is back to the storage picker — the user can reconnect.
		await openSettings();
		const text = await (await browser.$('body')).getText();
		expect(text).toContain('Connect');
		expect(text).not.toContain('Change Storage');
		await closeSettings();
	});

	it('revokes the refresh token at Google when the user disconnects via Change Storage', async function () {
		// Own precondition (retry-safe): seed a fresh fake-issued refresh token and reload
		// so OAuthManager restores it into memory — the exact "connected" state a real
		// UI connect leaves behind, without re-driving the whole browser hop.
		await seedConnectedState();
		fake.clearRequests();
		await reloadPlugin();

		// The seeded refresh token now held in memory is the value the revoke must carry.
		const connected = await state();
		expect(connected.isAuthenticated).toBe(true);
		const refreshToken = connected.refreshToken;
		expect(refreshToken.startsWith('refresh-')).toBe(true);

		// Real UI disconnect: the Google-connected row renders exactly one "Change Storage"
		// button (the handler returns before the folder branch), so clicking it exercises
		// the plugin's genuine disconnect path — no direct oauthManager call.
		await openSettings();
		await clickButtonWhenPresent('Change Storage');

		// The disconnect POSTed the refresh token to the fake /revoke endpoint — a real
		// server-side sign-out, fired AFTER the local clear with the captured token.
		await browser.waitUntil(async () => fake.revokedTokens.includes(refreshToken), {
			timeout: 15000, interval: 250,
			timeoutMsg: 'Disconnect never revoked the refresh token at the fake Google /revoke endpoint',
		});

		// Local teardown completed: token gone from memory AND from secret storage
		// (the revoke is best-effort, the local clear is unconditional and runs first).
		await browser.waitUntil(async () => {
			const s = await state();
			return !s.isAuthenticated && s.refreshToken === '';
		}, { timeout: 15000, interval: 500, timeoutMsg: 'Disconnect never cleared the local token after the revoke' });
		const persistedAfterRevoke = await persistedSecret();
		expect(persistedAfterRevoke ?? '').toBe('');

		// A single, well-formed revoke POST carrying the token in the form body — after
		// clearRequests this is unambiguously the Change-Storage disconnect's call.
		const revokeReq = fake.requests.find((r) => r.method === 'POST' && r.path === '/revoke');
		expect(revokeReq).toBeDefined();
		expect(new URLSearchParams(revokeReq!.body).get('token')).toBe(refreshToken);
		expect(revokeReq!.responseStatus).toBe(200);

		await closeSettings();
	});

	it('surfaces a Connection failed notice when the token exchange fails mid-flow', async function () {
		// Flow-level error-surface for the PKCE-mismatch row: force the exchange leg of
		// a real Connect click to fail with the same Google-shaped invalid_grant the
		// PKCE guard emits, and assert the token_revoked path reaches the user.
		// Normalize to disconnected first (same as the happy path): the Connect
		// button only renders in the disconnected picker, so a leftover connected
		// state — from a failed earlier test or a mocha retry — would fail the
		// click on a missing button instead of testing the error surface.
		await switchToMainWindow();
		await browser.execute(async () => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app.plugins.plugins;
			const plugin = (ps['papersync'] ?? ps['obsidian-papersync']) as {
				settings: Record<string, unknown>;
				saveSettings: () => Promise<void>;
				oauthManager: { disconnect: () => void } | null;
			};
			plugin.oauthManager?.disconnect();
			plugin.settings.backendType = 'none';
			plugin.settings.setupComplete = false;
			await plugin.saveSettings();
		});
		fake.clearRequests();
		fake.failNextTokenRequest(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });

		await openSettings();
		await clickConnectWithPatchedOpen();

		// The Connect handler resets a failed attempt back to backendType 'none'.
		await browser.waitUntil(async () => (await state()).backendType === 'none', {
			timeout: 15000, interval: 500,
			timeoutMsg: 'Failed Connect flow never reset backendType to none',
		});

		const s = await state();
		expect(s.isAuthenticated).toBe(false);
		expect(s.refreshToken).toBe('');

		// The Notice carries the surfaced token_revoked message. Where it mounts
		// differs by version (main-window document pre-1.13; possibly the settings
		// window's own notice container on 1.13+), so poll every window for it.
		await browser.waitUntil(async () => {
			for (const handle of await browser.getWindowHandles()) {
				try {
					await browser.switchToWindow(handle);
					const text = await (await browser.$('body')).getText();
					if (text.includes('Connection failed') && text.includes('PKCE verification failed')) { return true; }
				} catch { /* window closed mid-poll */ }
			}
			return false;
		}, { timeout: 5000, interval: 250, timeoutMsg: 'Connection failed notice never surfaced' });

		await closeSettings();
	});
});
