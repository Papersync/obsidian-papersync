// Covers the OAUTH_TIMEOUT_MS branch of startAuthFlow (the timeout callback that
// stops the callback server and rejects with token_expired when no OAuth callback
// arrives). We mock `http` so no real socket binds, and shrink OAUTH_TIMEOUT_MS via
// a config mock so the timeout fires in milliseconds instead of three minutes.

jest.mock('http');
jest.mock('@/config', () => ({
	OAUTH_TIMEOUT_MS: 50,
	GOOGLE_CLIENT_SECRET: 'test-secret',
}));

import * as http from 'http';
import type { Plugin } from 'obsidian';

import { OAuthManager } from '@/auth/oauth-manager';

const createServerMock = http.createServer as unknown as jest.Mock;

function installFakeServer(): { close: jest.Mock } {
	const server = {
		listen: jest.fn((_port: number, _host: string, cb?: () => void) => cb && cb()),
		on: jest.fn(),
		address: jest.fn(() => ({ port: 45678 })),
		close: jest.fn(),
	};
	createServerMock.mockImplementation(() => server as unknown as http.Server);
	return server;
}

describe('OAuthManager.startAuthFlow — no-callback timeout', () => {
	beforeEach(() => createServerMock.mockReset());

	it('rejects with token_expired and stops the server when no callback arrives in time', async () => {
		const server = installFakeServer();
		const originalOpen = window.open;
		window.open = (() => null) as typeof window.open;

		try {
			const mgr = new OAuthManager({} as Plugin, 'client-id');
			// No HTTP callback is delivered → the OAUTH_TIMEOUT_MS timer (mocked to 50ms) fires.
			await expect(mgr.startAuthFlow()).rejects.toMatchObject({ type: 'token_expired' });
			expect(server.close).toHaveBeenCalled();
			mgr.cleanup();
		} finally {
			window.open = originalOpen;
		}
	});
});
