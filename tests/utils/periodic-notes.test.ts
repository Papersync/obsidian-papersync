import { readPeriodicDailySettings } from '@/utils/periodic-notes';

const appWith = (plugin: unknown, enabled = true): never => ({
	plugins: {
		enabledPlugins: new Set(enabled ? ['periodic-notes'] : []),
		getPlugin: (id: string) => (id === 'periodic-notes' ? plugin : null),
	},
}) as never;

describe('readPeriodicDailySettings', () => {
	it('reads the 0.0.17 daily folder and format', () => {
		const app = appWith({ settings: { daily: { enabled: true, folder: 'Journal/Daily', format: 'YYYY-MM-DD dddd' } } });

		expect(readPeriodicDailySettings(app)).toEqual({ folder: 'Journal/Daily', format: 'YYYY-MM-DD dddd' });
	});

	it('treats a missing folder and format as empty', () => {
		expect(readPeriodicDailySettings(appWith({ settings: { daily: { enabled: true } } }))).toEqual({ folder: '', format: '' });
	});

	it('ignores a missing plugin manager or plugin', () => {
		expect(readPeriodicDailySettings({} as never)).toBeNull();
		expect(readPeriodicDailySettings({ plugins: { enabledPlugins: new Set(['periodic-notes']) } } as never)).toBeNull();
		expect(readPeriodicDailySettings(appWith(null))).toBeNull();
	});

	it('ignores a disabled plugin', () => {
		const app = appWith({ settings: { daily: { enabled: true, folder: 'J', format: 'YYYY' } } }, false);

		expect(readPeriodicDailySettings(app)).toBeNull();
	});

	it('ignores daily notes turned off in Periodic Notes', () => {
		expect(readPeriodicDailySettings(appWith({ settings: { daily: { enabled: false, folder: 'J' } } }))).toBeNull();
	});

	it.each([
		['a non-string folder', { daily: { enabled: true, folder: 7, format: 'YYYY' } }],
		['a non-string format', { daily: { enabled: true, folder: 'J', format: null } }],
		['a truthy non-boolean enabled', { daily: { enabled: 'yes' } }],
		['the 1.0 beta calendar sets', { calendarSets: [{ id: 'default', day: { enabled: true, folder: 'J', format: 'YYYY' } }] }],
		['no settings object', undefined],
	])('ignores %s', (_label, settings) => {
		expect(readPeriodicDailySettings(appWith({ settings }))).toBeNull();
	});

	it('ignores a plugin whose settings throw', () => {
		const plugin = { get settings(): unknown { throw new Error('boom'); } };

		expect(readPeriodicDailySettings(appWith(plugin))).toBeNull();
	});
});
