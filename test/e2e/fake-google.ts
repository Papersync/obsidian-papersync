import * as http from 'http';
import * as crypto from 'crypto';
import { GOOGLE_SCANS_FOLDER } from '../../src/config';

// Hand-rolled fake Google (OAuth issuer + Drive v3 subset) for the wdio E2E lane.
// Runs on the wdio-worker (Node) side; the Obsidian process reaches it over
// loopback via the plugin's undocumented `endpointOverrides` settings seam.
// Never imported by src/, never bundled into main.js.
//
// Faithfulness bar: Google-shaped JSON on success AND error, a real PKCE S256
// verification on the authorization_code grant (the lane must prove the plugin's
// PKCE code, not bypass it), and the exact Drive v3 query subset drive-backend.ts
// emits (folder-chain lookup, list-by-parent with createdTime filter + pagination,
// alt=media download, uploadType=media PATCH).

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface RecordedRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: string;
	authorization: string;
	responseStatus: number;
}

interface DriveNode {
	id: string;
	name: string;
	mimeType: string;
	parentId: string; // 'root' at the top of the chain
	createdTime: string;
	// Bumped by every PATCH, like Drive's own modifiedTime.
	modifiedTime: string;
	content: Buffer;
}

interface PendingCode {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
}

interface TokenFault {
	status: number;
	body: Record<string, unknown>;
}

interface PageSnapshot {
	files: Array<{ id: string; name: string; createdTime: string; modifiedTime: string }>;
	offset: number;
}

function s256(verifier: string): string {
	return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): number {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
	return status;
}

// Google's two error shapes: OAuth token errors are flat ({error, error_description});
// Drive API errors are nested ({error: {code, message, status}}).
function sendOAuthError(res: http.ServerResponse, status: number, error: string, description: string): number {
	return sendJson(res, status, { error, error_description: description });
}

function sendDriveError(res: http.ServerResponse, status: number, message: string, statusText: string): number {
	return sendJson(res, status, { error: { code: status, message, status: statusText } });
}

export class FakeGoogle {
	private server: http.Server | null = null;
	port = 0;
	readonly requests: RecordedRequest[] = [];

	private pendingCodes = new Map<string, PendingCode>();
	private accessTokens = new Set<string>();
	private refreshTokens = new Set<string>();
	// Every token POSTed to /revoke, in order — the disconnect-revoke spec asserts on this.
	readonly revokedTokens: string[] = [];
	private files = new Map<string, DriveNode>();
	private nextTokenFault: TokenFault | null = null;
	// The OAuth error the NEXT authorization request returns to the plugin's
	// callback instead of a code (the user pressing Cancel on Google's consent page).
	private nextConsentError: string | null = null;
	// Page tokens reference a snapshot of the result set taken at the FIRST page, so
	// a seed landing mid-pagination can never skip or duplicate entries the way a
	// bare mutable offset would.
	private pageTokens = new Map<string, PageSnapshot>();
	private seq = 0;

