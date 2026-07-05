import { requestUrl, Plugin } from 'obsidian';
import { generateCodeVerifier, computeCodeChallenge } from '@/auth/pkce';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';
import { createSyncError } from '@/errors/sync-error';
import * as http from 'http';

import { OAUTH_TIMEOUT_MS, GOOGLE_CLIENT_SECRET } from '@/config';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

interface GoogleTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	scope?: string;
}

interface GoogleTokenError {
	error: string;
	error_description?: string;
}

export class OAuthManager {
	private plugin: Plugin;
	private clientId: string;
	private accessToken: string | null = null;
	private refreshToken: string | null = null;
	private expiresAt = 0;
	private authServer: http.Server | null = null;
	private onTokenChange: ((token: string) => void) | null = null;

	constructor(plugin: Plugin, clientId: string) {
		this.plugin = plugin;
		this.clientId = clientId;
	}

	get isAuthenticated(): boolean {
		return this.refreshToken !== null;
	}

	get currentAccessToken(): string | null {
		return this.accessToken;
	}

	setOnTokenChange(callback: (token: string) => void): void {
		this.onTokenChange = callback;
	}

	restoreFromToken(token: string): void {
		if (token) {
			this.refreshToken = token;
			logger.info('OAuth refresh token restored from settings');
		}
	}

