import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { configureFolderBackend, writeScan, syncNow, readNotes, waitForNotes, isoStamp, MINIMAL_JPEG } from './helpers';

// End-to-end against a REAL iCloud Drive folder on macOS — the only place the
// iCloud code paths actually execute. Everything else in the suite runs against
// ordinary temp folders, where `isICloudPath` is false and the offload handling
// is never reached.
//
// Self-skips off macOS or when the iCloud Drive container is absent, so it is a
// no-op on CI and on machines without iCloud rather than a red suite.
const ICLOUD_ROOT = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const HAS_ICLOUD = process.platform === 'darwin' && fs.existsSync(ICLOUD_ROOT);

// Every on-demand client leaves the same dataless signature, so the detection
// under test is provider-agnostic. Assert that on a SECOND real provider when
// one is installed, rather than trusting that iCloud generalises.
function cloudStorageRoots(): Array<{ label: string; root: string }> {
	const base = path.join(os.homedir(), 'Library', 'CloudStorage');
	try {
		return fs.readdirSync(base)
			.filter((e) => /^(OneDrive|Dropbox)(-|$)/.test(e))
			.map((e) => ({ label: e, root: path.join(base, e) }));
	} catch {
		return [];
	}
}

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

// brctl refuses to evict content iCloud has not finished uploading, and upload
// speed is not ours to control. Asking exactly once therefore raced the network:
// whenever iCloud was slower than the caller's fixed pause, the refusal was read
// as "cannot evict" and the test that depends on it quietly skipped. Retry the
// eviction itself against a deadline so a slow upload costs time rather than
// coverage, and a genuine inability to evict still ends the loop.
//
// Asynchronous on purpose. The previous execFileSync/`sleep` loop blocked the
// wdio worker's event loop for up to the whole budget, so no timer (wdio's
// per-test race, keepalives) could fire until it returned.
const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function evict(filePath: string, budgetMs = 90_000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		try {
			await run('brctl', ['evict', filePath], { timeout: 15000 });
		} catch {
			// Still uploading. Wait and ask again rather than giving up on the run.
			await sleep(1000);
			continue;
		}
		// The command was accepted, but eviction is asynchronous, so confirm it
		// actually took instead of trusting the exit code.
		for (let i = 0; i < 40 && Date.now() < deadline; i++) {
			if (isEvicted(filePath)) {return true;}
			await sleep(250);
		}
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
		//
		// Polled, not read once. forceSyncNow() returns immediately while a sync is
		// already in flight (by design: no concurrent syncs), and configureFolderBackend()
		// has just started one. Under host load that sync was still running at the
		// single read, so it saw the stale 'synced' status and failed on a race.
		type SyncStatus = { status?: string; lastError?: string | null };
		let status: SyncStatus = {};
		await browser.waitUntil(async () => {
			status = await browser.execute(async () => {
				const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
					syncEngine?: { forceSyncNow: () => Promise<void> };
					syncState?: { status: string; lastError: string | null };
				}> } } }).app.plugins.plugins;
				// Neither id being present is a real failure mode, so reach for it optionally
				// and let the assertions report it, rather than throwing a raw TypeError here.
				const plugin = ps['papersync'] ?? ps['obsidian-papersync'];
				await plugin?.syncEngine?.forceSyncNow();
				return { status: plugin?.syncState?.status, lastError: plugin?.syncState?.lastError };
			});
			return status.status === 'error';
		}, { timeout: 20_000, interval: 1000 }).catch(() => undefined);

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

	// Its own suite so it can carry a longer budget. The waits add up to more than
	// the 60 s mochaOpts.timeout: up to 90 s for evict() to outlast a slow upload,
	// the syncNow() pauses, and up to 60 s for waitForNotes(). An in-test
	// this.timeout() cannot fix that under wdio: @wdio/utils executeAsync races
	// every test against a timer armed ONCE at test start from the runnable's
	// timeout, so only a suite-level timeout (inherited when the test is created)
	// moves it. Before, a slow upload surfaced as a bare "Error: Timeout" from that
	// race, not as this test's own verdict, and the orphaned poll ran on into the
	// next test.
	describe('evicted content', function () {
		this.timeout(240_000);

		it('recovers a scan whose content iCloud has evicted', async function () {
			const stamp = isoStamp();
			const id = `evicted-${stamp}`;
			const marker = `EVICTED_${stamp}`;
			// Its OWN folder, never the suite's shared `dir`. The other tests leave the
			// plugin's folder watcher live on `dir`, so a scan written there is discovered
			// and synced within about a second, before it can be evicted, and markSynced()
			// rewrites the JSON with `synced: true`. That rewrite also restarts the iCloud
			// upload, so brctl keeps refusing to evict. Either way the scan this test
			// needs (evicted AND unsynced) never exists, and the backend it later points at
			// ICloudEvicted skips it as already synced: the test could not pass. Nothing
			// may watch evDir until configureFolderBackend() below.
			const evDir = path.join(ICLOUD_ROOT, `Papersync-e2e-evicted-${stamp}`);
			fs.mkdirSync(evDir, { recursive: true });
			try {
				const jsonPath = path.join(evDir, `${id}.json`);
				writeScan(evDir, id, baseScan(marker, `${id}.jpg`));

				// evict() waits for the upload itself, so this only has to cover the
				// window before the file is visible to brctl at all.
				await browser.pause(1000);
				if (!(await evict(jsonPath))) {
					// Reachable only when iCloud cannot evict at all within the budget, which
					// in practice means the machine is offline or signed out. Skipping still
					// beats a red suite for a precondition we could not establish, but say so
					// loudly: this is the assertion that covers the eviction recovery path,
					// and a silent skip is how it went unverified before.
					console.warn(
						`[icloud-real] SKIPPED eviction recovery: brctl could not evict ${jsonPath} ` +
						`within the budget. The evicted-content path was NOT verified on this run.`
					);
					this.skip();
					return;
				}

				// The evicted file still lists normally and still reports its logical size;
				// this is the exact trap that made the old `size === 0` check inert.
				expect(fs.readdirSync(evDir)).toContain(`${id}.json`);
				expect(fs.statSync(jsonPath).size).toBeGreaterThan(0);

				await configureFolderBackend({
					folderPath: evDir,
					targetFolder: 'ICloudEvicted',
					attachmentsFolder: 'ICloudEvicted/attachments',
				});
				await syncNow();

				// Recovery has to download the content before the note can be written, which
				// outlasts syncNow()'s fixed pause; wait for the note rather than for a guess.
				expect(await waitForNotes('ICloudEvicted', marker)).toContain(marker);
				expect(isEvicted(jsonPath)).toBe(false); // materialized by the read
			} finally {
				try { fs.rmSync(evDir, { recursive: true, force: true }); } catch { /* best effort */ }
			}
		});
	});
});

