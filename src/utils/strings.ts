export const STRINGS = {
	PLUGIN_NAME: 'PaperSynced',

	STATUS_SYNCED: 'PaperSynced: synced',
	STATUS_PENDING: (count: number) => `PaperSynced: ${count} pending`,
	STATUS_ERROR: 'PaperSynced: error',
	STATUS_OFFLINE: 'PaperSynced: offline',

	CMD_SYNC_NOW: 'Sync now',
	CMD_OPEN_SETTINGS: 'Open settings',

	NOTICE_SYNCING: (count: number) => `Syncing ${count} scans...`,
	NOTICE_SYNC_COMPLETE: (count: number) => `Synced ${count} new notes`,
	NOTICE_DOWNLOADING_OFFLOADED: 'Downloading offloaded files...',
	NOTICE_TOKEN_EXPIRED: 'Google Drive token expired — reconnect in settings',
	NOTICE_SCHEMA_MISMATCH: 'Scan format not recognized — update PaperSynced plugin',
	NOTICE_OBSIDIAN_VERSION: 'PaperSynced requires Obsidian v1.11.4 or later',
	NOTICE_DRIVE_PERMISSION: 'Cannot access scans — check Google Drive permissions',
	NOTICE_DRIVE_403_TOKEN_REVOKED: 'Reconnect Google Drive in settings',
	NOTICE_DRIVE_403_SCOPE_DENIED: 'Your Drive permissions changed. Disconnect and reconnect Google Drive in settings to re-authorize the PaperSynced scope.',
	NOTICE_DRIVE_403_UNKNOWN: 'Drive returned permission denied. Open Google Drive and verify the PaperSynced folder exists and is accessible to your account.',

	SETTINGS_CONNECT: 'Connect',
	SETTINGS_DISCONNECT: 'Disconnect',
	SETTINGS_CONNECTED: 'Connected to Google drive',
	SETTINGS_NOT_CONNECTED: 'Not connected',
	SETTINGS_OAUTH_WARNING:
		'Google may show an "unverified app" warning. Click "Advanced" then "Continue" to proceed safely.',
} as const;
