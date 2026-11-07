import { moment } from 'obsidian';
import type { App } from 'obsidian';
import { logger } from '@/utils/logger';

export interface DailyNotesConfig {
	// Whether the core Daily Notes plugin is on. When it is, folder '' is the vault root.
	enabled: boolean;
	folder: string;
	format: string;
}

interface InternalPlugin {
	enabled: boolean;
	instance?: {
		options?: Record<string, unknown>;
	};
}

interface InternalPlugins {
	getPluginById(id: string): InternalPlugin | null;
}

const DEFAULT_CONFIG: DailyNotesConfig = {
	enabled: false,
	folder: '',
	format: 'YYYY-MM-DD',
};

export function getDailyNotesConfig(app: App): DailyNotesConfig {
	try {
		if (!('internalPlugins' in app)) {return DEFAULT_CONFIG;}
		const internalPlugins = app.internalPlugins as InternalPlugins;
		const dailyNotes = internalPlugins?.getPluginById('daily-notes');
		if (!dailyNotes?.enabled) {
			logger.info('Daily notes plugin not enabled — using defaults');
			return DEFAULT_CONFIG;
		}

		// Enabled without saved options means Obsidian's own defaults: vault root, YYYY-MM-DD.
		const options = dailyNotes.instance?.options;
		if (!options) {return { ...DEFAULT_CONFIG, enabled: true };}

		const folder = (typeof options.folder === 'string' ? options.folder : DEFAULT_CONFIG.folder).replace(/\/+$/, '');
		const format = typeof options.format === 'string' && options.format ? options.format : DEFAULT_CONFIG.format;

		logger.info(`Daily notes config — folder: "${folder}", format: "${format}"`);
		return { enabled: true, folder, format };
	} catch {
		logger.warn('Failed to read daily notes config');
		return DEFAULT_CONFIG;
	}
}

// obsidian.d.ts types `moment` as a namespace import that is not callable under
// esModuleInterop, although the runtime value is the moment function.
export const momentOf = moment as unknown as (date: Date) => { format(pattern: string): string };

// The date tokens a folder may hold. Each is formatted by Obsidian's moment, so
// month and weekday names follow the app language exactly as Daily notes and
// Periodic Notes write them. The alternation lists longer tokens first (MMMM
// before MMM before MM before M), so "MMMM" is the month name, never "MM" twice.
const DATE_TOKEN = /YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D/g;
const ALL_DATE_TOKENS = /^(?:YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D)+$/;

export function formatDateWithPattern(date: Date, pattern: string): string {
	const at = momentOf(date);
	// Only a run of letters made entirely of tokens is a date ("YYYY", "YYYYMMDD",
	// "MMMM"); any other word is a literal folder name, so "SUMMARY" and "ADDRESS"
	// survive. Single-letter tokens only count alone or beside a longer token ("M"
	// or "YYYYMD"), so a folder named "MD" or "DM" stays a folder name.
	return pattern.replace(/[A-Za-z]+/g, (run) =>
		ALL_DATE_TOKENS.test(run) && (run.length === 1 || /YY|MM|DD|ddd/.test(run))
			? run.replace(DATE_TOKEN, (token) => at.format(token))
			: run);
}
