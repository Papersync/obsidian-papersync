// A sign-in the user cancelled at Google ends at once, and a sign-in (or a token
// refresh) that was abandoned by Disconnect or a newer Connect can never write its
// result over the newer state or close the newer flow's callback server.
import * as http from 'http';
import { requestUrl } from 'obsidian';
import type { Plugin } from 'obsidian';
import { OAuthManager, isAuthSuperseded } from '@/auth/oauth-manager';
import { isSyncError } from '@/errors/error-handler';

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

// A fresh connection each time (no keep-alive reuse), so a closed server refuses it.
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.get({ hostname: '127.0.0.1', port, path, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (c: Buffer) => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
		});
		req.on('error', reject);
	});
}

// Starts a flow and reads the loopback port and state from the URL it opens.
async function begin(mgr: OAuthManager): Promise<{ port: number; state: string; flow: Promise<unknown> }> {
	let opened = '';
	const realOpen = window.open;
	window.open = ((url: string) => { opened = String(url); return null; }) as typeof window.open;
	const flow = mgr.startAuthFlow();
	flow.catch(() => undefined);
	await new Promise((r) => setTimeout(r, 50));
	window.open = realOpen;
	const url = new URL(opened);
	const port = Number(/:(\d+)\//.exec(url.searchParams.get('redirect_uri') ?? '')![1]);
	return { port, state: url.searchParams.get('state') ?? '', flow };
}

// A token response the test releases by hand, to hold an exchange in flight.
function heldResponse(): { release: (json: unknown, status?: number) => void } {
	let release!: (json: unknown, status?: number) => void;
	mockedRequestUrl.mockImplementationOnce(() => new Promise((resolve) => {
		release = (json, status = 200) => resolve({ status, json } as never);
	}) as never);
	return { release: (json, status) => release(json, status) };
}

const tokens = (n: string) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600, token_type: 'Bearer' });
const settle = () => new Promise((r) => setTimeout(r, 30));
const isListening = (port: number) => httpGet(port, '/probe').then(() => true, () => false);

describe('OAuthManager flow ownership', () => {
	beforeEach(() => mockedRequestUrl.mockReset());

	it('rejects at once when Google reports an error for this sign-in, and closes the server (item 9)', async () => {
		const mgr = new OAuthManager({} as Plugin, 'client');
		const { port, state, flow } = await begin(mgr);
		const res = await httpGet(port, `/callback?error=access_denied&state=${state}`);
		expect(res.body).toContain('Authorization failed');
		const err: unknown = await flow.then(() => null, (e: unknown) => e);
		expect(isSyncError(err)).toBe(true);
		expect((err as Error).message).toContain('access_denied');
		expect(isAuthSuperseded(err)).toBe(false);
		await settle();
		expect(await isListening(port)).toBe(false);
		mgr.cleanup();
	});

	it('does not restore tokens from an exchange that finishes after Disconnect (item 13)', async () => {
		const changes: string[] = [];
		const mgr = new OAuthManager({} as Plugin, 'client');
		mgr.setOnTokenChange((t) => changes.push(t));
		const exchange = heldResponse();
		const { port, state, flow } = await begin(mgr);
		await httpGet(port, `/callback?code=C&state=${state}`);

		await mgr.disconnect();
		exchange.release(tokens('old'));
		const err: unknown = await flow.then(() => null, (e: unknown) => e);
		expect(isAuthSuperseded(err)).toBe(true);
		expect(mgr.isAuthenticated).toBe(false);
		expect(changes).toEqual(['']);
	});

	it('an abandoned exchange neither stores its tokens nor closes the newer flow (item 13)', async () => {
		const mgr = new OAuthManager({} as Plugin, 'client');
		const exchangeA = heldResponse();
		const a = await begin(mgr);
		await httpGet(a.port, `/callback?code=A&state=${a.state}`);

		const b = await begin(mgr);
		exchangeA.release(tokens('A'));
		expect(isAuthSuperseded(await a.flow.then(() => null, (e: unknown) => e))).toBe(true);
		await settle();
		expect(mgr.isAuthenticated).toBe(false);
		// Flow B still owns its server and completes.
		expect(await isListening(b.port)).toBe(true);
		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: tokens('B') } as never);
		await httpGet(b.port, `/callback?code=B&state=${b.state}`);
		await expect(b.flow).resolves.toMatchObject({ refreshToken: 'refresh-B' });
		mgr.cleanup();
	});

	it('a refresh that finishes after Disconnect does not bring the access token back (item 13)', async () => {
		const mgr = new OAuthManager({} as Plugin, 'client');
		mgr.restoreFromToken('refresh-1');
		const refresh = heldResponse();
		const pending = mgr.getValidAccessToken();
		await mgr.disconnect();
		refresh.release({ access_token: 'late' });
		await expect(pending).rejects.toMatchObject({ type: 'token_revoked' });
		mockedRequestUrl.mockReset();
		await expect(mgr.getValidAccessToken()).rejects.toMatchObject({ type: 'token_revoked' });
		expect(mockedRequestUrl).not.toHaveBeenCalled();
	});

	it('a stale invalid_grant does not wipe a token from a newer sign-in (item 13)', async () => {
		const changes: string[] = [];
		const mgr = new OAuthManager({} as Plugin, 'client');
		mgr.setOnTokenChange((t) => changes.push(t));
		mgr.restoreFromToken('refresh-old');
		const refresh = heldResponse();
		const pending = mgr.getValidAccessToken();

		mockedRequestUrl.mockResolvedValueOnce({ status: 200, json: tokens('new') } as never);
		const flow = await begin(mgr);
		await httpGet(flow.port, `/callback?code=N&state=${flow.state}`);
		await flow.flow;

		refresh.release({ error: 'invalid_grant' }, 400);
		// The stale answer is dropped; the caller gets the current sign-in's token.
		await expect(pending).resolves.toBe('access-new');
		expect(mgr.isAuthenticated).toBe(true);
		expect(changes).toEqual(['refresh-new']);
		mgr.cleanup();
	});
});
