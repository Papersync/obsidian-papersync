import * as fs from 'fs';
import * as path from 'path';
import type PaperSyncPlugin from '@/main';
import { detectSyncLocations, resolvePickedFolder } from '@/utils/platform';
import type { SyncLocation } from '@/utils/platform';
import { STRINGS } from '@/utils/strings';
import { errorMessage } from '@/utils/error-message';
import { isExistingDirectory } from '@/utils/fs';
import { logger } from '@/utils/logger';
import { buildScanPlaceholderSvg } from '@/ui/scan-placeholder';
import { renderTemplate, LEGACY_TOKENS } from '@/notes/template-engine';
import { isAuthSuperseded } from '@/auth/oauth-manager';
import type { TemplateContext } from '@/notes/template-engine';
import { App, Component, MarkdownRenderer, Notice, PluginSettingTab } from 'obsidian';
import type { Setting } from 'obsidian';
import type { SettingDefinition, SettingDefinitionItem } from 'obsidian';
import type { GoogleEndpoints } from '@/config';
import { getDailyNotesConfig } from '@/utils/daily-notes';
import type { DailyNotesConfig } from '@/utils/daily-notes';
import {
	DEFAULT_CUSTOM_FILE_NAME,
	DEFAULT_CUSTOM_FOLDER,
	effectiveSaveTo,
	isFixedDestination,
	migrateNotesFolder,
	resolveNotePath,
} from '@/notes/scan-destination';
import type { SaveTo } from '@/notes/scan-destination';
import { DEFAULT_POLL_INTERVAL_S, MAX_POLL_INTERVAL_S, MIN_POLL_INTERVAL_S } from '@/config';

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
	ps_title: 'Small steps',
	ps_summary: 'A reminder to keep moving forward, with four everyday tasks.',
	ps_image_file: 'attachments/Papersync/papersync-scan.jpg',
	ps_markdown:
		'Small steps still move you forward. Start with one, and let momentum carry the rest.\n\n- [x] Grocery run before it rains\n- [ ] Read 20 pages before bed\n- [ ] 30-min walk after lunch\n- [ ] Call mom back',
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
// True when a template embeds the scan image.
// Obsidian reads these as wikilink syntax, so an attachments folder containing
// one saves the image but leaves the ![[ ]] embed unresolved.
const RESERVED_WIKILINK_CHARS = /[#|[\]]/;

const DAILY_NOTES_OFF_HINT = 'Turn on Daily notes in Obsidian to use this';

function templateEmbedsImage(template: string): boolean {
	return /\{\{\s*ps_image_file\s*\}\}/.test(template);
}

export type BackendType = 'drive' | 'folder' | 'none';

export interface PluginSettings {
	settingsVersion: number;
	setupComplete: boolean;
	backendType: BackendType;
	drivePollInterval: number;
	folderPath: string;
	folderType: string;
	// Where scans go (see notes/scan-destination.ts). saveTo '' = not chosen yet.
	saveTo: SaveTo;
	customFolder: string;
	customFileName: string;
	attachmentsFolder: string;
	templateString: string;
	downloadImages: boolean;
	lastSyncTimestamp: string;
	lastSyncAt: number;
	// Undocumented test seam: overrides for the Google OAuth/Drive endpoints.
	// Absent in DEFAULT_SETTINGS, never written by any UI path, no settings-UI
	// control. E2E specs set it at runtime to point the REAL OAuth + Drive flow
	// at an in-repo fake server (test/e2e/fake-google.ts).
	endpointOverrides?: Partial<GoogleEndpoints>;
	// Undocumented test seam, same rules as endpointOverrides (absent by default,
	// no UI, stripped on load): a shorter missing-photo grace in ms so E2E specs
	// need not wait the production window out. Only ever shortens it.
	companionGraceOverrideMs?: number;
}

const DEFAULT_TEMPLATE = `{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Source
> ![[{{ps_image_file}}]]
`;

export const DEFAULT_SETTINGS: PluginSettings = {
	settingsVersion: 5,
	setupComplete: false,
	backendType: 'none',
	drivePollInterval: DEFAULT_POLL_INTERVAL_S,
	folderPath: '',
	folderType: '',
	saveTo: '', // resolved on first setup (PaperSyncPlugin.resolveScanDestination)
	customFolder: DEFAULT_CUSTOM_FOLDER,
	customFileName: DEFAULT_CUSTOM_FILE_NAME,
	attachmentsFolder: '', // empty => Obsidian's own attachment folder
	templateString: DEFAULT_TEMPLATE,
	downloadImages: true,
	lastSyncTimestamp: '',
	lastSyncAt: 0,
};

// `daily` is the core Daily notes config at load time; only the v5 step reads it.
export function migrateSettings(
	data: Record<string, unknown>,
	daily: DailyNotesConfig = { enabled: false, folder: '', format: DEFAULT_CUSTOM_FILE_NAME }
): Record<string, unknown> {
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
		// The Google OAuth refresh token now lives in Obsidian's secret storage, never
		// plaintext data.json. Discard any stray plaintext copy a pre-secret-storage build
		// left at rest — the plugin is unpublished, so there is nothing to migrate; those
		// devices reconnect once. (main.ts also deletes the field on load as a belt-and-
		// braces strip for an already-v3 data.json that still carries it.)
		delete data.oauthRefreshToken;
		data.settingsVersion = 3;
	}

	if (version < 4) {
		// The un-prefixed template tokens ({{markdown}}, {{time}}, ...) stopped being
		// rendered. Rewrite them to their ps_ names in a saved template so it keeps
		// producing the same notes.
		if (typeof data.templateString === 'string') {
			data.templateString = data.templateString.replace(
				new RegExp(`\\{\\{(${Object.keys(LEGACY_TOKENS).join('|')})\\}\\}`, 'g'),
				(_match, name: string) => `{{${LEGACY_TOKENS[name]}}}`
			);
		}
		data.settingsVersion = 4;
	}

	if (version < 5) {
		// "Notes folder" (targetFolder) became "Save scans to". Map it so every scan
		// keeps landing in the file 0.1.5 would have used (migrateNotesFolder).
		const targetFolder = typeof data.targetFolder === 'string' ? data.targetFolder : '';
		Object.assign(data, migrateNotesFolder(targetFolder, daily));
		delete data.targetFolder;
		data.settingsVersion = 5;
	}

	return data;
}

