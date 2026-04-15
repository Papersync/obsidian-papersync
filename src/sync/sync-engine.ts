import { App, Notice } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import { NoteCreator } from '@/notes/note-creator';
import type { NoteCreatorConfig } from '@/notes/note-creator';
import { ErrorHandler } from '@/errors/error-handler';
import { SyncState } from '@/sync/sync-state';
import { isOnline } from '@/utils/platform';
import { logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';

const BATCH_SIZE = 10;

export class SyncEngine {
	private backend: SyncBackend;
	private noteCreator: NoteCreator;
	private errorHandler: ErrorHandler;
	readonly state: SyncState;

	constructor(
		backend: SyncBackend,
		app: App,
		noteConfig: NoteCreatorConfig,
		errorHandler: ErrorHandler,
		state: SyncState
	) {
		this.backend = backend;
		this.noteCreator = new NoteCreator(app, app.vault, noteConfig);
		this.errorHandler = errorHandler;
		this.state = state;

		if ('setOnScanDiscovered' in backend) {
			(backend as { setOnScanDiscovered: (cb: (refs: ScanReference[]) => void) => void })
				.setOnScanDiscovered((refs) => this.processBatch(refs));
		}
	}

	start(): void {
		window.addEventListener('online', this.handleOnline);
		window.addEventListener('offline', this.handleOffline);

		if (!isOnline()) {
			logger.info('Starting offline — will sync when connected');
			this.state.setStatus('offline');
			return;
		}

		this.backend.start();
	}

	stop(): void {
		window.removeEventListener('online', this.handleOnline);
		window.removeEventListener('offline', this.handleOffline);
		this.backend.stop();
	}

	async forceSyncNow(): Promise<void> {
		if (!isOnline()) {
			new Notice(STRINGS.STATUS_OFFLINE);
			return;
		}

		if (this.state.isSyncing) {
			logger.info('Sync already in progress');
			return;
		}

		try {
			const refs = await this.backend.discoverUnsynced();
			if (refs.length > 0) {
				await this.processBatch(refs);
			} else {
				this.state.setStatus('synced', 0);
			}
		} catch (err) {
			logger.error(`Force sync failed: ${err instanceof Error ? err.message : String(err)}`);
			this.state.setStatus('error');
		}
	}

	private async processBatch(refs: ScanReference[]): Promise<void> {
		if (!this.state.tryStartSync()) {return;}

		const unsyncedRefs = refs
			.filter((r) => r.imagePath !== '')
			.sort((a, b) => a.id.localeCompare(b.id));
		let remaining = unsyncedRefs.length;

		this.state.setStatus('syncing', remaining);
		if (remaining > 0) {
			new Notice(STRINGS.NOTICE_SYNCING(remaining));
		}

		let synced = 0;

		for (let i = 0; i < unsyncedRefs.length; i += BATCH_SIZE) {
			const chunk = unsyncedRefs.slice(i, i + BATCH_SIZE);

			for (const ref of chunk) {
				const result = await this.errorHandler.handleWithRetry(ref.id, async () => {
					const scanFile = await this.backend.fetchScan(ref);

					if (scanFile.synced) {
						logger.info(`Scan ${ref.id} already synced, skipping`);
						return 'skipped';
					}

					const imageData = this.noteCreator.config.downloadImages
						? await this.backend.fetchImage(ref)
						: null;
					await this.noteCreator.createOrAppend(scanFile, imageData, ref.id);
					await this.backend.markSynced(ref, scanFile);
					return 'synced';
				});

				if ((result === 'synced' || result === 'skipped') && ref.createdTime) {
					this.state.advanceTimestamp(ref.createdTime);
					if ('updateLastSyncTimestamp' in this.backend) {
						(this.backend as { updateLastSyncTimestamp(ts: string): void }).updateLastSyncTimestamp(ref.createdTime);
					}
				}
				if (result === 'synced') {
					synced++;
				}
				remaining--;
				this.state.setStatus('syncing', remaining);
			}

			if (i + BATCH_SIZE < unsyncedRefs.length) {
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		}

		this.state.setSyncing(false);

		if (synced > 0) {
			new Notice(STRINGS.NOTICE_SYNC_COMPLETE(synced));
		}
		this.state.setStatus('synced', 0);
		this.errorHandler.resetRetries();
	}

	private handleOnline = (): void => {
		logger.info('Network restored — resuming sync');
		this.state.setStatus('idle');
		this.backend.stop();
		this.backend.start();
		// forceSyncNow not needed — backend.start() triggers the first poll
	};

	private handleOffline = (): void => {
		logger.info('Network lost — pausing sync');
		this.state.setStatus('offline');
		this.backend.stop();
	};
}
