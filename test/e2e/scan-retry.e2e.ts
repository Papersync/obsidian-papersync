import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, syncNow, readNotes, waitForNotes, isoStamp } from './helpers';

// Retry / no-data-loss: a scan that fails validation stays unsynced and remains
// discoverable, so correcting the data lets a later sync pick it up (nothing is
// silently consumed or dropped).
describe('Failed scan retries after fix', function () {
	const SCANS = 'PaperSync-retry-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'Retry', attachmentsFolder: 'Retry/attachments' });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('leaves a failed scan unsynced, then syncs it once the data is valid', async function () {
		const stamp = isoStamp();
		const id = `retry-${stamp}`;
		const marker = `RETRY_${stamp}`;
		const base = {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}\n\nAppears only after the fix.`,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		};

		// A non-numeric confidence fails validation -> schema mismatch. (An out of
		// range number no longer does: the shared scan format clamps it to 0-100.)
		// A valid sibling goes in the same pass: once it is imported, that pass has
		// run, so the failed scan's absence below means it was rejected, not that the
		// sync had not got to it yet.
		writeScan(dir, id, { ...base, confidence: 'high' });
		const siblingId = `retry-sibling-${stamp}`;
		const siblingMarker = `RETRY_SIBLING_${stamp}`;
		writeScan(dir, siblingId, { ...base, markdown: `# ${siblingMarker}`, imageFileName: `${siblingId}.jpg`, confidence: 90 });
		await syncNow();
		await waitForNotes('Retry', siblingMarker, 20_000);

		let notes = await readNotes('Retry');
		expect(notes).not.toContain(marker);
		let json = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
		expect(json.synced).not.toBe(true);

		// Correct the data and re-sync (no image rewrite needed, it already exists).
		writeScan(dir, id, { ...base, confidence: 90 }, false);
		await syncNow();

		notes = await waitForNotes('Retry', marker, 20_000);
		expect(notes).toContain(marker);
		json = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
		expect(json.synced).toBe(true);
	});
});