function asyncHandler<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => void {
	return (...args: A) => {
		fn(...args).catch(console.error);
	};
}

export class PaperSyncSettingTab extends PluginSettingTab {
	plugin: PaperSyncPlugin;
	private syncButton: HTMLButtonElement | null = null;
	private syncDesc: HTMLElement | null = null;
	// The storage-loss state the open tab was last painted for: whether the folder
	// is missing and whether Google Drive is signed out (null = not painted since it
	// was last hidden). A state update that disagrees means storage was just lost
	// or just came back, and the picker and connected row must swap.
	private shownLoss: string | null = null;
	private previewComponent: Component | null = null;
	private previewDebounce: number | null = null;
	// The Save scans to row's live parts, while that row is rendered.
	private destinationUI: {
		descText: HTMLElement;
		previewLabel: HTMLElement;
		previewPath: HTMLElement;
		dropdown: HTMLSelectElement;
		dailyOption: HTMLOptionElement | null;
	} | null = null;

	constructor(app: App, plugin: PaperSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Edits are saved per keystroke, but the sync engine only sees finished ones
		// (see PaperSyncPlugin.commitSettings). 'change' fires when a text field or the
		// template editor is left or Enter is pressed; focusout also covers leaving a
		// field unchanged-looking, e.g. by switching windows. hide() commits the rest.
		const commit = (): void => {
			this.plugin.commitSettings();
		};
		plugin.registerDomEvent(this.containerEl, 'change', commit);
		plugin.registerDomEvent(this.containerEl, 'focusout', commit);
	}

