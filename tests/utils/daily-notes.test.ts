import { formatDateWithPattern, getDailyNotesConfig } from '@/utils/daily-notes';

describe('formatDateWithPattern', () => {
	const date = new Date('2026-04-12T14:30:00.000Z');

	it('formats YYYY-MM-DD', () => {
		expect(formatDateWithPattern(date, 'YYYY-MM-DD')).toBe('2026-04-12');
	});

	it('formats YYYY/MM/DD', () => {
		expect(formatDateWithPattern(date, 'YYYY/MM/DD')).toBe('2026/04/12');
	});

	it('formats YY-MM-DD', () => {
		expect(formatDateWithPattern(date, 'YY-MM-DD')).toBe('26-04-12');
	});

	it('formats folder path with date tokens', () => {
		expect(formatDateWithPattern(date, 'Journal/YYYY/MM')).toBe('Journal/2026/04');
	});

	it('handles plain text without tokens', () => {
		expect(formatDateWithPattern(date, 'MyNotes')).toBe('MyNotes');
	});

	it('handles mixed tokens and text', () => {
		expect(formatDateWithPattern(date, 'Notes-YYYY-MM')).toBe('Notes-2026-04');
	});

	it('formats single digit month with M', () => {
		const jan = new Date('2026-01-05T00:00:00.000Z');
		expect(formatDateWithPattern(jan, 'YYYY/M/D')).toBe('2026/1/5');
	});

	it('formats double digit month with MM', () => {
		const jan = new Date('2026-01-05T00:00:00.000Z');
		expect(formatDateWithPattern(jan, 'YYYY/MM/DD')).toBe('2026/01/05');
	});
});

describe('getDailyNotesConfig', () => {
	it('returns defaults when daily notes plugin is not available', () => {
		const mockApp = { internalPlugins: { getPluginById: () => null } };
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('');
		expect(config.format).toBe('YYYY-MM-DD');
	});

	it('returns defaults when internalPlugins is not available', () => {
		const mockApp = {};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('');
		expect(config.format).toBe('YYYY-MM-DD');
	});

	it('reads folder and format from daily notes plugin', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: (id: string) =>
					id === 'daily-notes'
						? { enabled: true, instance: { options: { folder: 'Journal', format: 'YYYY/MM/DD' } } }
						: null,
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('Journal');
		expect(config.format).toBe('YYYY/MM/DD');
	});

	it('strips trailing slashes from folder', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => ({
					enabled: true,
					instance: { options: { folder: 'Journal/' } },
				}),
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('Journal');
	});

	it('returns default format when daily notes format is empty', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => ({
					enabled: true,
					instance: { options: { folder: 'Notes', format: '' } },
				}),
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.format).toBe('YYYY-MM-DD');
	});

	it('returns defaults when plugin is disabled', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => ({ enabled: false }),
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('');
	});
});
