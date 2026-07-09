// Endpoint-override seam: the OAuthManager resolves its auth/token URLs through a
// call-time supplier feeding the shared loopback-gated resolver. With no supplier
// (or a supplier yielding nothing) every URL must be byte-identical to today's
// hardcoded Google values; a loopback override wins; anything non-loopback, empty,
// or malformed is ignored (the resolver's own branch matrix lives in
// tests/google-endpoints.test.ts — here we prove the wiring through the manager).

import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';
import { DEFAULT_GOOGLE_ENDPOINTS } from '@/config';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

function makePlugin(): Plugin {
	return {} as unknown as Plugin;
}

const refreshOk = { json: { access_token: 'fresh', expires_in: 3600 } };

async function refreshUrlFor(mgr: OAuthManager): Promise<string> {
	mockedRequestUrl.mockResolvedValueOnce(refreshOk as never);
	mgr.restoreFromToken('refresh-abc');
	await mgr.getValidAccessToken();
	const call = mockedRequestUrl.mock.calls[mockedRequestUrl.mock.calls.length - 1]![0];
	return call.url;
}

// Captures the URL handed to window.open by startAuthFlow, then tears the flow down.
// The browser hop only happens after PKCE generation + callback-server bind, so poll
// for the capture (bounded, no fixed sleep) instead of hoping 50ms is enough.
async function authUrlFor(mgr: OAuthManager): Promise<string> {
	let captured = '';
	const originalOpen = window.open;
	window.open = ((url: string) => { captured = String(url); return null; }) as typeof window.open;
	const flow = mgr.startAuthFlow();
	flow.catch(() => undefined); // torn down before completion — silence the rejection
	try {
		const deadline = Date.now() + 2000;
		while (!captured && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
	} finally {
		window.open = originalOpen;
		mgr.cleanup();
		// Give the callback server's close() callback a turn of the event loop so the
		// test leaves no open-handle noise behind.
		await new Promise((r) => setTimeout(r, 0));
	}
	return captured;
}

describe('OAuthManager endpoint resolution', () => {
	beforeEach(() => {
		mockedRequestUrl.mockReset();
	});

	it('defaults byte-identically to the production Google token URL when no supplier is given', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		expect(await refreshUrlFor(mgr)).toBe('https://oauth2.googleapis.com/token');
	});

	it('defaults when the supplier returns undefined (no overrides stored)', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => undefined);
		expect(await refreshUrlFor(mgr)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('defaults when the supplier returns a partial without the requested key', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ authUrl: 'http://127.0.0.1:9/auth' }));
		expect(await refreshUrlFor(mgr)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('uses the override token URL for refresh when supplied', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ tokenUrl: 'http://127.0.0.1:9/token' }));
		expect(await refreshUrlFor(mgr)).toBe('http://127.0.0.1:9/token');
	});

	it('uses the override token URL for the code exchange when supplied', async () => {
		mockedRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
		} as never);

		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ tokenUrl: 'http://127.0.0.1:9/token' }));
		await (mgr as unknown as {
			exchangeCodeForTokens(code: string, verifier: string, redirectUri: string): Promise<unknown>;
		}).exchangeCodeForTokens('code', 'verifier', 'http://127.0.0.1:1/callback');

		expect(mockedRequestUrl.mock.calls[0]![0].url).toBe('http://127.0.0.1:9/token');
	});

	it('defaults byte-identically to the production Google auth URL when no supplier is given', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id');
		const url = await authUrlFor(mgr);
		expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
	});

	it('uses the override auth URL in startAuthFlow when supplied', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ authUrl: 'http://127.0.0.1:9/fake-auth' }));
		const url = await authUrlFor(mgr);
		expect(url.startsWith('http://127.0.0.1:9/fake-auth?')).toBe(true);
	});

	it('ignores a non-loopback override and falls back to the production URL (credential-redirect hardening)', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ tokenUrl: 'https://attacker.example.com/token' }));
		expect(await refreshUrlFor(mgr)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('ignores an empty-string override instead of throwing on new URL("")', async () => {
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => ({ tokenUrl: '' }));
		expect(await refreshUrlFor(mgr)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('resolves the supplier at CALL time, not construction time', async () => {
		// The seam exists because OAuthManager is constructed at plugin load, before a
		// spec can mutate settings — a late-written override must still take effect.
		let overrides: { tokenUrl?: string } | undefined;
		const mgr = new OAuthManager(makePlugin(), 'client-id', () => overrides);

		expect(await refreshUrlFor(mgr)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);

		overrides = { tokenUrl: 'http://127.0.0.1:9/late-token' };
		mockedRequestUrl.mockResolvedValueOnce(refreshOk as never);
		(mgr as unknown as { accessToken: string | null; expiresAt: number }).accessToken = null;
		await mgr.getValidAccessToken();
		const lastCall = mockedRequestUrl.mock.calls[mockedRequestUrl.mock.calls.length - 1]![0];
		expect(lastCall.url).toBe('http://127.0.0.1:9/late-token');
	});
});
