import * as fs from 'fs';
import type PaperSyncPlugin from '@/main';
import { detectSyncLocations } from '@/utils/platform';
import type { SyncLocation } from '@/utils/platform';
import { STRINGS } from '@/utils/strings';
import { errorMessage } from '@/utils/error-message';
import { logger } from '@/utils/logger';
import { WORDMARK_SVG, PAPERSYNC_WEBSITE } from '@/ui/wordmark';
import { SCAN_PLACEHOLDER_SVG } from '@/ui/scan-placeholder';
import { renderTemplate } from '@/notes/template-engine';
import type { TemplateContext } from '@/notes/template-engine';
import { App, Component, MarkdownRenderer, Notice, PluginSettingTab, Setting } from 'obsidian';
import type { GoogleEndpoints } from '@/config';

// A fixed sample scan used to render the note-template live preview. Deterministic
// so the preview is stable and never depends on real vault state.
const PREVIEW_CONTEXT: TemplateContext = {
	ps_scan_date: '2026-07-05T14:30:00.000Z',
	ps_scan_date_short: '2026-07-05',
	ps_scan_time: '2:30 PM',
	ps_scan_time_24h: '14:30',
	ps_confidence: 92,
	ps_provider: 'claude',
	ps_model: 'claude-sonnet-4',
	ps_image_file: 'attachments/Papersync/papersync-scan.jpg',
	ps_markdown: 'Small steps still move you forward. Start with one, and let momentum carry the rest.\n\n- [x] Grocery run before it rains\n- [ ] Read 20 pages before bed\n- [ ] 30-min walk after lunch\n- [ ] Call mom back',
	// '***' (the append case) so the live preview can show the divider in context.
	ps_separator: '***',
};

// A faint placeholder standing in for whatever is already in today's daily note, so
// the {{ps_separator}} divider is shown doing its real job: splitting this capture
// from earlier content on the same day.
const PRIOR_ENTRY_MD = '*...your earlier notes from today...*';

// Shown where the scan image would embed. The embed IS the original handwritten page
// that was translated into the markdown above, so the placeholder MIRRORS that note's
// structure (two prose lines and the same four checkboxes with one done) but masks
// the text as illegible handwriting. (The sample file is not a real vault
// note, so a live embed would otherwise render as an unresolved "not found" box.)
// True when a template embeds the scan image (canonical ps_image_file or its alias).
function templateEmbedsImage(template: string): boolean {
	return /\{\{\s*(ps_image_file|image_file)\s*\}\}/.test(template);
}

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
	oauthExpiresAt: number;
	lastSyncTimestamp: string;
	lastSyncAt: number;
	// Undocumented test seam: overrides for the Google OAuth/Drive endpoints.
	// Absent in DEFAULT_SETTINGS, never written by any UI path, no settings-UI
	// control. E2E specs set it at runtime to point the REAL OAuth + Drive flow
	// at an in-repo fake server (test/e2e/fake-google.ts).
	endpointOverrides?: Partial<GoogleEndpoints>;
}

const DEFAULT_TEMPLATE = `{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Source
> ![[{{ps_image_file}}]]
`;

export const DEFAULT_SETTINGS: PluginSettings = {
	settingsVersion: 3,
	setupComplete: false,
	backendType: 'none',
	drivePollInterval: 30,
	folderPath: '',
	folderType: '',
	targetFolder: '',  // resolved on first setup from daily notes config
	attachmentsFolder: '', // empty => Obsidian's own attachment folder
	templateString: DEFAULT_TEMPLATE,
	downloadImages: true,
	oauthExpiresAt: 0,
	lastSyncTimestamp: '',
	lastSyncAt: 0,
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

	if (version < 3) {
		// The Google OAuth refresh token now lives in Obsidian's OS secret storage, never
		// plaintext data.json. Discard any stray plaintext copy a pre-secret-storage build
		// left at rest — the plugin is unpublished, so there is nothing to migrate; those
		// devices reconnect once. (main.ts also deletes the field on load as a belt-and-
		// braces strip for an already-v3 data.json that still carries it.)
		delete data.oauthRefreshToken;
		data.settingsVersion = 3;
	}

	return data;
}