	get origin(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	// The values a spec writes into settings.endpointOverrides.
	get endpointOverrides(): { authUrl: string; tokenUrl: string; revokeUrl: string; driveApiBase: string; driveUploadBase: string } {
		return {
			authUrl: `${this.origin}/o/oauth2/auth`,
			tokenUrl: `${this.origin}/token`,
			revokeUrl: `${this.origin}/revoke`,
			driveApiBase: `${this.origin}/drive/v3`,
			driveUploadBase: `${this.origin}/upload/drive/v3`,
		};
	}

	async start(): Promise<void> {
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((resolve, reject) => {
			this.server!.on('error', reject);
			this.server!.listen(0, '127.0.0.1', () => {
				const address = this.server!.address();
				if (address && typeof address !== 'string') {
					this.port = address.port;
					resolve();
				} else {
					reject(new Error('fake-google failed to bind'));
				}
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) { return; }
		// close() only resolves once every keep-alive connection drains — sever them
		// so stop() can never hang the suite teardown.
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.server = null;
	}

	// ---- test controls -------------------------------------------------------

	/** Fail the NEXT /token request (any grant) with a canned status + body. */
	failNextTokenRequest(status: number, body: Record<string, unknown>): void {
		this.nextTokenFault = { status, body };
	}

	/**
	 * Drop any armed-but-unconsumed fault. afterEach hygiene: a fault stranded by a
	 * failed test (mocha retries re-run it) would otherwise poison the next token
	 * request that happens to arrive.
	 */
	clearFaults(): void {
		this.nextTokenFault = null;
		this.nextConsentError = null;
	}

	/** The NEXT consent page is declined: Google redirects with error=<error> and the state. */
	denyNextConsent(error = 'access_denied'): void {
		this.nextConsentError = error;
	}

	/** Mint a refresh token the fake accepts, for specs that seed a connected state directly. */
	issueRefreshToken(): string {
		const token = `refresh-${crypto.randomBytes(12).toString('hex')}`;
		this.refreshTokens.add(token);
		return token;
	}

	clearRequests(): void {
		this.requests.length = 0;
	}

	tokenRequests(): Array<RecordedRequest & { params: URLSearchParams }> {
		return this.requests
			.filter((r) => r.path === '/token')
			.map((r) => ({ ...r, params: new URLSearchParams(r.body) }));
	}

	driveListRequests(): RecordedRequest[] {
		return this.requests.filter((r) => r.method === 'GET' && r.path === '/drive/v3/files');
	}

	isIssuedAccessToken(bearer: string): boolean {
		return this.accessTokens.has(bearer.replace(/^Bearer /, ''));
	}

	/** Create the GOOGLE_SCANS_FOLDER folder ('Papersync') and return the leaf folder id. */
	seedScansFolder(): string {
		let parentId = 'root';
		for (const part of GOOGLE_SCANS_FOLDER.split('/')) {
			const existing = [...this.files.values()].find(
				(f) => f.mimeType === FOLDER_MIME && f.name === part && f.parentId === parentId
			);
			if (existing) {
				parentId = existing.id;
				continue;
			}
			const id = `folder-${++this.seq}`;
			this.files.set(id, {
				id, name: part, mimeType: FOLDER_MIME, parentId,
				createdTime: new Date().toISOString(), modifiedTime: new Date().toISOString(), content: Buffer.alloc(0),
			});
			parentId = id;
		}
		return parentId;
	}

	/** Seed an unsynced scan (<base>.json + <base>.jpg) into the scans folder. */
	seedScan(baseName: string, scan: Record<string, unknown>, image: Buffer, createdTime?: string): { jsonId: string; imageId: string } {
		return this.seedRawScan(baseName, JSON.stringify(scan, null, 2), image, createdTime);
	}

	/** Same as seedScan with the JSON file's bytes as given (a corrupt or future-format scan). */
	seedRawScan(baseName: string, json: string, image: Buffer, createdTime?: string): { jsonId: string; imageId: string } {
		const folderId = this.seedScansFolder();
		const time = createdTime ?? new Date().toISOString();
		const jsonId = `file-${++this.seq}`;
		this.files.set(jsonId, {
			id: jsonId, name: `${baseName}.json`, mimeType: 'application/json', parentId: folderId,
			createdTime: time, modifiedTime: time, content: Buffer.from(json),
		});
		const imageId = `file-${++this.seq}`;
		this.files.set(imageId, {
			id: imageId, name: `${baseName}.jpg`, mimeType: 'image/jpeg', parentId: folderId,
			createdTime: time, modifiedTime: time, content: image,
		});
		return { jsonId, imageId };
	}

	/** Every alt=media download of one file, in order. */
	downloadsOf(id: string): RecordedRequest[] {
		return this.requests.filter((r) => r.method === 'GET' && r.path === `/drive/v3/files/${id}`);
	}

	fileJson(id: string): unknown {
		const node = this.files.get(id);
		if (!node) { throw new Error(`fake-google: no file ${id}`); }
		return JSON.parse(node.content.toString('utf-8'));
	}

	// ---- request handling ----------------------------------------------------

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		// A client abort mid-request emits 'error'; without a listener node throws
		// and takes the whole wdio worker down with it.
		req.on('error', () => { /* aborted request — nothing to serve or record */ });
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const url = new URL(req.url ?? '/', this.origin);
			const query: Record<string, string> = {};
			url.searchParams.forEach((v, k) => { query[k] = v; });

			// A handler bug must ANSWER the plugin's request (not hang it until the
			// spec times out): degrade to a Google-shaped 500 and still record it.
			let status: number;
			try {
				status = this.route(req, res, url.pathname, query, body);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (res.headersSent) {
					res.end();
					status = 500;
				} else {
					status = sendDriveError(res, 500, `fake-google internal error: ${message}`, 'INTERNAL');
				}
			}

			this.requests.push({
				method: req.method ?? '',
				path: url.pathname,
				query,
				body: body.toString('utf-8'),
				authorization: req.headers.authorization ?? '',
				responseStatus: status,
			});
		});
	}

	private route(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		path: string,
		query: Record<string, string>,
		body: Buffer
	): number {
		const method = req.method ?? '';

		if (method === 'GET' && path === '/o/oauth2/auth') {
			return this.handleAuth(res, query);
		}
		if (method === 'POST' && path === '/token') {
			return this.handleToken(res, body.toString('utf-8'));
		}
		if (method === 'POST' && path === '/revoke') {
			return this.handleRevoke(res, body.toString('utf-8'));
		}

		// Everything under /drive and /upload requires a Bearer token we issued.
		if (path.startsWith('/drive/') || path.startsWith('/upload/')) {
			const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
			if (!this.accessTokens.has(bearer)) {
				return sendDriveError(res, 401, 'Invalid Credentials', 'UNAUTHENTICATED');
			}
		}

		if (method === 'GET' && path === '/drive/v3/files') {
			return this.handleList(res, query);
		}
		const getMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (method === 'GET' && getMatch) {
			return this.handleGetFile(res, getMatch[1]!, query);
		}
		const patchMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path);
		if (method === 'PATCH' && patchMatch) {
			return this.handlePatchFile(res, patchMatch[1]!, query, body);
		}

		return sendDriveError(res, 404, `Unknown fake-google route: ${method} ${path}`, 'NOT_FOUND');
	}

