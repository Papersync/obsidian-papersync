// A watched folder that disappears (deleted, renamed, drive unplugged) must be
// reported, and must not leave the plugin deaf until Obsidian restarts. While the
// backend runs, a monitor checks the folder on an interval: gone while watching is
// reported once and the dead watch dropped; back while not watching re-arms the
// watch and reports that first pass even when it finds nothing, so the engine
// records a completed sync and the folder_missing error clears on its own. The
// fs.watch 'rename' for the folder itself is only a fast path: Electron 28
// (Obsidian installer 1.5.8) on macOS never delivers it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FolderBackend, FOLDER_CHECK_MS } from '@/sync/folder-backend';

const CHECK = 40;
// Negative assertions ("nothing happened") need a fixed wait; positive ones poll
// until the condition holds, so a loaded machine costs time, not a false red.
const settle = (ms = CHECK * 4): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) {throw new Error(`timed out waiting for: ${what}`);}
		await new Promise((r) => setTimeout(r, 10));
	}
}
const watcherOf = (b: FolderBackend): fs.FSWatcher | null => (b as unknown as { watcher: fs.FSWatcher | null }).watcher;
const monitorOf = (b: FolderBackend): number | null => (b as unknown as { monitorTimer: number | null }).monitorTimer;

describe('FolderBackend folder monitor', () => {
	let root: string;
	let dir: string;
	let backend: FolderBackend | null = null;
	let reported: Array<{ type: string; message: string }>;
	let passes: number[];

	function make(check = CHECK): FolderBackend {
		const b = new FolderBackend(dir, check);
		b.setOnUnavailable((e) => reported.push(e));
		b.setOnScanDiscovered((refs) => passes.push(refs.length));
		backend = b;
		return b;
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backend-monitor-'));
		dir = path.join(root, 'Papersync');
		reported = [];
		passes = [];
	});

	afterEach(() => {
		backend?.stop();
		backend = null;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('checks every 5 s by default', () => {
		expect(FOLDER_CHECK_MS).toBe(5000);
	});

	it('reports a deletion no watch event announced, once, and drops the dead watch', async () => {
		fs.mkdirSync(dir);
		const b = make();
		b.start();
		// Stand in for a runtime whose fs.watch never reports its own folder going
		// away: silence the watcher, then delete the folder.
		watcherOf(b)!.removeAllListeners('change');
		fs.rmSync(dir, { recursive: true, force: true });

		await until(() => reported.length > 0, 'the monitor to report the folder gone');
		expect(reported.map((e) => e.type)).toEqual(['folder_missing']);
		expect(reported[0]!.message).toContain(dir);
		expect(watcherOf(b)).toBeNull();

		await settle(); // further ticks while still gone: no repeat report
		expect(reported).toHaveLength(1);
	});

	it('re-arms once the folder is back and reports that pass even though it is empty', async () => {
		fs.mkdirSync(dir);
		const b = make();
		b.start();
		await settle(700); // initial debounced discovery: empty folder, nothing reported
		expect(passes).toEqual([]);

		fs.rmSync(dir, { recursive: true, force: true });
		await until(() => watcherOf(b) === null, 'the dead watch to be dropped');

		fs.mkdirSync(dir);
		await until(() => watcherOf(b) !== null, 'the watch to re-arm');
		await until(() => passes.length > 0, 'the recovery pass'); // past the debounce
		expect(passes).toEqual([0]);

		// A second disappearance is reported again: the record resets on re-arm.
		fs.rmSync(dir, { recursive: true, force: true });
		await until(() => reported.length === 2, 'the second disappearance report');
	}, 15000);

	it('reports a folder already missing at start(), and resumes when it appears', async () => {
		const b = make();
		b.start(); // fs.watch throws: the folder does not exist
		expect(reported.map((e) => e.type)).toEqual(['folder_missing']);
		expect(watcherOf(b)).toBeNull();

		// A second start() while waiting must not stack a second monitor.
		const first = monitorOf(b);
		b.start();
		expect(monitorOf(b)).toBe(first);
		expect(reported).toHaveLength(1);

		fs.mkdirSync(dir);
		await until(() => watcherOf(b) !== null, 'the watch to arm once the folder exists');
		await until(() => passes.length > 0, 'the recovery pass');
		expect(passes).toEqual([0]);
	}, 15000);

	it('reports immediately when the watch event does arrive (the fast path)', () => {
		fs.mkdirSync(dir);
		const b = make(60_000); // monitor too slow to be the one that notices
		b.start();
		fs.rmSync(dir, { recursive: true, force: true });
		watcherOf(b)!.emit('change', 'rename', 'Papersync');

		expect(reported.map((e) => e.type)).toEqual(['folder_missing']);
		expect(watcherOf(b)).toBeNull();
	});

	it('ignores a rename (or a nameless event) while the folder is still there', () => {
		fs.mkdirSync(dir);
		const b = make(60_000);
		b.start();
		watcherOf(b)!.emit('change', 'rename', 'notes.txt');
		watcherOf(b)!.emit('change', 'rename', null);
		expect(reported).toEqual([]);
		expect(watcherOf(b)).not.toBeNull();
	});

	it('drops a watch that errored while the folder is fine, and re-arms it on the next check', async () => {
		fs.mkdirSync(dir);
		const b = make();
		b.start();
		watcherOf(b)!.emit('error', new Error('EMFILE'));
		expect(watcherOf(b)).toBeNull();
		expect(reported).toEqual([]);

		await until(() => watcherOf(b) !== null, 'the next check to re-arm the watch');
	});

	it('reports a watcher error as the folder being gone only when it actually is', () => {
		fs.mkdirSync(dir);
		const b = make(60_000);
		b.start();
		fs.rmSync(dir, { recursive: true, force: true });
		watcherOf(b)!.emit('error', new Error('watched folder vanished'));
		expect(reported.map((e) => e.type)).toEqual(['folder_missing']);
	});

	it('hands a background pass that finds the folder gone to the engine', async () => {
		fs.mkdirSync(dir);
		const b = make(60_000);
		b.start();
		watcherOf(b)!.removeAllListeners('change'); // only the debounced pass may notice
		fs.rmSync(dir, { recursive: true, force: true });
		await until(() => reported.length > 0, 'the background pass to report');
		expect(reported.map((e) => e.type)).toEqual(['folder_missing']);
	});

	it('keeps other background discovery failures in the log only', async () => {
		// A FILE where the folder should be: readdir fails with ENOTDIR, not ENOENT.
		fs.writeFileSync(dir, 'not a folder');
		const b = make(60_000);
		b.start();
		await settle(700);
		expect(passes).toEqual([]);
		expect(reported).toEqual([]);
	});

	it('a normal (non-recovery) empty pass is not reported', async () => {
		fs.mkdirSync(dir);
		make().start();
		await settle(700);
		expect(passes).toEqual([]);
	});

	it('stop() ends the monitor, so a folder appearing later is not watched', async () => {
		const b = make();
		b.start();
		expect(monitorOf(b)).not.toBeNull();
		b.stop();
		expect(monitorOf(b)).toBeNull();

		fs.mkdirSync(dir);
		await settle();
		expect(watcherOf(b)).toBeNull();
	});

	it('a stopped backend asked to discover a missing folder only throws', async () => {
		const b = make();
		b.stop();
		await expect(b.discoverUnsynced()).rejects.toMatchObject({ type: 'folder_missing' });
		expect(monitorOf(b)).toBeNull();
		expect(reported).toEqual([]);
	});
});
