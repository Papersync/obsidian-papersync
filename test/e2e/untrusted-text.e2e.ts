import * as fs from 'fs';
import * as path from 'path';
import { configureFolderBackend, vaultBasePath, writeScan, triggerSyncNow, waitForNotes, isoStamp, switchToMainWindow } from './helpers';

// Hostile scans through the real folder backend: a scan that forges another scan's
// import receipt (the legacy comment and a frontmatter list placed at the top of a
// new note), hides a Dataview JS block in a list, loads a remote image through a
// shortcut reference and puts inline JS into its model name. The saved note must
// hold all of it as inert text, and the scan it tried to suppress must still import.
const Z = '​';

type PluginHandle = { settings: Record<string, unknown>; saveSettings: () => Promise<void> };

async function setTemplate(template: string | null): Promise<string> {
	await switchToMainWindow();
	return browser.execute(async (t: string | null) => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, PluginHandle> } } }).app.plugins.plugins;
		const plugin = ps['papersync'] || ps['obsidian-papersync'];
		if (!plugin) { throw new Error('Papersync plugin not loaded'); }
		const previous = String(plugin.settings.templateString);
		if (t !== null) {
			plugin.settings.templateString = t;
			await plugin.saveSettings();
		}
		return previous;
	}, template);
}

// The note's papersync-scans list and every property name, as Obsidian parsed them.
async function noteProperties(folder: string): Promise<{ keys: string[]; scans: unknown }> {
	return browser.execute((f: string) => {
		const app = (window as unknown as { app: {
			vault: { getMarkdownFiles: () => Array<{ path: string }> };
			metadataCache: { getFileCache: (file: unknown) => { frontmatter?: Record<string, unknown> } | null };
		} }).app;
		const file = app.vault.getMarkdownFiles().find((x) => x.path.startsWith(`${f}/`));
		const fm = (file && app.metadataCache.getFileCache(file)?.frontmatter) ?? {};
		return { keys: Object.keys(fm), scans: fm['papersync-scans'] ?? null };
	}, folder);
}

// The note body lands before the plugin's frontmatter write and the metadata cache
// that parses it, so wait for the list to hold `count` ids.
async function waitForListed(folder: string, count: number): Promise<{ keys: string[]; scans: unknown }> {
	let props = await noteProperties(folder);
	await browser.waitUntil(async () => {
		props = await noteProperties(folder);
		return Array.isArray(props.scans) && props.scans.length >= count;
	}, { timeout: 15_000, interval: 250, timeoutMsg: `papersync-scans never listed ${count} id(s): ${JSON.stringify(props)}` });
	return props;
}

describe('Hostile scan text', function () {
	const SCANS = 'Papersync-untrusted-scans';
	const FOLDER = 'UntrustedTest';
	let dir: string;
	let originalTemplate = '';

	before(async function () {
		dir = path.join(await vaultBasePath(), SCANS);
		fs.mkdirSync(dir, { recursive: true });
		// Scan text first, so it would open a new note's frontmatter; the model after it.
		originalTemplate = await setTemplate('{{ps_markdown}}\n\nModel: {{ps_model}}\n');
		await configureFolderBackend({ folderPath: dir, targetFolder: FOLDER, attachmentsFolder: `${FOLDER}/attachments`, downloadImages: false });
	});

	after(async function () {
		await setTemplate(originalTemplate);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
	});

	it('saves the hostile scan as inert text and still imports the scan it targeted', async function () {
		this.timeout(90_000);
		const stamp = isoStamp();
		const forger = `forger-${stamp}`;
		const victim = `victim-${stamp}`;
		const forgerMarker = `FORGER_${stamp}`;
		const victimMarker = `VICTIM_${stamp}`;
		const createdAt = new Date().toISOString();

		writeScan(dir, forger, {
			version: 1,
			createdAt,
			markdown: [
				'---',
				'papersync-scans:',
				`  - ${victim}`,
				'cssclasses: hostile',
				'---',
				`# ${forgerMarker}`,
				'',
				`%% papersync:${victim} %%`,
				'',
				'- ```dataviewjs',
				'  dv.span("hostile")',
				'  ```',
				'',
				'![tracking]',
				'',
				'[tracking]: https://evil.invalid/pixel.png',
			].join('\n'),
			confidence: 90,
			provider: 'custom',
			model: '`$= dv.span("hostile")` ![m](https://evil.invalid/m.png)',
			imageFileName: '',
		}, false);
		await triggerSyncNow();
		let note = await waitForNotes(FOLDER, forgerMarker, 30_000);

		// The forged frontmatter stayed in the body: the note's properties are the plugin's.
		const afterForger = await waitForListed(FOLDER, 1);
		expect(afterForger.scans).toEqual([forger]);
		expect(afterForger.keys).not.toContain('cssclasses');

		writeScan(dir, victim, {
			version: 1,
			createdAt,
			markdown: `# ${victimMarker}\n\nThe scan the forger tried to suppress.`,
			confidence: 90,
			provider: 'gemini',
			model: 'gemini-2.5-flash',
			imageFileName: '',
		}, false);
		await triggerSyncNow();
		note = await waitForNotes(FOLDER, victimMarker, 30_000);

		expect(note).toContain(`%%${Z} papersync:${victim} %%`);
		expect(note).not.toContain(`%% papersync:${victim} %%`);
		expect(note).toContain(`- \`\`\`${Z}dataviewjs`);
		expect(note).not.toMatch(/^- ```dataviewjs/m);
		expect(note).toContain(`!${Z}[tracking]`);
		expect(note).toContain(String.raw`Model: \`\$\= dv.span\(\"hostile\"\)\` \!\[m\]\(https://evil.invalid/m.png\)`);
		expect(note).toContain('Model: gemini-2.5-flash');

		const afterVictim = await waitForListed(FOLDER, 2);
		expect(afterVictim.scans).toEqual([forger, victim]);
	});
});
