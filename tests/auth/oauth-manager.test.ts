import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function makePlugin(): Plugin {
	return {} as unknown as Plugin;
}

describe('OAuthManager', () => {
	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	describe('isAuthenticated / currentAccessToken / restoreFromToken', () => {
		it('starts unauthenticated', () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			expect(mgr.isAuthenticated).toBe(false);
			expect(mgr.currentAccessToken).toBeNull();
		});

		it('becomes authenticated after restoring a refresh token', () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');
			expect(mgr.isAuthenticated).toBe(true);
		});

		it('ignores empty token in restoreFromToken', () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('');
			expect(mgr.isAuthenticated).toBe(false);
		});
	});

	describe('getValidAccessToken', () => {
		it('returns cached access token if not near expiry', async () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');
			// Inject a still-valid access token via storeTokens (via reflection)
			(mgr as unknown as { accessToken: string }).accessToken = 'cached-access';
			(mgr as unknown as { expiresAt: number }).expiresAt = Date.now() + 5 * 60 * 1000;

			const token = await mgr.getValidAccessToken();
			expect(token).toBe('cached-access');
			expect(mockedRequestUrl).not.toHaveBeenCalled();
		});

		it('refreshes when access token is near expiry', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				json: { access_token: 'refreshed-access', expires_in: 3600 },
			} as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');
			(mgr as unknown as { accessToken: string }).accessToken = 'stale';
			(mgr as unknown as { expiresAt: number }).expiresAt = Date.now() + 30_000;

			const token = await mgr.getValidAccessToken();
			expect(token).toBe('refreshed-access');
			expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
		});

		it('throws token_revoked when no refresh token is set', async () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
		});

		it('keeps the refresh token on a transient NETWORK failure — does not disconnect (#1)', async () => {
			mockedRequestUrl.mockRejectedValueOnce(new Error('network down'));

			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
			// Token preserved so the next attempt can recover — one blip must not sign the user out.
			expect(mgr.isAuthenticated).toBe(true);
			expect(tokenChange).not.toHaveBeenCalled();
		});

		it('keeps the token on a transient 5xx (null error body → ?? {} guard) (#1)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 503, json: null } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
			expect(mgr.isAuthenticated).toBe(true);
		});

		it('keeps the token on a 401 that is NOT invalid_grant (#1)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 401, json: { error: 'temporarily_unavailable' } } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
			expect(mgr.isAuthenticated).toBe(true);
		});

		it('clears the token ONLY on a definitive invalid_grant (400) (#1)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 400, json: { error: 'invalid_grant' } } as never);

			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
			expect(mgr.isAuthenticated).toBe(false);
			expect(tokenChange).toHaveBeenCalledWith('');
		});

		it('clears on invalid_grant even without a token-change listener (?. no-op) (#1)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 400, json: { error: 'invalid_grant' } } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			// No setOnTokenChange — the `this.onTokenChange?.('')` optional chain must no-op.
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
			expect(mgr.isAuthenticated).toBe(false);
		});

		it('keeps the token when a 2xx refresh response lacks an access_token (transient) (#1)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: {} } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'network_timeout' });
			expect(mgr.isAuthenticated).toBe(true);
		});

		it('defaults the token lifetime when a refresh response omits expires_in', async () => {
			mockedRequestUrl.mockResolvedValueOnce({
				json: { access_token: 'refreshed-no-expiry' },
			} as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			const token = await mgr.getValidAccessToken();
			expect(token).toBe('refreshed-no-expiry');
		});
	});

	describe('disconnect', () => {
		it('clears tokens locally then best-effort revokes the refresh token at Google', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 200 } as never);

			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');
			expect(mgr.isAuthenticated).toBe(true);

			await mgr.disconnect();

			// Revoke fired once, POST to the revoke endpoint, refresh token in the form body.
			expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
			const call = mockedRequestUrl.mock.calls[0]![0];
			expect(call.url).toBe('https://oauth2.googleapis.com/revoke');
			expect(call.method).toBe('POST');
			expect(call.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
			expect(new URLSearchParams(call.body as string).get('token')).toBe('refresh-abc');
			// Then the local clear ran.
			expect(mgr.isAuthenticated).toBe(false);
			expect(mgr.currentAccessToken).toBeNull();
			expect(tokenChange).toHaveBeenLastCalledWith('');
		});

		it('still clears locally and never throws when the revoke fails offline (network throw swallowed)', async () => {
			mockedRequestUrl.mockRejectedValueOnce(new Error('network down'));

			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');

			// Best-effort: the failed revoke is swallowed and disconnect still resolves.
			await expect(mgr.disconnect()).resolves.toBeUndefined();
			expect(mgr.isAuthenticated).toBe(false);
			expect(mgr.currentAccessToken).toBeNull();
			expect(tokenChange).toHaveBeenLastCalledWith('');
		});

		it('still clears locally when the revoke returns a non-2xx status (logged, not thrown)', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 400 } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.disconnect()).resolves.toBeUndefined();
			expect(mgr.isAuthenticated).toBe(false);
		});

		it('does not call the revoke endpoint when there is no refresh token — only the local clear runs', async () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			// Never restored a token → refreshToken is null, so the revoke is skipped.
			await mgr.disconnect();

			expect(mockedRequestUrl).not.toHaveBeenCalled();
			expect(mgr.isAuthenticated).toBe(false);
			expect(mgr.currentAccessToken).toBeNull();
		});

		it('does not throw when disconnecting with no token-change listener registered', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ status: 200 } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			// onTokenChange is null → the `this.onTokenChange?.('')` optional chain must no-op.
			await expect(mgr.disconnect()).resolves.toBeUndefined();
			expect(mgr.isAuthenticated).toBe(false);
		});
	});

	describe('cleanup', () => {
		it('does not throw when no callback server is active', () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			expect(() => mgr.cleanup()).not.toThrow();
		});
	});

	describe('startAuthFlow validation', () => {
		it('throws when client ID is missing', async () => {
			const mgr = new OAuthManager(makePlugin(), '');
			await expect(mgr.startAuthFlow()).rejects.toMatchObject({ type: 'token_revoked' });
		});
	});
});
