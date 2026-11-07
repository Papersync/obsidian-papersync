import type { App } from 'obsidian';
import { logger } from '@/utils/logger';

export interface PeriodicDailySettings {
	folder: string;
	format: string;
}

interface CommunityPlugins {
	enabledPlugins?: Set<string>;
	getPlugin?(id: string): unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

// The Periodic Notes daily folder and format, read ONCE on first setup and copied
// into the custom fields; never followed afterwards. Best effort: only the 0.0.17
// shape `settings.daily = { enabled, folder?, format? }` is accepted, with every
// field type-checked. A missing or disabled plugin, daily notes off there, any
// other shape (the 1.0 beta's calendarSets), or a throw gives null, and the
// caller uses its defaults. Never writes to Periodic Notes.
export function readPeriodicDailySettings(app: App): PeriodicDailySettings | null {
	try {
		const plugins = (app as unknown as { plugins?: CommunityPlugins }).plugins;
		if (!plugins?.enabledPlugins?.has('periodic-notes') || typeof plugins.getPlugin !== 'function') {
			return null;
		}
		const settings: unknown = (plugins.getPlugin('periodic-notes') as { settings?: unknown } | null)?.settings;
		const daily: unknown = isRecord(settings) ? settings.daily : undefined;
		if (!isRecord(daily) || daily.enabled !== true) {
			return null;
		}
		const { folder = '', format = '' } = daily;
		if (typeof folder !== 'string' || typeof format !== 'string') {
			return null;
		}
		logger.info(`Periodic Notes daily settings found: folder "${folder}", format "${format}"`);
		return { folder, format };
	} catch {
		logger.info('Could not read Periodic Notes settings; using defaults');
		return null;
	}
}
