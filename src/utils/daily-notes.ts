import { App } from 'obsidian';
import { logger } from '@/utils/logger';

export interface DailyNotesConfig {
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

		const options = dailyNotes.instance?.options;
		if (!options) {return DEFAULT_CONFIG;}

		const folder = (typeof options.folder === 'string' ? options.folder : DEFAULT_CONFIG.folder).replace(/\/+$/, '');
		const format = typeof options.format === 'string' && options.format ? options.format : DEFAULT_CONFIG.format;

		logger.info(`Daily notes config — folder: "${folder}", format: "${format}"`);
		return { folder, format };
	} catch {
		logger.warn('Failed to read daily notes config');
		return DEFAULT_CONFIG;
	}
}

export function formatDateWithPattern(date: Date, pattern: string): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');

	// Replace longer tokens first to avoid greedy partial matches (MM before M, DD before D)
	return pattern
		.replace(/YYYY/g, String(year))
		.replace(/YY/g, String(year).slice(2))
		.replace(/MM/g, month)
		.replace(/DD/g, day)
		.replace(/(?<![A-Za-z])M(?![A-Za-z])/g, String(date.getMonth() + 1))
		.replace(/(?<![A-Za-z])D(?![A-Za-z])/g, String(date.getDate()));
}
