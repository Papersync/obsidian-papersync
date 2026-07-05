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

		it('clears tokens and throws when refresh fails', async () => {
			mockedRequestUrl.mockRejectedValueOnce(new Error('network'));

			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
			expect(mgr.isAuthenticated).toBe(false);
			expect(tokenChange).toHaveBeenCalledWith('');
		});

		it('clears tokens when refresh response lacks access_token', async () => {
			mockedRequestUrl.mockResolvedValueOnce({ json: {} } as never);

			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
			expect(mgr.isAuthenticated).toBe(false);
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
		it('clears tokens and notifies token-change listener', () => {
			const tokenChange = jest.fn();
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.setOnTokenChange(tokenChange);
			mgr.restoreFromToken('refresh-abc');
			expect(mgr.isAuthenticated).toBe(true);

			mgr.disconnect();
			expect(mgr.isAuthenticated).toBe(false);
			expect(mgr.currentAccessToken).toBeNull();
			expect(tokenChange).toHaveBeenLastCalledWith('');
		});

		it('does not throw when disconnecting with no token-change listener registered', () => {
			const mgr = new OAuthManager(makePlugin(), 'client-id');
			mgr.restoreFromToken('refresh-abc');

			// onTokenChange is null → the `this.onTokenChange?.('')` optional chain must no-op.
			expect(() => mgr.disconnect()).not.toThrow();
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
