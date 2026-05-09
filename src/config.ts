export const GOOGLE_CLIENT_ID = '344492494845-k6l29jvbpact44a873vjbl2pv9i46ndt.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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'; // Not actually secret for Desktop apps — shipped in binary
export const GOOGLE_SCANS_FOLDER = 'PaperSync/scans';
export const DEFAULT_POLL_INTERVAL_S = 30;
export const MAX_RETRIES = 2;
export const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
declare const __DEV_MODE__: boolean;
export const DEV_MODE: boolean = typeof __DEV_MODE__ !== 'undefined' ? __DEV_MODE__ : false;
