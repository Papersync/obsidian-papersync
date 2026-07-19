import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { configureFolderBackend, writeScan, syncNow, readNotes, isoStamp, MINIMAL_JPEG } from './helpers';

// End-to-end against a REAL iCloud Drive folder on macOS — the only place the
// iCloud code paths actually execute. Everything else in the suite runs against
// ordinary temp folders, where `isICloudPath` is false and the offload handling
// is never reached.
//
// Self-skips off macOS or when the iCloud Drive container is absent, so it is a
// no-op on CI and on machines without iCloud rather than a red suite.
const ICLOUD_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const HAS_ICLOUD = process.platform === 'darwin' && fs.existsSync(ICLOUD_ROOT);

const baseScan = (marker: string, imageFileName: string): Record<string, unknown> => ({
	version: 1,
	createdAt: new Date().toISOString(),
	markdown: `# ${marker}\n\nCaptured into a real iCloud Drive folder.`,
	confidence: 91,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName,
});

// `blocks === 0` with a non-zero size is the dataless (evicted) signature; the
// file keeps its name and its logical size, so neither readdir nor `size === 0`
// can see it. Mirrors isDataless() in src/sync/icloud-offload.ts.
function isEvicted(filePath: string): boolean {
	const st = fs.statSync(filePath);
	return st.size > 0 && st.blocks === 0;
}

function evict(filePath: string): boolean {
	try {
		execFileSync('brctl', ['evict', filePath], { timeout: 15000, stdio: 'pipe' });
	} catch {
		return false;
	}
	// Eviction is asynchronous and only works once iCloud has uploaded the file,
	// so poll briefly rather than assuming it took.
	for (let i = 0; i < 40; i++) {
		if (isEvicted(filePath)) {return true;}
		execFileSync('sleep', ['0.25']);
	}
	return false;
}

describe('Real iCloud Drive folder backend', function () {
	let dir: string;

	before(function () {
		if (!HAS_ICLOUD) {
			this.skip();
			return;
		}
		dir = path.join(ICLOUD_ROOT, `Papersync-e2e-${isoStamp()}`);
		fs.mkdirSync(dir, { recursive: true });
	});

	after(function () {
		if (!dir) {return;}
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('syncs a scan sitting in a real iCloud Drive folder', async function () {
		const stamp = isoStamp();
		const id = `icloud-${stamp}`;
		const marker = `ICLOUD_${stamp}`;
		writeScan(dir, id, baseScan(marker, `${id}.jpg`));

		await configureFolderBackend({
			folderPath: dir,
			targetFolder: 'ICloudTest',
			attachmentsFolder: 'ICloudTest/attachments',
		});
		await syncNow();

		expect(await readNotes('ICloudTest')).toContain(marker);
	});

	it('recovers a scan whose content iCloud has evicted', async function () {
		const stamp = isoStamp();
		const id = `evicted-${stamp}`;
		const marker = `EVICTED_${stamp}`;
		const jsonPath = path.join(dir, `${id}.json`);
		writeScan(dir, id, baseScan(marker, `${id}.jpg`));

		// Give iCloud a moment to upload; eviction is refused for content that has
		// not been uploaded yet.
		await browser.pause(8000);
		if (!evict(jsonPath)) {
			// Upload speed is not ours to control. Skipping beats a red suite for a
			// precondition we could not establish.
			this.skip();
			return;
		}

		// The evicted file still lists normally and still reports its logical size —
		// this is the exact trap that made the old `size === 0` check inert.
		expect(fs.readdirSync(dir)).toContain(`${id}.json`);
		expect(fs.statSync(jsonPath).size).toBeGreaterThan(0);

		await configureFolderBackend({
			folderPath: dir,
			targetFolder: 'ICloudEvicted',
			attachmentsFolder: 'ICloudEvicted/attachments',
		});
		await syncNow();

		expect(await readNotes('ICloudEvicted')).toContain(marker);
		expect(isEvicted(jsonPath)).toBe(false); // materialized by the read
	});

	it('reports the folder as missing when it is deleted underneath the plugin', async function () {
		const gone = path.join(ICLOUD_ROOT, `Papersync-e2e-gone-${isoStamp()}`);
		fs.mkdirSync(gone, { recursive: true });
		await configureFolderBackend({
			folderPath: gone,
			targetFolder: 'ICloudGone',
			attachmentsFolder: 'ICloudGone/attachments',
		});

		fs.rmSync(gone, { recursive: true, force: true });

		// Must degrade to the typed folder_missing state, never an uncaught ENOENT
		// that takes the plugin (or Obsidian) down.
		const status = await browser.execute(async () => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
				syncEngine?: { forceSyncNow: () => Promise<void> };
				syncState?: { status: string; lastError: string | null };
			}> } } }).app.plugins.plugins;
			const plugin = ps['papersync'] ?? ps['obsidian-papersync'];
			await plugin.syncEngine?.forceSyncNow();
			return { status: plugin.syncState?.status, lastError: plugin.syncState?.lastError };
		});

		expect(status.status).toBe('error');
		expect(String(status.lastError)).toContain('Papersync folder not found');
	});

	it('skips a scan whose companion image has not arrived yet', async function () {
		const stamp = isoStamp();
		const id = `partial-${stamp}`;
		const marker = `PARTIAL_${stamp}`;
		// JSON only: mid-sync from the phone, image still uploading.
		fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(baseScan(marker, `${id}.jpg`), null, 2));

		await configureFolderBackend({
			folderPath: dir,
			targetFolder: 'ICloudPartial',
			attachmentsFolder: 'ICloudPartial/attachments',
		});
		await syncNow();
		expect(await readNotes('ICloudPartial')).not.toContain(marker);

		// Once the image lands the scan syncs on the next pass, with no intervention.
		fs.writeFileSync(path.join(dir, `${id}.jpg`), MINIMAL_JPEG);
		await syncNow();
		expect(await readNotes('ICloudPartial')).toContain(marker);
	});
});
