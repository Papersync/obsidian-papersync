import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, PaperSyncedSettingTab } from '@/settings';
import type { PluginSettings } from '@/settings';
import { setDebugLogging, logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';
import { OAuthManager } from '@/auth/oauth-manager';
import { DriveBackend } from '@/sync/drive-backend';
import { ICloudBackend } from '@/sync/icloud-backend';
import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import type { SyncStateSnapshot } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';

import { GOOGLE_CLIENT_ID, DEV_MODE } from '@/config';
import { getDailyNotesConfig } from '@/utils/daily-notes';
import { createFakeScanOnDrive } from '@/utils/dev-tools';

export default class PaperSyncedPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	oauthManager: OAuthManager | null = null;
	syncEngine: SyncEngine | null = null;
	syncState: SyncState = new SyncState('');
	errorHandler: ErrorHandler = new ErrorHandler();
	private statusBarEl: HTMLElement | null = null;
	private settingsTab: PaperSyncedSettingTab | null = null;
	private unsubscribeSyncState: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		setDebugLogging(this.settings.debugLogging);

		this.settingsTab = new PaperSyncedSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		this.statusBarEl = this.addStatusBarItem();

		this.addRibbonIcon('refresh-cw', STRINGS.PLUGIN_NAME, () => {
			void this.forceSyncNow();
		});

		this.addCommand({
			id: 'papersynced-sync-now',
			name: STRINGS.CMD_SYNC_NOW,
			callback: () => void this.forceSyncNow(),
		});

		this.addCommand({
			id: 'papersynced-open-settings',
			name: STRINGS.CMD_OPEN_SETTINGS,
			callback: () => this.openSettings(),
		});

		if (DEV_MODE) {
			this.addCommand({
				id: 'papersynced-dev-fake-scan',
				name: 'DEV: Add fake scan to Drive',
				callback: () => {
					if (!this.oauthManager?.isAuthenticated) {
						new Notice('Connect Google Drive first');
						return;
					}
					void createFakeScanOnDrive(this.oauthManager).then(() => {
						new Notice('Fake scan uploaded — will sync on next poll');
					}).catch((err: unknown) => {
						new Notice(`Failed: ${err instanceof Error ? err.message : String(err)}`);
					});
				},
			});
		}

		void this.initAsync();
		logger.info('Plugin loaded');
	}

	onunload(): void {
		this.syncEngine?.stop();
		this.unsubscribeSyncState?.();
		this.oauthManager?.cleanup();
		logger.info('Plugin unloaded');
	}

	async loadSettings(): Promise<void> {
		const loaded = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded as Partial<PluginSettings>);
	}

	async saveSettings(): Promise<void> {
		setDebugLogging(this.settings.debugLogging);
		await this.saveData(this.settings);
	}

	private async initAsync(): Promise<void> {
		this.oauthManager = new OAuthManager(this, GOOGLE_CLIENT_ID);
		this.oauthManager.setOnTokenChange((token) => {
			this.settings.oauthRefreshToken = token;
			void this.saveSettings();
		});

		if (this.settings.backendType === 'drive' && this.settings.oauthRefreshToken) {
			this.oauthManager.restoreFromToken(this.settings.oauthRefreshToken);
		}

		if (!this.settings.setupComplete) {
			logger.info('First run detected — opening settings');
			this.syncState.setStatus('error');
			setTimeout(() => this.openSettings(), 500);
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
		this.settings.targetFolder = dailyConfig.folder || 'PaperSynced';
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
			const backend = new DriveBackend(this.oauthManager, this.settings.drivePollInterval, this.settings.lastSyncTimestamp);
			this.syncEngine = new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState);
			this.syncEngine.start();
			logger.info('Drive sync started');
		} else if (this.settings.backendType === 'icloud' && this.settings.icloudFolderPath) {
			const backend = new ICloudBackend(this.settings.icloudFolderPath);
			this.syncEngine = new SyncEngine(backend, this.app, noteConfig, this.errorHandler, this.syncState);
			this.syncEngine.start();
			logger.info('iCloud sync started');
		} else {
			logger.info('No backend configured or authenticated — sync not started');
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

		// Update settings tab
		this.settingsTab?.updateSyncState();

		// Persist sync cursor
		if (snap.lastSyncTimestamp !== this.settings.lastSyncTimestamp) {
			this.settings.lastSyncTimestamp = snap.lastSyncTimestamp;
			void this.saveSettings();
		}
	}

	private async forceSyncNow(): Promise<void> {
		if (this.syncEngine) {
			await this.syncEngine.forceSyncNow();
		} else {
			new Notice('PaperSynced is not configured — open settings to set up sync');
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
