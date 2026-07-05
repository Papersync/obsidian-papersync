export const GOOGLE_CLIENT_ID =
	'401509475922-fev7sp7c5t4og4di9htk3av4kri08clv.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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';
export const GOOGLE_SCANS_FOLDER = 'PaperSync/scans';
export const DEFAULT_POLL_INTERVAL_S = 30;
export const MAX_RETRIES = 2;
export const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
declare const __DEV_MODE__: boolean;
export const DEV_MODE: boolean = typeof __DEV_MODE__ !== 'undefined' ? __DEV_MODE__ : false;
