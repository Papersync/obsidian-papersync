import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, vaultBasePath, writeScan, syncNow, readNotes, isoStamp } from './helpers';

// A scan whose JSON cannot be marked synced (read-only file, a sync client's
// lock) is rediscovered on every sync. The note's papersync-scans list must keep
// it from being appended again.

// chmod 0444 only blocks a writer that is not root: a root runner (some CI
// containers) can still write the file, and then the case cannot be built.
function canStillWrite(file: string): boolean {
	try {
		fs.closeSync(fs.openSync(file, 'r+'));
		return true;
	} catch {
		return false;
	}
}

describe('Dedupe when a scan cannot be marked synced', function () {
	const SCANS = 'Papersync-readonly-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'ReadOnly', attachmentsFolder: 'ReadOnly/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('imports a read-only scan exactly once over three syncs', async function () {
		const stamp = isoStamp();
		const id = `readonly-${stamp}`;
		const marker = `READONLY_${stamp}`;
		const json = path.join(dir, `${id}.json`);
		// Write the scan while the watcher is paused, so no pass can import it before
		// it is read-only.
		await browser.execute(() => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { syncEngine: { backend: { stop: () => void } } | null }> } } }).app.plugins.plugins;
			ps['papersync']?.syncEngine?.backend.stop();
		});
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});
		fs.chmodSync(json, 0o444);
		if (canStillWrite(json)) {
			this.skip(); // root: the read-only case cannot be built here
		}

		for (let i = 0; i < 3; i++) { await syncNow(); }

		const notes = await readNotes('ReadOnly');
		expect(notes.split(`# ${marker}`).length - 1).toBe(1);
		// Still not marked synced: the write-back really failed every time.
		expect(JSON.parse(fs.readFileSync(json, 'utf-8')).synced).not.toBe(true);
	});
});
