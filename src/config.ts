export const GOOGLE_CLIENT_ID =
	'401509475922-fev7sp7c5t4og4di9htk3av4kri08clv.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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';

// The four Google endpoints the plugin talks to. Overridable via the undocumented
// `endpointOverrides` settings seam (E2E-only — no UI ever writes it); with no
// override every URL resolves to these production values. Overrides are honored
// only for loopback URLs and never survive a plugin load — see
// src/google-endpoints.ts (resolver) and main.ts loadSettings (strip-on-load).
export interface GoogleEndpoints {
	authUrl: string;
	tokenUrl: string;
	driveApiBase: string;
	driveUploadBase: string;
}

export const DEFAULT_GOOGLE_ENDPOINTS: GoogleEndpoints = {
	authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
	tokenUrl: 'https://oauth2.googleapis.com/token',
	driveApiBase: 'https://www.googleapis.com/drive/v3',
	driveUploadBase: 'https://www.googleapis.com/upload/drive/v3',
};
export const GOOGLE_SCANS_FOLDER = 'PaperSync/scans';

// Fixed id under which the Google OAuth refresh token is kept in Obsidian's
// OS-integrated Secret Storage (app.secretStorage), NOT plaintext data.json. The id
// must be lowercase-alphanumeric-with-dashes — setSecret throws on an invalid id.
export const OAUTH_TOKEN_SECRET_ID = 'papersync-oauth-refresh-token';

export const DEFAULT_POLL_INTERVAL_S = 30;
export const MAX_RETRIES = 2;
export const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
declare const __DEV_MODE__: boolean;
export const DEV_MODE: boolean = typeof __DEV_MODE__ !== 'undefined' ? __DEV_MODE__ : false;
