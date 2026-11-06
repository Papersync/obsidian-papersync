import { dirname } from 'node:path';
import type { moment as ObsidianMoment } from 'obsidian';

// Obsidian re-exports its bundled moment; load the copy the obsidian package depends on.
const obsidianDir = dirname(require.resolve('obsidian/package.json'));
export const moment = require(require.resolve('moment', { paths: [obsidianDir] })) as typeof ObsidianMoment;

// Faithful-enough stand-in for Obsidian's normalizePath: collapse slashes, trim ends.
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '') || '/';
}

export class Notice {
	constructor(public message: string, public timeout?: number) {}
}

// In-memory stand-in for Obsidian's SecretStorage (1.11.4+). Map-backed, synchronous,
// no deleteSecret (clear via setSecret(id, "")). Set `unavailable = true` to force
// every call to throw, simulating a backend Obsidian reports as absent. Set
// `silentNoop = true` to make setSecret a silent no-op (no throw, no store) — a
// backend that quietly drops the value, which the read-back in writeSecret catches.
// Both exercise the guarded degrade paths. Neither models a missing OS secret store:
// there real Obsidian accepts the write and stores it unencrypted.
export class SecretStorage {
	private store = new Map<string, string>();
	unavailable = false;
	silentNoop = false;
	// Lowercase alphanumeric with single dashes between segments — mirrors the real
	// setSecret id validation (it throws on an invalid id).
	private static readonly VALID_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

	setSecret(id: string, secret: string): void {
		if (this.unavailable) { throw new Error('secret storage unavailable'); }
		if (!SecretStorage.VALID_ID.test(id)) { throw new Error(`Invalid secret id: ${id}`); }
		if (this.silentNoop) { return; }
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

// Minimal Modal stand-in: enough for a subclass to be defined and constructed.
// The DOM-building in onOpen() is exercised by the E2E suite against real
// Obsidian, not here.
export class Modal {
	app: unknown;
	contentEl = { empty: jest.fn(), createEl: jest.fn(), createDiv: jest.fn() };
	titleEl = { setText: jest.fn() };
	constructor(app: unknown) { this.app = app; }
	open(): void { /* no-op */ }
	close(): void { /* no-op */ }
}
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

export class TFolder {
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
