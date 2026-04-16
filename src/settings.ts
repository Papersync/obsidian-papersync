import type PaperSyncedPlugin from '@/main';
import { detectSyncLocations } from '@/utils/platform';
import type { SyncLocation } from '@/utils/platform';
import { STRINGS } from '@/utils/strings';
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';

export type BackendType = 'drive' | 'folder' | 'none';

export interface PluginSettings {
	settingsVersion: number;
	setupComplete: boolean;
	backendType: BackendType;
	drivePollInterval: number;
	folderPath: string;
	folderType: string;
	targetFolder: string;
	attachmentsFolder: string;
	templateString: string;
	downloadImages: boolean;
	debugLogging: boolean;
	oauthExpiresAt: number;
	oauthRefreshToken: string;
	lastSyncTimestamp: string;
}

const DEFAULT_TEMPLATE = `{{separator}}

## {{time}}

{{markdown}}

> [!abstract]- Source
> ![[{{image_file}}]]
`;

export const DEFAULT_SETTINGS: PluginSettings = {
	settingsVersion: 2,
	setupComplete: false,
	backendType: 'none',
	drivePollInterval: 30,
	folderPath: '',
	folderType: '',
	targetFolder: '',  // resolved on first setup from daily notes config
	attachmentsFolder: 'attachments/Papersynced',
	templateString: DEFAULT_TEMPLATE,
	downloadImages: true,
	debugLogging: false,
	oauthExpiresAt: 0,
	oauthRefreshToken: '',
	lastSyncTimestamp: '',
};

export function migrateSettings(data: Record<string, unknown>): Record<string, unknown> {
	const version = typeof data.settingsVersion === 'number' ? data.settingsVersion : 0;

	if (version < 2) {
		if (data.backendType === 'icloud') {
			data.backendType = 'folder';
		}
		if ('icloudFolderPath' in data) {
			data.folderPath = data.icloudFolderPath ?? '';
			delete data.icloudFolderPath;
		}
		data.settingsVersion = 2;
	}

	return data;
}

function asyncHandler(fn: () => Promise<void>): () => void {
	return () => { fn().catch(console.error); };
}

function asyncValueHandler<T>(fn: (value: T) => Promise<void>): (value: T) => void {
	return (value: T) => { fn(value).catch(console.error); };
}

export class PaperSyncedSettingTab extends PluginSettingTab {
	plugin: PaperSyncedPlugin;
	private syncButton: HTMLButtonElement | null = null;
	private syncDesc: HTMLElement | null = null;

