export const STRINGS = {
	PLUGIN_NAME: 'PaperSync',

	STATUS_SYNCED: 'PaperSync: synced',
	STATUS_PENDING: (count: number) => `PaperSync: ${count} pending`,
	STATUS_ERROR: 'PaperSync: error',
	STATUS_OFFLINE: 'PaperSync: offline',

	CMD_SYNC_NOW: 'Sync now',
	CMD_OPEN_SETTINGS: 'Open settings',
	RIBBON_TOOLTIP: 'Sync scans now',

	NOTICE_SYNCING: (count: number) => `Syncing ${count} scans...`,
	NOTICE_SYNC_COMPLETE: (count: number) => `Synced ${count} new notes`,
	NOTICE_DOWNLOADING_OFFLOADED: 'Downloading offloaded files...',
	NOTICE_TOKEN_EXPIRED: 'Your scans are safe. Reconnect Google Drive in settings to resume syncing.',
	NOTICE_SCHEMA_MISMATCH: 'Your scan is safe in your cloud. Update PaperSync to read this newer format.',
	NOTICE_OBSIDIAN_VERSION: 'PaperSync requires Obsidian v1.11.4 or later',
	NOTICE_SECRET_STORAGE_UNAVAILABLE: "Secure storage is unavailable, so Google Drive stays connected only until you restart Obsidian. Reconnect from settings when secure storage is back.",
	NOTICE_DRIVE_PERMISSION: 'Your scans are safe in Google Drive. PaperSync lost access; check its Drive permissions.',
	NOTICE_OFFLINE: "You're offline. PaperSync will sync your scans when you're back online.",
	NOTICE_SYNC_ERROR: 'Sync paused on an error. Your scans are safe in your cloud. PaperSync will retry on the next sync.',
	NOTICE_DRIVE_403_TOKEN_REVOKED: 'Reconnect Google Drive in settings',
	NOTICE_DRIVE_403_SCOPE_DENIED: 'Your Drive permissions changed. Disconnect and reconnect Google Drive in settings to re-authorize the PaperSync scope.',
	NOTICE_DRIVE_403_UNKNOWN: 'Drive returned permission denied. Open Google Drive and verify the PaperSync folder exists and is accessible to your account.',

	SETTINGS_CONNECTED: 'Connected to Google Drive',

} as const;
