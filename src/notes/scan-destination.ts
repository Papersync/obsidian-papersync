import { normalizePath } from 'obsidian';
import { formatDateWithPattern, momentOf } from '@/utils/daily-notes';
import type { DailyNotesConfig } from '@/utils/daily-notes';
import type { PeriodicDailySettings } from '@/utils/periodic-notes';

// Where each scan is appended.
//   'daily'  : the core Daily notes note, folder and format read live on every scan.
//   'custom' : customFolder + customFileName.
//   ''       : not chosen yet; resolved once on first setup (firstSetupDestination).
export type SaveTo = '' | 'daily' | 'custom';

export interface ScanDestination {
	saveTo: SaveTo;
	customFolder: string;
	customFileName: string;
}

export const DEFAULT_CUSTOM_FOLDER = 'Papersync';
export const DEFAULT_CUSTOM_FILE_NAME = 'YYYY-MM-DD';

// The mode that applies right now. A saved 'daily' only applies while core Daily
// notes is on; otherwise the custom fields do, and the saved choice is kept, so it
// comes back by itself once Daily notes is on again.
export function effectiveSaveTo(saveTo: SaveTo, daily: DailyNotesConfig): 'daily' | 'custom' {
	if (!daily.enabled) {return 'custom';}
	return saveTo === 'custom' ? 'custom' : 'daily';
}

// Moment tokens. A letter run made only of these may be a date format.
const MOMENT_RUN = /^(?:Mo|Do|DDDo|do|Qo|wo|Wo|Y+|M+|D+|d+|w+|W+|Q|E|e|g+|G+|H+|h+|k+|m+|s+|S+|A|a|X|x)+$/;
// ...but it counts as one only when it holds a real date part (a doubled date
// token, or a lone D, M or Y as in "M-D"), so a fixed name whose letters happen to
// be tokens ("Mass", "Plan A") stays a fixed name.
const DATE_ANCHOR = /YY|MM|DD|Do|dd|ww|WW|gg|GG|^[DMY]$/;

// True when a file name is a moment date format rather than a fixed name.
// Bracketed text ([Daily]) is a moment literal and is skipped.
export function isDateFormat(name: string): boolean {
	const outsideBrackets = name.replace(/\[[^\]]*\]/g, ' ');
	return (outsideBrackets.match(/[A-Za-z]+/g) ?? []).some((run) => MOMENT_RUN.test(run) && DATE_ANCHOR.test(run));
}

// A date format goes through moment exactly as Daily notes and Periodic Notes name
// their notes (month names, escaped literals, '/' for nesting). A name with no date
// part is used as written: moment would read "Inbox" as "Inbo" + a timestamp.
export function formatFileName(date: Date, name: string): string {
	return isDateFormat(name) ? momentOf(date).format(name) : name;
}

// '' or '/' (any run of slashes) is the vault root; trailing slashes are dropped
// so a path never gets a '//'.
function folderPattern(folder: string): string {
	return folder.trim().replace(/\/+$/, '');
}

// The vault path of the note a scan made at `date` goes into.
export function resolveNotePath(date: Date, dest: ScanDestination, daily: DailyNotesConfig): string {
	let folder: string;
	let file: string;
	if (effectiveSaveTo(dest.saveTo, daily) === 'daily') {
		// Core Daily notes uses its folder literally and its format through moment.
		folder = daily.folder.replace(/\/+$/, '');
		file = momentOf(date).format(daily.format);
	} else {
		// The folder formats only its date runs ("YYYY", "MMMM"): literal folder
		// names ("Journal") must survive, which moment would mangle. An empty field
		// means the default.
		const pattern = folderPattern(dest.customFolder.trim() ? dest.customFolder : DEFAULT_CUSTOM_FOLDER);
		folder = pattern ? formatDateWithPattern(date, pattern) : '';
		// "Scans.md" means the note Scans, not Scans.md.md.
		const name = dest.customFileName.trim().replace(/\.md$/i, '') || DEFAULT_CUSTOM_FILE_NAME;
		file = formatFileName(date, name);
	}
	return normalizePath(folder ? `${folder}/${file}.md` : `${file}.md`);
}

// Two far-apart moments: a destination that resolves to the same path for both
// sends every scan to one note.
const SAMPLE_A = new Date(2001, 1, 3, 4, 5, 6);
const SAMPLE_B = new Date(2027, 10, 28, 19, 48, 37);

export function isFixedDestination(dest: ScanDestination, daily: DailyNotesConfig): boolean {
	return resolveNotePath(SAMPLE_A, dest, daily) === resolveNotePath(SAMPLE_B, dest, daily);
}

// The first-setup choice: a copy of Periodic Notes' daily folder and format when
// that is on (read once, never followed); else the core daily note when Daily
// notes is on; else the Papersync defaults. Periodic Notes comes first because,
// when both are on, it is the one that creates the daily note: it takes over the
// core command and keeps its own folder and format, so the core settings are
// often stale leftovers.
export function firstSetupDestination(
	daily: DailyNotesConfig,
	periodic: PeriodicDailySettings | null
): ScanDestination {
	if (periodic) {
		return {
			saveTo: 'custom',
			customFolder: periodic.folder.replace(/\/+$/, '') || '/',
			customFileName: periodic.format || DEFAULT_CUSTOM_FILE_NAME,
		};
	}
	if (daily.enabled) {
		return { saveTo: 'daily', customFolder: DEFAULT_CUSTOM_FOLDER, customFileName: DEFAULT_CUSTOM_FILE_NAME };
	}
	return { saveTo: 'custom', customFolder: DEFAULT_CUSTOM_FOLDER, customFileName: DEFAULT_CUSTOM_FILE_NAME };
}

function normalizeFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, '');
}

// The 0.1.5 "Notes folder" mapped onto the new setting so that every scan keeps
// landing in the file 0.1.5 would have used. 0.1.5 named the file with the Daily
// notes format (YYYY-MM-DD when Daily notes is off) and ran the folder through the
// Y/M/D replacer; an empty folder meant the Daily notes folder (or Papersync with
// Daily notes off).
export function migrateNotesFolder(targetFolder: string, daily: DailyNotesConfig): ScanDestination {
	const isEmpty = targetFolder.trim() === '';
	if (daily.enabled) {
		const old = normalizeFolder(targetFolder);
		// The daily folder is used literally, so only a folder with no date tokens
		// in it can be the same folder.
		const literal = formatDateWithPattern(SAMPLE_A, old) === old;
		if (isEmpty || (literal && old === normalizeFolder(daily.folder))) {
			return { saveTo: 'daily', customFolder: DEFAULT_CUSTOM_FOLDER, customFileName: DEFAULT_CUSTOM_FILE_NAME };
		}
	}
	return {
		saveTo: 'custom',
		customFolder: isEmpty ? DEFAULT_CUSTOM_FOLDER : targetFolder,
		customFileName: daily.enabled ? daily.format : DEFAULT_CUSTOM_FILE_NAME,
	};
}
