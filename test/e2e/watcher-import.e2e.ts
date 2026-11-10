import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, vaultBasePath, writeScan, waitForNotes, isoStamp } from './helpers';

// The everyday path: the phone drops a scan into the folder and it shows up in
// the vault with nobody pressing Sync now. Only the folder watcher can import it
// here; no spec step triggers a sync.
describe('Watcher-only import', function () {
	const SCANS = 'Papersync-watcher-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'WatchOnly', attachmentsFolder: 'WatchOnly/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('imports a new scan within 15 s without Sync now', async function () {
		const stamp = isoStamp();
		const id = `watch-only-${stamp}`;
		const marker = `WATCHONLY_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});
		// The watcher debounces 500 ms; 15 s leaves room for a loaded machine.
		await waitForNotes('WatchOnly', marker, 15_000);
		await browser.waitUntil(
			() => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).synced === true,
			{ timeout: 5000, interval: 200, timeoutMsg: 'the watched scan was never marked synced' }
		);
	});
});
