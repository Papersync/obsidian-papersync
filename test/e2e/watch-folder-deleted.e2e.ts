import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, syncNow, readNotes, isoStamp } from './helpers';

// Regression lock for the fs.watch 'error' listener: deleting the watched folder
// mid-session must be caught (logged), never an uncaught exception that takes down
// Obsidian or the plugin.
describe('Watched-folder deletion resilience', function () {
	const SCANS = 'PaperSync-watch-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'WatchTest', attachmentsFolder: 'WatchTest/attachments' });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('survives the watched folder being deleted mid-session', async function () {
		// Retry-safe: this test deletes `dir` mid-flight and only recreates it on
		// the success path, while before() runs once per describe — so a failed
		// first attempt used to leave every mocha retry writing into a deleted
		// folder (ENOENT from writeScan). Recreate up front, idempotently.
		fs.mkdirSync(dir, { recursive: true });

		// First a normal sync so the watcher is active on a real folder.
		const stamp = isoStamp();
		const id = `watch-${stamp}`;
		const marker = `WATCH_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}\n\nBaseline capture before deletion.`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});
		await syncNow();
		expect(await readNotes('WatchTest')).toContain(marker);

		// Delete the watched folder out from under the fs.watch handle.
		fs.rmSync(dir, { recursive: true, force: true });
		await browser.pause(1500);

		// A manual sync against the now-missing folder must be caught, not fatal.
		await syncNow();

		const alive = await browser.execute(() => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, unknown> } } }).app;
			return !!(app.plugins.plugins['papersync'] || app.plugins.plugins['obsidian-papersync']);
		});
		expect(alive).toBe(true);

		// Recreate so the after-hook cleanup path is safe.
		fs.mkdirSync(dir, { recursive: true });
	});
});
