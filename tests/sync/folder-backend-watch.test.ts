import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FolderBackend } from '@/sync/folder-backend';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backend-watch-'));
}

describe('FolderBackend.fetchImage', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('returns the file contents as an ArrayBuffer', async () => {
		const imagePath = path.join(tmp, 'scan.jpg');
		fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG SOI

		const buf = await backend.fetchImage({ id: 'scan', jsonPath: '', imagePath });
		expect(buf.byteLength).toBe(4);
		expect(new Uint8Array(buf)[0]).toBe(0xff);
	});
});

describe('FolderBackend.start watcher', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		backend.stop();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('fires the discovery callback when a new JSON file lands', async () => {
		const seen: string[] = [];
		backend.setOnScanDiscovered((refs) => {
			for (const r of refs) {seen.push(r.id);}
		});
		backend.start();

		// Allow initial debounce + immediate scan
		await new Promise((r) => setTimeout(r, 700));

		// Drop a paired scan into the watched folder
		const base = '2026-04-12-143000';
		fs.writeFileSync(
			path.join(tmp, `${base}.json`),
			JSON.stringify({
				version: '1',
				createdAt: '2026-04-12T14:30:00.000Z',
				markdown: '# Hi',
				confidence: 90,
				provider: 'claude',
				model: 'claude-sonnet-4',
				imageFileName: `${base}.jpg`,
			})
		);
		fs.writeFileSync(path.join(tmp, `${base}.jpg`), 'image-bytes');

		// Wait past the debounce
		await new Promise((r) => setTimeout(r, 900));

		expect(seen).toContain(base);
	}, 15000);
});

describe('FolderBackend.start watcher error event (#6)', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		backend.stop();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('absorbs a watcher error event and drops the watcher instead of throwing uncaught', () => {
		backend.start();
		const watcher = (backend as unknown as { watcher: fs.FSWatcher | null }).watcher;
		expect(watcher).not.toBeNull();

		// Without our 'error' listener, emitting 'error' on an EventEmitter throws
		// uncaught. Our handler must log and stop, absorbing it.
		expect(() => watcher!.emit('error', new Error('watched folder vanished'))).not.toThrow();

		// The handler dropped the dead watcher (and now waits for the folder to come
		// back; see folder-backend-rearm.test.ts).
		expect((backend as unknown as { watcher: fs.FSWatcher | null }).watcher).toBeNull();
	});
});

describe('FolderBackend.start error path', () => {
	it('logs and recovers if the folder does not exist', () => {
		const backend = new FolderBackend('/non/existent/folder/papersync');
		expect(() => backend.start()).not.toThrow();
		backend.stop();
	});

	it('catches discoverUnsynced rejection inside the debounced timer (folder deleted between start and fire)', async () => {
		const tmp = makeTempDir();
		const backend = new FolderBackend(tmp);
		try {
			backend.start();
			// Pull the rug — delete the folder before the debounce fires (~500ms).
			fs.rmSync(tmp, { recursive: true, force: true });
			// Wait past the debounce so discoverUnsynced runs and rejects internally.
			await new Promise((r) => setTimeout(r, 700));
			// No throw escaping into the test runner means the internal catch did its job.
		} finally {
			backend.stop();
		}
	}, 15000);

	it('stringifies a non-Error rejection from discovery inside the debounced timer (String(err) branch)', async () => {
		jest.useFakeTimers();
		const tmp = makeTempDir();
		const backend = new FolderBackend(tmp);
		const spy = jest
			.spyOn(backend as unknown as { discoverUnsynced: () => Promise<unknown> }, 'discoverUnsynced')
			.mockRejectedValue('discovery-blew-up'); // non-Error → String(err) branch
		try {
			backend.start(); // schedules the 500ms debounced discovery
			await jest.advanceTimersByTimeAsync(600); // fire it deterministically
		} finally {
			spy.mockRestore();
			backend.stop();
			jest.useRealTimers();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe('FolderBackend.start — discovery with no callback registered', () => {
	const scanBody = {
		version: '1',
		createdAt: '2026-04-12T14:30:00.000Z',
		markdown: '# Hi',
		confidence: 90,
		provider: 'claude',
		model: 'claude-sonnet-4',
	};

	it('does not throw when discovery finds refs but onScanDiscovered is unset (nullish optional chain)', async () => {
		const tmp = makeTempDir();
		const base = '2026-11-11-210000';
		fs.writeFileSync(
			path.join(tmp, `${base}.json`),
			JSON.stringify({ ...scanBody, imageFileName: `${base}.jpg` })
		);
		fs.writeFileSync(path.join(tmp, `${base}.jpg`), 'image-bytes');

		const backend = new FolderBackend(tmp);
		try {
			// No setOnScanDiscovered — the debounced discovery finds 1 ref and must
			// short-circuit `this.onScanDiscovered?.(refs)` without throwing.
			backend.start();
			await new Promise((r) => setTimeout(r, 900));
		} finally {
			backend.stop();
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}, 15000);
});
