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

export class Vault {
	getAbstractFileByPath() { return null; }
	create() { return Promise.resolve(); }
	createBinary() { return Promise.resolve(); }
	createFolder() { return Promise.resolve(); }
	adapter = {
		read: () => Promise.resolve(''),
		write: () => Promise.resolve(),
	};
}
