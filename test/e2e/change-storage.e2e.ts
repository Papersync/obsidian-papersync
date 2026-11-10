import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, openPluginSettings, clickButtonWhenPresent, switchToMainWindow, vaultBasePath, writeScan, waitForNotes, waitForSyncIdle, readNotes, isoStamp } from './helpers';

// Change storage on a folder backend must stop watching that folder: a scan that
// lands in the old folder afterwards stays out of the vault.
describe('Folder Change storage', function () {
	let oldDir: string;
	let newDir: string;

	before(async function () {
		const vault = await vaultBasePath();
		oldDir = path.join(vault, 'Papersync-old-folder');
		newDir = path.join(vault, 'Papersync-new-folder');
		fs.mkdirSync(oldDir, { recursive: true });
		fs.mkdirSync(newDir, { recursive: true });
		await configureFolderBackend({ folderPath: oldDir, targetFolder: 'ChangeStorage', attachmentsFolder: 'ChangeStorage/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
	});

	after(function () {
		for (const d of [oldDir, newDir]) {
			try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
		}
	});

	function scan(dir: string, label: string, stamp: string): string {
		const id = `${label}-${stamp}`;
		const marker = `${label.toUpperCase()}_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});
		return marker;
	}

	it('stops importing from the old folder once storage is changed', async function () {
		await openPluginSettings();
		await clickButtonWhenPresent('Change storage');
		await closeSettings();

		await switchToMainWindow();
		await browser.waitUntil(async () => browser.execute(() => {
			const p = (window as unknown as { app: { plugins: { plugins: Record<string, { syncEngine: unknown; settings: Record<string, unknown> }> } } }).app.plugins.plugins['papersync']!;
			return p.syncEngine === null && p.settings.backendType === 'none' && p.settings.folderPath === '';
		}), { timeout: 5000, interval: 100, timeoutMsg: 'Change storage never stopped sync' });

		// Pick a new folder, then drop a scan in each. The new folder's scan is
		// imported by its watcher; the old folder's scan was written first, so a
		// watcher still alive on it would have fired by then too.
		await configureFolderBackend({ folderPath: newDir, targetFolder: 'ChangeStorage', attachmentsFolder: 'ChangeStorage/attachments' });
		const stamp = isoStamp();
		const oldMarker = scan(oldDir, 'oldfolder', stamp);
		const newMarker = scan(newDir, 'newfolder', stamp);
		await waitForNotes('ChangeStorage', newMarker, 15_000);
		await waitForSyncIdle();

		expect(await readNotes('ChangeStorage')).not.toContain(oldMarker);
		expect(JSON.parse(fs.readFileSync(path.join(oldDir, `oldfolder-${stamp}.json`), 'utf-8')).synced).not.toBe(true);
	});
});