	// GET /o/oauth2/auth — validates the real PKCE authorization request the plugin
	// builds, then 302s the one-time code back to the plugin's loopback callback.
	private handleAuth(res: http.ServerResponse, q: Record<string, string>): number {
		if (!q.client_id) {
			return sendOAuthError(res, 400, 'invalid_request', 'client_id missing');
		}
		if (!q.redirect_uri || !q.redirect_uri.startsWith('http://127.0.0.1:')) {
			return sendOAuthError(res, 400, 'invalid_request', 'redirect_uri missing or not loopback');
		}
		if (q.response_type !== 'code') {
			return sendOAuthError(res, 400, 'invalid_request', 'response_type must be code');
		}
		if (!q.code_challenge) {
			return sendOAuthError(res, 400, 'invalid_request', 'code_challenge missing');
		}
		if (q.code_challenge_method !== 'S256') {
			return sendOAuthError(res, 400, 'invalid_request', 'code_challenge_method must be S256');
		}

		if (this.nextConsentError) {
			const error = this.nextConsentError;
			this.nextConsentError = null;
			const denied = new URL(q.redirect_uri);
			denied.searchParams.set('error', error);
			if (q.state) {
				denied.searchParams.set('state', q.state);
			}
			res.writeHead(302, { Location: denied.toString() });
			res.end();
			return 302;
		}

		const code = `code-${crypto.randomBytes(12).toString('hex')}`;
		this.pendingCodes.set(code, {
			clientId: q.client_id,
			redirectUri: q.redirect_uri,
			codeChallenge: q.code_challenge,
		});

		// Build the redirect through the URL API (never string-append `?code=`): a
		// redirect_uri that already carries a query or fragment stays well-formed.
		const location = new URL(q.redirect_uri);
		location.searchParams.set('code', code);
		// Google echoes the request's state; the plugin ignores a callback without it.
		if (q.state) {
			location.searchParams.set('state', q.state);
		}
		res.writeHead(302, { Location: location.toString() });
		res.end();
		return 302;
	}

	private handleToken(res: http.ServerResponse, rawBody: string): number {
		if (this.nextTokenFault) {
			const fault = this.nextTokenFault;
			this.nextTokenFault = null;
			return sendJson(res, fault.status, fault.body);
		}

		const params = new URLSearchParams(rawBody);
		const grantType = params.get('grant_type');

		if (grantType === 'authorization_code') {
			const code = params.get('code') ?? '';
			const pending = this.pendingCodes.get(code);
			this.pendingCodes.delete(code); // single use, even on failure
			if (!pending) {
				return sendOAuthError(res, 400, 'invalid_grant', 'Unknown or already-used authorization code');
			}
			if (params.get('client_id') !== pending.clientId) {
				return sendOAuthError(res, 400, 'invalid_client', 'client_id does not match the authorization request');
			}
			if (params.get('redirect_uri') !== pending.redirectUri) {
				return sendOAuthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
			}
			// The PKCE guard this lane exists to prove: S256(code_verifier) must equal
			// the code_challenge captured at the authorization step.
			const verifier = params.get('code_verifier') ?? '';
			if (s256(verifier) !== pending.codeChallenge) {
				return sendOAuthError(res, 400, 'invalid_grant', 'PKCE verification failed: code_verifier does not match code_challenge');
			}

			const accessToken = `access-${crypto.randomBytes(12).toString('hex')}`;
			const refreshToken = `refresh-${crypto.randomBytes(12).toString('hex')}`;
			this.accessTokens.add(accessToken);
			this.refreshTokens.add(refreshToken);
			return sendJson(res, 200, {
				access_token: accessToken,
				refresh_token: refreshToken,
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'https://www.googleapis.com/auth/drive.file',
			});
		}

		if (grantType === 'refresh_token') {
			const refreshToken = params.get('refresh_token') ?? '';
			if (!this.refreshTokens.has(refreshToken)) {
				return sendOAuthError(res, 400, 'invalid_grant', 'Unknown refresh token');
			}
			const accessToken = `access-${crypto.randomBytes(12).toString('hex')}`;
			this.accessTokens.add(accessToken);
			return sendJson(res, 200, {
				access_token: accessToken,
				expires_in: 3600,
				token_type: 'Bearer',
				scope: 'https://www.googleapis.com/auth/drive.file',
			});
		}

		return sendOAuthError(res, 400, 'unsupported_grant_type', `grant_type ${grantType ?? '(none)'} not supported`);
	}

