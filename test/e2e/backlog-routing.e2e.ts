import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, vaultBasePath, writeScan, syncNow, isoStamp } from './helpers';
import { fmt, filesContaining, readFile, setDailyNotes, setDestination } from './destination-helpers';

// A backlog (scans taken over several days, imported in one sync, e.g. after the
// laptop was off for a week) must put every scan in the daily note of the day it
// was TAKEN, not the day it was imported, and keep a day's scans oldest first.
//
// Ids use the app's own shape (UTC YYYY-MM-DD-HHMMSS-xxxx, see the app's
// generateTimestampName): the folder backend has no upload time and orders a
// batch by id, so for real scans id order is capture order.
function appId(date: Date, suffix: string): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-${suffix}`;
}

describe('Backlog routing to each scan\'s own daily note', function () {
	const SCANS = 'Papersync-backlog-scans';
	const DAILY = 'BacklogDaily';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'BacklogCustom', attachmentsFolder: 'BacklogDaily/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
		await setDailyNotes(true, DAILY, 'YYYY-MM-DD');
		await setDestination({ saveTo: 'daily' });
	});

	after(async function () {
		await setDailyNotes(false);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('imports a multi-day backlog into each day\'s note, oldest first, including scans either side of local midnight', async function () {
		const stamp = isoStamp().replace(/\D/g, '').slice(-9);
		// Local times (the daily note follows the local day). Two scans share
		// March 3, one is a minute before local midnight on March 4 and one a minute
		// after it (March 5), so a UTC-based day would misplace at least one of them
		// in every time zone but UTC.
		const scans = [
			{ at: new Date(2026, 2, 3, 9, 15), key: 'MAR3_MORNING' },
			{ at: new Date(2026, 2, 3, 18, 40), key: 'MAR3_EVENING' },
			{ at: new Date(2026, 2, 4, 23, 59, 30), key: 'MAR4_BEFORE_MIDNIGHT' },
			{ at: new Date(2026, 2, 5, 0, 0, 30), key: 'MAR5_AFTER_MIDNIGHT' },
			{ at: new Date(2026, 1, 20, 12, 0), key: 'FEB20' },
		].map((s, i) => ({ ...s, id: appId(s.at, `${i}a0${i}`), marker: `BACKLOG_${s.key}_${stamp}` }));

		// Written newest first, the order a careless implementation would import in.
		for (const s of [...scans].reverse()) {
			writeScan(dir, s.id, {
				version: 1,
				createdAt: s.at.toISOString(),
				markdown: `# ${s.marker}`,
				confidence: 90,
				provider: 'gemini',
				model: 'gemini-2.5-flash',
				imageFileName: `${s.id}.jpg`,
			});
		}
		await syncNow();

		for (const s of scans) {
			expect({ key: s.key, files: await filesContaining(s.marker) })
				.toEqual({ key: s.key, files: [`${DAILY}/${fmt(s.at, 'YYYY-MM-DD')}.md`] });
		}

		const mar3 = await readFile(`${DAILY}/${fmt(scans[0]!.at, 'YYYY-MM-DD')}.md`);
		const morning = mar3.indexOf(`# ${scans[0]!.marker}`);
		const evening = mar3.indexOf(`# ${scans[1]!.marker}`);
		expect(morning).toBeGreaterThanOrEqual(0);
		expect(evening).toBeGreaterThan(morning);
		// Each scan's time heading is its own capture time, not the import time.
		expect(mar3).toContain('## 9:15 AM');
		expect(mar3).toContain('## 6:40 PM');
		const mar4 = await readFile(`${DAILY}/${fmt(scans[2]!.at, 'YYYY-MM-DD')}.md`);
		expect(mar4).toContain('## 11:59 PM');
		const mar5 = await readFile(`${DAILY}/${fmt(scans[3]!.at, 'YYYY-MM-DD')}.md`);
		expect(mar5).toContain('## 12:00 AM');
	});
});
