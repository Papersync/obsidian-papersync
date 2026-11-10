import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, vaultBasePath, writeScan, syncNow, readNotes, isoStamp, switchToMainWindow } from './helpers';
import { fileExists, filesContaining, readFile } from './destination-helpers';

// The folder pipeline end to end. Every test writes its own scan (own id and
// marker) and asserts on it unconditionally, so a test never depends on what an
// earlier one left behind and never passes by finding nothing to check.

const PNG_1X1 = Buffer.from([
	0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
	0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
	0x54, 0x08, 0x99, 0x63, 0x60, 0x60, 0x60, 0x00,
	0x00, 0x00, 0x04, 0x00, 0x01, 0x5C, 0xCD, 0xFF,
	0x69, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
	0x44, 0xAE, 0x42, 0x60, 0x82,
]);

describe('Sync pipeline E2E', function () {
	const SCANS = 'PaperSync-test-scans';
	let dir: string;
	let n = 0;

	// Writes one scan created now and returns its id and marker.
	function newScan(label: string, image: 'jpg' | 'png' = 'jpg', createdAt = new Date()): { id: string; marker: string } {
		n += 1;
		const stamp = isoStamp();
		const id = `${label}-${stamp}-${n}`;
		const marker = `${label.toUpperCase()}_${stamp}_${n}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: createdAt.toISOString(),
			markdown: `# ${marker}\n\nThis note was created by the E2E test pipeline.`,
			confidence: 95,
			provider: 'e2e-test',
			model: 'mock-model',
			imageFileName: `${id}.${image}`,
		}, image === 'jpg');
		if (image === 'png') { fs.writeFileSync(path.join(dir, `${id}.png`), PNG_1X1); }
		return { id, marker };
	}

	async function noteWith(marker: string): Promise<{ path: string; body: string }> {
		const hits = await filesContaining(marker);
		expect(hits).toHaveLength(1);
		return { path: hits[0]!, body: await readFile(hits[0]!) };
	}

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'SyncTest', attachmentsFolder: 'SyncTest/attachments' });
		await closeSettings(); // the first-run Settings window of the clean vault
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('syncs a scan from local folder into a vault note', async function () {
		const { id, marker } = newScan('basic');
		await syncNow();

		const note = await noteWith(marker);
		expect(note.path.startsWith('SyncTest/')).toBe(true);
		expect(note.body).toContain(`# ${marker}`);
		expect(note.body).toContain('This note was created by the E2E test pipeline.');
		expect(note.body).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
		// The note lists the scan id in its frontmatter (the dedupe record).
		await switchToMainWindow();
		const listed = await browser.execute((p: string) => {
			const app = (window as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown }; metadataCache: { getFileCache: (f: unknown) => { frontmatter?: Record<string, unknown> } | null } } }).app;
			const fm = app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(p))?.frontmatter;
			return [fm?.['papersync-scans']].flat().map(String);
		}, note.path);
		expect(listed).toContain(id);
	});

	it('saves the scan image in the attachments folder and embeds it in the Source callout', async function () {
		const { id, marker } = newScan('image');
		await syncNow();

		const imagePath = `SyncTest/attachments/papersync-${id}.jpg`;
		expect(await fileExists(imagePath)).toBe(true);
		const note = await noteWith(marker);
		expect(note.body).toContain('[!abstract]- Source');
		expect(note.body).toContain(`![[${imagePath}]]`);
	});

	it('marks the scan as synced in the JSON file', async function () {
		const { id, marker } = newScan('marked');
		await syncNow();

		await noteWith(marker);
		const json = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
		expect(json.synced).toBe(true);
	});

	it('syncs a PNG-format scan (legacy archive companion image)', async function () {
		// Regression test for folder-backend.ts image-extension fallback fix.
		// Pre-fix, discoverUnsynced hardcoded `.jpg` lookup and silently skipped
		// any scan whose companion image was `.png` (legacy capture format).
		const { id, marker } = newScan('png', 'png');
		await syncNow();

		const note = await noteWith(marker);
		expect(note.body).toContain(`papersync-${id}.png]]`);
		expect(await fileExists(`SyncTest/attachments/papersync-${id}.png`)).toBe(true);
		const json = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
		expect(json.synced).toBe(true);
	});

	it('appends a second scan of the same day to the same note with a separator', async function () {
		// Two fixed times on one local day, so a run near midnight cannot split them.
		const first = newScan('first', 'jpg', new Date(2026, 0, 15, 10, 0));
		await syncNow();
		const second = newScan('second', 'jpg', new Date(2026, 0, 15, 10, 5));
		await syncNow();

		const a = await noteWith(first.marker);
		const b = await noteWith(second.marker);
		expect(b.path).toBe(a.path);
		const body = b.body;
		const i = body.indexOf(`# ${first.marker}`);
		const j = body.indexOf(`# ${second.marker}`);
		expect(i).toBeGreaterThanOrEqual(0);
		expect(j).toBeGreaterThan(i);
		expect(body.slice(i, j)).toContain('***');
		expect(await readNotes('SyncTest')).toContain(second.marker);
	});
});