	updateSyncState(): void {
		// The folder went missing (a sync or the backend reported it) or came back
		// while the tab is open: swap the picker (with its missing-folder warning)
		// and the connected row. The swap is a visibility change only
		// (refreshDomState(), no re-render). It is driven by the folder state the tab
		// last painted, which the missing-folder row's visible() records, never by
		// which render callbacks ran: Obsidian runs every row's render(), hidden rows
		// included, so "rendered" does not mean "on screen".
		const loss = this.getLossKey();
		if (this.shownLoss !== null && this.shownLoss !== loss) {
			this.shownLoss = loss;
			this.swapFolderState();
			// Fall through: the rows were not re-rendered, so the connected row coming
			// back still carries the status text from before the loss.
		}
		if (!this.syncButton || !this.syncDesc) {
			return;
		}
		const { status, pendingCount } = this.plugin.syncState.snapshot;
		const isBusy = status === 'syncing';

		this.setSyncBusy(isBusy);

		const lastSyncAt = this.plugin.settings.lastSyncAt;
		const syncedText = lastSyncAt
			? `Synced. Last sync ${new Date(lastSyncAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
			: 'Synced';
		const statusText = isBusy
			? `Syncing (${pendingCount} pending)...`
			: status === 'error'
				? (this.plugin.syncState.snapshot.lastError ?? 'Sync error')
				: status === 'offline'
					? 'Offline'
					: this.plugin.syncEngine
						? syncedText
						: 'Not connected';
		this.syncDesc.textContent = statusText;
	}

	private setSyncBusy(busy: boolean): void {
		if (!this.syncButton) {
			return;
		}
		const isReady = !!this.plugin.syncEngine;
		this.syncButton.textContent = busy ? 'Syncing...' : 'Sync now';
		this.syncButton.disabled = busy || !isReady;
		if (busy) {
			this.syncButton.addClass('is-loading');
		} else {
			this.syncButton.removeClass('is-loading');
		}
	}

	// A folder backend whose folder is gone counts as NOT connected, so the tab
	// falls back to the storage picker (with a warning naming the folder)
	// instead of a connected row that cannot sync. Read from disk on every call
	// rather than from the last sync error: the disk is the truth at startup, before
	// any sync has run, and after a drive is remounted, when a stale error would lie.
	// Google Drive set up but signed out (Google refused the saved sign-in, so it
	// was cleared) is the same kind of loss: the picker shows, under a warning that
	// says why, instead of looking like storage was never chosen. Before the OAuth
	// manager exists (startup) nothing is known yet, so it is not a loss.
	private getConnectionState(): {
		isGoogleConnected: boolean;
		isFolderConnected: boolean;
		isFolderMissing: boolean;
		isDriveSignedOut: boolean;
	} {
		const { backendType, setupComplete, folderPath } = this.plugin.settings;
		const oauth = this.plugin.oauthManager;
		const isGoogleConnected = backendType === 'drive' && (oauth?.isAuthenticated ?? false);
		const isDriveSignedOut = backendType === 'drive' && setupComplete && oauth !== null && !oauth.isAuthenticated;
		const folderConfigured = backendType === 'folder' && setupComplete;
		const isFolderMissing = folderConfigured && !isExistingDirectory(folderPath);
		const isFolderConnected = folderConfigured && !isFolderMissing;
		return { isGoogleConnected, isFolderConnected, isFolderMissing, isDriveSignedOut };
	}

	private getLossKey(): string {
		const { isFolderMissing, isDriveSignedOut } = this.getConnectionState();
		return `${String(isFolderMissing)}/${String(isDriveSignedOut)}`;
	}

	private getMissingFolderName(): string {
		return path.basename(this.plugin.settings.folderPath) || 'Papersync';
	}

	// Structural re-render: getSettingDefinitions() runs again and every row is
	// re-rendered. For a change that only flips which rows show, use
	// swapFolderState() instead.
	private refresh(): void {
		this.update();
	}

	// Swap the picker and the connected row after the folder went missing or came
	// back. Every row is already rendered, hidden or not, so this is only a
	// visibility change: refreshDomState() re-runs the visible() predicates and
	// touches nothing else. A full update() would re-render every row, the
	// template editor included, and take focus from whatever the user is typing in.
	private swapFolderState(): void {
		this.refreshDomState();
	}

	// The behaviour behind each control lives in these handlers; the definitions
	// below only wire them to rows.

	private async disconnectGoogle(): Promise<void> {
		this.plugin.stopSync();
		await this.plugin.oauthManager?.disconnect();
		this.plugin.settings.backendType = 'none';
		this.plugin.settings.setupComplete = false;
		await this.plugin.saveSettings();
		new Notice('Disconnected from Google Drive');
		this.refresh();
	}

	private async disconnectFolder(): Promise<void> {
		const displayName = this.getFolderDisplayName();
		this.plugin.stopSync();
		this.plugin.settings.backendType = 'none';
		this.plugin.settings.folderPath = '';
		this.plugin.settings.folderType = '';
		this.plugin.settings.setupComplete = false;
		await this.plugin.saveSettings();
		new Notice(`Disconnected from ${displayName}`);
		this.refresh();
	}

	private async connectGoogle(): Promise<void> {
		// The picker (where Connect lives) also shows for a folder backend whose
		// folder is missing, with that engine still running. Stop it first: a
		// cancelled or failed sign-in leaves backendType 'none', and nothing may keep
		// watching (and, once the folder is back, syncing from) the abandoned folder.
		this.plugin.stopSync();
		try {
			this.plugin.settings.backendType = 'drive';
			await this.plugin.saveSettings();
			await this.plugin.oauthManager?.startAuthFlow();
			this.plugin.settings.setupComplete = true;
			await this.plugin.saveSettings();
			await this.plugin.startSync();
			new Notice(STRINGS.SETTINGS_CONNECTED);
		} catch (err) {
			// Connect was pressed again: the newer sign-in owns the settings now.
			if (isAuthSuperseded(err)) {return;}
			this.plugin.settings.backendType = 'none';
			await this.plugin.saveSettings();
			new Notice(`Connection failed: ${errorMessage(err)}`);
		}
		this.refresh();
	}

	private async resetSettings(): Promise<void> {
		this.plugin.stopSync();
		// "Account kept": the storage connection survives. For a folder backend that
		// is the folder itself; resetting only backendType/setupComplete left a folder
		// backend pointing at '' (and the settings reporting "Papersync" missing).
		const { backendType, setupComplete, folderPath, folderType } = this.plugin.settings;
		this.plugin.settings = {
			...DEFAULT_SETTINGS,
			backendType,
			setupComplete,
			folderPath,
			folderType,
		};
		await this.plugin.saveSettings();
		// startSync re-runs the first-setup choice of where scans go (saveTo is '').
		await this.plugin.startSync();
		new Notice('Settings reset (account kept)');
		this.refresh();
	}

	private async fullReset(): Promise<void> {
		this.plugin.stopSync();
		await this.plugin.oauthManager?.disconnect();
		this.plugin.settings = { ...DEFAULT_SETTINGS };
		await this.plugin.saveSettings();
		new Notice('Settings cleared. Reconnect your account to continue');
		this.refresh();
	}

	private async setDownloadImages(value: boolean): Promise<void> {
		this.plugin.settings.downloadImages = value;
		await this.plugin.saveSettings();
		this.plugin.commitSettings(); // a toggle is a finished edit
		this.refresh();
	}

	// Tear down the template preview's render component when the tab closes.
	hide(): void {
		// Closed: state updates must not re-render into (or write into) a hidden tab.
		this.syncButton = null;
		this.syncDesc = null;
		this.shownLoss = null;
		this.teardownPreview();
		// Settings closed: whatever is in the fields now is final.
		this.plugin.commitSettings();
	}

	// Shared by hide() and the template row's cleanup callback: the
	// preview owns a loaded Component and a pending debounce, and both leak if the
	// row goes away without them being released.
	private teardownPreview(): void {
		this.previewComponent?.unload();
		this.previewComponent = null;
		if (this.previewDebounce !== null) {
			window.clearTimeout(this.previewDebounce);
			this.previewDebounce = null;
			// The debounce is also what persists template edits. Flush, don't drop:
			// closing the settings (or a re-render) within 250 ms of a keystroke used
			// to leave that edit in memory only.
			this.plugin.saveSettings().catch(console.error);
		}
	}

	private async browseForFolder(): Promise<void> {
		try {
			const electron = (
				window as unknown as {
					require?: (mod: string) => {
						remote?: {
							dialog: {
								showOpenDialog: (opts: {
									properties: string[];
								}) => Promise<{ canceled: boolean; filePaths: string[] }>;
							};
						};
					};
				}
			).require?.('electron');
			const dialog = electron?.remote?.dialog;
			if (!dialog) {
				new Notice('Folder browser not available');
				return;
			}
			const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
			if (result.canceled || !result.filePaths[0]) {
				return;
			}
			await this.selectFolderLocation(resolvePickedFolder(result.filePaths[0]), 'custom');
		} catch (err) {
			new Notice(`Could not open the folder browser: ${errorMessage(err)}`);
		}
	}

	private getFolderDisplayName(): string {
		// Only iCloud is a named row now; everything else arrives through Browse or
		// as a detected folder, and reads as generic folder sync.
		return this.plugin.settings.folderType === 'icloud' ? 'iCloud Drive' : 'Folder sync';
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
		this.plugin.stopSync();
		this.plugin.settings.backendType = 'folder';
		this.plugin.settings.folderPath = folderPath;
		this.plugin.settings.folderType = folderType;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();
		await this.plugin.startSync();
		new Notice(`Now watching ${folderPath} for new scans`);
		this.refresh();
	}

	// Sync now is the primary action, so it sits on the connected provider row
	// itself (next to Change Storage); that row's description carries live status.
	private addSyncNowButton(setting: Setting): void {
		setting.addButton((button) => {
			button.setCta().onClick(
				asyncHandler(async () => {
					if (!this.plugin.syncEngine || this.plugin.syncState.isSyncing) {
						return;
					}
					this.setSyncBusy(true);
					await new Promise((r) => window.setTimeout(r, 50));
					await this.plugin.syncEngine.forceSyncNow();
					this.setSyncBusy(false);
				})
			);
			this.syncButton = button.buttonEl;
		});
		this.syncDesc = setting.descEl;
		this.updateSyncState();
	}

	private renderTemplateSection(containerEl: HTMLElement): void {
		const descContainer = containerEl.createDiv({
			cls: 'setting-item-description papersync-template-desc',
		});
		descContainer.createEl('p', { text: 'Template for synced notes. Available variables:' });

		const varList = descContainer.createEl('table', { cls: 'papersync-var-table' });
		const vars: Array<[string, string]> = [
			['{{ps_markdown}}', 'Converted text'],
			['{{ps_title}}', 'Page title (AI, or the first heading)'],
			['{{ps_summary}}', 'One-line summary (AI, empty if none)'],
			['{{ps_image_file}}', 'Image vault path, use ![[{{ps_image_file}}]] to embed'],
			['{{ps_scan_time}}', '12h scan time (2:30 PM)'],
			['{{ps_scan_time_24h}}', '24h scan time (14:30)'],
			['{{ps_separator}}', 'Divider (***) on append, empty on new note'],
			['{{ps_scan_date_short}}', 'Scan date per Daily Notes format'],
			['{{ps_scan_date}}', 'Full scan ISO timestamp'],
			['{{ps_confidence}}', 'AI score (0-100)'],
			['{{ps_provider}}', 'AI provider used (claude)'],
			['{{ps_model}}', 'Model used (claude-sonnet-4)'],
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
		const embedsSeparator = (): boolean => /\{\{\s*ps_separator\s*\}\}/.test(textarea.value);
		const imageSavingOff = (): boolean => !this.plugin.settings.downloadImages;

		const updateImageWarning = (): void => {
			const show = embedsImage() && imageSavingOff();
			imageWarning.toggleClass('is-visible', show);
			imageWarning.setText(
				show
					? 'Save scan images is off, so the image line is dropped from synced notes. Remove it from your template, or turn Save scan images back on under Sync.'
					: ''
			);
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
				MarkdownRenderer.render(this.app, PRIOR_ENTRY_MD, prior, '', component).catch(
					console.error
				);
			}

			const md = renderTemplate(textarea.value, PREVIEW_CONTEXT);
			MarkdownRenderer.render(this.app, md, previewEl, '', component)
				.then(() => {
					// Only the scan embed (a correctly-written {{ps_image_file}}, which resolves
					// to the sample path) becomes the placeholder. A malformed embed such as
					// ![[{{}}]] leaves the token literal, so its src won't match and it keeps
					// rendering as Obsidian's own unresolved box, showing the user their mistake.
					previewEl.querySelectorAll('.internal-embed').forEach((embed) => {
						const box = embed as HTMLElement;
						if (box.getAttribute('src') !== PREVIEW_CONTEXT.ps_image_file) {
							return;
						}
						box.empty();
						if (imageSavingOff()) {
							box.createDiv({
								cls: 'papersync-preview-scan-off',
								text: 'Image saving is off, so this line is dropped from synced notes.',
							});
						} else {
							const figure = box.createDiv({ cls: 'papersync-preview-scan' });
							// Trusted static asset (no user input); parsed into a node rather
							// than assigned as innerHTML so the DOM-safety lint stays happy.
							const scan = new DOMParser().parseFromString(
								buildScanPlaceholderSvg(PREVIEW_CONTEXT.ps_markdown),
								'image/svg+xml'
							);
							// The settings tab lives in its own window, not the global `document`.
							figure.appendChild(figure.doc.importNode(scan.documentElement, true));
						}
					});
				})
				.catch(console.error);
		};

		textarea.addEventListener('input', () => {
			this.plugin.settings.templateString = textarea.value;
			if (this.previewDebounce !== null) {
				window.clearTimeout(this.previewDebounce);
			}
			this.previewDebounce = window.setTimeout(() => {
				this.previewDebounce = null;
				this.plugin.saveSettings().catch(console.error);
				renderPreview();
				// The Sync section's "Template still embeds the scan image" row reads
				// the template in its visible(), and Obsidian cannot see this textarea
				// (it is not a control), so re-run the predicates. A visibility toggle
				// only: no re-render, so the editor keeps focus.
				this.refreshDomState();
			}, 250);
		});

		renderPreview();
	}

	// ---------------------------------------------------------------------------
	// Rendering (declarative, Obsidian 1.13+; the manifest floor is 1.13.4)
	//
	// Rows that are plain values use `control`, so the framework owns the binding
	// through getControlValue/setControlValue. Everything bespoke uses `render`. A
	// `render` row is still indexed for settings search, because search reads the
	// definition's name/desc rather than the DOM.
	//
	// The three sections are headed groups in a single scroll rather than pages:
	// groups keep every setting individually indexed, and nesting them into pages
	// would hide them from the search.
	// ---------------------------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ type: 'group', heading: 'Sync', items: this.syncDefinitions() },
			{ type: 'group', heading: 'Template', items: this.templateDefinitions() },
			{ type: 'group', heading: 'Advanced', items: this.advancedDefinitions() },
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key) {
			case 'downloadImages':
				return s.downloadImages;
			case 'attachmentsFolder':
				return s.attachmentsFolder;
			// The control is a text field, so hand back a string rather than the
			// number we store; the framework would otherwise seed it as "[object]".
			case 'drivePollInterval':
				return String(s.drivePollInterval);
			default:
				return undefined;
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key) {
			case 'attachmentsFolder':
				s.attachmentsFolder = String(value);
				break;
			case 'drivePollInterval': {
				// validate() already rejects anything out of range, so by here the
				// value parses; guard anyway rather than persist a NaN.
				const parsed = parseInt(String(value), 10);
				if (isNaN(parsed) || parsed < MIN_POLL_INTERVAL_S || parsed > MAX_POLL_INTERVAL_S) {
					return;
				}
				s.drivePollInterval = parsed;
				break;
			}
			// Toggling image saving changes which other rows are visible, so it goes
			// through the shared handler that persists AND re-renders.
			case 'downloadImages':
				return this.setDownloadImages(Boolean(value));
			default:
				return;
		}
		await this.plugin.saveSettings();
	}

	// The mode that applies now: core Daily notes is read live, so turning it off
	// shows Custom without touching a saved Daily note choice.
	private currentSaveTo(): 'daily' | 'custom' {
		return effectiveSaveTo(this.plugin.settings.saveTo, getDailyNotesConfig(this.app));
	}

	// Paints the Save scans to row from the current settings and Daily notes state:
	// the selected option, the Daily note option's availability, the description
	// and the preview of today's path.
	private updateDestinationUI(): void {
		const ui = this.destinationUI;
		if (!ui) {
			return;
		}
		const daily = getDailyNotesConfig(this.app);
		const mode = effectiveSaveTo(this.plugin.settings.saveTo, daily);
		ui.dropdown.value = mode;
		if (ui.dailyOption) {
			// A native <option> cannot show a second line, so the hint goes into the
			// disabled option's label (and its tooltip).
			ui.dailyOption.disabled = !daily.enabled;
			ui.dailyOption.text = daily.enabled ? 'Daily note' : `Daily note (${DAILY_NOTES_OFF_HINT})`;
			ui.dailyOption.title = daily.enabled ? '' : DAILY_NOTES_OFF_HINT;
		}
		ui.descText.setText(
			mode === 'daily'
				? 'Each scan is added to this note. Follows your Daily notes folder and date format.'
				: 'Each scan is added to this note.'
		);
		const dest = this.plugin.settings;
		ui.previewLabel.setText(isFixedDestination(dest, daily) ? 'Every scan: ' : 'Today: ');
		ui.previewPath.setText(resolveNotePath(new Date(), dest, daily));
	}

	private isConnected(): boolean {
		const { isGoogleConnected, isFolderConnected } = this.getConnectionState();
		return isGoogleConnected || isFolderConnected;
	}

	private syncDefinitions(): SettingDefinition[] {
		const defs: SettingDefinition[] = [];

		// Above the storage picker when the configured folder is gone. Everything
		// connection-dependent reads it from getConnectionState() at paint time,
		// like every other row here.
		defs.push({
			name: 'Papersync folder missing',
			searchable: false,
			// visible() runs on every paint (render() runs for hidden rows too), so
			// this is where the tab records which folder state it painted.
			visible: () => {
				this.shownLoss = this.getLossKey();
				return this.getConnectionState().isFolderMissing;
			},
			render: (setting) => {
				setting.setClass('papersync-folder-missing');
				setting.setName(STRINGS.SETTINGS_FOLDER_MISSING_TITLE(this.getMissingFolderName()));
				setting.setDesc(STRINGS.SETTINGS_FOLDER_MISSING_DESC);
			},
		});

		defs.push({
			name: 'Google Drive signed out',
			searchable: false,
			visible: () => {
				this.shownLoss = this.getLossKey();
				return this.getConnectionState().isDriveSignedOut;
			},
			render: (setting) => {
				setting.setClass('papersync-warning-row');
				setting.setClass('papersync-drive-signed-out');
				setting.setName(STRINGS.SETTINGS_DRIVE_SIGNED_OUT_TITLE);
				setting.setDesc(STRINGS.SETTINGS_DRIVE_SIGNED_OUT_DESC);
			},
		});

		// Every row is ALWAYS in the list, with connection state expressed only
		// through visible()/render(). Obsidian 1.13 computes this list once (at
		// tab registration, for the settings search index) and re-runs only those
		// callbacks per paint — so any branch taken while BUILDING the list is
		// baked in for the tab's lifetime. Proven the hard way: at registration
		// the oauthManager does not exist yet, so a connection branch here froze
		// the disconnected picker into the pane even while authenticated.
		// (detectSyncLocations() is still called here once: which sync folders
		// exist on disk is machine-static, unlike the connection.)

		defs.push({
			name: 'Connected storage',
			aliases: ['storage', 'provider', 'connection', 'sync now', 'disconnect'],
			visible: () => this.isConnected(),
			render: (setting) => {
				const { isGoogleConnected } = this.getConnectionState();
				setting.setName(isGoogleConnected ? '✓ Google Drive' : `✓ ${this.getFolderDisplayName()}`);
				setting.setClass('papersync-storage-active');
				this.addSyncNowButton(setting);
				setting.addButton((button) =>
					button
						.setButtonText('Change storage')
						.onClick(
							asyncHandler(() =>
								this.getConnectionState().isGoogleConnected
									? this.disconnectGoogle()
									: this.disconnectFolder()
							)
						)
				);
				// addSyncNowButton caches these for updateSyncState; drop the
				// references when the row goes so it cannot write into dead DOM.
				return () => {
					this.syncButton = null;
					this.syncDesc = null;
				};
			},
		});

		defs.push({
			name: 'Google Drive',
			desc: 'Sign in with your Google account',
			aliases: ['connect', 'storage', 'sign in'],
			visible: () => !this.isConnected(),
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText('Connect').onClick(asyncHandler(() => this.connectGoogle()))
				);
			},
		});

		for (const loc of detectSyncLocations()) {
			defs.push({
				name: loc.displayName,
				desc: loc.exists ? loc.path : `${loc.path} (will be created)`,
				aliases: ['storage', 'folder', 'sync location'],
				visible: () => !this.isConnected(),
				render: (setting) => {
					setting.addButton((button) =>
						button
							.setButtonText('Select')
							.onClick(asyncHandler(() => this.selectDetectedLocation(loc)))
					);
				},
			});
		}

		defs.push({
			name: 'Select your Papersync folder',
			desc: 'Browse to the folder your phone saves scans into. Papersync finds the right level from wherever you point it.',
			aliases: ['browse', 'storage', 'folder'],
			visible: () => !this.isConnected(),
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText('Browse').onClick(asyncHandler(() => this.browseForFolder()))
				);
			},
		});

		// Everything below only means anything once a backend is chosen.
		// Where scans go: the core daily note, or a custom folder and file. Render
		// rows rather than controls: the dropdown needs a disabled option, the
		// description carries a live preview of the path, and the two custom fields
		// are indented under it.
		defs.push({
			name: 'Save scans to',
			desc: 'Each scan is added to this note. Daily note, or a custom folder and file.',
			aliases: ['notes folder', 'daily note', 'folder', 'file name', 'destination', 'periodic notes'],
			visible: () => this.isConnected(),
			render: (setting) => {
				setting.setClass('papersync-save-to');
				setting.descEl.empty();
				const descText = setting.descEl.createDiv();
				const preview = setting.descEl.createDiv({ cls: 'papersync-save-to-preview' });
				const previewLabel = preview.createSpan();
				const previewPath = preview.createEl('code');
				setting.addDropdown((dropdown) => {
					dropdown.addOption('daily', 'Daily note');
					dropdown.addOption('custom', 'Custom folder and file');
					const dailyOption = dropdown.selectEl.querySelector<HTMLOptionElement>('option[value="daily"]');
					this.destinationUI = { descText, previewLabel, previewPath, dropdown: dropdown.selectEl, dailyOption };
					dropdown.onChange(asyncHandler(async (value) => {
						this.plugin.settings.saveTo = value === 'daily' ? 'daily' : 'custom';
						await this.plugin.saveSettings();
						this.plugin.commitSettings(); // a dropdown pick is a finished edit
						// Shows or hides the Folder and File name rows: a visibility
						// change only, no re-render.
						this.refreshDomState();
						this.updateDestinationUI();
					}));
				});
				this.updateDestinationUI();
				return () => {
					this.destinationUI = null;
				};
			},
		});

		defs.push({
			name: 'Folder',
			desc: '/ is the vault root. Date tokens: YYYY, MM, DD (e.g. Journal/YYYY/MM).',
			aliases: ['notes folder', 'custom folder'],
			visible: () => this.isConnected() && this.currentSaveTo() === 'custom',
			render: (setting) => {
				setting.setClass('papersync-sub-setting');
				setting.setClass('papersync-custom-folder');
				setting.addText((text) =>
					text
						.setPlaceholder(DEFAULT_CUSTOM_FOLDER)
						.setValue(this.plugin.settings.customFolder)
						.onChange(asyncHandler(async (value) => {
							this.plugin.settings.customFolder = value;
							await this.plugin.saveSettings();
							this.updateDestinationUI();
						}))
				);
			},
		});

		defs.push({
			name: 'File name',
			desc: 'A date format like YYYY-MM-DD, or a fixed name like Inbox to keep every scan in one note. Using Periodic Notes? Enter its folder and date format here.',
			aliases: ['file name', 'date format', 'periodic notes'],
			visible: () => this.isConnected() && this.currentSaveTo() === 'custom',
			render: (setting) => {
				setting.setClass('papersync-sub-setting');
				setting.setClass('papersync-custom-file');
				setting.addText((text) =>
					text
						.setPlaceholder(DEFAULT_CUSTOM_FILE_NAME)
						.setValue(this.plugin.settings.customFileName)
						.onChange(asyncHandler(async (value) => {
							this.plugin.settings.customFileName = value;
							await this.plugin.saveSettings();
							this.updateDestinationUI();
						}))
				);
			},
		});

		defs.push({
			name: 'Save scan images',
			desc: 'Download the original scan image into your vault. If off, remove {{ps_image_file}} from your template.',
			visible: () => this.isConnected(),
			control: { type: 'toggle', key: 'downloadImages' },
		});

		defs.push({
			name: 'Template still embeds the scan image',
			searchable: false,
			visible: () =>
				this.isConnected() &&
				!this.plugin.settings.downloadImages &&
				templateEmbedsImage(this.plugin.settings.templateString),
			render: (setting) => {
				// Not 'papersync-image-warning': that class is display:none until the
				// template editor adds is-visible, which left this row permanently
				// hidden. visible() alone decides whether it shows.
				setting.setClass('papersync-warning-row');
				setting.setDesc(
					'Your template still embeds the scan image, but saving is off, so that embed is dropped from synced notes. Remove the image line in the template section to make it explicit.'
				);
			},
		});

		defs.push({
			name: 'Attachments folder',
			desc: "Where scan images are saved (/ is the vault root). Leave empty to use Obsidian's own attachment folder.",
			visible: () => this.isConnected() && this.plugin.settings.downloadImages,
			control: {
				type: 'text',
				key: 'attachmentsFolder',
				placeholder: 'Obsidian default',
				// Obsidian reads these as wikilink syntax, so the image saves but the
				// ![[ ]] embed never resolves. Inline validation says so at the point
				// of entry rather than as a separate warning element.
				validate: (value) =>
					RESERVED_WIKILINK_CHARS.test(value)
						? 'Avoid # | [ ] here. Obsidian reads them as wikilink syntax, so the image embed will not resolve.'
						: undefined,
			},
		});

		return defs;
	}

	private templateDefinitions(): SettingDefinition[] {
		return [
			{
				name: 'Note template',
				desc: 'Template for synced notes, with a live preview of a sample scan.',
				aliases: [
					'template',
					'preview',
					'variables',
					'ps_markdown',
					'ps_image_file',
					'ps_scan_time',
				],
				render: (setting) => {
					// The variable table, editor and live preview are built imperatively
					// inside the row.
					setting.settingEl.addClass('papersync-template-row');
					// The editor lives outside controlEl, which is all Setting.clear()
					// empties before Obsidian re-renders a row. Remove it in the cleanup, or
					// every update() stacks another live editor (and its listeners) on top
					// of the old one.
					const host = setting.settingEl.createDiv();
					this.renderTemplateSection(host);
					return () => {
						this.teardownPreview();
						host.remove();
					};
				},
			},
		];
	}

	private advancedDefinitions(): SettingDefinition[] {
		return [
			{
				name: 'Poll interval (seconds)',
				desc: 'How often to check Google Drive for new scans.',
				visible: () => this.getConnectionState().isGoogleConnected,
				control: {
					type: 'text',
					key: 'drivePollInterval',
					placeholder: String(DEFAULT_POLL_INTERVAL_S),
					validate: (value) => {
						const parsed = parseInt(value, 10);
						return isNaN(parsed) || parsed < MIN_POLL_INTERVAL_S || parsed > MAX_POLL_INTERVAL_S
							? `Enter a whole number of seconds, from ${MIN_POLL_INTERVAL_S} to ${MAX_POLL_INTERVAL_S}.`
							: undefined;
					},
				},
			},
			{
				name: 'Reset settings',
				desc: 'Reset preferences to defaults. Keeps your account connected.',
				aliases: ['reset', 'clear', 'defaults'],
				render: (setting) => {
					setting.addButton((button) =>
						button.setButtonText('Reset settings').onClick(asyncHandler(() => this.resetSettings()))
					);
					setting.addButton((button) =>
						button
							.setButtonText('Full reset')
							.setDestructive()
							.onClick(asyncHandler(() => this.fullReset()))
					);
				},
			},
		];
	}
}
