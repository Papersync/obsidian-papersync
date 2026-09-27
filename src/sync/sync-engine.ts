import { App, Notice } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import { NoteCreator } from '@/notes/note-creator';
import type { NoteCreatorConfig } from '@/notes/note-creator';
import { ErrorHandler, isSyncError, stateMessageFor } from '@/errors/error-handler';
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
	private pendingNetwork = new Set<string>();

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

		backend.setOnScanDiscovered?.((refs) => this.processBatch(refs));
		backend.setOnUnavailable?.((error) => {
			logger.error(`Sync source unavailable: ${error.message}`);
			this.state.recordError(stateMessageFor(error));
		});
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
			new Notice(STRINGS.NOTICE_OFFLINE);
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
				this.state.recordSyncCompleted(0);
				new Notice('All synced, nothing new');
			}
		} catch (err) {
			// Classify to surface the real reason (the Drive API body, a token issue,
			// etc.) instead of a generic "error", both to the user and for debugging.
			// The log always keeps the raw detail; stateMessageFor() decides what the
			// user sees.
			const syncError = this.errorHandler.classify(err);
			logger.error(`Force sync failed: ${syncError.message}`);
			this.state.recordError(stateMessageFor(syncError));
		}
	}

	private async processBatch(refs: ScanReference[]): Promise<void> {
		if (!this.state.tryStartSync()) {return;}

		try {
			// When image download is off, image-less scans still produce notes, so the
			// empty-imagePath drop only applies when we actually need the image.
			const unsyncedRefs = refs
				.filter((r) => this.noteCreator.config.downloadImages ? r.imagePath !== '' : true)
				.sort((a, b) => {
					// Order by createdTime so the persisted cursor can advance as a
					// contiguous high-water mark (see earliestFailureTime below). Refs
					// without a createdTime (folder backend) keep a stable id order and
					// never touch the cursor.
					const at = a.createdTime ?? '';
					const bt = b.createdTime ?? '';
					if (at !== bt) {return at < bt ? -1 : 1;}
					return a.id.localeCompare(b.id);
				});
			let remaining = unsyncedRefs.length;

			this.state.setStatus('syncing', remaining);
			if (remaining > 0) {
				new Notice(STRINGS.NOTICE_SYNCING(remaining));
			}

			let synced = 0;
			// The persisted cursor must never advance up to OR past the earliest FAILED
			// scan's createdTime: Drive discovery re-queries `createdTime > cursor`, and a
			// failed ref lives only in in-memory pendingNetwork (lost on reload). Advancing
			// to its timestamp would drop it forever. Collect the createdTimes of processed
			// refs and the earliest failure, then advance to a contiguous high-water mark
			// (the max success time strictly before any failure) after the loop.
			let earliestFailureTime: string | null = null;
			const processedTimes: string[] = [];

			for (let i = 0; i < unsyncedRefs.length; i += BATCH_SIZE) {
				const chunk = unsyncedRefs.slice(i, i + BATCH_SIZE);

				for (const ref of chunk) {
					const result = await this.errorHandler.handleWithRetry(ref.id, async () => {
						try {
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
							this.pendingNetwork.delete(ref.id);
							return 'synced';
						} catch (err) {
							// A scan deleted between discovery and fetch is not a failure —
							// the source of truth removed it. Skip without retries or notices.
							if (isSyncError(err) && err.type === 'scan_missing') {
								logger.info(`Scan ${ref.id} was removed from the source — skipping`);
								this.pendingNetwork.delete(ref.id);
								return 'skipped';
							}
							throw err;
						}
					});

					if (result === null) {
						// Check if the error was icloud_offloaded — add to pending network
						// The error handler already surfaced the notice; we just track it
						this.pendingNetwork.add(ref.id);
						// Refs are processed in ascending createdTime order, so the first failure
						// we see is the earliest — record it once as the cursor ceiling.
						if (ref.createdTime && earliestFailureTime === null) {
							earliestFailureTime = ref.createdTime;
						}
					}

					if ((result === 'synced' || result === 'skipped') && ref.createdTime) {
						processedTimes.push(ref.createdTime);
					}
					if (result === 'synced') {
						synced++;
					}
					remaining--;
					this.state.setStatus('syncing', remaining);
				}

				if (i + BATCH_SIZE < unsyncedRefs.length) {
					await new Promise((resolve) => window.setTimeout(resolve, 0));
				}
			}

			// Advance to the newest success that is strictly before the earliest failure.
			let highWater: string | null = null;
			for (const t of processedTimes) {
				if ((earliestFailureTime === null || t < earliestFailureTime) && (highWater === null || t > highWater)) {
					highWater = t;
				}
			}
			if (highWater !== null) {
				this.state.advanceTimestamp(highWater);
				this.backend.updateLastSyncTimestamp?.(highWater);
			}

			if (synced > 0) {
				new Notice(STRINGS.NOTICE_SYNC_COMPLETE(synced));
			}

			if (this.pendingNetwork.size > 0) {
				this.state.recordSyncCompleted(this.pendingNetwork.size);
				new Notice(`${this.pendingNetwork.size} scan(s) waiting for download`);
			} else {
				this.state.recordSyncCompleted(0);
			}
			this.errorHandler.resetRetries();
		} finally {
			// Release the lock no matter what so a future throw can't deadlock all syncs.
			this.state.setSyncing(false);
		}
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
