import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, syncNow, readNotes, isoStamp } from './helpers';

// Proves a scan matching the EXACT shape of production app output (validated
// against ScanFileSchema from 17 real captures: version int, createdAt ISO-8601
// with millis + Z, integer confidence, gemini provider, checkbox markdown) flows
// end to end into a rendered note and round-trips the synced flag.
describe('Real-app-shaped scan sync', function () {
	const SCANS = 'PaperSync-realshape-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		await configureFolderBackend({ folderPath: dir, targetFolder: 'RealShape', attachmentsFolder: 'RealShape/attachments' });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('syncs a production-shaped scan into a rendered note and marks it synced', async function () {
		const stamp = isoStamp();
		const id = `real-${stamp}`;
		const marker = `REALSHAPE_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}\n\n- [x] Ship the audit fixes\n- [ ] Dogfood a code-page capture`,
			confidence: 95,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});

		await syncNow();

		const notes = await readNotes('RealShape');
		expect(notes).toContain(marker);
		expect(notes).toContain('- [x] Ship the audit fixes');
		expect(notes).toContain('- [ ] Dogfood a code-page capture');

		const saved = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
		expect(saved.synced).toBe(true);
	});
});