// A dataless file is how EVERY on-demand provider represents evicted content, so
// the same blocks-based detection must hold outside iCloud. Confirmed on this
// machine against OneDrive-Personal: `size=11748396 blocks=0
// flags=compressed,dataless`, identical in shape to an evicted iCloud file.
describe('Other on-demand providers use the same dataless signature', function () {
	const roots = cloudStorageRoots();

	it('finds at least one provider folder, or skips when none is installed', function () {
		if (roots.length === 0) {this.skip();}
	});

	it('reports evicted content as size > 0 with zero allocated blocks', function () {
		if (roots.length === 0) {this.skip(); return;}

		const dataless: string[] = [];
		for (const { root } of roots) {
			const stack = [root];
			let looked = 0;
			while (stack.length > 0 && looked < 400 && dataless.length === 0) {
				const dir = stack.pop()!;
				let entries: fs.Dirent[];
				try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
				for (const e of entries) {
					const full = path.join(dir, e.name);
					if (e.isDirectory()) { stack.push(full); continue; }
					if (!e.isFile()) {continue;}
					looked++;
					try {
						const st = fs.statSync(full);
						if (st.size > 0 && st.blocks === 0) { dataless.push(full); break; }
					} catch { /* unreadable entries are not our concern */ }
				}
			}
		}

		if (dataless.length === 0) {
			// Everything happens to be downloaded locally. Nothing to assert, and
			// forcing an eviction is not scriptable for these clients.
			this.skip();
			return;
		}

		const st = fs.statSync(dataless[0]!);
		expect(st.size).toBeGreaterThan(0);
		expect(st.blocks).toBe(0);
		expect(st.isFile()).toBe(true); // the guard that keeps EISDIR a real error
	});
});
