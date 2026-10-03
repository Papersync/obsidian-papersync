import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	configureFolderBackend,
	triggerSyncNow,
	waitForNotes,
	readNotes,
	MINIMAL_JPEG,
	isoStamp,
	switchToMainWindow,
} from './helpers';

describe('Missing saved scan photo', function () {
	this.timeout(100_000);
	let dir: string;
	let target: string;
	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papersync-missing-photo-e2e-'));
		target = `MissingPhoto-${isoStamp()}`;
		await configureFolderBackend({
			folderPath: dir,
			targetFolder: target,
			attachmentsFolder: `${target}/attachments`,
			downloadImages: true,
		});
	});
	afterEach(async () => {
		await switchToMainWindow();
		await browser.execute(() => {
			const plugins = (
				window as unknown as {
					app: {
						plugins: { plugins: Record<string, { syncEngine: { stop: () => void } | null }> };
					};
				}
			).app.plugins.plugins;
			plugins['papersync']?.syncEngine?.stop();
		});
		fs.rmSync(dir, { recursive: true, force: true });
	});
	function write(id: string, createdAt: string): void {
		fs.writeFileSync(
			path.join(dir, `${id}.json`),
			JSON.stringify({
				version: 1,
				createdAt,
				markdown: `# ${id} text kept`,
				confidence: 95,
				provider: 'test',
				model: 'test',
				imageFileName: `${id}.jpg`,
			})
		);
	}
	async function waitPending(): Promise<void> {
		await browser.waitUntil(() => browser.execute(() => {
			const plugin = (window as unknown as {app: {plugins: {plugins: Record<string, {syncState: {isSyncing: boolean; pendingCount: number}}>}}}).app.plugins.plugins['papersync'];
			return !!plugin && !plugin.syncState.isSyncing && plugin.syncState.pendingCount === 1;
		}), {timeout: 5000, interval: 100, timeoutMsg: 'new JSON did not enter companion grace'});
	}

	async function waitSynced(id: string): Promise<void> {
		await browser.waitUntil(() => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).synced === true,
			{timeout: 5000, interval: 100, timeoutMsg: 'import did not mark its source JSON synced'});
	}

	for (const action of ['delete', 'move']) {
		it(`imports text once when the saved photo is ${action}d`, async () => {
			const id = `${action}-${isoStamp()}`;
			// Existing saved scan, with its companion removed outside Obsidian.
			fs.writeFileSync(path.join(dir, `${id}.jpg`), MINIMAL_JPEG);
			if (action === 'delete') {
				fs.unlinkSync(path.join(dir, `${id}.jpg`));
			} else {
				fs.renameSync(path.join(dir, `${id}.jpg`), path.join(dir, 'moved.jpg'));
			}
			write(id, '2026-01-01T12:00:00Z');
			await triggerSyncNow();
			let text = await waitForNotes(target, `# ${id} text kept`, 75_000);
			await waitSynced(id);
			expect(text).not.toContain('![[');
			await triggerSyncNow();
			text = await readNotes(target);
			expect(text.split(`# ${id} text kept`)).toHaveLength(2);
			expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).synced).toBe(true);
		});
	}
	it('keeps JSON-first uploads pending and imports their photo at recheck', async () => {
		const id = `late-${isoStamp()}`;
		write(id, new Date().toISOString());
		await triggerSyncNow();
		await waitPending();
		// The first pass must not mark a JSON-first upload synced.
		expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).synced).not.toBe(true);
		fs.writeFileSync(path.join(dir, `${id}.jpg`), MINIMAL_JPEG);
		await triggerSyncNow();
		const text = await waitForNotes(target, `# ${id} text kept`, 75_000);
		expect(text).toContain('![[');
	});
	it('automatically imports permanently absent photos after the bounded grace', async () => {
		const id = `grace-${isoStamp()}`;
		write(id, new Date().toISOString());
		await triggerSyncNow();
		await waitPending();
		expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).synced).not.toBe(true);
		const text = await waitForNotes(target, `# ${id} text kept`, 75_000);
		await waitSynced(id);
		expect(text).not.toContain('![[');
		expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')).synced).toBe(true);
	});
});
