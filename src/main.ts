import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, PaperSyncSettingTab, migrateSettings } from '@/settings';
import type { PluginSettings } from '@/settings';
import { setDebugLogging, logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';
import { STRINGS } from '@/utils/strings';
import { OAuthManager } from '@/auth/oauth-manager';
import { readSecret, writeSecret } from '@/auth/secret-store';
import { DriveBackend } from '@/sync/drive-backend';
import { FolderBackend } from '@/sync/folder-backend';
import { SyncEngine } from '@/sync/sync-engine';
import type { NoteCreatorConfig } from '@/notes/note-creator';
import { SyncState } from '@/sync/sync-state';
import type { SyncStateSnapshot } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';

import { GOOGLE_CLIENT_ID, DEV_MODE, OAUTH_TOKEN_SECRET_ID } from '@/config';
import { getDailyNotesConfig } from '@/utils/daily-notes';
import { createFakeScanOnDrive } from '@/utils/dev-tools';

export default class PaperSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	oauthManager: OAuthManager | null = null;
	syncEngine: SyncEngine | null = null;
	syncState: SyncState = new SyncState('');
	errorHandler: ErrorHandler = new ErrorHandler();
	private statusBarEl: HTMLElement | null = null;
	private settingsTab: PaperSyncSettingTab | null = null;
	private unsubscribeSyncState: (() => void) | null = null;
	private lastStatus: SyncStateSnapshot['status'] | null = null;
	private firstRunTimeout: number | null = null;

	async onload(): Promise<void> {
		if (!this.checkMinObsidianVersion()) {return;}

		await this.loadSettings();
		// Console logging is a development-phase aid, gated to dev builds (no user toggle).
		setDebugLogging(DEV_MODE);

		this.settingsTab = new PaperSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		this.statusBarEl = this.addStatusBarItem();

		this.addRibbonIcon('refresh-cw', STRINGS.RIBBON_TOOLTIP, () => {
			void this.forceSyncNow();
		});

		// Command IDs are namespaced by Obsidian as `<plugin-id>:<id>`, so no papersync- prefix here.
		this.addCommand({
			id: 'sync-now',
			name: STRINGS.CMD_SYNC_NOW,
			callback: () => void this.forceSyncNow(),
		});

		this.addCommand({
			id: 'open-settings',
			name: STRINGS.CMD_OPEN_SETTINGS,
			callback: () => { void this.openSettings(); },
		});

		if (DEV_MODE) {
			this.addCommand({
				id: 'dev-fake-scan',
				name: 'DEV: Add fake scan to Drive',
				callback: () => {
					if (!this.oauthManager?.isAuthenticated) {
						new Notice('Connect Google Drive first');
						return;
					}
					void createFakeScanOnDrive(this.oauthManager).then(() => {
						new Notice('Fake scan uploaded, will sync on next poll');
					}).catch((err: unknown) => {
						new Notice(`Failed: ${errorMessage(err)}`);
					});
				},
			});
		}

		void this.initAsync();
		logger.info('Plugin loaded');
	}

	onunload(): void {
		if (this.firstRunTimeout !== null) {
			window.clearTimeout(this.firstRunTimeout);
			this.firstRunTimeout = null;
		}
		this.syncEngine?.stop();
		this.unsubscribeSyncState?.();
		this.oauthManager?.cleanup();
		logger.info('Plugin unloaded');
	}

	private checkMinObsidianVersion(): boolean {
		const MIN_VERSION = '1.13.4';
		// requireApiVersion is an Obsidian global that checks minAppVersion
		const requireApiVersion = (window as unknown as { requireApiVersion?: (version: string) => boolean }).requireApiVersion;
		if (requireApiVersion && !requireApiVersion(MIN_VERSION)) {
			new Notice(STRINGS.NOTICE_OBSIDIAN_VERSION, 0);
			logger.error(`Obsidian version too old — requires ${MIN_VERSION}+`);
			return false;
		}
		return true;
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		if (loaded && typeof loaded === 'object') {
			const raw = loaded as Record<string, unknown>;
			// The endpointOverrides seam is runtime-injected by E2E only — never honor a
			// persisted copy across a plugin load. Stripping it here (in memory; no
			// re-persist needed) makes a stale or tampered data.json self-heal instead of
			// steering OAuth/Drive traffic at whatever host the file names.
			delete raw.endpointOverrides;
			// The refresh token lives in OS secret storage, never data.json. The plugin is
			// unpublished, so there is no token worth migrating — just discard any stray
			// plaintext copy a pre-secret-storage dogfood build may have left behind (those
			// devices reconnect once). The migrateSettings v3 step also strips it, but this
			// explicit delete covers an already-v3 data.json that still carries the field.
			// Remember whether a stray copy was present so we can scrub the plaintext from
			// DISK below, not only from the in-memory settings.
			const hadStrayToken = 'oauthRefreshToken' in raw;
			delete raw.oauthRefreshToken;
			const versionBefore = raw.settingsVersion;
			const migrated = migrateSettings(raw);
			this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated as Partial<PluginSettings>);
			// Re-persist on a version bump (existing behavior) OR when a stray plaintext
			// token was present. The latter forces "discard" to overwrite data.json with
			// this.settings (which no longer carries the field), so an already-v3 file whose
			// version does not change still gets the plaintext scrubbed from disk, not just
			// from memory.
			if (versionBefore !== migrated.settingsVersion || hadStrayToken) {
				await this.saveData(this.settings);
			}
		} else {
			this.settings = { ...DEFAULT_SETTINGS };
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async initAsync(): Promise<void> {
		// The endpoints supplier is resolved at call time: OAuthManager is built at
		// plugin load, before the E2E seam (settings.endpointOverrides) can be written.
		this.oauthManager = new OAuthManager(this, GOOGLE_CLIENT_ID, () => this.settings.endpointOverrides);
		this.oauthManager.setOnTokenChange((token) => {
			// The refresh token lives in OS secret storage, never data.json. An empty string
			// (disconnect / revoke) clears it — the SecretStorage API has no deleteSecret.
			const ok = writeSecret(this.app, OAUTH_TOKEN_SECRET_ID, token);
			// A non-empty token that could not persist means Drive works this session but
			// won't survive a restart. Tell the user to reconnect — never fall back to
			// plaintext. A failed CLEAR (empty token) is log-only: the in-memory copy is
			// already gone, so there is nothing for the user to act on.
			if (!ok && token) {
				new Notice(STRINGS.NOTICE_SECRET_STORAGE_UNAVAILABLE, 0);
			}
		});

		if (this.settings.backendType === 'drive') {
			const token = readSecret(this.app, OAUTH_TOKEN_SECRET_ID);
			if (token) {
				this.oauthManager.restoreFromToken(token);
			}
		}

		if (!this.settings.setupComplete) {
			logger.info('First run detected, opening settings');
			this.syncState.setStatus('idle');
			this.firstRunTimeout = window.setTimeout(() => {
				this.firstRunTimeout = null;
				void this.openSettings();
			}, 500);
			return;
		}

		if (this.settings.backendType === 'none' || (this.settings.backendType === 'drive' && !this.oauthManager.isAuthenticated)) {
			this.syncState.setStatus('error');
		}

		void this.startSync();
	}

	async resolveTargetFolder(): Promise<void> {
		if (this.settings.targetFolder) {return;}

		// With Daily Notes on, scans append to the real daily note wherever it lives,
		// including the vault root ('/': '' already means "not resolved yet"). With it
		// off there is no daily note to join, so scans get their own folder.
		const dailyConfig = getDailyNotesConfig(this.app);
		this.settings.targetFolder = dailyConfig.enabled ? dailyConfig.folder || '/' : 'Papersync';
		await this.saveSettings();
		logger.info(`Notes folder resolved to "${this.settings.targetFolder}"`);
	}

	async startSync(): Promise<void> {
		this.syncEngine?.stop();
		this.unsubscribeSyncState?.();

		await this.resolveTargetFolder();

		logger.info(`startSync — backendType: ${this.settings.backendType}, setupComplete: ${String(this.settings.setupComplete)}, oauthAuthenticated: ${String(this.oauthManager?.isAuthenticated)}`);

		// Create shared sync state
		this.syncState = new SyncState(this.settings.lastSyncTimestamp);

		// Subscribe to state changes — single listener drives status bar + settings tab + persistence
		this.unsubscribeSyncState = this.syncState.subscribe((snap) => {
			this.onSyncStateChanged(snap);
		});

		// A live view, not a copy: the engine reads these on every scan, so an edit in
		// Settings (template, Notes folder, attachments folder, image saving) applies
		// to the next scan without restarting sync. A snapshot here used to keep the
		// old values until Obsidian restarted, while the live preview already showed
		// the new template. `this.settings` is itself replaced by a reset, so the
		// getters read it at call time.
		const settings = (): PluginSettings => this.settings;
		const noteConfig: NoteCreatorConfig = {
			get templateString() { return settings().templateString; },
			get targetFolder() { return settings().targetFolder; },
			get attachmentsFolder() { return settings().attachmentsFolder; },
			get downloadImages() { return settings().downloadImages; },
		};

		if (this.settings.backendType === 'drive' && this.oauthManager?.isAuthenticated) {
			// Same call-time supplier as OAuthManager gets in initAsync, so the token and
			// Drive legs of a sync can never resolve against two different snapshots of
			// the endpoint seam.
			const backend = new DriveBackend(this.oauthManager, () => this.settings.drivePollInterval, this.settings.lastSyncTimestamp, () => this.settings.endpointOverrides);
			this.startEngine(new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState));
			logger.info('Drive sync started');
		} else if (this.settings.backendType === 'folder' && this.settings.folderPath) {
			const backend = new FolderBackend(this.settings.folderPath);
			this.startEngine(new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState));
			logger.info('Folder sync started');
		} else {
			logger.info('No backend configured or authenticated — sync not started');
			// startSync replaced this.syncState above, so any error status set before this
			// call was lost. Set it on the LIVE instance so the UI reflects the misconfig
			// instead of silently showing "synced".
			this.syncState.setStatus('error');
		}
	}

	// A fresh engine runs on a fresh state that has not notified anyone yet. Left
	// alone, the status bar keeps whatever the previous engine last said (typically
	// "Papersync: error" after a missing folder is picked again) and the
	// transition gate swallows this engine's first error Notice. Re-open the gate
	// before starting, then paint the new state's current snapshot.
	private startEngine(engine: SyncEngine): void {
		this.syncEngine = engine;
		this.lastStatus = null;
		engine.start();
		this.onSyncStateChanged(this.syncState.snapshot);
	}

	private onSyncStateChanged(snap: SyncStateSnapshot): void {
		// Update status bar
		if (this.statusBarEl) {
			switch (snap.status) {
				case 'synced':
				case 'idle':
					this.statusBarEl.setText(STRINGS.STATUS_SYNCED);
					break;
				case 'syncing':
					this.statusBarEl.setText(STRINGS.STATUS_PENDING(snap.pendingCount));
					break;
				case 'error':
					this.statusBarEl.setText(STRINGS.STATUS_ERROR);
					break;
				case 'offline':
					this.statusBarEl.setText(STRINGS.STATUS_OFFLINE);
					break;
			}
		}

		const enteringError = snap.status === 'error' && this.lastStatus !== 'error';
		this.lastStatus = snap.status;

		// Surface a single Notice with the real reason when sync first enters the error
		// state, so a background failure is never silent. Gated on the transition.
		if (enteringError) {
			new Notice(snap.lastError ?? STRINGS.NOTICE_SYNC_ERROR, 10000);
		}
		// Record the wall-clock time a sync cycle last completed (distinct from the
		// sync cursor, which is the newest scan's timestamp). Driven by the state's
		// completion stamp rather than a status transition: a "Sync now" that found
		// nothing new keeps status at 'synced', but the stamp still advances.
		const justSynced = snap.lastSyncCompletedAt > this.settings.lastSyncAt;
		if (justSynced) {
			this.settings.lastSyncAt = snap.lastSyncCompletedAt;
		}

		// Update settings tab after lastSyncAt so the connection row shows the fresh time.
		this.settingsTab?.updateSyncState();

		// Persist sync cursor + last-sync time.
		let needsSave = justSynced;
		if (snap.lastSyncTimestamp !== this.settings.lastSyncTimestamp) {
			this.settings.lastSyncTimestamp = snap.lastSyncTimestamp;
			needsSave = true;
		}
		if (needsSave) {
			void this.saveSettings();
		}
	}

	private async forceSyncNow(): Promise<void> {
		if (this.syncEngine) {
			await this.syncEngine.forceSyncNow();
		} else {
			new Notice('Papersync is not configured. Open settings to set up sync');
		}
	}

	private async openSettings(): Promise<void> {
		if ('setting' in this.app) {
			// On Obsidian 1.13+ the settings UI lives in its own window and open()
			// resolves only once that window exists; calling openTabById in the same
			// tick races the window creation and can leave Settings open with NO tab
			// selected (empty pane). Await both — on older versions they return void
			// and the awaits are no-ops.
			const setting = this.app.setting as { open(): void | Promise<void>; openTabById(id: string): void | Promise<void> } | undefined;
			await setting?.open();
			await setting?.openTabById(this.manifest.id);
		}
	}
}
