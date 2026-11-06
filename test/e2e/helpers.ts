import * as fs from 'fs';
import * as path from 'path';

// Shared helpers for the folder-backend E2E specs. Kept out of the *.e2e.ts glob
// so wdio does not treat it as a spec. Each dedicated spec owns one concern and
// reuses these so the setup stays DRY.

export const MINIMAL_JPEG = Buffer.from([
	0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
	0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

// ---------------------------------------------------------------------------
// Settings-window handling.
//
// Obsidian 1.13 moved Settings out of the main-window modal into a dedicated
// window (a separate webContents, so a separate WebDriver window handle whose
// document is about:blank and has NO `window.app`). Every DOM assertion against
// the settings UI must therefore run in whichever window actually hosts it,
// while everything that touches `window.app` (plugin state, commands) must run
// in the main window. With Obsidian's "Open settings in a new window" turned
// off, Settings stay in a main-window modal instead; these helpers handle both.
// ---------------------------------------------------------------------------

// The main window is the one that loaded Obsidian itself; the settings window
// is about:blank. URL is the discriminator that needs no title parsing.
export async function switchToMainWindow(): Promise<void> {
	try {
		if ((await browser.getUrl()).startsWith('app://obsidian.md')) { return; }
	} catch { /* current window just closed; fall through to the scan */ }
	for (const handle of await browser.getWindowHandles()) {
		try {
			await browser.switchToWindow(handle);
			if ((await browser.getUrl()).startsWith('app://obsidian.md')) { return; }
		} catch { /* window closed between listing and switching */ }
	}
	throw new Error('main Obsidian window not found');
}

async function findSettingsWindow(): Promise<string | null> {
	for (const handle of await browser.getWindowHandles()) {
		try {
			await browser.switchToWindow(handle);
			if ((await browser.getTitle()).startsWith('Settings')) { return handle; }
		} catch { /* window closed between listing and switching */ }
	}
	return null;
}

// Leave the driver focused on whichever window hosts the settings UI: the
// dedicated settings window, or the main window when Settings open as a modal.
// Returns
// whether a settings UI is actually open.
export async function focusSettingsUI(): Promise<boolean> {
	if (await findSettingsWindow()) { return true; }
	await switchToMainWindow();
	return browser.execute(() => !!document.querySelector('.mod-settings'));
}

// Every spec opens Settings through this helper. Do not call the command from a
// plain synchronous browser.execute: with WebdriverIO 10 on macOS, the plugin's
// `await setting.open()` continuation then never runs on the first open of the
// settings window, so openTabById is skipped and Settings stay on the General tab.
// executeObsidianCommand runs inside an async script, where it does run.
export async function openPluginSettings(): Promise<void> {
	await switchToMainWindow();
	await browser.executeObsidianCommand('papersync:open-settings');
	await browser.waitUntil(() => focusSettingsUI(), {
		timeout: 5000,
		interval: 200,
		timeoutMsg: 'settings UI never appeared',
	});
	// Let the plugin tab finish painting (template preview etc. render async).
	await browser.pause(500);
}

export async function closeSettings(): Promise<void> {
	// Close through the app API from the MAIN window, never by pressing Escape
	// while focused on the settings window: if the driver's current window is
	// the one being closed, wdio sees its handle vanish and tears the whole
	// session down ("All window handles were removed").
	const settingsHandle = await findSettingsWindow();
	await switchToMainWindow();
	await browser.execute(() => {
		const setting = (window as unknown as { app?: { setting?: { close?: () => void } } }).app?.setting;
		setting?.close?.();
	});
	if (settingsHandle) {
		// 1.13+: wait for the dedicated window to actually go away, polling the
		// handle list only — no switching to a window that is mid-teardown.
		await browser.waitUntil(
			async () => !(await browser.getWindowHandles()).includes(settingsHandle),
			{ timeout: 3000, interval: 200, timeoutMsg: 'settings window never closed' }
		);
	} else {
		await browser.pause(300); // modal teardown
	}
	await switchToMainWindow();
}

// Find a button by exact label in the CURRENT window and click it, waiting for
// it to exist first: on 1.13+ a freshly opened settings window paints its tab
// content asynchronously, so a one-shot querySelector right after open races
// the render and fails deterministically under load.
export async function clickButtonWhenPresent(label: string, timeoutMs = 5000): Promise<void> {
	await browser.waitUntil(
		() => browser.execute((l: string) => {
			const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === l);
			if (btn) { btn.click(); return true; }
			return false;
		}, label),
		{ timeout: timeoutMs, interval: 200, timeoutMsg: `"${label}" button never appeared in the settings UI` }
	);
}

// The plugin is keyed in app.plugins by its manifest id. Resolve id-agnostically
// so a future rename does not silently break every spec's setup.
// (Like every helper below that touches window.app, this pins itself to the
// main window first — the 1.13+ settings window is an app-less about:blank.)
export async function waitForPlugin(): Promise<void> {
	await switchToMainWindow();
	await browser.waitUntil(
		async () => browser.execute(() => {
			const ps = (window as unknown as { app?: { plugins?: { plugins?: Record<string, unknown> } } }).app?.plugins?.plugins;
			return !!(ps && (ps['papersync'] || ps['obsidian-papersync']));
		}),
		{ timeout: 20000, interval: 500, timeoutMsg: 'PaperSync plugin never loaded' }
	);
}

export async function vaultBasePath(): Promise<string> {
	await switchToMainWindow();
	const p = await browser.execute(() => {
		const app = (window as unknown as { app: { vault: { adapter: { getBasePath: () => string } } } }).app;
		return app.vault.adapter.getBasePath();
	});
	if (!p) { throw new Error('Could not determine vault path'); }
	return p;
}

export interface FolderBackendConfig {
	folderPath: string;
	targetFolder?: string;
	attachmentsFolder?: string;
	downloadImages?: boolean;
}

export async function configureFolderBackend(cfg: FolderBackendConfig): Promise<void> {
	await waitForPlugin();
	await browser.execute(async (c: FolderBackendConfig) => {
		const ps = (window as unknown as { app: { plugins: { plugins: Record<string, {
			settings: Record<string, unknown>;
			saveSettings: () => Promise<void>;
			startSync: () => Promise<void>;
		}> } } }).app.plugins.plugins;
		const plugin = ps['papersync'] || ps['obsidian-papersync'];
		if (!plugin) { throw new Error('PaperSync plugin not loaded'); }
		plugin.settings.backendType = 'folder';
		plugin.settings.folderPath = c.folderPath;
		plugin.settings.folderType = 'custom';
		plugin.settings.targetFolder = c.targetFolder ?? 'EdgeTest';
		plugin.settings.attachmentsFolder = c.attachmentsFolder ?? 'EdgeTest/attachments';
		plugin.settings.downloadImages = c.downloadImages ?? true;
		plugin.settings.setupComplete = true;
		plugin.settings.lastSyncTimestamp = '';
		await plugin.saveSettings();
		await plugin.startSync();
	}, cfg);
	await browser.pause(1000);
}

export function writeScan(dir: string, id: string, scan: Record<string, unknown>, image = true): void {
	fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(scan, null, 2));
	if (image) { fs.writeFileSync(path.join(dir, `${id}.jpg`), MINIMAL_JPEG); }
}

