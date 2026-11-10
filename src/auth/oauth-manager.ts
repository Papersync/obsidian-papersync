import { requestUrl, Plugin } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { generateCodeVerifier, computeCodeChallenge } from '@/auth/pkce';
import { logger } from '@/utils/logger';
import { errorMessage, toError } from '@/utils/error-message';
import { createSyncError } from '@/errors/sync-error';
import { isSyncError } from '@/errors/error-handler';
import { STRINGS } from '@/utils/strings';
import * as http from 'http';

import { OAUTH_TIMEOUT_MS, GOOGLE_CLIENT_SECRET } from '@/config';
import { resolveGoogleEndpoint } from '@/google-endpoints';
import type { GoogleEndpointsSupplier } from '@/google-endpoints';

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

// The rejection a pending sign-in gets when Connect is pressed again: the new
// flow replaces it, so its caller must not treat it as a failure.
export function isAuthSuperseded(err: unknown): boolean {
	return isSyncError(err) && (err as { superseded?: unknown }).superseded === true;
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
	// window.setTimeout returns a DOM number (obsidianmd/prefer-window-timers).
	private authTimeout: number | null = null;
	private onTokenChange: ((token: string) => void) | null = null;
	// The random state the pending flow sent to Google. A callback must echo it;
	// anything else reaching the loopback port (another local page probing ports)
	// is ignored.
	private expectedState: string | null = null;
	private rejectPendingFlow: ((err: Error) => void) | null = null;
	// Bumped whenever a sign-in is abandoned (Connect pressed again, Disconnect,
	// unload). A token exchange still in flight for an older flow then neither
	// stores its tokens nor closes the newer flow's callback server.
	private flowGeneration = 0;
	// Bumped whenever the stored credentials change (a sign-in, Disconnect, a
	// restore). A token refresh that started before then drops its answer.
	private credentialGeneration = 0;
	private endpointsSupplier: GoogleEndpointsSupplier | undefined;

	constructor(plugin: Plugin, clientId: string, endpointsSupplier?: GoogleEndpointsSupplier) {
		this.plugin = plugin;
		this.clientId = clientId;
		this.endpointsSupplier = endpointsSupplier;
	}

	// Resolved at CALL time (the manager is built at plugin load, before an E2E spec
	// can write settings.endpointOverrides) through the shared loopback-gated resolver
	// (non-loopback / malformed / empty overrides fall back to production defaults).
	private endpoint(key: 'authUrl' | 'tokenUrl' | 'revokeUrl'): string {
		return resolveGoogleEndpoint(key, this.endpointsSupplier?.());
	}

	get isAuthenticated(): boolean {
		return this.refreshToken !== null;
	}

	setOnTokenChange(callback: (token: string) => void): void {
		this.onTokenChange = callback;
	}

	restoreFromToken(token: string): void {
		if (token) {
			this.credentialGeneration++;
			this.refreshToken = token;
			logger.info('OAuth refresh token restored from settings');
		}
	}

	async startAuthFlow(): Promise<OAuthTokens> {
		if (!this.clientId) {
			throw createSyncError('token_revoked', 'Google Client ID is not configured. Check src/config.ts');
		}

		// Connect pressed again: end the previous flow (its server, its timeout and
		// its promise) before starting a new one.
		this.supersedePendingFlow();

		const verifier = generateCodeVerifier();
		const challenge = await computeCodeChallenge(verifier);
		const state = generateCodeVerifier();

		const { port, redirectUri } = await this.startCallbackServer(verifier);
		this.expectedState = state;
		const flow = this.flowGeneration;

		const authUrl = new URL(this.endpoint('authUrl'));
		authUrl.searchParams.set('client_id', this.clientId);
		authUrl.searchParams.set('redirect_uri', redirectUri);
		authUrl.searchParams.set('response_type', 'code');
		authUrl.searchParams.set('scope', SCOPES);
		authUrl.searchParams.set('code_challenge', challenge);
		authUrl.searchParams.set('code_challenge_method', 'S256');
		authUrl.searchParams.set('access_type', 'offline');
		authUrl.searchParams.set('prompt', 'consent');
		authUrl.searchParams.set('state', state);

		logger.info('OAuth flow starting');
		logger.info(`Redirect URI: ${redirectUri}`);
		window.open(authUrl.toString());
		logger.info(`OAuth browser opened on port ${port}`);

		return new Promise((resolve, reject) => {
			this.rejectPendingFlow = reject;
			this.authTimeout = window.setTimeout(() => {
				this.authTimeout = null;
				this.stopCallbackServer();
				reject(createSyncError('token_expired', 'OAuth flow timed out after 3 minutes'));
			}, OAUTH_TIMEOUT_MS);

			this.onAuthCallback = (code: string) => {
				// Disarm the timeout before the (network-bound) token exchange so a slow
				// exchange can't trip the 3-minute abort mid-flight.
				this.clearAuthTimeout();
				this.rejectPendingFlow = null;
				void this.exchangeCodeForTokens(code, verifier, redirectUri)
					.then((tokens) => {
						if (flow !== this.flowGeneration) {
							logger.info('OAuth token exchange finished for an abandoned sign-in; ignored');
							throw supersededError();
						}
						this.storeTokens(tokens);
						resolve(tokens);
					})
					.catch((err: unknown) => {
						reject(toError(err));
					})
					.finally(() => {
						// A newer flow owns the server now; leave it running.
						if (flow === this.flowGeneration) {
							this.stopCallbackServer();
						}
					});
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

				const url = new URL(reqUrl, `http://localhost`);
				// Never log the query: it carries the one-time authorization code.
				logger.info(`OAuth callback received (params: ${[...url.searchParams.keys()].join(', ') || 'none'})`);
				const code = url.searchParams.get('code');
				const error = url.searchParams.get('error');
				const errorDescription = url.searchParams.get('error_description');
				const stateMatches = this.expectedState !== null && url.searchParams.get('state') === this.expectedState;

				res.writeHead(200, { 'Content-Type': 'text/html' });
				if (error) {
					const safeError = escapeHtml(error);
					const safeDesc = escapeHtml(errorDescription ?? 'Unknown error');
					res.end(`<html><body><h1>Authorization failed</h1><p>${safeError}: ${safeDesc}</p><p>You can close this window.</p></body></html>`);
					logger.error(`OAuth callback error: ${error} — ${errorDescription ?? 'no description'}`);
					// The user pressed Cancel or Deny on this sign-in: end it now rather
					// than waiting out the timeout. An error without this flow's state
					// (another local page) changes nothing.
					if (stateMatches) {
						this.endPendingFlow(createSyncError('token_revoked', STRINGS.OAUTH_SIGN_IN_ENDED(error)));
					}
				} else if (code && stateMatches) {
					res.end('<html><body><h1>Connected!</h1><p>You can close this window and return to Obsidian.</p></body></html>');
					logger.info(`OAuth callback received authorization code (${code.length} chars)`);
					// The first valid callback wins; any later one finds no state to match.
					const onCode = this.onAuthCallback;
					this.onAuthCallback = null;
					this.expectedState = null;
					onCode?.(code);
				} else {
					logger.warn(code ? 'OAuth callback ignored: its state does not match this sign-in' : 'OAuth callback at /callback without a code');
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

	private clearAuthTimeout(): void {
		if (this.authTimeout !== null) {
			window.clearTimeout(this.authTimeout);
			this.authTimeout = null;
		}
	}

	private stopCallbackServer(): void {
		this.clearAuthTimeout();
		if (this.authServer) {
			this.authServer.close();
			this.authServer = null;
		}
		this.onAuthCallback = null;
		this.expectedState = null;
		this.rejectPendingFlow = null;
	}

	// Ends the pending flow, whatever stage it is at: a flow waiting for its
	// callback is rejected as superseded, one whose token exchange is in flight is
	// rejected the same way when the exchange returns.
	private supersedePendingFlow(): void {
		this.flowGeneration++;
		this.endPendingFlow(supersededError());
	}

	// Closes the callback server and rejects the flow still waiting for it, if any.
	private endPendingFlow(error: Error): void {
		const reject = this.rejectPendingFlow;
		this.stopCallbackServer();
		if (reject) {
			logger.info(`OAuth flow ended: ${error.message}`);
			reject(error);
		}
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
				url: this.endpoint('tokenUrl'),
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
			if (isSyncError(err)) {throw err;}
			const msg = errorMessage(err);
			logger.error(`Token exchange request failed: ${msg}`);
			logger.error(`Sent client_id: ${this.clientId}`);
			logger.error(`Sent redirect_uri: ${redirectUri}`);
			logger.error(`Tip: check GCP Console — OAuth client must be type "Desktop app", not "Web application"`);
			throw createSyncError('token_revoked', `Token exchange failed (${msg})`);
		}

		if (!tokenData.access_token || !tokenData.refresh_token) {
			logger.error('Token response missing required fields');
			throw createSyncError('token_revoked', `Token exchange incomplete: missing ${!tokenData.access_token ? 'access_token' : 'refresh_token'}`);
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
			throw createSyncError('token_revoked', 'No refresh token available. Reconnect in settings');
		}

		return this.refreshAccessToken();
	}

	private async refreshAccessToken(): Promise<string> {
		const generation = this.credentialGeneration;
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: GOOGLE_CLIENT_SECRET,
			refresh_token: this.refreshToken!,
			grant_type: 'refresh_token',
		});

		// Use throw:false so a non-2xx never lands in a bare catch that nulls the stored
		// token: a transient 5xx / network blip must NOT permanently disconnect Drive.
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: this.endpoint('tokenUrl'),
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
				throw: false,
			});
		} catch (err) {
			// A genuine network failure (offline, DNS, reset) is transient — keep the
			// refresh token so the next attempt can recover.
			throw createSyncError('network_timeout', `Token refresh network error (${errorMessage(err)})`);
		}

		// Disconnected or signed in again while this refresh was out: its answer
		// belongs to credentials that are gone. Answer from the current ones.
		if (generation !== this.credentialGeneration) {
			logger.info('Token refresh finished for replaced credentials; ignored');
			return this.getValidAccessToken();
		}

		if (response.status >= 400) {
			const errorData = (jsonOrUndefined(response) ?? {}) as GoogleTokenError;
			// The ONLY definitive "reconnect" signal is invalid_grant (the refresh token
			// was actually revoked/expired). Every other 4xx/5xx is treated as transient
			// so a single bad response cannot clear the token and disconnect the user.
			if ((response.status === 400 || response.status === 401) && errorData.error === 'invalid_grant') {
				this.credentialGeneration++;
				this.accessToken = null;
				this.refreshToken = null;
				this.onTokenChange?.('');
				throw createSyncError('token_revoked', 'Refresh token revoked. Reconnect in settings');
			}
			throw createSyncError('network_timeout', `Token refresh failed (status ${response.status}); will retry`);
		}

		const tokenData = (jsonOrUndefined(response) ?? {}) as Partial<GoogleTokenResponse>;
		if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
			// A 2xx with no access_token is anomalous but transient — keep the token.
			throw createSyncError('network_timeout', 'Token refresh returned no access token; will retry');
		}

		this.accessToken = tokenData.access_token;
		const expiresIn = typeof tokenData.expires_in === 'number' && tokenData.expires_in > 0 ? tokenData.expires_in : 3600;
		this.expiresAt = Date.now() + expiresIn * 1000;

		logger.info('Access token refreshed successfully');
		return this.accessToken;
	}

	private storeTokens(tokens: OAuthTokens): void {
		this.credentialGeneration++;
		this.accessToken = tokens.accessToken;
		this.refreshToken = tokens.refreshToken;
		this.expiresAt = tokens.expiresAt;
		this.onTokenChange?.(tokens.refreshToken);
		logger.info('Refresh token stored');
	}

	// Best-effort server-side revocation of the refresh token (RFC 7009 / Google's
	// /revoke), so one call kills the long-lived credential at Google. Already-issued
	// access tokens are short-lived (~1h) and self-expire; disconnect also nulls the
	// in-memory access token locally. NEVER throws: an offline or failed revoke must
	// not block disconnect's local teardown (which now runs first) — the refresh
	// token is then left live at Google only until it expires, and any local residue
	// self-heals via refreshAccessToken's invalid_grant clear on first use.
	private async revokeToken(token: string): Promise<void> {
		try {
			const response = await requestUrl({
				url: this.endpoint('revokeUrl'),
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ token }).toString(),
				throw: false,
			});
			if (response.status >= 300) {
				logger.warn(`OAuth token revoke returned status ${response.status}; token cleared locally, may stay live at Google until expiry`);
				return;
			}
			logger.info('OAuth refresh token revoked at Google');
		} catch (err) {
			logger.warn(`OAuth token revoke request failed (${errorMessage(err)}); token cleared locally, may stay live at Google until expiry`);
		}
	}

	async disconnect(): Promise<void> {
		// Capture the token, then do the LOCAL teardown FIRST so it can never be
		// delayed by a slow or half-open revoke socket (captive portal, blackhole).
		// The user-visible disconnect + secret wipe complete immediately; the
		// best-effort server-side revocation runs afterwards with the captured value.
		const token = this.refreshToken;
		this.credentialGeneration++;
		this.accessToken = null;
		this.refreshToken = null;
		this.expiresAt = 0;
		this.supersedePendingFlow();
		this.onTokenChange?.('');
		logger.info('OAuth tokens cleared');
		if (token) {
			await this.revokeToken(token);
		}
	}

	cleanup(): void {
		this.supersedePendingFlow();
	}
}

// The rejection of a sign-in that a newer one (or Disconnect) replaced.
function supersededError(): Error {
	return Object.assign(createSyncError('token_expired', 'Sign-in was restarted'), { superseded: true });
}

// response.json is a getter that throws on a body that is not JSON (an HTML error
// page from a proxy or a captive portal).
function jsonOrUndefined(response: RequestUrlResponse): unknown {
	try {
		return response.json;
	} catch {
		return undefined;
	}
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
