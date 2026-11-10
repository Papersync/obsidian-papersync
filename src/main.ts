import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, PaperSyncSettingTab, migrateSettings } from '@/settings';
import { sanitizeSettings } from '@/settings-validation';
import type { PluginSettings } from '@/settings';
import { setDebugLogging, logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';
import { STRINGS } from '@/utils/strings';
import { OAuthManager, isAuthSuperseded } from '@/auth/oauth-manager';
import { readSecret, writeSecret } from '@/auth/secret-store';
import { DriveBackend } from '@/sync/drive-backend';
import { FolderBackend } from '@/sync/folder-backend';
import { SyncEngine } from '@/sync/sync-engine';
import type { NoteCreatorConfig } from '@/notes/note-creator';
import { SyncState } from '@/sync/sync-state';
import type { SyncStateSnapshot } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';

import { GOOGLE_CLIENT_ID, OAUTH_TOKEN_SECRET_ID } from '@/config';
import { getDailyNotesConfig } from '@/utils/daily-notes';
import { readPeriodicDailySettings } from '@/utils/periodic-notes';
import { firstSetupDestination } from '@/notes/scan-destination';
import { createFakeScanOnDrive } from '@/utils/dev-tools';

// Set by esbuild `define` (esbuild.config.mjs): true only for `npm run dev`.
declare const __DEV_MODE__: boolean;

// A read-through view of the committed settings, so the engine always sees the
// latest commit without being handed a new object.
function committedView(read: () => PluginSettings): NoteCreatorConfig {
	return {
		get templateString() { return read().templateString; },
		get saveTo() { return read().saveTo; },
		get customFolder() { return read().customFolder; },
		get customFileName() { return read().customFileName; },
		get attachmentsFolder() { return read().attachmentsFolder; },
		get downloadImages() { return read().downloadImages; },
	};
}

export default class PaperSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	oauthManager: OAuthManager | null = null;
	syncEngine: SyncEngine | null = null;
	// What the sync engine reads. Settings edits land in `settings` on every
	// keystroke; the engine sees them only once committed (see commitSettings).
	private committed: PluginSettings = { ...DEFAULT_SETTINGS };
	readonly engineConfig: NoteCreatorConfig = committedView(() => this.committed);
	private driveBackend: DriveBackend | null = null;
	syncState: SyncState = new SyncState('');
	errorHandler: ErrorHandler = new ErrorHandler();
	private statusBarEl: HTMLElement | null = null;
	private settingsTab: PaperSyncSettingTab | null = null;
	private unsubscribeSyncState: (() => void) | null = null;
	private lastStatus: SyncStateSnapshot['status'] | null = null;
	private firstRunTimeout: number | null = null;
	// Set by onunload: a startSync still awaiting must not start an engine (with
	// its watcher, timers and window listeners) for a plugin that is gone.
	private unloaded = false;

	async onload(): Promise<void> {
		if (!this.checkMinObsidianVersion()) {return;}

		await this.loadSettings();
		// Console logging is a development-phase aid, gated to dev builds (no user toggle).
		setDebugLogging(__DEV_MODE__);

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

		// Build-time constant (esbuild `define`): false in production, so the
		// minifier drops this block and, with it, src/utils/dev-tools.ts.
		if (__DEV_MODE__) {
			this.addCommand({
				id: 'dev-fake-scan',
				name: 'Add fake scan to Google Drive (development)',
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
		this.unloaded = true;
		if (this.firstRunTimeout !== null) {
			window.clearTimeout(this.firstRunTimeout);
			this.firstRunTimeout = null;
		}
		this.stopSync();
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
		const loaded: unknown = await this.loadData();
		if (loaded && typeof loaded === 'object') {
			const raw = loaded as Record<string, unknown>;
			// The endpointOverrides seam is runtime-injected by E2E only — never honor a
			// persisted copy across a plugin load. Stripping it here (in memory; no
			// re-persist needed) makes a stale or tampered data.json self-heal instead of
			// steering OAuth/Drive traffic at whatever host the file names.
			delete raw.endpointOverrides;
			// Same for the E2E-only companion grace override.
			delete raw.companionGraceOverrideMs;
			// The refresh token lives in Obsidian's secret storage, never data.json. The plugin is
			// unpublished, so there is no token worth migrating — just discard any stray
			// plaintext copy a pre-secret-storage dogfood build may have left behind (those
			// devices reconnect once). The migrateSettings v3 step also strips it, but this
			// explicit delete covers an already-v3 data.json that still carries the field.
			// Remember whether a stray copy was present so we can scrub the plaintext from
			// DISK below, not only from the in-memory settings.
			const hadStrayToken = 'oauthRefreshToken' in raw;
			delete raw.oauthRefreshToken;
			const versionBefore = raw.settingsVersion;
			// The v5 step maps the old Notes folder against core Daily notes.
			const migrated = migrateSettings(raw, getDailyNotesConfig(this.app));
			this.settings = sanitizeSettings(migrated);
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
		this.commitSettings();
	}

	// Hand the current settings to the sync engine. Called for finished edits only
	// (a field left or Enter pressed, a toggle, Settings closing, sync starting),
	// never per keystroke: a sync that lands mid-typing would otherwise file a
	// note with a half-typed template or into a half-typed folder, then mark the
	// scan synced for good.
	commitSettings(): void {
		this.committed = { ...this.settings };
		this.driveBackend?.reschedule();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async initAsync(): Promise<void> {
		// The endpoints supplier is resolved at call time: OAuthManager is built at
		// plugin load, before the E2E seam (settings.endpointOverrides) can be written.
		this.oauthManager = new OAuthManager(this, GOOGLE_CLIENT_ID, () => this.settings.endpointOverrides);
		this.oauthManager.setOnTokenChange((token) => {
			// The refresh token lives in Obsidian's secret storage, never data.json. An empty
			// string (disconnect / revoke) clears it — the public SecretStorage API has no
			// deleteSecret.
			const ok = writeSecret(this.app, OAUTH_TOKEN_SECRET_ID, token);
			// A non-empty token that secret storage rejected means Drive works this session
			// but won't survive a restart. Tell the user to reconnect — never fall back to
			// data.json. A failed CLEAR (empty token) is log-only: the in-memory copy is
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

	// First setup (and Reset settings): choose where scans go, once. Periodic
	// Notes' daily folder and format when it is on (copied once, never followed);
	// else the daily note when core Daily notes is on; else the Papersync defaults.
	async resolveScanDestination(): Promise<void> {
		if (this.settings.saveTo) {return;}

		const dest = firstSetupDestination(getDailyNotesConfig(this.app), readPeriodicDailySettings(this.app));
		Object.assign(this.settings, dest);
		await this.saveSettings();
		logger.info(`Scan destination resolved to ${dest.saveTo} ("${dest.customFolder}" / "${dest.customFileName}")`);
	}

	// Stops the engine and forgets it, so Sync now (ribbon, command) cannot run a
	// stopped engine against a source that was just disconnected.
	stopSync(): void {
		this.syncEngine?.stop();
		this.syncEngine = null;
		this.driveBackend = null;
	}

	// Signs in to Google and switches sync to Drive. Settings change only once the
	// sign-in succeeded, so a cancelled or failed one (rethrown for the caller to
	// show) leaves the previous storage exactly as it was, still syncing. Resolves
	// 'superseded' when Connect was pressed again: the newer sign-in owns the
	// outcome.
	async connectGoogle(): Promise<'connected' | 'superseded'> {
		try {
			await this.oauthManager?.startAuthFlow();
		} catch (err) {
			if (isAuthSuperseded(err)) {return 'superseded';}
			throw err;
		}
		this.detachSync();
		this.settings.backendType = 'drive';
		this.settings.setupComplete = true;
		// The cursor belongs to whatever was synced before (another account, or one
		// signed out long ago): start over. Already imported scans are marked synced
		// on Drive and in their notes, so nothing imports twice.
		this.settings.lastSyncTimestamp = '';
		await this.saveSettings();
		await this.startSync();
		return 'connected';
	}

	async disconnectGoogle(): Promise<void> {
		this.detachSync();
		await this.oauthManager?.disconnect();
		this.settings.backendType = 'none';
		this.settings.setupComplete = false;
		// The next account starts from its oldest scan (see connectGoogle).
		this.settings.lastSyncTimestamp = '';
		await this.saveSettings();
	}

	// Stops sync and stops listening to its state, so a batch the old engine was
	// still finishing cannot write its cursor back into the settings.
	private detachSync(): void {
		this.stopSync();
		this.unsubscribeSyncState?.();
		this.unsubscribeSyncState = null;
	}

	async startSync(): Promise<void> {
		this.stopSync();
		this.unsubscribeSyncState?.();

		await this.resolveScanDestination();
		if (this.unloaded) {
			logger.info('Plugin unloaded while sync was starting; not starting it');
			return;
		}

		logger.info(`startSync — backendType: ${this.settings.backendType}, setupComplete: ${String(this.settings.setupComplete)}, oauthAuthenticated: ${String(this.oauthManager?.isAuthenticated)}`);

		// Create shared sync state
		this.syncState = new SyncState(this.settings.lastSyncTimestamp);

		// Subscribe to state changes — single listener drives status bar + settings tab + persistence
		this.unsubscribeSyncState = this.syncState.subscribe((snap) => {
			this.onSyncStateChanged(snap);
		});

		// The engine reads committed settings through engineConfig on every scan, so
		// a finished edit in Settings applies to the next scan without restarting
		// sync (a copy taken here used to hold the old values until restart).
		this.driveBackend = null;
		this.commitSettings();

		if (this.settings.backendType === 'drive' && this.oauthManager?.isAuthenticated) {
			// Same call-time supplier as OAuthManager gets in initAsync, so the token and
			// Drive legs of a sync can never resolve against two different snapshots of
			// the endpoint seam.
			const backend = new DriveBackend(this.oauthManager, () => this.committed.drivePollInterval, this.settings.lastSyncTimestamp, () => this.settings.endpointOverrides);
			this.driveBackend = backend;
			this.startEngine(new SyncEngine(backend, this.app, this.engineConfig, this.errorHandler, this.syncState, this.graceOverride));
			logger.info('Drive sync started');
		} else if (this.settings.backendType === 'folder' && this.settings.folderPath) {
			const backend = new FolderBackend(this.settings.folderPath);
			this.startEngine(new SyncEngine(backend, this.app, this.engineConfig, this.errorHandler, this.syncState, this.graceOverride));
			logger.info('Folder sync started');
		} else {
			logger.info('No backend configured or authenticated — sync not started');
			// startSync replaced this.syncState above, so any error status set before this
			// call was lost. Set it on the LIVE instance so the UI reflects the misconfig
			// instead of silently showing "synced".
			this.syncState.setStatus('error');
		}
	}

	// Call-time read so a late E2E write still applies to a running engine.
	private readonly graceOverride = (): unknown => this.settings.companionGraceOverrideMs;

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