// Fire the plugin's sync-now command with NO settle pauses — callers own their own
// readiness waits (e.g. waitUntil on a fake server's recorded requests). Resolved by
// suffix so it works regardless of the plugin's manifest-id prefix (papersync vs
// obsidian-papersync).
export async function triggerSyncNow(): Promise<void> {
	await switchToMainWindow();
	await browser.execute(() => {
		const app = (window as unknown as { app: { commands: {
			commands: Record<string, unknown>;
			executeCommandById: (id: string) => void;
		} } }).app;
		const id = Object.keys(app.commands.commands).find((k) => k.endsWith(':sync-now'));
		if (id) { app.commands.executeCommandById(id); }
	});
}

export async function syncNow(): Promise<void> {
	await browser.pause(2500);
	await triggerSyncNow();
	await browser.pause(3000);
}

// Concatenated bodies of every markdown note whose path contains `needle`.
export async function readNotes(needle: string): Promise<string> {
	await switchToMainWindow();
	return browser.execute(async (n: string) => {
		const app = (window as unknown as { app: { vault: {
			getMarkdownFiles: () => Array<{ path: string }>;
			adapter: { read: (p: string) => Promise<string> };
		} } }).app;
		const files = app.vault.getMarkdownFiles().filter((f) => f.path.includes(n));
		const bodies = await Promise.all(files.map((f) => app.vault.adapter.read(f.path)));
		return bodies.join('\n---FILE-BOUNDARY---\n');
	}, needle);
}

// Reading straight after syncNow() assumes the sync finished inside its fixed
// pause. That holds for a local file, and does not when the content has to be
// downloaded first: an evicted scan routinely takes longer than the pause, so the
// read came back empty and only the mocha retry passed — reading what the failed
// attempt had already pulled down. Poll for the marker rather than guessing a
// duration, so the wait scales with the network instead of hiding in a retry.
export async function waitForNotes(
	needle: string,
	marker: string,
	timeoutMs = 60_000,
): Promise<string> {
	let bodies = '';
	await browser.waitUntil(
		async () => {
			bodies = await readNotes(needle);
			return bodies.includes(marker);
		},
		{
			timeout: timeoutMs,
			interval: 500,
			timeoutMsg: `No note under "${needle}" contained "${marker}" within ${timeoutMs}ms`,
		},
	);
	return bodies;
}

export function isoStamp(): string {
	const n = new Date();
	const pad = (x: number, w = 2): string => String(x).padStart(w, '0');
	return `${n.toISOString().split('T')[0]}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}${pad(n.getMilliseconds(), 3)}`;
}
