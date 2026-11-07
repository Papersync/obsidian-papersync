import * as fs from 'fs';
import * as path from 'path';
import { closeSettings, configureFolderBackend, focusSettingsUI, openPluginSettings, switchToMainWindow, vaultBasePath } from './helpers';
import {
	fileExists,
	getDestination,
	readDestinationUI,
	readFile,
	reloadPapersync,
	scanAndWait,
	setDailyNotes,
	setDestination,
	today,
	waitForDestinationUI,
	writeVaultFile,
} from './destination-helpers';

// Save scans to, against real Obsidian, its real core Daily notes plugin and real
// vault files: every case asserts the exact note path a scan landed in and its
// content, not only the settings state.

const HINT = 'Turn on Daily notes in Obsidian to use this';

async function typeInto(rowClass: string, value: string): Promise<void> {
	await focusSettingsUI();
	const input = await browser.$(`.${rowClass} input`);
	await input.setValue(value);
	// Leave the field (a finished edit commits it to the sync engine).
	await (await browser.$(`.${rowClass} .setting-item-name`)).click();
}

async function pickInDropdown(value: 'daily' | 'custom'): Promise<void> {
	await focusSettingsUI();
	// Obsidian's dropdown adds a hidden "is-measuring" select next to the real one.
	await (await browser.$('.papersync-save-to select.dropdown:not(.is-measuring)')).selectByAttribute('value', value);
}

async function previewPath(): Promise<string> {
	await focusSettingsUI();
	const { preview } = await readDestinationUI();
	return preview.replace(/^(Today|Every scan): /, '');
}

