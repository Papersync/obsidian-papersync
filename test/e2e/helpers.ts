import * as fs from 'fs';
import * as path from 'path';

// Shared helpers for the folder-backend E2E specs. Kept out of the *.e2e.ts glob
// so wdio does not treat it as a spec. Each dedicated spec owns one concern and
// reuses these so the setup stays DRY.

export const MINIMAL_JPEG = Buffer.from([
	0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
	0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

// The plugin is keyed in app.plugins by its manifest id. Resolve id-agnostically
// so a future rename does not silently break every spec's setup.
export async function waitForPlugin(): Promise<void> {
	await browser.waitUntil(
		async () => browser.execute(() => {
			const ps = (window as unknown as { app?: { plugins?: { plugins?: Record<string, unknown> } } }).app?.plugins?.plugins;
			return !!(ps && (ps['papersync'] || ps['obsidian-papersync']));
		}),
		{ timeout: 20000, interval: 500, timeoutMsg: 'PaperSync plugin never loaded' }
	);
}

export async function vaultBasePath(): Promise<string> {
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

export function isoStamp(): string {
	const n = new Date();
	const pad = (x: number, w = 2): string => String(x).padStart(w, '0');
	return `${n.toISOString().split('T')[0]}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}${pad(n.getMilliseconds(), 3)}`;
}
