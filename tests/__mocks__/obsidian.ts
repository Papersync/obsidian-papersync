import momentImpl from 'moment';

// Obsidian bundles moment and re-exports it; mirror that so note-creator formats the
// daily-note filename exactly as Obsidian does. (ts-jest runs with esModuleInterop, so
// the default import yields the callable moment function.)
export const moment = momentImpl;

// Faithful-enough stand-in for Obsidian's normalizePath: collapse slashes, trim ends.
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '') || '/';
}

export class Notice {
	constructor(public message: string, public timeout?: number) {}
}

// In-memory stand-in for Obsidian's OS-integrated SecretStorage (1.11.4+). Map-backed,
// synchronous, no deleteSecret (clear via setSecret(id, "")). Set `unavailable = true`
// to force every call to throw, simulating an absent OS backend (headless CI, Linux
// without a Secret Service) so tests can exercise the guarded degrade paths.
export class SecretStorage {
	private store = new Map<string, string>();
	unavailable = false;
	// Lowercase alphanumeric with single dashes between segments — mirrors the real
	// setSecret id validation (it throws on an invalid id).
	private static readonly VALID_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

	setSecret(id: string, secret: string): void {
		if (this.unavailable) { throw new Error('secret storage unavailable'); }
		if (!SecretStorage.VALID_ID.test(id)) { throw new Error(`Invalid secret id: ${id}`); }
		this.store.set(id, secret);
	}

	getSecret(id: string): string | null {
		if (this.unavailable) { throw new Error('secret storage unavailable'); }
		const value = this.store.get(id);
		return value === undefined ? null : value;
	}

	listSecrets(): string[] {
		if (this.unavailable) { throw new Error('secret storage unavailable'); }
		return Array.from(this.store.keys());
	}
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {
	setName() { return this; }
	setDesc() { return this; }
	addText() { return this; }
	addButton() { return this; }
	addDropdown() { return this; }
	addToggle() { return this; }
	addTextArea() { return this; }
}

export const Platform = {
	isMacOS: false,
	isWin: false,
	isLinux: false,
	isMobile: false,
	isDesktop: true,
};

export const requestUrl = jest.fn(() =>
	Promise.resolve({ json: {}, arrayBuffer: new ArrayBuffer(0), status: 200 })
);

export class Component {
	load() { /* no-op */ }
	unload() { /* no-op */ }
}

export const MarkdownRenderer = {
	render: jest.fn(() => Promise.resolve()),
};

export class TFile {
	path = '';
}

export class Vault {
	getAbstractFileByPath() { return null; }
	create() { return Promise.resolve(); }
	createBinary() { return Promise.resolve(); }
	createFolder() { return Promise.resolve(); }
	process(_file: unknown, fn: (data: string) => string) { return Promise.resolve(fn('')); }
	adapter = {
		read: () => Promise.resolve(''),
		write: () => Promise.resolve(),
	};
}
