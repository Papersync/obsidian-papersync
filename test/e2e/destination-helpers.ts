import { switchToMainWindow, triggerSyncNow, writeScan } from './helpers';

// Shared by the Save scans to specs (scan-destination, settings-migration,
// periodic-notes). Kept out of the *.e2e.ts glob so wdio does not run it.

export interface DestinationSettings {
	saveTo: string;
	customFolder: string;
	customFileName: string;
	settingsVersion: number;
}

// The expected note names are built here by hand, never with the plugin's own
// formatter, so a wrong format in the product cannot also make the assertion wrong.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function fmt(date: Date, pattern: string): string {
	const pad = (n: number): string => String(n).padStart(2, '0');
	const values: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MMMM: MONTHS[date.getMonth()]!,
		dddd: DAYS[date.getDay()]!,
		MM: pad(date.getMonth() + 1),
		DD: pad(date.getDate()),
		D: String(date.getDate()),
	};
	return pattern.replace(/YYYY|MMMM|dddd|MM|DD|D/g, (t) => values[t]!);
}

export const today = (pattern = 'YYYY-MM-DD'): string => fmt(new Date(), pattern);

// Core Daily notes, driven through Obsidian's own internal-plugin API. Options are
// set on the live instance, which is what Daily notes itself (and Papersync) read.
export async function setDailyNotes(enabled: boolean, folder?: string, format?: string): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (on: boolean, f: string | null, fm: string | null) => {
		type Daily = {
			enabled: boolean;
			enable: (save?: boolean) => Promise<void> | void;
			disable: (save?: boolean) => Promise<void> | void;
			instance?: { options?: Record<string, unknown> };
		};
		const app = (window as unknown as { app: { internalPlugins: { getPluginById: (id: string) => Daily | null } } }).app;
		const daily = app.internalPlugins.getPluginById('daily-notes');
		if (!daily) { throw new Error('core Daily notes plugin not found'); }
		if (on && !daily.enabled) { await daily.enable(true); }
		if (!on && daily.enabled) { await daily.disable(true); }
		if (daily.instance) {
			daily.instance.options = daily.instance.options ?? {};
			if (f !== null) { daily.instance.options.folder = f; }
			if (fm !== null) { daily.instance.options.format = fm; }
		}
	}, enabled, folder ?? null, format ?? null);
	await browser.waitUntil(async () => browser.execute((on: boolean) => {
		const app = (window as unknown as { app: { internalPlugins: { getPluginById: (id: string) => { enabled: boolean } | null } } }).app;
		return app.internalPlugins.getPluginById('daily-notes')?.enabled === on;
	}, enabled), { timeout: 5000, interval: 100, timeoutMsg: `Daily notes never turned ${enabled ? 'on' : 'off'}` });
}

export async function getDestination(): Promise<DestinationSettings> {
	await switchToMainWindow();
	return browser.execute(() => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { settings: DestinationSettings }> } } }).app.plugins.plugins;
		const s = ps['papersync']!.settings;
		return { saveTo: s.saveTo, customFolder: s.customFolder, customFileName: s.customFileName, settingsVersion: s.settingsVersion };
	});
}

// Sets the destination the way a finished Settings edit does: saved and committed.
export async function setDestination(d: Partial<DestinationSettings>): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (patch: Partial<DestinationSettings>) => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>; saveSettings: () => Promise<void>; commitSettings: () => void;
		}> } } }).app.plugins.plugins;
		const plugin = ps['papersync']!;
		Object.assign(plugin.settings, patch);
		await plugin.saveSettings();
		plugin.commitSettings();
	}, d);
}

export async function fileExists(vaultPath: string): Promise<boolean> {
	await switchToMainWindow();
	return browser.execute((p: string) => {
		const app = (window as unknown as { app: { vault: { getAbstractFileByPath: (p: string) => unknown } } }).app;
		return app.vault.getAbstractFileByPath(p) !== null;
	}, vaultPath);
}

export async function readFile(vaultPath: string): Promise<string> {
	await switchToMainWindow();
	return browser.execute(async (p: string) => {
		const app = (window as unknown as { app: { vault: { adapter: { exists: (p: string) => Promise<boolean>; read: (p: string) => Promise<string> } } } }).app;
		return (await app.vault.adapter.exists(p)) ? app.vault.adapter.read(p) : '';
	}, vaultPath);
}

export async function writeVaultFile(vaultPath: string, content: string): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async (p: string, c: string) => {
		const app = (window as unknown as { app: { vault: {
			createFolder: (p: string) => Promise<unknown>;
			create: (p: string, c: string) => Promise<unknown>;
			getAbstractFileByPath: (p: string) => unknown;
		} } }).app;
		const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
		if (parent && !app.vault.getAbstractFileByPath(parent)) { await app.vault.createFolder(parent); }
		await app.vault.create(p, c);
	}, vaultPath, content);
}

