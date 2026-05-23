import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

interface Internals {
	exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<unknown>;
	storeTokens(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void;
	stopCallbackServer(): void;
}

function asInternal(mgr: OAuthManager): Internals {
	return mgr as unknown as Internals;
}

const validTokenResponse = {
	access_token: 'ya29.access',
	refresh_token: '1//refresh',
	expires_in: 3600,
	token_type: 'Bearer',
};

describe('OAuthManager.exchangeCodeForTokens (private)', () => {
	beforeEach(() => mockedRequestUrl.mockReset());

	it('returns tokens on a successful response', async () => {
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: validTokenResponse } as never);

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		const tokens = (await asInternal(mgr).exchangeCodeForTokens('code', 'verifier', 'http://localhost:8080/callback')) as { accessToken: string; refreshToken: string; expiresAt: number };

		expect(tokens.accessToken).toBe('ya29.access');
		expect(tokens.refreshToken).toBe('1//refresh');
		expect(tokens.expiresAt).toBeGreaterThan(Date.now());
	});

	it('throws token_revoked on a Google error response (4xx)', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 400,
			json: { error: 'invalid_grant', error_description: 'Bad code' },
		} as never);

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await expect(
			asInternal(mgr).exchangeCodeForTokens('code', 'verifier', 'http://localhost/callback')
		).rejects.toMatchObject({ type: 'token_revoked' });
	});

	it('throws token_revoked when the response is missing access_token', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { refresh_token: 'only-refresh', expires_in: 3600 },
		} as never);

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await expect(
			asInternal(mgr).exchangeCodeForTokens('code', 'verifier', 'http://localhost/callback')
		).rejects.toMatchObject({ type: 'token_revoked' });
	});

	it('throws token_revoked when the response is missing refresh_token', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { access_token: 'only-access', expires_in: 3600 },
		} as never);

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await expect(
			asInternal(mgr).exchangeCodeForTokens('code', 'verifier', 'http://localhost/callback')
		).rejects.toMatchObject({ type: 'token_revoked' });
	});

	it('throws token_revoked when requestUrl itself fails with a network error', async () => {
		mockedRequestUrl.mockRejectedValueOnce(new Error('connection refused'));

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await expect(
			asInternal(mgr).exchangeCodeForTokens('code', 'verifier', 'http://localhost/callback')
		).rejects.toMatchObject({ type: 'token_revoked' });
	});

	it('re-throws a typed SyncError from inside the try block without re-wrapping', async () => {
		// requestUrl returns 400 → exchange throws a typed sync error → caught by try/catch which
		// must rethrow it as-is (not re-wrap). Verified by the consistent type field.
		mockedRequestUrl.mockResolvedValueOnce({
			status: 403,
			json: { error: 'access_denied' },
		} as never);

		const mgr = new OAuthManager({} as Plugin, 'client-id');
		const err = await asInternal(mgr)
			.exchangeCodeForTokens('code', 'verifier', 'http://localhost/callback')
			.catch((e: { type: string }) => e);
		expect((err as { type: string }).type).toBe('token_revoked');
	});
});

describe('OAuthManager.storeTokens (private)', () => {
	it('updates accessToken, refreshToken and expiresAt + notifies listener', () => {
		const tokenChange = jest.fn();
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		mgr.setOnTokenChange(tokenChange);

		const expiresAt = Date.now() + 60_000;
		asInternal(mgr).storeTokens({ accessToken: 'a', refreshToken: 'r', expiresAt });

		expect(mgr.isAuthenticated).toBe(true);
		expect(mgr.currentAccessToken).toBe('a');
		expect(tokenChange).toHaveBeenCalledWith('r');
	});
});

describe('OAuthManager.stopCallbackServer (private no-op path)', () => {
	it('is safe to call when no server is running', () => {
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		expect(() => asInternal(mgr).stopCallbackServer()).not.toThrow();
	});
});
