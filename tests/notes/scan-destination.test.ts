import {
	effectiveSaveTo,
	firstSetupDestination,
	formatFileName,
	isDateFormat,
	isFixedDestination,
	migrateNotesFolder,
	resolveNotePath,
} from '@/notes/scan-destination';
import type { ScanDestination } from '@/notes/scan-destination';

const date = new Date('2026-11-07T14:30:00.000Z'); // TZ is UTC in Jest
const dailyOn = (folder = 'Daily', format = 'YYYY-MM-DD') => ({ enabled: true, folder, format });
const dailyOff = { enabled: false, folder: '', format: 'YYYY-MM-DD' };
const custom = (customFolder: string, customFileName: string): ScanDestination => ({ saveTo: 'custom', customFolder, customFileName });
const daily: ScanDestination = { saveTo: 'daily', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' };

describe('effectiveSaveTo', () => {
	it('is Daily note only while core Daily notes is on', () => {
		expect(effectiveSaveTo('daily', dailyOn())).toBe('daily');
		expect(effectiveSaveTo('', dailyOn())).toBe('daily');
		expect(effectiveSaveTo('custom', dailyOn())).toBe('custom');
		expect(effectiveSaveTo('daily', dailyOff)).toBe('custom');
		expect(effectiveSaveTo('', dailyOff)).toBe('custom');
	});
});

describe('isDateFormat / formatFileName', () => {
	it.each([
		['YYYY-MM-DD', true],
		['MMMM D, YYYY', true],
		['YYYY/MM/YYYY-MM-DD', true],
		['YYYY-MM-DD dddd', true],
		['Do MMM', true],
		['M-D', true],
		['[Week] ww', true],
		['Inbox', false],
		['Scans', false],
		['Mass', false],
		['Plan A', false],
		['[YYYY]', false],
	])('%s is a date format: %s', (name, expected) => {
		expect(isDateFormat(name)).toBe(expected);
	});

	it('formats a date format through moment', () => {
		expect(formatFileName(date, 'MMMM D, YYYY')).toBe('November 7, 2026');
		expect(formatFileName(date, 'YYYY-MM-DD dddd')).toBe('2026-11-07 Saturday');
	});

	it('keeps a fixed name as written', () => {
		expect(formatFileName(date, 'Inbox')).toBe('Inbox');
		expect(formatFileName(date, 'Scans')).toBe('Scans');
	});
});

describe('resolveNotePath', () => {
	it('follows the Daily notes folder and format in Daily note mode', () => {
		expect(resolveNotePath(date, daily, dailyOn('Daily'))).toBe('Daily/2026-11-07.md');
		expect(resolveNotePath(date, daily, dailyOn('Journal/', 'MMMM D, YYYY'))).toBe('Journal/November 7, 2026.md');
		expect(resolveNotePath(date, daily, dailyOn('', 'YYYY/MM/YYYY-MM-DD'))).toBe('2026/11/2026-11-07.md');
	});

	it('uses the daily folder literally (Daily notes does not format folders)', () => {
		expect(resolveNotePath(date, daily, dailyOn('Notes/MM'))).toBe('Notes/MM/2026-11-07.md');
	});

	it('uses the custom fields when Daily note is saved but Daily notes is off', () => {
		expect(resolveNotePath(date, { ...daily, customFolder: 'Inbox', customFileName: 'Scans' }, dailyOff)).toBe('Inbox/Scans.md');
	});

	it('formats custom folder tokens and the moment file name', () => {
		expect(resolveNotePath(date, custom('Journal/YYYY/MM', 'YYYY-MM-DD'), dailyOn())).toBe('Journal/2026/11/2026-11-07.md');
		expect(resolveNotePath(date, custom('Journal', 'YYYY/MM/YYYY-MM-DD'), dailyOff)).toBe('Journal/2026/11/2026-11-07.md');
	});

	it('puts / at the vault root and drops trailing slashes', () => {
		expect(resolveNotePath(date, custom('/', 'YYYY-MM-DD'), dailyOff)).toBe('2026-11-07.md');
		expect(resolveNotePath(date, custom('Inbox//', 'Scans'), dailyOff)).toBe('Inbox/Scans.md');
	});

	it('falls back to the defaults for empty fields and drops a typed .md', () => {
		expect(resolveNotePath(date, custom('  ', ''), dailyOff)).toBe('Papersync/2026-11-07.md');
		expect(resolveNotePath(date, custom('Inbox', 'Scans.MD'), dailyOff)).toBe('Inbox/Scans.md');
	});
});

describe('isFixedDestination', () => {
	it('is true only when every scan goes to one note', () => {
		expect(isFixedDestination(custom('Inbox', 'Scans'), dailyOff)).toBe(true);
		expect(isFixedDestination(custom('Inbox', 'YYYY-MM-DD'), dailyOff)).toBe(false);
		expect(isFixedDestination(custom('Journal/YYYY', 'Scans'), dailyOff)).toBe(false);
		expect(isFixedDestination(daily, dailyOn())).toBe(false);
	});
});

describe('firstSetupDestination', () => {
	it('picks Daily note when core Daily notes is on, even with Periodic Notes on', () => {
		expect(firstSetupDestination(dailyOn(), { folder: 'Journal', format: 'YYYY' }).saveTo).toBe('daily');
	});

	it('copies the Periodic Notes daily folder and format into Custom', () => {
		expect(firstSetupDestination(dailyOff, { folder: 'Journal/Daily/', format: 'YYYY-MM-DD dddd' }))
			.toEqual({ saveTo: 'custom', customFolder: 'Journal/Daily', customFileName: 'YYYY-MM-DD dddd' });
	});

	it('maps an empty Periodic Notes folder and format to the vault root and YYYY-MM-DD', () => {
		expect(firstSetupDestination(dailyOff, { folder: '', format: '' }))
			.toEqual({ saveTo: 'custom', customFolder: '/', customFileName: 'YYYY-MM-DD' });
	});

	it('uses the Papersync defaults otherwise', () => {
		expect(firstSetupDestination(dailyOff, null))
			.toEqual({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
	});
});

describe('migrateNotesFolder keeps every scan in its 0.1.5 file', () => {
	const old = new Date('2026-11-07T09:00:00.000Z');
	// 0.1.5: folder through the Y/M/D replacer (empty = daily folder, or Papersync
	// with Daily notes off), file named with the Daily notes format.
	const path015 = (target: string, d: { enabled: boolean; folder: string; format: string }): string => {
		const resolved = target || (d.enabled ? d.folder || '/' : 'Papersync');
		const folder = resolveNotePath(old, custom(resolved, 'X'), dailyOff).replace(/\/?X\.md$/, '');
		return resolveNotePath(old, custom(folder || '/', d.format), dailyOff);
	};

	it.each([
		['Daily', dailyOn('Daily', 'MMMM D, YYYY')],
		['', dailyOn('Daily', 'YYYY/MM/YYYY-MM-DD')],
		['/', dailyOn('')],
		['Journal/YYYY', dailyOn('Daily', 'YYYY-MM-DD')],
		['Notes/MM', dailyOn('Notes/MM')],
		['Inbox', dailyOff],
		['', dailyOff],
		['/', dailyOff],
	])('folder "%s"', (target, d) => {
		expect(resolveNotePath(old, migrateNotesFolder(target, d), d)).toBe(path015(target, d));
	});
});
