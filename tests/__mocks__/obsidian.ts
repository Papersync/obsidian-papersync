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
