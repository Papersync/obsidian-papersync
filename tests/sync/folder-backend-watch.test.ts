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
});
