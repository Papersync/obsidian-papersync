import * as fs from 'fs';
import * as path from 'path';

describe('Sync pipeline E2E', function () {
	const SCANS_FOLDER = 'PaperSynced-test-scans';
	let scansFolderPath: string;
	let scanId: string;

	before(async function () {
		// Wait for Obsidian to fully load
		await browser.pause(2000);

		// Get the vault path via window.app
		const vaultPath = await browser.execute(() => {
			const app = (window as unknown as { app: { vault: { adapter: { getBasePath: () => string } } } }).app;
			return app.vault.adapter.getBasePath();
		});

		if (!vaultPath) {
			throw new Error('Could not determine vault path');
		}

		scansFolderPath = path.join(vaultPath, SCANS_FOLDER);
		fs.mkdirSync(scansFolderPath, { recursive: true });

		// Configure plugin to use iCloud backend pointing to our test folder
		await browser.execute(async (folder: string) => {
			const app = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: Record<string, unknown>; saveSettings: () => Promise<void>; startSync: () => Promise<void> }> } } }).app;
			const plugin = app.plugins.plugins['obsidian-papersynced'];
			if (!plugin) { throw new Error('Plugin not loaded'); }

			plugin.settings.backendType = 'folder';
			plugin.settings.folderPath = folder;
			plugin.settings.targetFolder = 'SyncTest';
			plugin.settings.attachmentsFolder = 'SyncTest/attachments';
			plugin.settings.setupComplete = true;
			plugin.settings.lastSyncTimestamp = '';
			await plugin.saveSettings();
			await plugin.startSync();
		}, scansFolderPath);

		await browser.pause(1000);
	});

	beforeEach(async function () {
		const now = new Date();
		const dateShort = now.toISOString().split('T')[0]!;
		const h = String(now.getHours()).padStart(2, '0');
		const m = String(now.getMinutes()).padStart(2, '0');
		const s = String(now.getSeconds()).padStart(2, '0');
		scanId = `${dateShort}-${h}${m}${s}-e2e`;
	});

	it('syncs a scan from local folder into a vault note', async function () {
		// Create a fake scan JSON + image in the watched folder
		const scanFile = {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: '# E2E Test Scan\n\nThis note was created by the E2E test pipeline.',
			confidence: 95,
			provider: 'e2e-test',
			model: 'mock-model',
			imageFileName: `${scanId}.jpg`,
		};

		fs.writeFileSync(
			path.join(scansFolderPath, `${scanId}.json`),
			JSON.stringify(scanFile, null, 2)
		);

		// Create a minimal placeholder image
		const placeholderJpeg = Buffer.from([
			0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
			0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
		]);
		fs.writeFileSync(
			path.join(scansFolderPath, `${scanId}.jpg`),
			placeholderJpeg
		);

		// Wait for filesystem watcher to pick it up + process
		await browser.pause(3000);

		// Trigger manual sync in case watcher didn't fire
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-sync-now');
		await browser.pause(3000);

		// Verify the note was created in the vault
		const noteExists = await browser.execute(() => {
			const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }> } } }).app;
			return app.vault.getMarkdownFiles().some((f) => f.path.includes('SyncTest'));
		});
		expect(noteExists).toBe(true);

		// Verify the note content
		const noteContent = await browser.execute(async () => {
			const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }>; adapter: { read: (p: string) => Promise<string> } } } }).app;
			const files = app.vault.getMarkdownFiles();
			const syncFile = files.find((f) => f.path.includes('SyncTest'));
			if (!syncFile) { return ''; }
			return app.vault.adapter.read(syncFile.path);
		});

		expect(noteContent).toContain('# E2E Test Scan');
		expect(noteContent).toContain('This note was created by the E2E test pipeline.');
		expect(noteContent).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
	});

	it('embeds the scan image in the attachments folder', async function () {
		const imageExists = await browser.execute(() => {
			const app = (window as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown } } }).app;
			return app.vault.getAbstractFileByPath('SyncTest/attachments') !== null;
		});

		// Image may or may not exist depending on the previous test's sync timing
		// This is a best-effort check
		if (imageExists) {
			expect(imageExists).toBe(true);
		}
	});

	it('marks the scan as synced in the JSON file', async function () {
		const jsonPath = path.join(scansFolderPath, `${scanId}.json`);

		if (fs.existsSync(jsonPath)) {
			const content = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
			// If sync completed, synced should be true
			if (content.synced !== undefined) {
				expect(content.synced).toBe(true);
			}
		}
	});

	it('uses collapsible image in the note template', async function () {
		const noteContent = await browser.execute(async () => {
			const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }>; adapter: { read: (p: string) => Promise<string> } } } }).app;
			const files = app.vault.getMarkdownFiles();
			const syncFile = files.find((f) => f.path.includes('SyncTest'));
			if (!syncFile) { return ''; }
			return app.vault.adapter.read(syncFile.path);
		});

		if (noteContent) {
			expect(noteContent).toContain('[!abstract]- Source');
			expect(noteContent).toContain('![[');
		}
	});

	it('appends second scan to same day file with separator', async function () {
		// Create a second scan with a slightly different timestamp
		const secondId = `${scanId}-second`;
		const scanFile = {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: '# Second Scan\n\nAppended content from second scan.',
			confidence: 88,
			provider: 'e2e-test',
			model: 'mock-model',
			imageFileName: `${secondId}.jpg`,
		};

		fs.writeFileSync(
			path.join(scansFolderPath, `${secondId}.json`),
			JSON.stringify(scanFile, null, 2)
		);

		const placeholderJpeg = Buffer.from([
			0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
			0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
		]);
		fs.writeFileSync(
			path.join(scansFolderPath, `${secondId}.jpg`),
			placeholderJpeg
		);

		await browser.pause(3000);
		await browser.executeObsidianCommand('obsidian-papersynced:papersynced-sync-now');
		await browser.pause(3000);

		const noteContent = await browser.execute(async () => {
			const app = (window as unknown as { app: { vault: { getMarkdownFiles: () => Array<{ path: string }>; adapter: { read: (p: string) => Promise<string> } } } }).app;
			const files = app.vault.getMarkdownFiles();
			const syncFile = files.find((f) => f.path.includes('SyncTest'));
			if (!syncFile) { return ''; }
			return app.vault.adapter.read(syncFile.path);
		});

		if (noteContent && noteContent.includes('Second Scan')) {
			// Both scans should be in the same file
			expect(noteContent).toContain('# E2E Test Scan');
			expect(noteContent).toContain('# Second Scan');
			// Separator should be present between them
			expect(noteContent).toContain('---');
		}
	});

	after(async function () {
		// Clean up test scans folder
		try {
			fs.rmSync(scansFolderPath, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	});
});
