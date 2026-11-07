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

	it('formats run-together tokens', () => {
		expect(formatDateWithPattern(date, 'Scans/YYYYMMDD')).toBe('Scans/20260412');
	});

	it('leaves words that merely contain token letters intact', () => {
		expect(formatDateWithPattern(date, 'SUMMARY/ADDRESS/MYDD/Daily')).toBe('SUMMARY/ADDRESS/MYDD/Daily');
		expect(formatDateWithPattern(date, 'SUMMARY YYYY')).toBe('SUMMARY 2026');
	});

	it('treats digits and punctuation as token boundaries', () => {
		expect(formatDateWithPattern(date, 'Q1_YYYY.MM')).toBe('Q1_2026.04');
	});

	it('keeps folder names made only of single-letter tokens (MD, DM)', () => {
		expect(formatDateWithPattern(date, 'Notes/MD/DM/MDM')).toBe('Notes/MD/DM/MDM');
	});

	it('still formats single-letter tokens beside a longer one', () => {
		expect(formatDateWithPattern(date, 'YYYYMD')).toBe('2026412');
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

	it('returns defaults when internalPlugins is present but null (optional-chain short-circuit)', () => {
		// `'internalPlugins' in app` is true, but the value is null, so
		// `internalPlugins?.getPluginById(...)` must short-circuit to defaults.
		const config = getDailyNotesConfig({ internalPlugins: null } as any);
		expect(config).toEqual({ enabled: false, folder: '', format: 'YYYY-MM-DD' });
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
		expect(config).toEqual({ enabled: true, folder: 'Journal', format: 'YYYY/MM/DD' });
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
		expect(config.enabled).toBe(false);
		expect(config.folder).toBe('');
	});

	it('returns defaults when reading internalPlugins throws', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => {
					throw new Error('Obsidian internals exploded');
				},
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config).toEqual({ enabled: false, folder: '', format: 'YYYY-MM-DD' });
	});

	it('reports Obsidian\'s own defaults (vault root) when enabled without options', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => ({ enabled: true }), // no instance
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config).toEqual({ enabled: true, folder: '', format: 'YYYY-MM-DD' });
	});

	it('falls back to default folder when options.folder is not a string', () => {
		const mockApp = {
			internalPlugins: {
				getPluginById: () => ({
					enabled: true,
					instance: { options: { folder: 42, format: 'YYYY-MM-DD' } },
				}),
			},
		};
		const config = getDailyNotesConfig(mockApp as any);
		expect(config.folder).toBe('');
	});
});