	constructor(app: App, plugin: PaperSyncedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	updateSyncState(): void {
		if (!this.syncButton || !this.syncDesc) {return;}
		const { status, pendingCount } = this.plugin.syncState.snapshot;
		const isBusy = status === 'syncing';

		this.setSyncBusy(isBusy);

		const statusText = isBusy
			? `Syncing (${pendingCount} pending)...`
			: status === 'error' ? 'Error, check logs'
			: status === 'offline' ? 'Offline'
			: this.plugin.syncEngine ? 'Synced' : 'Not connected';
		this.syncDesc.textContent = statusText;
	}

	private setSyncBusy(busy: boolean): void {
		if (!this.syncButton) {return;}
		const isReady = !!this.plugin.syncEngine;
		this.syncButton.textContent = busy ? 'Syncing...' : isReady ? 'Sync now' : 'Sync now';
		this.syncButton.disabled = busy || !isReady;
		if (busy) {
			this.syncButton.addClass('is-loading');
		} else {
			this.syncButton.removeClass('is-loading');
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		;

		this.renderAccountSection(containerEl);

		if (this.plugin.settings.backendType !== 'none') {
			this.renderSyncSection(containerEl);
			this.renderTemplateSection(containerEl);
		}

		this.renderAdvancedSection(containerEl);
	}

	private renderAccountSection(containerEl: HTMLElement): void {
		const { backendType } = this.plugin.settings;
		const isGoogleConnected = backendType === 'drive' && (this.plugin.oauthManager?.isAuthenticated ?? false);
		const isFolderConnected = backendType === 'folder' && this.plugin.settings.setupComplete;

		new Setting(containerEl).setName("Storage").setHeading();

		if (isGoogleConnected) {
			new Setting(containerEl)
				.setName('\u2713 Google Drive')
				.setDesc(STRINGS.SETTINGS_CONNECTED)
				.setClass('papersynced-storage-active')
				.addButton((button) =>
					button.setButtonText('Change Storage').onClick(asyncHandler(async () => {
						this.plugin.oauthManager?.disconnect();
						this.plugin.syncEngine?.stop();
						this.plugin.settings.backendType = 'none';
						this.plugin.settings.setupComplete = false;
						await this.plugin.saveSettings();
						new Notice('Disconnected from Google Drive');
						this.display();
					}))
				);
			return;
		}

		if (isFolderConnected) {
			const displayName = this.getFolderDisplayName();
			new Setting(containerEl)
				.setName(`\u2713 ${displayName}`)
				.setDesc(`Watching ${this.plugin.settings.folderPath} for new scans`)
				.setClass('papersynced-storage-active')
				.addButton((button) =>
					button.setButtonText('Change Storage').onClick(asyncHandler(async () => {
						this.plugin.syncEngine?.stop();
						this.plugin.settings.backendType = 'none';
						this.plugin.settings.folderPath = '';
						this.plugin.settings.folderType = '';
						this.plugin.settings.setupComplete = false;
						await this.plugin.saveSettings();
						new Notice(`Disconnected from ${displayName}`);
						this.display();
					}))
				);
			return;
		}

		// Not connected — show both options as equal-weight choices
		containerEl.createEl('p', {
			text: 'Choose the same storage you used in the PaperSynced mobile app.',
			cls: 'setting-item-description',
		});

		new Setting(containerEl)
			.setName('Google Drive')
			.setDesc('Sign in with your Google account')
			.addButton((button) =>
				button.setButtonText('Connect').onClick(asyncHandler(async () => {
					try {
						this.plugin.settings.backendType = 'drive';
						await this.plugin.saveSettings();
						await this.plugin.oauthManager?.startAuthFlow();
						this.plugin.settings.setupComplete = true;
						await this.plugin.saveSettings();
						await this.plugin.startSync();
						new Notice(STRINGS.SETTINGS_CONNECTED);
					} catch (err) {
						this.plugin.settings.backendType = 'none';
						await this.plugin.saveSettings();
						new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					this.display();
				}))
			);

		// Folder — show detected locations inline + browse
		const vaultPath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
		const detected = detectSyncLocations(vaultPath);

		for (const loc of detected) {
			new Setting(containerEl)
				.setName(loc.displayName)
				.setDesc(loc.path)
				.addButton((button) =>
					button
						.setButtonText('Select')
						.onClick(asyncHandler(async () => {
							await this.selectFolderLocation(loc.path, loc.type);
						}))
				);
		}

		new Setting(containerEl)
			.setName('Another folder on this device')
			.setDesc(detected.length === 0
				? 'No sync tools detected. Browse to pick a folder'
				: 'Pick any folder on your filesystem')
			.addButton((button) =>
				button.setButtonText('Browse').onClick(asyncHandler(async () => {
					const electron = (window as unknown as { require?: (mod: string) => { remote?: { dialog: { showOpenDialog: (opts: { properties: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }> } } } }).require?.('electron');
					const dialog = electron?.remote?.dialog;
					if (dialog) {
						const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
						if (!result.canceled && result.filePaths[0]) {
							await this.selectFolderLocation(result.filePaths[0], 'custom');
						}
					} else {
						new Notice('Folder browser not available');
					}
				}))
			);
	}

	private getFolderDisplayName(): string {
		const { folderType } = this.plugin.settings;
		const typeToName: Record<string, string> = {
			icloud: 'iCloud Drive',
			dropbox: 'Dropbox',
			onedrive: 'OneDrive',
			syncthing: 'Syncthing',
			'obsidian-sync': 'Obsidian Sync',
			custom: 'Folder sync',
		};
		return typeToName[folderType] ?? 'Folder sync';
	}

	private async selectFolderLocation(folderPath: string, folderType: string): Promise<void> {
		this.plugin.syncEngine?.stop();
		this.plugin.settings.backendType = 'folder';
		this.plugin.settings.folderPath = folderPath;
		this.plugin.settings.folderType = folderType;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();
		await this.plugin.startSync();
		new Notice(`Now watching ${folderPath} for new scans`);
		this.display();
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Sync").setHeading();

		const syncSetting = new Setting(containerEl)
			.setName('Sync now')
			.setDesc('')
			.addButton((button) => {
				button
					.setCta()
					.onClick(asyncHandler(async () => {
						if (!this.plugin.syncEngine || this.plugin.syncState.isSyncing) {return;}
						this.setSyncBusy(true);
						await new Promise((r) => setTimeout(r, 50));
						await this.plugin.syncEngine.forceSyncNow();
						this.setSyncBusy(false);
					}));
				this.syncButton = button.buttonEl;
			});

		this.syncDesc = syncSetting.descEl;
		this.updateSyncState();

		new Setting(containerEl)
			.setName('Notes folder')
			.setDesc('Subfolder for synced notes. Supports date tokens: YYYY, MM, DD (e.g. Journal/YYYY/MM).')
			.addText((text) =>
				text
					.setPlaceholder('PaperSynced')
					.setValue(this.plugin.settings.targetFolder)
					.onChange(asyncValueHandler(async (value) => {
						this.plugin.settings.targetFolder = value;
						await this.plugin.saveSettings();
					}))
			);

		new Setting(containerEl)
			.setName('Save scan images')
			.setDesc('Download the original scan image into your vault. If off, remove {{image_file}} from your template.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.downloadImages).onChange(asyncValueHandler(async (value) => {
					this.plugin.settings.downloadImages = value;
					await this.plugin.saveSettings();
					this.display();
				}))
			);

		if (this.plugin.settings.downloadImages) {
			new Setting(containerEl)
				.setName('Attachments folder')
				.setDesc('Subfolder in this vault for embedded scan images.')
				.setClass('papersynced-sub-setting')
				.addText((text) =>
					text
						.setPlaceholder('attachments/Papersynced')
						.setValue(this.plugin.settings.attachmentsFolder)
						.onChange(asyncValueHandler(async (value) => {
							this.plugin.settings.attachmentsFolder = value;
							await this.plugin.saveSettings();
						}))
				);
		}

		if (this.plugin.settings.backendType === 'drive') {
			new Setting(containerEl)
				.setName('Poll interval (seconds)')
				.setDesc('How often to check Google Drive for new scans.')
				.addText((text) =>
					text
						.setPlaceholder('30')
						.setValue(String(this.plugin.settings.drivePollInterval))
						.onChange(asyncValueHandler(async (value) => {
							const parsed = parseInt(value, 10);
							if (!isNaN(parsed) && parsed >= 5) {
								this.plugin.settings.drivePollInterval = parsed;
								await this.plugin.saveSettings();
							}
						}))
				);
		}
	}

	private renderTemplateSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Note Template").setHeading();

		const descContainer = containerEl.createDiv({ cls: 'setting-item-description papersynced-template-desc' });
		descContainer.createEl('p', { text: 'Template for synced notes. Available variables:' });

		const varList = descContainer.createEl('table', { cls: 'papersynced-var-table' });
		const vars: Array<[string, string]> = [
			['{{markdown}}', 'Converted text'],
			['{{image_file}}', 'Image vault path, use ![[{{image_file}}]] to embed'],
			['{{time}}', '12h time (2:30 PM)'],
			['{{time_24h}}', '24h time (14:30)'],
			['{{separator}}', '--- on append, empty on new file'],
			['{{date_short}}', 'Date per Daily Notes format'],
			['{{date}}', 'Full ISO timestamp'],
			['{{confidence}}', 'AI score (0-100)'],
		];
		for (const [token, desc] of vars) {
			const row = varList.createEl('tr');
			row.createEl('td', { text: token, cls: 'papersynced-var-token' });
			row.createEl('td', { text: desc });
		}

		const textareaContainer = containerEl.createDiv({ cls: 'papersynced-template-container' });
		const textarea = textareaContainer.createEl('textarea', {
			cls: 'papersynced-template-editor',
			attr: {
				spellcheck: 'false',
				placeholder: 'Enter your note template...',
			},
		});
		textarea.value = this.plugin.settings.templateString;
		textarea.addEventListener('change', () => {
			this.plugin.settings.templateString = textarea.value;
			this.plugin.saveSettings().catch(console.error);
		});
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Advanced").setHeading();

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Enable detailed logging in the developer console.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(asyncValueHandler(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}))
			);

		new Setting(containerEl)
			.setName('Reset settings')
			.setDesc('Reset preferences to defaults. Keeps your account connected.')
			.addButton((button) =>
				button.setButtonText('Reset settings').onClick(asyncHandler(async () => {
					this.plugin.syncEngine?.stop();
					const keepBackend = this.plugin.settings.backendType;
					const keepSetup = this.plugin.settings.setupComplete;
					this.plugin.settings = { ...DEFAULT_SETTINGS, backendType: keepBackend, setupComplete: keepSetup };
					await this.plugin.saveSettings();
					await this.plugin.resolveTargetFolder();
					await this.plugin.startSync();
					new Notice('Settings reset (account kept)');
					this.display();
				}))
			)
			.addButton((button) =>
				button.setButtonText('Full reset').setWarning().onClick(asyncHandler(async () => {
					this.plugin.syncEngine?.stop();
					this.plugin.oauthManager?.disconnect();
					this.plugin.settings = { ...DEFAULT_SETTINGS };
					await this.plugin.saveSettings();
					new Notice('Settings cleared. Reconnect your account to continue');
					this.display();
				}))
			);
	}
}
