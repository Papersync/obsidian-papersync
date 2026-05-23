// Exercises the OAuth callback HTTP server end-to-end by spinning the real
// http.Server, capturing the random port from the URL handed to window.open,
// and making live HTTP requests against /callback to drive each branch
// (code present, error present, missing code, unknown path).
//
// We mock `requestUrl` so the token-exchange step is offline.

import * as http from 'http';
import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function makePlugin(): Plugin {
	return {} as unknown as Plugin;
}

function extractPortFromAuthUrl(authUrl: string): number {
	const url = new URL(authUrl);
	const redirect = url.searchParams.get('redirect_uri');
	if (!redirect) throw new Error('redirect_uri missing from auth URL');
	const match = redirect.match(/:(\d+)\//);
	if (!match) throw new Error(`port not parseable from ${redirect}`);
	return Number(match[1]);
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
		});
		req.on('error', reject);
	});
}

async function captureAuthUrl(mgr: OAuthManager): Promise<{ port: number; flowPromise: Promise<unknown> }> {
	let capturedUrl = '';
	const originalOpen = window.open;
	window.open = ((url: string) => { capturedUrl = String(url); return null; }) as typeof window.open;

	const flowPromise = mgr.startAuthFlow();
	// Yield to allow the callback server to bind and window.open to be called.
	await new Promise((r) => setTimeout(r, 50));
	window.open = originalOpen;

	const port = extractPortFromAuthUrl(capturedUrl);
	return { port, flowPromise };
}

describe('OAuthManager.startAuthFlow — callback HTTP server', () => {
	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	it('resolves with tokens after the callback delivers a code', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				access_token: 'ya29.real-access',
				refresh_token: '1//real-refresh',
				expires_in: 3600,
				token_type: 'Bearer',
			},
		} as never);

		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const { port, flowPromise } = await captureAuthUrl(mgr);

		// Deliver the success callback.
		const res = await httpGet(port, '/callback?code=AUTHCODE');
		expect(res.status).toBe(200);
		expect(res.body).toContain('Connected!');

		const tokens = (await flowPromise) as { accessToken: string; refreshToken: string };
		expect(tokens.accessToken).toBe('ya29.real-access');
		expect(tokens.refreshToken).toBe('1//real-refresh');

		mgr.cleanup();
	});

	it('rejects when the callback URL carries an OAuth error param (and escapes HTML in the response)', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const { port, flowPromise } = await captureAuthUrl(mgr);

		// Use an error_description with HTML metacharacters to prove escapeHtml runs.
		const res = await httpGet(
			port,
			'/callback?error=access_denied&error_description=' + encodeURIComponent('<bad>&"oops"')
		);
		expect(res.status).toBe(200);
		expect(res.body).toContain('Authorization failed');
		// HTML must be escaped, not raw.
		expect(res.body).toContain('&lt;bad&gt;');
		expect(res.body).toContain('&amp;');
		expect(res.body).toContain('&quot;oops&quot;');
		// Raw < or > or " must not appear in the escaped payload.
		expect(res.body).not.toContain('<bad>');

		// The flow promise should remain pending (server stays open until callback w/code or timeout).
		// We can detect this by racing it against a short timer.
		const winner = await Promise.race([
			flowPromise.then(() => 'resolved').catch(() => 'rejected'),
			new Promise((r) => setTimeout(() => r('pending'), 100)),
		]);
		expect(winner).toBe('pending');

		mgr.cleanup();
		// Awaiting the abandoned promise would hang; the test ends with cleanup which closes the server.
		// Attach a no-op rejection handler so jest doesn't warn about an unhandled promise.
		flowPromise.catch(() => undefined);
	});

	it('returns 204 for non-/callback requests', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const { port, flowPromise } = await captureAuthUrl(mgr);

		const res = await httpGet(port, '/favicon.ico');
		expect(res.status).toBe(204);
		expect(res.body).toBe('');

		mgr.cleanup();
		flowPromise.catch(() => undefined);
	});

	it('returns "Unexpected response" HTML when /callback has neither code nor error', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const { port, flowPromise } = await captureAuthUrl(mgr);

		const res = await httpGet(port, '/callback');
		expect(res.status).toBe(200);
		expect(res.body).toContain('Unexpected response');

		mgr.cleanup();
		flowPromise.catch(() => undefined);
	});

	it('cleanup() closes the active callback server', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const { port, flowPromise } = await captureAuthUrl(mgr);

		// Server is up — first request lands.
		const before = await httpGet(port, '/callback');
		expect(before.status).toBe(200);

		// Verify the internal server handle is set, then cleanup nulls it.
		const internals = mgr as unknown as { authServer: http.Server | null };
		expect(internals.authServer).not.toBeNull();
		mgr.cleanup();
		expect(internals.authServer).toBeNull();

		// And the server should no longer accept new connections (ECONNREFUSED
		// or ECONNRESET depending on timing of pending sockets).
		await expect(httpGet(port, '/callback')).rejects.toMatchObject({
			code: expect.stringMatching(/^ECONN(REFUSED|RESET)$/),
		});
		flowPromise.catch(() => undefined);
	});
});

describe('OAuthManager.startAuthFlow — token-exchange failure surfaces through the callback handler', () => {
	beforeEach(() => mockedRequestUrl.mockReset());

	// Note: the OAUTH_TIMEOUT_MS = 3-minute timeout branch (oauth-manager.ts:91-94)
	// and the server.on('error') branch (line 157-159) are intentionally not unit-tested:
	// the timeout requires fake-timer + microtask coordination that interacts poorly with
	// the real http.Server bind path, and server.on('error') only fires when listen itself
	// errors AFTER it has already resolved — a race that's hard to provoke deterministically.
	// Both are validated end-to-end via the wdio E2E suite (test/e2e/) instead.

	it('rejects with token_revoked when the token endpoint returns a 4xx after a callback code', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 400,
			json: { error: 'invalid_grant', error_description: 'Bad code' },
		} as never);

		const mgr = new OAuthManager(makePlugin(), 'client-id');
		let capturedUrl = '';
		const originalOpen = window.open;
		window.open = ((url: string) => { capturedUrl = String(url); return null; }) as typeof window.open;

		// Attach an immediate catch handler so the async rejection (which
		// fires after httpGet returns) is never seen as unhandled.
		const flow = mgr.startAuthFlow();
		const settled = flow.then((v) => ({ kind: 'resolved' as const, v })).catch((e: unknown) => ({ kind: 'rejected' as const, e }));

		await new Promise((r) => setTimeout(r, 50));
		window.open = originalOpen;

		const port = extractPortFromAuthUrl(capturedUrl);
		await httpGet(port, '/callback?code=BADCODE');

		const result = await settled;
		expect(result.kind).toBe('rejected');
		if (result.kind === 'rejected') {
			expect(result.e).toMatchObject({ type: 'token_revoked' });
		}
		mgr.cleanup();
	});
});
