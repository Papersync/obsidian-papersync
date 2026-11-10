import * as fs from 'fs';
import * as path from 'path';
import { STRINGS } from '../../src/utils/strings';
import { closeSettings, configureFolderBackend, switchToMainWindow, vaultBasePath, waitForNotes, waitForPlugin, writeScan, isoStamp } from './helpers';

async function noticeTexts(): Promise<string[]> {
	await switchToMainWindow();
	return browser.execute(() => Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? ''));
}

async function statusBarText(): Promise<string> {
	await switchToMainWindow();
	return browser.execute(() => Array.from(document.querySelectorAll('.status-bar-item'))
		.map((el) => el.textContent ?? '')
		.find((t) => t.startsWith('Papersync')) ?? '');
}

describe('Sync state management', function () {
	const SCANS = 'Papersync-syncstate-scans';
	let dir: string;

	before(async function () {
		await waitForPlugin();
		// A clean vault opens Settings on first run (a window on 1.13+); close it so
		// the ribbon and status bar are in reach.
		await closeSettings();
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
	});

	after(function () {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('Sync now with no storage chosen says Papersync is not configured', async function () {
		// The clean test vault has no backend, so there is no sync engine.
		await browser.executeObsidianCommand('papersync:sync-now');
		await browser.waitUntil(
			async () => (await noticeTexts()).some((t) => t.includes('Papersync is not configured')),
			{ timeout: 5000, interval: 100, timeoutMsg: 'no "not configured" notice after Sync now' }
		);
	});

	it('the ribbon icon (tooltip Sync scans now) runs a sync that imports a waiting scan', async function () {
		await configureFolderBackend({ folderPath: dir, targetFolder: 'SyncStateTest', attachmentsFolder: 'SyncStateTest/attachments' });
		const ribbon = await browser.$(`.side-dock-ribbon-action[aria-label="${STRINGS.RIBBON_TOOLTIP}"]`);
		await ribbon.waitForExist({ timeout: 5000 });

		// Stop the watcher so only the ribbon click can import this scan.
		await browser.execute(() => {
			const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { syncEngine: { backend: { stop: () => void } } | null }> } } }).app.plugins.plugins;
			ps['papersync']?.syncEngine?.backend.stop();
		});
		const stamp = isoStamp();
		const id = `ribbon-${stamp}`;
		const marker = `RIBBON_${stamp}`;
		writeScan(dir, id, {
			version: 1,
			createdAt: new Date().toISOString(),
			markdown: `# ${marker}`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: `${id}.jpg`,
		});

		await ribbon.click();
		await waitForNotes('SyncStateTest', marker, 20_000);
	});

	it('the status bar says synced after a completed sync', async function () {
		await browser.waitUntil(
			async () => (await statusBarText()) === STRINGS.STATUS_SYNCED,
			{ timeout: 10_000, interval: 200, timeoutMsg: `status bar never showed "${STRINGS.STATUS_SYNCED}"` }
		);
	});
});