describe('Save scans to', function () {
	this.timeout(120_000);
	const SCANS = 'Papersync-destination-scans';
	let dir: string;

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(async function () {
		await closeSettings().catch(() => undefined);
		await switchToMainWindow();
	});

	describe('first setup', function () {
		it('defaults to Daily note in a fresh vault with Daily notes on', async function () {
			// A fresh vault: nothing chosen yet.
			expect((await getDestination()).saveTo).toBe('');
			await setDailyNotes(true, 'FreshDaily', 'YYYY-MM-DD');
			await configureFirstSetup(dir);

			expect((await getDestination()).saveTo).toBe('daily');
			await openPluginSettings();
			const ui = await waitForDestinationUI((u) => u.present && u.value === 'daily', 'Daily note');
			expect(ui.folderVisible).toBe(false);
			expect(ui.fileVisible).toBe(false);
			expect(ui.preview).toBe(`Today: FreshDaily/${today()}.md`);
		});

		it('defaults to Custom Papersync / YYYY-MM-DD with Daily notes off', async function () {
			await setDailyNotes(false);
			await setDestination({ saveTo: '' });
			await configureFirstSetup(dir);

			expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
			const hits = await scanAndWait(dir, `FIRST_OFF_${Date.now()}`);
			expect(hits).toEqual([`Papersync/${today()}.md`]);
		});
	});

	describe('Daily note mode', function () {
		before(async function () {
			await configureFolderBackend({ folderPath: dir, targetFolder: 'Unused', attachmentsFolder: 'DestAttachments' });
			await setDestination({ saveTo: 'daily' });
		});

		it('appends to an existing daily note at <daily folder>/<YYYY-MM-DD>.md, keeping its content', async function () {
			await setDailyNotes(true, 'DailyE2E', 'YYYY-MM-DD');
			const notePath = `DailyE2E/${today()}.md`;
			await writeVaultFile(notePath, '# My day\n\nWritten before the scan.\n');

			const marker = `DAILY_${Date.now()}`;
			expect(await scanAndWait(dir, marker)).toEqual([notePath]);

			const body = await readFile(notePath);
			expect(body).toContain('# My day');
			expect(body).toContain('Written before the scan.');
			expect(body.indexOf('Written before the scan.')).toBeLessThan(body.indexOf('***'));
			expect(body.indexOf('***')).toBeLessThan(body.indexOf(marker));
		});

		it('names the note with a named-month format', async function () {
			await setDailyNotes(true, 'DailyNamed', 'MMMM D, YYYY');
			const marker = `NAMED_${Date.now()}`;
			expect(await scanAndWait(dir, marker)).toEqual([`DailyNamed/${today('MMMM D, YYYY')}.md`]);
		});

		it('creates every parent for a nested format', async function () {
			await setDailyNotes(true, 'DailyNest', 'YYYY/MM/YYYY-MM-DD');
			const marker = `NEST_${Date.now()}`;
			const expected = `DailyNest/${today('YYYY/MM/YYYY-MM-DD')}.md`;
			expect(await scanAndWait(dir, marker)).toEqual([expected]);
			expect(await fileExists(`DailyNest/${today('YYYY/MM')}`)).toBe(true);
		});

		it('uses date codes in the Daily notes folder as written, exactly like Obsidian opens today', async function () {
			// Core Daily notes formats only its date format, never its folder: its own
			// "Open today's daily note" goes to a folder literally named YYYY/MM. The
			// scan must land in that same note, not in a dated folder of its own.
			await setDailyNotes(true, 'DailyLit/YYYY/MM', 'YYYY-MM-DD');
			await switchToMainWindow();
			// Obsidian's Daily notes does not create a missing folder, so make the
			// literal one, as it exists for anyone whose daily notes already work.
			await browser.execute(async () => {
				const vault = (window as unknown as { app: { vault: { createFolder: (p: string) => Promise<unknown>; getAbstractFileByPath: (p: string) => unknown } } }).app.vault;
				if (!vault.getAbstractFileByPath('DailyLit/YYYY/MM')) {await vault.createFolder('DailyLit/YYYY/MM');}
			});
			await browser.executeObsidianCommand('daily-notes');
			let opened = '';
			await browser.waitUntil(async () => {
				opened = await browser.execute(() =>
					(window as unknown as { app: { workspace: { getActiveFile: () => { path: string } | null } } }).app.workspace.getActiveFile()?.path ?? '');
				return opened.startsWith('DailyLit/');
			}, { timeout: 10_000, interval: 250 }).catch(async () => {
				const files = await browser.execute(() =>
					(window as unknown as { app: { vault: { getFiles: () => Array<{ path: string }> } } }).app.vault.getFiles()
						.map((f) => f.path).filter((p) => p.startsWith('DailyLit')));
				throw new Error(`Daily notes never opened today's note (active: "${opened}", DailyLit files: ${JSON.stringify(files)})`);
			});
			expect(opened).toBe(`DailyLit/YYYY/MM/${today()}.md`);
			expect(await scanAndWait(dir, `LITERAL_${Date.now()}`)).toEqual([opened]);
		});

		it('follows a Daily notes folder and format change on the next scan, with no Papersync setting touched', async function () {
			await setDailyNotes(true, 'DailyBefore', 'YYYY-MM-DD');
			const before = await getDestination();
			expect(await scanAndWait(dir, `LIVE1_${Date.now()}`)).toEqual([`DailyBefore/${today()}.md`]);

			await setDailyNotes(true, 'DailyAfter', 'MMMM D, YYYY');
			expect(await scanAndWait(dir, `LIVE2_${Date.now()}`)).toEqual([`DailyAfter/${today('MMMM D, YYYY')}.md`]);
			expect(await getDestination()).toEqual(before);
		});

		it('shows the daily path in the preview, and it is where the scan lands', async function () {
			await setDailyNotes(true, 'DailyPreview', 'YYYY/MM/YYYY-MM-DD');
			await openPluginSettings();
			const ui = await waitForDestinationUI((u) => u.value === 'daily', 'Daily note');
			expect(ui.desc).toContain('Follows your Daily notes folder and date format.');
			expect(ui.dailyDisabled).toBe(false);
			const shown = await previewPath();
			expect(ui.preview.startsWith('Today: ')).toBe(true);
			await closeSettings();

			expect(await scanAndWait(dir, `PREV_DAILY_${Date.now()}`)).toEqual([shown]);
		});
	});

	describe('Daily notes turned off while Daily note is saved', function () {
		before(async function () {
			await configureFolderBackend({ folderPath: dir, targetFolder: 'CustomOff', attachmentsFolder: 'DestAttachments' });
			await setDestination({ saveTo: 'daily', customFolder: 'CustomOff', customFileName: 'YYYY-MM-DD' });
			await setDailyNotes(true, 'DailyBack', 'YYYY-MM-DD');
		});

		it('shows Custom with its fields, Daily note disabled with the hint, and no warning', async function () {
			await setDailyNotes(false);
			await openPluginSettings();
			const ui = await waitForDestinationUI((u) => u.present && u.value === 'custom', 'Custom');
			expect(ui.dailyDisabled).toBe(true);
			expect(ui.dailyLabel).toContain(HINT);
			expect(ui.folderVisible).toBe(true);
			expect(ui.fileVisible).toBe(true);
			expect(ui.warningRows).toBe(0);
			expect(ui.desc).not.toContain('Follows your Daily notes');
			expect(ui.preview).toBe(`Today: CustomOff/${today()}.md`);
			// The saved choice is untouched.
			expect((await getDestination()).saveTo).toBe('daily');
		});

		it('sends the next scan to the custom path', async function () {
			await setDailyNotes(false);
			expect(await scanAndWait(dir, `OFF_${Date.now()}`)).toEqual([`CustomOff/${today()}.md`]);
			expect((await getDestination()).saveTo).toBe('daily');
		});

		it('keeps Daily note across a settings reopen and a plugin reload, and it comes back with Daily notes', async function () {
			await setDailyNotes(false);
			await openPluginSettings();
			await waitForDestinationUI((u) => u.value === 'custom', 'Custom');
			await closeSettings();
			await openPluginSettings();
			await waitForDestinationUI((u) => u.value === 'custom', 'Custom after a reopen');
			await closeSettings();

			await reloadPapersync();
			expect((await getDestination()).saveTo).toBe('daily');

			await setDailyNotes(true, 'DailyBack', 'YYYY-MM-DD');
			await openPluginSettings();
			const ui = await waitForDestinationUI((u) => u.value === 'daily', 'Daily note again');
			expect(ui.dailyDisabled).toBe(false);
			expect(ui.folderVisible).toBe(false);
			await closeSettings();
			expect(await scanAndWait(dir, `BACK_${Date.now()}`)).toEqual([`DailyBack/${today()}.md`]);
		});
	});

	describe('Custom folder and file', function () {
		before(async function () {
			await configureFolderBackend({ folderPath: dir, targetFolder: 'Unused', attachmentsFolder: 'DestAttachments' });
			await setDailyNotes(true, 'DailyIgnored', 'YYYY-MM-DD');
		});

		it('formats date tokens in the folder and the file name', async function () {
			await setDestination({ saveTo: 'custom', customFolder: 'Journal/YYYY/MM', customFileName: 'YYYY-MM-DD' });
			expect(await scanAndWait(dir, `JOURNAL_${Date.now()}`)).toEqual([`Journal/${today('YYYY/MM')}/${today()}.md`]);
		});

		it('writes month names in the folder (M-MMMM is 11-November, not 11-1111)', async function () {
			await setDestination({ saveTo: 'custom', customFolder: 'Months/YYYY/M-MMMM', customFileName: 'YYYY-MM-DD' });
			const expected = `Months/${today('YYYY/M-MMMM')}/${today()}.md`;
			expect(expected).toMatch(/^Months\/\d{4}\/\d{1,2}-[A-Za-z]+\//);
			expect(await scanAndWait(dir, `MONTHS_${Date.now()}`)).toEqual([expected]);
		});

		it('puts the note at the vault root for /', async function () {
			await setDestination({ saveTo: 'custom', customFolder: '/', customFileName: '[Root] YYYY-MM-DD' });
			expect(await scanAndWait(dir, `ROOT_${Date.now()}`)).toEqual([`Root ${today()}.md`]);
		});

		it('appends every scan to one note for a fixed file name', async function () {
			await setDestination({ saveTo: 'custom', customFolder: 'Inbox', customFileName: 'Scans' });
			const first = `FIXED1_${Date.now()}`;
			expect(await scanAndWait(dir, first)).toEqual(['Inbox/Scans.md']);
			const second = `FIXED2_${Date.now()}`;
			expect(await scanAndWait(dir, second)).toEqual(['Inbox/Scans.md']);

			const body = await readFile('Inbox/Scans.md');
			expect(body.indexOf(first)).toBeLessThan(body.indexOf('***'));
			expect(body.indexOf('***')).toBeLessThan(body.indexOf(second));
		});

		it('updates the preview live as the fields change, and the scan lands on it', async function () {
			await setDestination({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
			await openPluginSettings();
			await waitForDestinationUI((u) => u.value === 'custom' && u.folderVisible, 'Custom');

			await typeInto('papersync-custom-folder', 'Inbox');
			await typeInto('papersync-custom-file', 'Scans');
			let ui = await waitForDestinationUI((u) => u.preview === 'Every scan: Inbox/Scans.md', 'the fixed-note preview');
			expect(ui.desc).toBe('Each scan is added to this note.Every scan: Inbox/Scans.md');

			await typeInto('papersync-custom-folder', 'Live/YYYY');
			await typeInto('papersync-custom-file', 'MMMM D, YYYY');
			ui = await waitForDestinationUI((u) => u.preview === `Today: Live/${today('YYYY')}/${today('MMMM D, YYYY')}.md`, 'the dated preview');
			const shown = await previewPath();
			await closeSettings();

			expect(await getDestination()).toMatchObject({ customFolder: 'Live/YYYY', customFileName: 'MMMM D, YYYY' });
			expect(await scanAndWait(dir, `PREV_CUSTOM_${Date.now()}`)).toEqual([shown]);
		});

		it('switches between the two modes from the dropdown', async function () {
			await setDestination({ saveTo: 'custom', customFolder: 'Inbox', customFileName: 'Scans' });
			await openPluginSettings();
			await waitForDestinationUI((u) => u.value === 'custom', 'Custom');
			await pickInDropdown('daily');
			let ui = await waitForDestinationUI((u) => u.value === 'daily' && !u.folderVisible, 'Daily note after the pick');
			expect(ui.preview).toBe(`Today: DailyIgnored/${today()}.md`);
			expect((await getDestination()).saveTo).toBe('daily');

			await pickInDropdown('custom');
			ui = await waitForDestinationUI((u) => u.value === 'custom' && u.folderVisible && u.fileVisible, 'Custom after the pick');
			expect(ui.preview).toBe('Every scan: Inbox/Scans.md');
			await closeSettings();
			expect(await scanAndWait(dir, `SWITCH_${Date.now()}`)).toEqual(['Inbox/Scans.md']);
		});
	});

	describe('Reset settings', function () {
		before(async function () {
			await configureFolderBackend({ folderPath: dir, targetFolder: 'BeforeReset', attachmentsFolder: 'DestAttachments' });
		});

		it('re-applies the first-setup default: Daily note with Daily notes on', async function () {
			await setDailyNotes(true, 'DailyReset', 'YYYY-MM-DD');
			await setDestination({ saveTo: 'custom', customFolder: 'BeforeReset', customFileName: 'Scans' });
			await openPluginSettings();
			await clickReset();
			await waitForDestinationUI((u) => u.value === 'daily', 'Daily note after reset');
			await closeSettings();

			expect(await getDestination()).toMatchObject({ saveTo: 'daily', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
			expect(await scanAndWait(dir, `RESET_ON_${Date.now()}`)).toEqual([`DailyReset/${today()}.md`]);
		});

		it('re-applies the first-setup default: Custom Papersync with Daily notes off', async function () {
			await setDailyNotes(false);
			await setDestination({ saveTo: 'daily', customFolder: 'BeforeReset', customFileName: 'Scans' });
			await openPluginSettings();
			await clickReset();
			await waitForDestinationUI((u) => u.value === 'custom' && u.preview === `Today: Papersync/${today()}.md`, 'Custom Papersync after reset');
			await closeSettings();

			expect(await getDestination()).toMatchObject({ saveTo: 'custom', customFolder: 'Papersync', customFileName: 'YYYY-MM-DD' });
			expect(await scanAndWait(dir, `RESET_OFF_${Date.now()}`)).toEqual([`Papersync/${today()}.md`]);
		});
	});
});

// First setup the way the settings tab does it: a folder backend chosen, then
// startSync (which picks where scans go when nothing is chosen yet).
async function configureFirstSetup(dir: string): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (folder: string) => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>; saveSettings: () => Promise<void>; startSync: () => Promise<void>;
		}> } } }).app.plugins.plugins;
		const plugin = ps['papersync']!;
		Object.assign(plugin.settings, {
			backendType: 'folder', folderPath: folder, folderType: 'custom', setupComplete: true,
			lastSyncTimestamp: '', attachmentsFolder: 'DestAttachments',
		});
		await plugin.saveSettings();
		await plugin.startSync();
	}, dir);
}

async function clickReset(): Promise<void> {
	await focusSettingsUI();
	await browser.waitUntil(() => browser.execute(() => {
		const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reset settings');
		if (btn) { btn.click(); return true; }
		return false;
	}), { timeout: 5000, interval: 200, timeoutMsg: 'Reset settings button never appeared' });
	await browser.pause(500);
}
