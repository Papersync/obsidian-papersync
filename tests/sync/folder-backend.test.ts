import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FolderBackend } from '@/sync/folder-backend';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'folder-backend-test-'));
}

function writeScanJson(dir: string, base: string, body: Record<string, unknown>): void {
	fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(body));
}

function writeBlob(dir: string, name: string): void {
	fs.writeFileSync(path.join(dir, name), 'blob');
}

const baseScan = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Sample',
	confidence: 90,
	provider: 'claude',
	model: 'claude-sonnet-4',
};

describe('FolderBackend.discoverUnsynced', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('pairs a JSON scan with its .jpg companion', async () => {
		const base = '2026-04-12-143000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpg` });
		writeBlob(tmp, `${base}.jpg`);

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0].id).toBe(base);
		expect(refs[0].imagePath).toBe(path.join(tmp, `${base}.jpg`));
	});

	it('pairs a JSON scan with a .png companion (legacy archive)', async () => {
		const base = '2025-09-01-101010';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.png` });
		writeBlob(tmp, `${base}.png`);

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0].imagePath).toBe(path.join(tmp, `${base}.png`));
	});

	it('pairs a JSON scan with a .jpeg companion', async () => {
		const base = '2026-01-01-091500';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpeg` });
		writeBlob(tmp, `${base}.jpeg`);

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0].imagePath).toBe(path.join(tmp, `${base}.jpeg`));
	});

	it('falls back to extension probing when imageFileName field is missing', async () => {
		const base = '2026-02-02-120000';
		writeScanJson(tmp, base, { ...baseScan });
		writeBlob(tmp, `${base}.png`);

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0].imagePath).toBe(path.join(tmp, `${base}.png`));
	});

	it('prefers the JSON-declared imageFileName even when other extensions exist on disk', async () => {
		const base = '2026-03-03-130000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.png` });
		writeBlob(tmp, `${base}.png`);
		writeBlob(tmp, `${base}.jpg`); // a stray .jpg should NOT win

		const refs = await backend.discoverUnsynced();
		expect(refs[0].imagePath).toBe(path.join(tmp, `${base}.png`));
	});

	it('skips scans already marked synced', async () => {
		const base = '2026-04-04-140000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpg`, synced: true });
		writeBlob(tmp, `${base}.jpg`);

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(0);
	});

	it('skips scans whose companion image is missing', async () => {
		const base = '2026-05-05-150000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpg` });
		// no companion image on disk

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(0);
	});

	it('tolerates corrupt JSON files without crashing the discovery loop', async () => {
		const goodBase = '2026-06-06-160000';
		writeScanJson(tmp, goodBase, { ...baseScan, imageFileName: `${goodBase}.jpg` });
		writeBlob(tmp, `${goodBase}.jpg`);

		fs.writeFileSync(path.join(tmp, 'corrupt.json'), '{ not valid json');

		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(1);
		expect(refs[0].id).toBe(goodBase);
	});

	it('returns multiple refs for multiple paired scans', async () => {
		const bases = ['2026-07-07-170000', '2026-07-07-170100', '2026-07-07-170200'];
		for (const b of bases) {
			writeScanJson(tmp, b, { ...baseScan, imageFileName: `${b}.jpg` });
			writeBlob(tmp, `${b}.jpg`);
		}
		const refs = await backend.discoverUnsynced();
		expect(refs).toHaveLength(3);
		expect(refs.map((r) => r.id).sort()).toEqual([...bases].sort());
	});
});

describe('FolderBackend.fetchScan', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('returns a validated ScanFile for a well-formed JSON', async () => {
		const base = '2026-04-12-143000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpg` });
		writeBlob(tmp, `${base}.jpg`);

		const ref = {
			id: base,
			jsonPath: path.join(tmp, `${base}.json`),
			imagePath: path.join(tmp, `${base}.jpg`),
		};
		const scan = await backend.fetchScan(ref);
		expect(scan.markdown).toBe('# Sample');
		expect(scan.confidence).toBe(90);
		expect(scan.imageFileName).toBe(`${base}.jpg`);
	});

	it('throws schema_mismatch for a JSON missing required fields', async () => {
		fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify({ version: '1' }));
		const ref = {
			id: 'bad',
			jsonPath: path.join(tmp, 'bad.json'),
			imagePath: path.join(tmp, 'bad.jpg'),
		};
		await expect(backend.fetchScan(ref)).rejects.toMatchObject({ type: 'schema_mismatch' });
	});

	it('coerces numeric version to string per the schema contract', async () => {
		const base = '2026-04-12-143000';
		// App writes `version: 1` (number); plugin must accept it.
		writeScanJson(tmp, base, { ...baseScan, version: 1, imageFileName: `${base}.jpg` });
		writeBlob(tmp, `${base}.jpg`);
		const ref = {
			id: base,
			jsonPath: path.join(tmp, `${base}.json`),
			imagePath: path.join(tmp, `${base}.jpg`),
		};
		const scan = await backend.fetchScan(ref);
		expect(scan.version).toBe('1');
	});
});

describe('FolderBackend.markSynced', () => {
	let tmp: string;
	let backend: FolderBackend;

	beforeEach(() => {
		tmp = makeTempDir();
		backend = new FolderBackend(tmp);
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('writes synced:true into the JSON file in place', async () => {
		const base = '2026-04-12-143000';
		writeScanJson(tmp, base, { ...baseScan, imageFileName: `${base}.jpg` });
		const ref = {
			id: base,
			jsonPath: path.join(tmp, `${base}.json`),
			imagePath: path.join(tmp, `${base}.jpg`),
		};

		await backend.markSynced(ref);

		const updated = JSON.parse(fs.readFileSync(ref.jsonPath, 'utf-8'));
		expect(updated.synced).toBe(true);
		// Original fields preserved
		expect(updated.markdown).toBe('# Sample');
		expect(updated.imageFileName).toBe(`${base}.jpg`);
	});
});

describe('FolderBackend lifecycle', () => {
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

	it('start() then stop() does not throw and is idempotent', () => {
		expect(() => backend.start()).not.toThrow();
		expect(() => backend.stop()).not.toThrow();
		expect(() => backend.stop()).not.toThrow();
	});
});