	// POST /revoke — Google's revocation endpoint (RFC 7009). Records the token, then
	// invalidates it (a refresh grant on it afterward would 400 invalid_grant, matching
	// Google's contract). Success is an empty 200; a missing token param is a 400.
	private handleRevoke(res: http.ServerResponse, rawBody: string): number {
		const token = new URLSearchParams(rawBody).get('token') ?? '';
		if (!token) {
			return sendOAuthError(res, 400, 'invalid_request', 'token parameter missing');
		}
		this.revokedTokens.push(token);
		this.refreshTokens.delete(token);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end('');
		return 200;
	}

	// GET /drive/v3/files — the two query shapes drive-backend.ts emits:
	//   folder lookup:  name = 'X' and '<parent>' in parents and mimeType = '...folder' and trashed = false
	//   list children:  '<parent>' in parents and trashed = false [and createdTime > '<ts>']
	// Anything else is a 400 so a drifted query fails loudly instead of silently matching.
	private handleList(res: http.ServerResponse, q: Record<string, string>): number {
		const query = q.q ?? '';

		const folderLookup = new RegExp(
			`^name = '([^']+)' and '([^']+)' in parents and mimeType = '${FOLDER_MIME.replace(/[.]/g, '\\.')}' and trashed = false$`
		).exec(query);
		if (folderLookup) {
			const [, name, parentId] = folderLookup;
			const matches = [...this.files.values()]
				.filter((f) => f.mimeType === FOLDER_MIME && f.name === name && f.parentId === parentId)
				.map((f) => ({ id: f.id }));
			return sendJson(res, 200, { files: matches });
		}

		const listChildren = /^'([^']+)' in parents and trashed = false( and createdTime > '([^']+)')?$/.exec(query);
		if (listChildren) {
			const pageSize = Math.max(1, parseInt(q.pageSize ?? '100', 10) || 100);

			let files: PageSnapshot['files'];
			let offset = 0;
			if (q.pageToken) {
				// Continue from the snapshot the first page took (single-use token).
				const snapshot = this.pageTokens.get(q.pageToken);
				if (!snapshot) {
					return sendDriveError(res, 400, `Invalid pageToken: ${q.pageToken}`, 'INVALID_ARGUMENT');
				}
				this.pageTokens.delete(q.pageToken);
				({ files, offset } = snapshot);
			} else {
				const parentId = listChildren[1]!;
				const after = listChildren[3];
				let children = [...this.files.values()]
					.filter((f) => f.parentId === parentId)
					.sort((a, b) => a.createdTime.localeCompare(b.createdTime)); // orderBy=createdTime
				if (after) {
					children = children.filter((f) => f.createdTime > after);
				}
				files = children.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, modifiedTime: f.modifiedTime }));
			}

			const payload: { files: PageSnapshot['files']; nextPageToken?: string } = {
				files: files.slice(offset, offset + pageSize),
			};
			if (offset + pageSize < files.length) {
				const token = `page-${crypto.randomBytes(8).toString('hex')}`;
				this.pageTokens.set(token, { files, offset: offset + pageSize });
				payload.nextPageToken = token;
			}
			return sendJson(res, 200, payload);
		}

		return sendDriveError(res, 400, `Unrecognized query: ${query}`, 'INVALID_ARGUMENT');
	}

	private handleGetFile(res: http.ServerResponse, id: string, q: Record<string, string>): number {
		const node = this.files.get(id);
		if (!node) {
			return sendDriveError(res, 404, `File not found: ${id}`, 'NOT_FOUND');
		}
		if (q.alt !== 'media') {
			return sendDriveError(res, 400, 'Only alt=media is supported by fake-google', 'INVALID_ARGUMENT');
		}
		res.writeHead(200, { 'Content-Type': node.mimeType });
		res.end(node.content);
		return 200;
	}

	private handlePatchFile(res: http.ServerResponse, id: string, q: Record<string, string>, body: Buffer): number {
		const node = this.files.get(id);
		if (!node) {
			return sendDriveError(res, 404, `File not found: ${id}`, 'NOT_FOUND');
		}
		if (q.uploadType !== 'media') {
			return sendDriveError(res, 400, 'Only uploadType=media is supported by fake-google', 'INVALID_ARGUMENT');
		}
		node.content = Buffer.from(body);
		node.modifiedTime = new Date().toISOString();
		return sendJson(res, 200, { id: node.id, name: node.name });
	}
}
