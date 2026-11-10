import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, closeSettings, vaultBasePath, writeScan, syncNow, isoStamp, switchToMainWindow } from './helpers';
import { filesContaining, readFile } from './destination-helpers';

async function vaultFilesNamed(fragment: string): Promise<string[]> {
	await switchToMainWindow();
	return browser.execute((f: string) => (window as unknown as { app: { vault: { getFiles: () => Array<{ path: string }> } } })
		.app.vault.getFiles().map((file) => file.path).filter((p) => p.includes(f)), fragment);
}

async function setObsidianAttachmentFolder(value: string): Promise<void> {
	await switchToMainWindow();
	await browser.execute((v: string) => {
		(window as unknown as { app: { vault: { setConfig: (k: string, v: string) => void } } }).app.vault.setConfig('attachmentFolderPath', v);
	}, value);
}

describe('Scan image settings', function () {
	const SCANS = 'Papersync-image-settings-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
	});

	after(async function () {
		await setObsidianAttachmentFolder('/');
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	function newScan(label: string): { id: string; marker: string } {
		const stamp = isoStamp();
		const id = `${label}-${stamp}`;
		const marker = `${label.toUpperCase()}_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}\n\nImage settings test.`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});
		return { id, marker };
	}

	it('with Save scan images off, imports the text with no attachment and no embed', async function () {
		await configureFolderBackend({ folderPath: dir, targetFolder: 'NoImages', attachmentsFolder: 'NoImages/attachments', downloadImages: false });
		await closeSettings(); // the first-run Settings window of the clean vault
		const { id, marker } = newScan('noimg');
		await syncNow();

		const hits = await filesContaining(marker);
		expect(hits).toHaveLength(1);
		const body = await readFile(hits[0]!);
		expect(body).toContain(`# ${marker}`);
		expect(body).not.toContain('![[');
		expect(await vaultFilesNamed(`papersync-${id}`)).toEqual([]);
		// The photo stays where it was, and the scan still counts as imported.
		expect(fs.existsSync(path.join(dir, `${id}.jpg`))).toBe(true);
		expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).synced).toBe(true);
	});

	it('with the Attachments folder empty, saves the image in Obsidian\'s own attachment folder', async function () {
		await setObsidianAttachmentFolder('ObsidianAssets');
		await configureFolderBackend({ folderPath: dir, targetFolder: 'DefaultAttach', attachmentsFolder: '', downloadImages: true });
		const { id, marker } = newScan('defattach');
		await syncNow();

		const expected = `ObsidianAssets/papersync-${id}.jpg`;
		expect(await vaultFilesNamed(`papersync-${id}`)).toEqual([expected]);
		const hits = await filesContaining(marker);
		expect(hits).toHaveLength(1);
		expect(await readFile(hits[0]!)).toContain(`![[${expected}]]`);
	});
});