	async startAuthFlow(): Promise<OAuthTokens> {
		if (!this.clientId) {
			throw createSyncError('token_revoked', 'Google Client ID is not configured — check src/config.ts');
		}

		const verifier = generateCodeVerifier();
		const challenge = await computeCodeChallenge(verifier);

		const { port, redirectUri } = await this.startCallbackServer(verifier);

		const authUrl = new URL(GOOGLE_AUTH_URL);
		authUrl.searchParams.set('client_id', this.clientId);
		authUrl.searchParams.set('redirect_uri', redirectUri);
		authUrl.searchParams.set('response_type', 'code');
		authUrl.searchParams.set('scope', SCOPES);
		authUrl.searchParams.set('code_challenge', challenge);
		authUrl.searchParams.set('code_challenge_method', 'S256');
		authUrl.searchParams.set('access_type', 'offline');
		authUrl.searchParams.set('prompt', 'consent');

		logger.info('OAuth flow starting');
		logger.info(`Redirect URI: ${redirectUri}`);
		window.open(authUrl.toString());
		logger.info(`OAuth browser opened on port ${port}`);

		return new Promise((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				this.stopCallbackServer();
				reject(createSyncError('token_expired', 'OAuth flow timed out after 3 minutes'));
			}, OAUTH_TIMEOUT_MS);

			this.onAuthCallback = async (code: string) => {
				window.clearTimeout(timeout);
				try {
					const tokens = await this.exchangeCodeForTokens(code, verifier, redirectUri);
					this.storeTokens(tokens);
					resolve(tokens);
				} catch (err) {
					reject(err);
				} finally {
					this.stopCallbackServer();
				}
			};
		});
	}

	private onAuthCallback: ((code: string) => void) | null = null;

	private startCallbackServer(verifier: string): Promise<{ port: number; redirectUri: string }> {
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				const reqUrl = req.url ?? '/';

				if (!reqUrl.startsWith('/callback')) {
					res.writeHead(204);
					res.end();
					return;
				}

				logger.info(`OAuth callback received: ${reqUrl}`);
				const url = new URL(reqUrl, `http://localhost`);
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');
				const errorDescription = url.searchParams.get('error_description');

				res.writeHead(200, { 'Content-Type': 'text/html' });
				if (error) {
					const safeError = escapeHtml(error);
					const safeDesc = escapeHtml(errorDescription ?? 'Unknown error');
					res.end(`<html><body><h1>Authorization failed</h1><p>${safeError}: ${safeDesc}</p><p>You can close this window.</p></body></html>`);
					logger.error(`OAuth callback error: ${error} — ${errorDescription ?? 'no description'}`);
				} else if (code) {
					res.end('<html><body><h1>Connected!</h1><p>You can close this window and return to Obsidian.</p></body></html>');
					logger.info(`OAuth callback received authorization code (${code.length} chars)`);
					this.onAuthCallback?.(code);
				} else {
					logger.warn(`OAuth callback at /callback but no code param — full URL: ${reqUrl}`);
					res.end('<html><body><h1>Unexpected response</h1></body></html>');
				}
			});

			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				if (address && typeof address !== 'string') {
					this.authServer = server;
					const port = address.port;
					resolve({ port, redirectUri: `http://127.0.0.1:${port}/callback` });
				} else {
					reject(createSyncError('network_timeout', 'Failed to start OAuth callback server'));
				}
			});

			server.on('error', (err) => {
				reject(createSyncError('network_timeout', `OAuth callback server error: ${err.message}`));
			});
		});
	}

	private stopCallbackServer(): void {
		if (this.authServer) {
			this.authServer.close();
			this.authServer = null;
		}
		this.onAuthCallback = null;
	}

	private async exchangeCodeForTokens(
		code: string,
		verifier: string,
		redirectUri: string
	): Promise<OAuthTokens> {
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: GOOGLE_CLIENT_SECRET,
			code,
			code_verifier: verifier,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri,
		});

		logger.info('Token exchange — POST to Google token endpoint');

		// Use fetch-style approach: make the request without letting requestUrl throw on non-2xx
		// by catching and extracting the response body from the error
		let tokenData: GoogleTokenResponse;
		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
				throw: false,
			});

			logger.info(`Token exchange response status: ${response.status}`);

			if (response.status >= 400) {
				const errorData = response.json as GoogleTokenError;
				logger.error(`Token exchange failed with status ${response.status}`);
				logger.error(`Google error: ${errorData.error} — ${errorData.error_description ?? 'no description'}`);
				logger.error(`Sent client_id: ${this.clientId}`);
				logger.error(`Sent redirect_uri: ${redirectUri}`);
				throw createSyncError('token_revoked', `Google OAuth error: ${errorData.error_description ?? errorData.error}`);
			}

			tokenData = response.json as GoogleTokenResponse;
		} catch (err) {
			if (err && typeof err === 'object' && 'type' in err) {throw err;}
			const msg = errorMessage(err);
			logger.error(`Token exchange request failed: ${msg}`);
			logger.error(`Sent client_id: ${this.clientId}`);
			logger.error(`Sent redirect_uri: ${redirectUri}`);
			logger.error(`Tip: check GCP Console — OAuth client must be type "Desktop app", not "Web application"`);
			throw createSyncError('token_revoked', `Token exchange failed (${msg})`);
		}

		if (!tokenData.access_token || !tokenData.refresh_token) {
			logger.error('Token response missing required fields');
			throw createSyncError('token_revoked', `Token exchange incomplete — missing ${!tokenData.access_token ? 'access_token' : 'refresh_token'}`);
		}

		logger.info('Token exchange successful — got access_token + refresh_token');

		return {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
			expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
		};
	}

	async getValidAccessToken(): Promise<string> {
		if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
			return this.accessToken;
		}

		if (!this.refreshToken) {
			throw createSyncError('token_revoked', 'No refresh token available — reconnect in settings');
		}

		return this.refreshAccessToken();
	}

	private async refreshAccessToken(): Promise<string> {
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: GOOGLE_CLIENT_SECRET,
			refresh_token: this.refreshToken!,
			grant_type: 'refresh_token',
		});

		try {
			const response = await requestUrl({
				url: GOOGLE_TOKEN_URL,
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			});

			const tokenData = response.json as GoogleTokenResponse;
			if (!tokenData.access_token) {
				throw new Error('No access token in refresh response');
			}

			this.accessToken = tokenData.access_token;
			this.expiresAt = Date.now() + (tokenData.expires_in ?? 3600) * 1000;

			logger.info('Access token refreshed successfully');
			return this.accessToken;
		} catch {
			this.accessToken = null;
			this.refreshToken = null;
			this.onTokenChange?.('');
			throw createSyncError('token_revoked', 'Refresh token revoked — reconnect in settings');
		}
	}

	private storeTokens(tokens: OAuthTokens): void {
		this.accessToken = tokens.accessToken;
		this.refreshToken = tokens.refreshToken;
		this.expiresAt = tokens.expiresAt;
		this.onTokenChange?.(tokens.refreshToken);
		logger.info('Refresh token stored');
	}

	disconnect(): void {
		this.accessToken = null;
		this.refreshToken = null;
		this.expiresAt = 0;
		this.stopCallbackServer();
		this.onTokenChange?.('');
		logger.info('OAuth tokens cleared');
	}

	cleanup(): void {
		this.stopCallbackServer();
	}
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
