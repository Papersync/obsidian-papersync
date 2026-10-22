// Drives the defensive branches of OAuthManager.startCallbackServer that the
// real-http end-to-end suite (oauth-manager-callback-server.test.ts) can't hit
// deterministically: an undefined req.url, an OAuth error without a description,
// a code arriving with no onAuthCallback registered, a non-object server
// address (listen edge case), and the server 'error' event. We mock the `http`
// module so the request handler and listen callback can be invoked synchronously.

jest.mock('http');

import * as http from 'http';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';

const createServerMock = http.createServer as unknown as jest.Mock;

interface FakeRes {
	writeHead: jest.Mock;
	end: jest.Mock;
}

function makeRes(): FakeRes {
	return { writeHead: jest.fn(), end: jest.fn() };
}

type ReqHandler = (req: { url?: string }, res: FakeRes) => void;

function installFakeServer(opts: { address?: unknown; callListen?: boolean }): {
	getHandler: () => ReqHandler;
	listeners: Record<string, (arg: unknown) => void>;
} {
	let handler: ReqHandler = () => undefined;
	const listeners: Record<string, (arg: unknown) => void> = {};
	const server = {
		listen: jest.fn((_port: number, _host: string, cb?: () => void) => {
			if (opts.callListen !== false && cb) {cb();}
		}),
		on: jest.fn((event: string, fn: (arg: unknown) => void) => {
			listeners[event] = fn;
		}),
		address: jest.fn(() => ('address' in opts ? opts.address : { port: 45678 })),
		close: jest.fn(),
	};
	createServerMock.mockImplementation((h: ReqHandler) => {
		handler = h;
		return server as unknown as http.Server;
	});
	return { getHandler: () => handler, listeners };
}

function startServer(mgr: OAuthManager): Promise<{ port: number; redirectUri: string }> {
	return (
		mgr as unknown as { startCallbackServer(v: string): Promise<{ port: number; redirectUri: string }> }
	).startCallbackServer('verifier');
}

describe('OAuthManager.startCallbackServer — request handler branches (mocked http)', () => {
	beforeEach(() => createServerMock.mockReset());

	it('coerces an undefined req.url to "/" and answers 204 for non-callback paths', async () => {
		const { getHandler } = installFakeServer({});
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await startServer(mgr);

		const res = makeRes();
		getHandler()({ url: undefined }, res);

		expect(res.writeHead).toHaveBeenCalledWith(204);
		expect(res.end).toHaveBeenCalled();
	});

	it('falls back to "Unknown error" text when an OAuth error carries no description', async () => {
		const { getHandler } = installFakeServer({});
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await startServer(mgr);

		const res = makeRes();
		getHandler()({ url: '/callback?error=access_denied' }, res);

		const body = res.end.mock.calls[0][0] as string;
		expect(body).toContain('Authorization failed');
		expect(body).toContain('Unknown error');
	});

	it('ignores a code when no sign-in is waiting for one', async () => {
		const { getHandler } = installFakeServer({});
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		// startCallbackServer (unlike startAuthFlow) sets no expected state.
		await startServer(mgr);

		const res = makeRes();
		expect(() => getHandler()({ url: '/callback?code=ABC123' }, res)).not.toThrow();
		expect(res.end.mock.calls[0][0] as string).toContain('Unexpected response');
	});

	it('accepts a matching state even with no callback registered', async () => {
		const { getHandler } = installFakeServer({});
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await startServer(mgr);
		(mgr as unknown as { expectedState: string }).expectedState = 'S';

		const res = makeRes();
		expect(() => getHandler()({ url: '/callback?code=ABC123&state=S' }, res)).not.toThrow();
		expect(res.end.mock.calls[0][0] as string).toContain('Connected!');
	});
});

describe('OAuthManager.startCallbackServer — listen/error edge cases (mocked http)', () => {
	beforeEach(() => createServerMock.mockReset());

	it('rejects with network_timeout when server.address() is not an AddressInfo object', async () => {
		installFakeServer({ address: '/tmp/unix.sock' });
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		await expect(startServer(mgr)).rejects.toMatchObject({ type: 'network_timeout' });
	});

	it('rejects with network_timeout when the server emits an error event', async () => {
		const { listeners } = installFakeServer({ callListen: false });
		const mgr = new OAuthManager({} as Plugin, 'client-id');
		const pending = startServer(mgr);

		listeners['error'](new Error('EADDRINUSE: address already in use'));

		await expect(pending).rejects.toMatchObject({ type: 'network_timeout' });
	});
});