function asyncHandler(fn: () => Promise<void>): () => void {
	return () => { fn().catch(console.error); };
}

function asyncValueHandler<T>(fn: (value: T) => Promise<void>): (value: T) => void {
	return (value: T) => { fn(value).catch(console.error); };
}

export class PaperSyncSettingTab extends PluginSettingTab {
	plugin: PaperSyncPlugin;
	private syncButton: HTMLButtonElement | null = null;
	private syncDesc: HTMLElement | null = null;
	private activeTab: 'sync' | 'template' | 'advanced' = 'sync';
	private previewComponent: Component | null = null;
	private previewDebounce: number | null = null;

	constructor(app: App, plugin: PaperSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	updateSyncState(): void {
		if (!this.syncButton || !this.syncDesc) {return;}
		const { status, pendingCount } = this.plugin.syncState.snapshot;
		const isBusy = status === 'syncing';

		this.setSyncBusy(isBusy);

		const lastSyncAt = this.plugin.settings.lastSyncAt;
		const syncedText = lastSyncAt
			? `Synced. Last sync ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
			: 'Synced';
		const statusText = isBusy
			? `Syncing (${pendingCount} pending)...`
			: status === 'error' ? (this.plugin.syncState.snapshot.lastError ?? 'Sync error')
			: status === 'offline' ? 'Offline'
			: this.plugin.syncEngine ? syncedText : 'Not connected';
		this.syncDesc.textContent = statusText;
	}

	private setSyncBusy(busy: boolean): void {
		if (!this.syncButton) {return;}
		const isReady = !!this.plugin.syncEngine;
		this.syncButton.textContent = busy ? 'Syncing...' : 'Sync now';
		this.syncButton.disabled = busy || !isReady;
		if (busy) {
			this.syncButton.addClass('is-loading');
		} else {
			this.syncButton.removeClass('is-loading');
		}
	}

	private getConnectionState(): { isGoogleConnected: boolean; isFolderConnected: boolean } {
		const { backendType } = this.plugin.settings;
		const isGoogleConnected = backendType === 'drive' && (this.plugin.oauthManager?.isAuthenticated ?? false);
		const isFolderConnected = backendType === 'folder' && this.plugin.settings.setupComplete;
		return { isGoogleConnected, isFolderConnected };
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// The clickable wordmark anchors the top; everything else lives under tabs,
		// with the storage connection (or picker) owned by the Sync tab.
		this.renderLogoHeader(containerEl);
		this.renderTabs(containerEl);
	}

	// Reopen the settings on the Sync tab each time (the storage/connection anchor)
	// and tear down the template preview's render component.
	hide(): void {
		this.activeTab = 'sync';
		this.previewComponent?.unload();
		this.previewComponent = null;
		if (this.previewDebounce !== null) {
			window.clearTimeout(this.previewDebounce);
			this.previewDebounce = null;
		}
	}

	private renderLogoHeader(containerEl: HTMLElement): void {
		const header = containerEl.createDiv({ cls: 'papersync-logo-header' });
		const link = header.createEl('a', {
			cls: 'papersync-logo',
			href: PAPERSYNC_WEBSITE,
			attr: { 'aria-label': 'Open the Papersync website', target: '_blank', rel: 'noopener' },
		});
		// Trusted static asset from our own press kit (no user input); parse into a
		// node rather than assigning innerHTML so the DOM-safety lint stays happy.
		const parsed = new DOMParser().parseFromString(WORDMARK_SVG, 'image/svg+xml');
		link.appendChild(document.importNode(parsed.documentElement, true));
	}

	private renderSyncTab(containerEl: HTMLElement): void {
		const { isGoogleConnected, isFolderConnected } = this.getConnectionState();
		this.renderAccountSection(containerEl, isGoogleConnected, isFolderConnected);
		if (isGoogleConnected || isFolderConnected) {
			this.renderSyncSection(containerEl);
		}
	}

	private renderTabs(containerEl: HTMLElement): void {
		const tabs: Array<{ id: 'sync' | 'template' | 'advanced'; label: string; render: (el: HTMLElement) => void }> = [
			{ id: 'sync', label: 'Sync', render: (el) => this.renderSyncTab(el) },
			{ id: 'template', label: 'Template', render: (el) => this.renderTemplateSection(el) },
			{ id: 'advanced', label: 'Advanced', render: (el) => this.renderAdvancedSection(el) },
		];

		const bar = containerEl.createDiv({ cls: 'papersync-tab-bar' });
		const content = containerEl.createDiv({ cls: 'papersync-tab-content' });

		const paint = (): void => {
			content.empty();
			const active = tabs.find((t) => t.id === this.activeTab) ?? tabs[0];
			active?.render(content);
		};

		for (const tab of tabs) {
			const btn = bar.createEl('button', { cls: 'papersync-tab', text: tab.label });
			btn.setAttribute('type', 'button');
			if (this.activeTab === tab.id) {btn.addClass('is-active');}
			btn.addEventListener('click', () => {
				this.activeTab = tab.id;
				for (const child of Array.from(bar.children)) {child.removeClass('is-active');}
				btn.addClass('is-active');
				paint();
			});
		}

		paint();
	}

	private renderAccountSection(containerEl: HTMLElement, isGoogleConnected: boolean, isFolderConnected: boolean): void {
		if (isGoogleConnected) {
			const gSetting = new Setting(containerEl)
				.setName('\u2713 Google Drive')
				.setClass('papersync-storage-active');
			this.addSyncNowButton(gSetting);
			gSetting.addButton((button) =>
				button.setButtonText('Change Storage').onClick(asyncHandler(async () => {
					this.plugin.syncEngine?.stop();
					await this.plugin.oauthManager?.disconnect();
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
			const fSetting = new Setting(containerEl)
				.setName(`\u2713 ${displayName}`)
				.setClass('papersync-storage-active');
			this.addSyncNowButton(fSetting);
			fSetting.addButton((button) =>
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
			text: 'Choose the same storage you used in the Papersync mobile app.',
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
						new Notice(`Connection failed: ${errorMessage(err)}`);
					}
					this.display();
				}))
			);

		// Folder — show detected locations inline + browse
		const detected = detectSyncLocations();

		for (const loc of detected) {
			new Setting(containerEl)
				.setName(loc.displayName)
				.setDesc(loc.exists ? loc.path : `${loc.path} (will be created)`)
				.addButton((button) =>
					button
						.setButtonText('Select')
						.onClick(asyncHandler(async () => {
							await this.selectDetectedLocation(loc);
						}))
				);
		}

		new Setting(containerEl)
			.setName('Select your Papersync folder')
			.setDesc('Browse to the Papersync folder your app saves scans to.')
			.addButton((button) =>
				button.setButtonText('Browse').onClick(asyncHandler(async () => {
					try {
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
					} catch (err) {
						new Notice(`Could not open the folder browser: ${errorMessage(err)}`);
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
			custom: 'Folder sync',
		};
		return typeToName[folderType] ?? 'Folder sync';
	}

	// Detected locations are offered even before their scans folder exists (the
	// plugin can be set up before the app ever wrote a scan), so create it on
	// select. The provider root must already exist — its absence means the
	// provider itself isn't set up on this computer, which mkdir would silently
	// paper over with a plain local folder that never syncs.
	private async selectDetectedLocation(loc: SyncLocation): Promise<void> {
		if (!fs.existsSync(loc.path)) {
			if (!fs.existsSync(loc.basePath)) {
				new Notice(STRINGS.NOTICE_PROVIDER_UNAVAILABLE(loc.displayName));
				return;
			}
			try {
				fs.mkdirSync(loc.path, { recursive: true });
			} catch (err) {
				new Notice(STRINGS.NOTICE_FOLDER_CREATE_FAILED(loc.path));
				logger.error(`Could not create ${loc.path}: ${errorMessage(err)}`);
				return;
			}
		}
		await this.selectFolderLocation(loc.path, loc.type);
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

	// Sync now is the primary action, so it sits on the connected provider row
	// itself (next to Change Storage); that row's description carries live status.
	private addSyncNowButton(setting: Setting): void {
		setting.addButton((button) => {
			button
				.setCta()
				.onClick(asyncHandler(async () => {
					if (!this.plugin.syncEngine || this.plugin.syncState.isSyncing) {return;}
					this.setSyncBusy(true);
					await new Promise((r) => window.setTimeout(r, 50));
					await this.plugin.syncEngine.forceSyncNow();
					this.setSyncBusy(false);
				}));
			this.syncButton = button.buttonEl;
		});
		this.syncDesc = setting.descEl;
		this.updateSyncState();
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Notes folder')
			.setDesc('Subfolder for synced notes. Supports date tokens: YYYY, MM, DD (e.g. Journal/YYYY/MM).')
			.addText((text) =>
				text
					.setPlaceholder('Papersync')
					.setValue(this.plugin.settings.targetFolder)
					.onChange(asyncValueHandler(async (value) => {
						this.plugin.settings.targetFolder = value;
						await this.plugin.saveSettings();
					}))
			);

		new Setting(containerEl)
			.setName('Save scan images')
			.setDesc('Download the original scan image into your vault. If off, remove {{ps_image_file}} from your template.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.downloadImages).onChange(asyncValueHandler(async (value) => {
					this.plugin.settings.downloadImages = value;
					await this.plugin.saveSettings();
					this.display();
				}))
			);

		// Warn right at the toggle (not only on the Template tab) when saving is off but
		// the template still references the scan image, so its embed is silently dropped.
		if (!this.plugin.settings.downloadImages && templateEmbedsImage(this.plugin.settings.templateString)) {
			const warn = containerEl.createDiv({ cls: 'papersync-image-warning is-visible' });
			warn.setText('Your template still embeds the scan image, but saving is off, so that embed is dropped from synced notes. Remove the image line in the Template tab to make it explicit.');
		}

		if (this.plugin.settings.downloadImages) {
			let attachWarn: HTMLElement | null = null;
			const reservedWikilinkChars = /[#|[\]]/;

			new Setting(containerEl)
				.setName('Attachments folder')
				.setDesc('Where scan images are saved. Leave empty to use Obsidian\'s own attachment folder.')
				.setClass('papersync-sub-setting')
				.addText((text) =>
					text
						.setPlaceholder('Obsidian default')
						.setValue(this.plugin.settings.attachmentsFolder)
						.onChange(asyncValueHandler(async (value) => {
							this.plugin.settings.attachmentsFolder = value;
							await this.plugin.saveSettings();
							attachWarn?.toggleClass('is-visible', reservedWikilinkChars.test(value));
						}))
				);

			// Warn on wikilink-reserved characters: Obsidian reads them as link syntax, so
			// the image saves but the ![[ ]] embed never resolves.
			attachWarn = containerEl.createDiv({ cls: 'papersync-image-warning' });
			attachWarn.setText('Avoid # | [ ] in the attachments folder. Obsidian reads them as wikilink syntax, so the image embed will not resolve.');
			attachWarn.toggleClass('is-visible', reservedWikilinkChars.test(this.plugin.settings.attachmentsFolder));
		}

	}

	private renderTemplateSection(containerEl: HTMLElement): void {
		const descContainer = containerEl.createDiv({ cls: 'setting-item-description papersync-template-desc' });
		descContainer.createEl('p', { text: 'Template for synced notes. Available variables:' });

		const varList = descContainer.createEl('table', { cls: 'papersync-var-table' });
		const vars: Array<[string, string]> = [
			['{{ps_markdown}}', 'Converted text'],
			['{{ps_image_file}}', 'Image vault path, use ![[{{ps_image_file}}]] to embed'],
			['{{ps_scan_time}}', '12h scan time (2:30 PM)'],
			['{{ps_scan_time_24h}}', '24h scan time (14:30)'],
			['{{ps_separator}}', 'Divider (***) on append, empty on new note'],
			['{{ps_scan_date_short}}', 'Scan date per Daily Notes format'],
			['{{ps_scan_date}}', 'Full scan ISO timestamp'],
			['{{ps_confidence}}', 'AI score (0-100)'],
		];
		for (const [token, desc] of vars) {
			const row = varList.createEl('tr');
			row.createEl('td', { text: token, cls: 'papersync-var-token' });
			row.createEl('td', { text: desc });
		}

		// Warns when the template embeds a scan image but image saving is off (the
		// embed would render as an empty ![[]] in real notes).
		const imageWarning = containerEl.createDiv({ cls: 'papersync-image-warning' });

		// Editor on the left, live preview of a sample scan on the right.
		const split = containerEl.createDiv({ cls: 'papersync-template-split' });

		const editorCol = split.createDiv({ cls: 'papersync-template-col' });
		editorCol.createDiv({ cls: 'papersync-col-label', text: 'Template' });
		const textarea = editorCol.createEl('textarea', {
			cls: 'papersync-template-editor',
			attr: {
				spellcheck: 'false',
				placeholder: 'Enter your note template...',
			},
		});
		textarea.value = this.plugin.settings.templateString;

		const previewCol = split.createDiv({ cls: 'papersync-template-col' });
		previewCol.createDiv({ cls: 'papersync-col-label', text: 'Preview' });
		const previewEl = previewCol.createDiv({ cls: 'papersync-template-preview markdown-rendered' });

		const embedsImage = (): boolean => templateEmbedsImage(textarea.value);
		const embedsSeparator = (): boolean => /\{\{\s*(ps_separator|separator)\s*\}\}/.test(textarea.value);
		const imageSavingOff = (): boolean => !this.plugin.settings.downloadImages;

		const updateImageWarning = (): void => {
			const show = embedsImage() && imageSavingOff();
			imageWarning.toggleClass('is-visible', show);
			imageWarning.setText(show
				? 'Save scan images is off, so the image embed will render empty. Remove the image line from your template, or turn Save scan images back on in the Sync tab.'
				: '');
		};

		const renderPreview = (): void => {
			this.previewComponent?.unload();
			const component = new Component();
			this.previewComponent = component;
			component.load();
			previewEl.empty();
			updateImageWarning();

			// The faint prior entry only makes sense when the template uses {{ps_separator}}
			// (it shows the divider splitting this capture from earlier content). Without the
			// token, render the entry standalone so the heading isn't crowded.
			if (embedsSeparator()) {
				const prior = previewEl.createDiv({ cls: 'papersync-preview-prior markdown-rendered' });
				MarkdownRenderer.render(this.app, PRIOR_ENTRY_MD, prior, '', component).catch(console.error);
			}

			const md = renderTemplate(textarea.value, PREVIEW_CONTEXT);
			MarkdownRenderer.render(this.app, md, previewEl, '', component).then(() => {
				// Only the scan embed (a correctly-written {{ps_image_file}}, which resolves
				// to the sample path) becomes the placeholder. A malformed embed such as
				// ![[{{}}]] leaves the token literal, so its src won't match and it keeps
				// rendering as Obsidian's own unresolved box, showing the user their mistake.
				previewEl.querySelectorAll('.internal-embed').forEach((embed) => {
					const box = embed as HTMLElement;
					if (box.getAttribute('src') !== PREVIEW_CONTEXT.ps_image_file) {return;}
					box.empty();
					if (imageSavingOff()) {
						box.createDiv({ cls: 'papersync-preview-scan-off', text: 'Image saving is off, so this embed will be empty.' });
					} else {
						const figure = box.createDiv({ cls: 'papersync-preview-scan' });
						// Trusted static asset (no user input); parsed into a node rather
						// than assigned as innerHTML so the DOM-safety lint stays happy.
						const scan = new DOMParser().parseFromString(SCAN_PLACEHOLDER_SVG, 'image/svg+xml');
						figure.appendChild(document.importNode(scan.documentElement, true));
					}
				});
			}).catch(console.error);
		};

		textarea.addEventListener('input', () => {
			this.plugin.settings.templateString = textarea.value;
			if (this.previewDebounce !== null) {window.clearTimeout(this.previewDebounce);}
			this.previewDebounce = window.setTimeout(() => {
				this.previewDebounce = null;
				this.plugin.saveSettings().catch(console.error);
				renderPreview();
			}, 250);
		});

		renderPreview();
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		const { isGoogleConnected } = this.getConnectionState();
		if (isGoogleConnected) {
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
					await this.plugin.oauthManager?.disconnect();
					this.plugin.settings = { ...DEFAULT_SETTINGS };
					await this.plugin.saveSettings();
					new Notice('Settings cleared. Reconnect your account to continue');
					this.display();
				}))
			);
	}
}
