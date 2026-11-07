import { DEFAULT_SETTINGS } from '@/settings';
import type { BackendType, PluginSettings } from '@/settings';
import { clampPollInterval } from '@/utils/poll-interval';
import type { SaveTo } from '@/notes/scan-destination';

const BACKEND_TYPES: readonly BackendType[] = ['drive', 'folder', 'none'];
const SAVE_TO: readonly SaveTo[] = ['', 'daily', 'custom'];
// The Drive cursor goes into a Drive query, so only Drive's own RFC 3339 form
// (as the scan createdTime it was copied from) is accepted.
const DRIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Settings from data.json (after migration), field by field: a value of the wrong
 * type or out of range falls back to its default. data.json travels with the vault
 * (other devices, other versions, hand edits, merge conflicts), so it is never
 * trusted as is. Unknown keys are dropped.
 */
export function sanitizeSettings(raw: Record<string, unknown>): PluginSettings {
	const settings: PluginSettings = { ...DEFAULT_SETTINGS };
	const target = settings as unknown as Record<string, unknown>;
	for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
		const value = raw[key];
		if (typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value))) {
			target[key] = value;
		}
	}
	if (!BACKEND_TYPES.includes(settings.backendType)) {
		settings.backendType = DEFAULT_SETTINGS.backendType;
	}
	// Unknown = not chosen: first setup picks it again.
	if (!SAVE_TO.includes(settings.saveTo)) {
		settings.saveTo = DEFAULT_SETTINGS.saveTo;
	}
	settings.drivePollInterval = clampPollInterval(raw.drivePollInterval);
	if (!DRIVE_TIMESTAMP.test(settings.lastSyncTimestamp)) {
		settings.lastSyncTimestamp = DEFAULT_SETTINGS.lastSyncTimestamp;
	}
	if (settings.lastSyncAt < 0) {
		settings.lastSyncAt = DEFAULT_SETTINGS.lastSyncAt;
	}
	return settings;
}
