import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, syncNow, readNotes, isoStamp } from './helpers';

// Regression lock for the createdAt -> z.iso.datetime() tightening: a non-parseable
// createdAt must be rejected as a schema mismatch (no note, no "Invalid date" /
// "NaN:NaN" file, not marked synced) and MUST NOT block a valid sibling in the
// same batch (error isolation).
describe('Invalid createdAt rejection', function () {
	const SCANS = 'PaperSync-baddate-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'BadDate', attachmentsFolder: 'BadDate/attachments' });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('rejects an invalid createdAt without a corrupt note, and still syncs a valid sibling', async function () {
		const stamp = isoStamp();
		const badId = `bad-${stamp}`;
		const badMarker = `BADDATE_${stamp}`;
		writeScan(dir, badId, {
			version: 1,
			createdAt: 'not-a-real-date',
			markdown: `# ${badMarker}\n\nMust never reach the vault.`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${badId}.jpg`,
		});

		const goodId = `good-${stamp}`;
		const goodMarker = `GOODSIBLING_${stamp}`;
		writeScan(dir, goodId, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${goodMarker}\n\nValid sibling in the same batch.`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${goodId}.jpg`,
		});

		await syncNow();

		const notes = await readNotes('BadDate');
		expect(notes).toContain(goodMarker);
		expect(notes).not.toContain(badMarker);

		const corrupt = await browser.execute(() => {
			const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }> } } }).app;
			return app.vault.getMarkdownFiles().some((f) => /invalid date|nan/i.test(f.path));
		});
		expect(corrupt).toBe(false);

		const badJson = JSON.parse(fs.readFileSync(path.join(dir, `${badId}.json`), 'utf-8'));
		expect(badJson.synced).not.toBe(true);
	});
});
