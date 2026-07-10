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
			callback: () => this.openSettings(),
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
		const MIN_VERSION = '1.11.4';
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
			delete raw.oauthRefreshToken;
			const versionBefore = raw.settingsVersion;
			const migrated = migrateSettings(raw);
			this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated as Partial<PluginSettings>);
			if (versionBefore !== migrated.settingsVersion) {
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
			// (disconnect / revoke) clears it — there is no deleteSecret at the 1.11.4 floor.
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
				this.openSettings();
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

		const dailyConfig = getDailyNotesConfig(this.app);
		this.settings.targetFolder = dailyConfig.folder || 'PaperSync';
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

		const noteConfig = {
			templateString: this.settings.templateString,
			targetFolder: this.settings.targetFolder,
			attachmentsFolder: this.settings.attachmentsFolder,
			downloadImages: this.settings.downloadImages,
		};

		if (this.settings.backendType === 'drive' && this.oauthManager?.isAuthenticated) {
			// Same call-time supplier as OAuthManager gets in initAsync, so the token and
			// Drive legs of a sync can never resolve against two different snapshots of
			// the endpoint seam.
			const backend = new DriveBackend(this.oauthManager, this.settings.drivePollInterval, this.settings.lastSyncTimestamp, () => this.settings.endpointOverrides);
			this.syncEngine = new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState);
			this.syncEngine.start();
			logger.info('Drive sync started');
		} else if (this.settings.backendType === 'folder' && this.settings.folderPath) {
			const backend = new FolderBackend(this.settings.folderPath);
			this.syncEngine = new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState);
			this.syncEngine.start();
			logger.info('Folder sync started');
		} else {
			logger.info('No backend configured or authenticated — sync not started');
			// startSync replaced this.syncState above, so any error status set before this
			// call was lost. Set it on the LIVE instance so the UI reflects the misconfig
			// instead of silently showing "synced".
			this.syncState.setStatus('error');
		}
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
		const justSynced = snap.status === 'synced' && this.lastStatus !== 'synced';
		this.lastStatus = snap.status;

		// Surface a single Notice with the real reason when sync first enters the error
		// state, so a background failure is never silent. Gated on the transition.
		if (enteringError) {
			new Notice(snap.lastError ?? STRINGS.NOTICE_SYNC_ERROR, 10000);
		}
		// Record the wall-clock time a sync cycle last completed (distinct from the
		// sync cursor, which is the newest scan's timestamp).
		if (justSynced) {
			this.settings.lastSyncAt = Date.now();
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
			new Notice('PaperSync is not configured. Open settings to set up sync');
		}
	}

	private openSettings(): void {
		if ('setting' in this.app) {
			const setting = this.app.setting as { open(): void; openTabById(id: string): void } | undefined;
			setting?.open();
			setting?.openTabById(this.manifest.id);
		}
	}
}
