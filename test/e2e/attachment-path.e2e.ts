import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, syncNow, readNotes, isoStamp } from './helpers';

// Regression lock for the attachment-path normalization fix: an override
// attachments folder with a trailing slash must not produce a double slash in the
// saved image path or the note embed.
describe('Attachment path normalization', function () {
	const SCANS = 'PaperSync-attach-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		// Trailing slash on purpose.
		await configureFolderBackend({ folderPath: dir, targetFolder: 'AttachTest', attachmentsFolder: 'AttachSlash/' });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('saves the image and embeds it with a single slash despite a trailing-slash folder', async function () {
		const stamp = isoStamp();
		const id = `slash-${stamp}`;
		const marker = `SLASH_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}\n\nAttachment path parity test.`,
			confidence: 92,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});

		await syncNow();

		const imageOk = await browser.execute((imgId: string) => {
			const app = (window as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown } } }).app;
			return app.vault.getAbstractFileByPath(`AttachSlash/papersync-${imgId}.jpg`) !== null;
		}, id);
		expect(imageOk).toBe(true);

		const notes = await readNotes('AttachTest');
		expect(notes).toContain(marker);
		expect(notes).not.toContain('AttachSlash//');
	});
});