// All markdown files in the vault holding `marker`, so a test can prove a scan
// landed in exactly one file, the expected one.
export async function filesContaining(marker: string): Promise<string[]> {
	await switchToMainWindow();
	return browser.execute(async (m: string) => {
		const app = (window as unknown as { app: { vault: {
			getMarkdownFiles: () => Array<{ path: string }>;
			adapter: { read: (p: string) => Promise<string> };
		} } }).app;
		const hits: string[] = [];
		for (const f of app.vault.getMarkdownFiles()) {
			if ((await app.vault.adapter.read(f.path)).includes(m)) { hits.push(f.path); }
		}
		return hits;
	}, marker);
}

let scanCounter = 0;

// Writes a scan (created now) into the watched folder, syncs, and waits until a
// note holds its marker. Returns the vault paths that hold it (normally one).
export async function scanAndWait(dir: string, marker: string, timeoutMs = 30_000): Promise<string[]> {
	scanCounter += 1;
	const id = `dest-${Date.now()}-${scanCounter}`;
	writeScan(dir, id, {
		version: 1,
		createdAt: new Date().toISOString(),
		markdown: `Body ${marker}`,
		confidence: 90,
		provider: 'claude',
		model: 'claude-sonnet-4',
		imageFileName: `${id}.jpg`,
	});
	let hits: string[] = [];
	await browser.waitUntil(async () => {
		await triggerSyncNow();
		hits = await filesContaining(marker);
		return hits.length > 0;
	}, { timeout: timeoutMs, interval: 1500, timeoutMsg: `no note received scan ${marker}` });
	return hits;
}

// Disable and re-enable Papersync (a plugin reload, data.json re-read).
export async function reloadPapersync(): Promise<void> {
	await switchToMainWindow();
	await browser.execute(async () => {
		const plugins = (window as unknown as { app: { plugins: {
			disablePlugin: (id: string) => Promise<void>;
			enablePlugin: (id: string) => Promise<void>;
		} } }).app.plugins;
		await plugins.disablePlugin('papersync');
		await plugins.enablePlugin('papersync');
	});
	await browser.waitUntil(async () => browser.execute(() => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, { syncEngine: unknown } | undefined> } } }).app.plugins.plugins;
		return !!ps['papersync']?.syncEngine;
	}), { timeout: 15_000, interval: 250, timeoutMsg: 'Papersync never started sync after reload' });
}

// The Save scans to row as the settings UI shows it (call with the driver on the
// settings window, after focusSettingsUI()).
export interface DestinationUI {
	present: boolean;
	value: string;
	dailyDisabled: boolean;
	dailyLabel: string;
	desc: string;
	preview: string;
	folderVisible: boolean;
	fileVisible: boolean;
	warningRows: number;
}

export async function readDestinationUI(): Promise<DestinationUI> {
	return browser.execute(() => {
		const row = document.querySelector('.papersync-save-to');
		// Obsidian's dropdown adds a hidden "is-measuring" select next to the real one.
		const select = row?.querySelector('select.dropdown:not(.is-measuring)') as HTMLSelectElement | null | undefined;
		const daily = select?.querySelector('option[value="daily"]') as HTMLOptionElement | null | undefined;
		const shown = (sel: string): boolean => {
			const el = document.querySelector(sel) as HTMLElement | null;
			return !!el && el.offsetParent !== null;
		};
		const warnings = Array.from(document.querySelectorAll('.papersync-warning-row, .papersync-folder-missing'))
			.filter((el) => (el as HTMLElement).offsetParent !== null).length;
		return {
			present: !!row && (row as HTMLElement).offsetParent !== null,
			value: select?.value ?? '',
			dailyDisabled: daily?.disabled ?? false,
			dailyLabel: daily?.text ?? '',
			desc: row?.querySelector('.setting-item-description')?.textContent ?? '',
			preview: row?.querySelector('.papersync-save-to-preview')?.textContent ?? '',
			folderVisible: shown('.papersync-custom-folder'),
			fileVisible: shown('.papersync-custom-file'),
			warningRows: warnings,
		};
	});
}

export async function waitForDestinationUI(check: (ui: DestinationUI) => boolean, what: string): Promise<DestinationUI> {
	let ui: DestinationUI | null = null;
	await browser.waitUntil(async () => {
		ui = await readDestinationUI();
		return check(ui);
	}, { timeout: 5000, interval: 200, timeoutMsg: `Save scans to never showed ${what}: ${JSON.stringify(ui)}` });
	return ui!;
}
