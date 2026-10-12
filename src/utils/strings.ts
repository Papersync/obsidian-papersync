export const STRINGS = {
	PLUGIN_NAME: 'Papersync',

	STATUS_SYNCED: 'Papersync: synced',
	STATUS_PENDING: (count: number) => `Papersync: ${count} pending`,
	STATUS_ERROR: 'Papersync: error',
	STATUS_OFFLINE: 'Papersync: offline',

	CMD_SYNC_NOW: 'Sync now',
	CMD_OPEN_SETTINGS: 'Open settings',
	RIBBON_TOOLTIP: 'Sync scans now',

	// Notices carry the plugin name: an Obsidian notice shows no source, so a bare
	// "Syncing..." leaves the user guessing which plugin is working.
	NOTICE_SYNCING: (count: number) => `Papersync: syncing ${count} ${count === 1 ? 'scan' : 'scans'}…`,
	NOTICE_SYNC_COMPLETE: (count: number) => `Papersync: synced ${count} new ${count === 1 ? 'note' : 'notes'}`,
	NOTICE_NOTHING_NEW: 'Papersync: all synced, nothing new',
	NOTICE_WAITING_FOR_DOWNLOAD: (count: number) => `Papersync: ${count} ${count === 1 ? 'scan' : 'scans'} waiting for download`,
	NOTICE_DOWNLOADING_OFFLOADED: 'Downloading offloaded files...',
	NOTICE_TOKEN_EXPIRED: 'Your scans are safe. Reconnect Google Drive in settings to resume syncing.',
	NOTICE_SCHEMA_MISMATCH: 'Your scan is safe in your cloud. Update Papersync to read this newer format.',
	NOTICE_OBSIDIAN_VERSION: 'Papersync requires Obsidian v1.13.4 or later',
	NOTICE_SECRET_STORAGE_UNAVAILABLE: "Secure storage is unavailable, so Google Drive stays connected only until you restart Obsidian. Reconnect from settings when secure storage is back.",
	NOTICE_DRIVE_PERMISSION: 'Your scans are safe in Google Drive. Papersync lost access; check its Drive permissions.',
	NOTICE_OFFLINE: "You're offline. Papersync will sync your scans when you're back online.",
	NOTICE_SYNC_ERROR: 'Sync paused on an error. Your scans are safe in your cloud. Papersync will retry on the next sync.',
	NOTICE_DRIVE_403_TOKEN_REVOKED: 'Reconnect Google Drive in settings',
	NOTICE_DRIVE_403_SCOPE_DENIED: 'Your Drive permissions changed. Disconnect and reconnect Google Drive in settings to re-authorize the Papersync scope.',
	NOTICE_DRIVE_403_UNKNOWN: 'Drive returned permission denied. Open Google Drive and verify the Papersync folder exists and is accessible to your account.',
	NOTICE_FOLDER_MISSING: 'Your Papersync folder is missing. Re-select or recreate it from the plugin settings.',
	SETTINGS_FOLDER_MISSING_TITLE: (name: string) => `\u26A0 Your Papersync folder "${name}" is missing`,
	SETTINGS_FOLDER_MISSING_DESC: 'Pick it again below, or reconnect the drive it lives on.',
	NOTICE_SCAN_REMOVED: 'A scan was removed from your Papersync folder before it synced.',
	NOTICE_PROVIDER_UNAVAILABLE: (name: string) => `${name} is not available on this computer. Sign in and enable it, then select it again.`,
	NOTICE_FOLDER_CREATE_FAILED: (folderPath: string) => `Could not create ${folderPath}. Check the folder permissions and try again.`,

	SETTINGS_CONNECTED: 'Connected to Google Drive',

} as const;
