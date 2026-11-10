import { App, Notice } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import { NoteCreator } from '@/notes/note-creator';
import type { NoteCreatorConfig } from '@/notes/note-creator';
import type { SyncError, SyncErrorType } from '@/errors/sync-error';
import type { ScanFile } from '@/validation/scan-file-schema';
import { ErrorHandler, isSyncError, stateMessageFor } from '@/errors/error-handler';
import { SyncState } from '@/sync/sync-state';
import { isOnline } from '@/utils/platform';
import { logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';

import { CompanionGrace, COMPANION_GRACE_MS } from '@/sync/companion-grace';
import type { GraceOverrideSupplier } from '@/sync/companion-grace';

const BATCH_SIZE = 10;
// When a scan failed with a retriable error (most often "not downloaded yet" on
// an on-demand sync folder) and nothing else will rediscover it, the engine runs
// a quiet sync again on this schedule, staying at the last step until it clears.
export const RETRY_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
// Failures that come from the scan file itself: reading it again reads the same
// bytes, so only a changed file is worth another try.
const PERMANENT_SCAN_ERRORS = new Set<SyncErrorType>(['schema_mismatch', 'scan_too_large', 'obsidian_version']);
// Failures that clear once the file or the network comes through: they count as
// "waiting for download".
const NETWORK_WAIT_ERRORS = new Set<SyncErrorType>(['icloud_offloaded', 'network_timeout']);
// A background Drive poll that fails with a network or server error this many
// times in a row shows the error; a lost sign-in or permission shows at once.
export const POLL_FAILURES_SHOWN = 3;

export class SyncEngine {
	private backend: SyncBackend;
	private noteCreator: NoteCreator;
	private errorHandler: ErrorHandler;
	readonly state: SyncState;
	// Scans whose last failure was a download or network wait, shown as
	// "waiting for download (N)". Pruned against every listing.
	private pendingNetwork = new Set<string>();
	// Scans that failed for a reason inside the file (bad JSON, unsupported
	// version, too large), by id, with the revision that failed. Their Notice shows
	// once; the same revision is not fetched again and does not hold the Drive
	// cursor back, so newer scans keep importing. In memory only: after a reload a
	// bad file the cursor already passed is not listed again, so it is never retried
	// and its Notice does not come back. The user saw it once, and the scan can
	// only import once the phone writes it again as a new file. A bad file still at
	// or above the cursor is tried (and announced) once more per session.
	private permanentFailures = new Map<string, string>();
	// Background Drive polls that failed in a row.
	private pollFailures = 0;
	// Scans this session imported or found already synced. Drive re-lists them on
	// every poll while an older scan holds the cursor back (companion grace), so
	// they must not count toward the "syncing N" notice. In memory only: it never
	// skips a fetch, the JSON's synced flag still decides what imports.
	private syncedThisSession = new Set<string>();
	// A background retry: it must not announce "nothing new" or "offline"
	// the user never asked about.
	private companionGrace: CompanionGrace;
	// Set when the backend reports its source gone, cleared by the next pass that
	// can only run with the source present (a discovery that succeeded). A batch
	// already in flight when the source went away must not finish by recording
	// 'synced' over that error.
	private sourceUnavailable = false;
	// A discovery (or Sync now) that arrived while a batch held the sync lock. It
	// may carry scans the running batch never saw, so one more pass runs after it.
	private rerunRequested = false;
	// Scans whose last failure was retriable and still waiting for a retry.
	private retryLater = new Set<string>();
	private retryTimer: number | null = null;
	private retryStep = 0;
	// False between stop() and the next start(): nothing may import meanwhile.
	private active = true;

	constructor(
		backend: SyncBackend,
		app: App,
		noteConfig: NoteCreatorConfig,
		errorHandler: ErrorHandler,
		state: SyncState,
		// Test-only (settings.companionGraceOverrideMs, E2E-injected, never persisted
		// across a load): a shorter companion grace so specs need not wait it out.
		graceOverride?: GraceOverrideSupplier
	) {
		this.companionGrace = new CompanionGrace(() => this.forceSyncNow({ quiet: true }), graceOverride);
		this.backend = backend;
		this.noteCreator = new NoteCreator(app, app.vault, noteConfig);
		this.errorHandler = errorHandler;
		this.state = state;

		backend.setOnScanDiscovered?.((refs) => {
			this.sourceUnavailable = false;
			this.pollFailures = 0;
			return this.processBatch(refs);
		});
		backend.setOnPollResult?.({
			failed: (err) => this.handlePollFailure(err),
			succeeded: () => this.handleEmptyPoll(),
		});
		backend.setOnUnavailable?.((error) => {
			this.sourceUnavailable = true;
			logger.error(`Sync source unavailable: ${error.message}`);
			this.state.recordError(stateMessageFor(error));
		});
	}

	start(): void {
		this.active = true;
		this.companionGrace.resume();
		if (!this.backend.needsNetwork) {
			this.backend.start();
			return;
		}
		window.addEventListener('online', this.handleOnline);
		window.addEventListener('offline', this.handleOffline);

		if (!isOnline()) {
			this.companionGrace.pause();
			logger.info('Starting offline — will sync when connected');
			this.state.setStatus('offline');
			return;
		}

		this.backend.start();
	}

	stop(): void {
		this.active = false;
		this.rerunRequested = false;
		this.clearRetryTimer();
		this.companionGrace.pause();
		window.removeEventListener('online', this.handleOnline);
		window.removeEventListener('offline', this.handleOffline);
		this.backend.stop();
	}

	async forceSyncNow({ quiet = false }: { quiet?: boolean } = {}): Promise<void> {
		if (!this.active) {
			logger.info('Sync engine stopped; not syncing');
			return;
		}
		if (this.backend.needsNetwork && !isOnline()) {
			if (!quiet) {
				new Notice(STRINGS.NOTICE_OFFLINE);
			}
			return;
		}

		if (this.state.isSyncing) {
			logger.info('Sync already in progress; one more pass runs after it');
			this.rerunRequested = true;
			return;
		}

		try {
			const refs = await this.backend.discoverUnsynced();
			this.companionGrace.retain(refs.map((ref) => ref.id));
			this.sourceUnavailable = false;
			this.pollFailures = 0;
			if (refs.length > 0) {
				await this.processBatch(refs, !quiet);
			} else {
				this.retryLater.clear();
				this.pendingNetwork.clear();
				this.permanentFailures.clear();
				this.state.recordSyncCompleted(0);
				if (!quiet) {
					new Notice(STRINGS.NOTICE_NOTHING_NEW);
				}
			}
		} catch (err) {
			// Stop companion polling on a real discovery/access failure; the backend
			// retains its normal reconnect/poll recovery.
			this.companionGrace.retain([]);
			// Classify to surface the real reason (the Drive API body, a token issue,
			// etc.) instead of a generic "error", both to the user and for debugging.
			// The log always keeps the raw detail; stateMessageFor() decides what the
			// user sees.
			const syncError = this.errorHandler.classify(err);
			logger.error(`Force sync failed: ${syncError.message}`);
			this.state.recordError(stateMessageFor(syncError));
		}
	}

	private async processBatch(refs: ScanReference[], manual = false): Promise<void> {
		// A discovery that finished after stop() (Change Storage, unload) must not
		// import from the source that was just abandoned.
		if (!this.active) {return;}
		if (!this.state.tryStartSync()) {
			this.rerunRequested = true;
			return;
		}

		try {
			// A full discovery lists every unsynced scan, so a retry entry it no longer
			// lists was synced or removed in the meantime.
			const listed = new Set(refs.map((ref) => ref.id));
			for (const id of this.retryLater) {
				if (!listed.has(id)) {this.retryLater.delete(id);}
			}
			for (const id of this.pendingNetwork) {
				if (!listed.has(id)) {this.pendingNetwork.delete(id);}
			}
			for (const id of this.permanentFailures.keys()) {
				if (!listed.has(id)) {this.permanentFailures.delete(id);}
			}
			// Read once per batch so a settings edit cannot change attachment
			// handling halfway through a scan.
			const downloadImages = this.noteCreator.config.downloadImages;
			// Missing companions stay eligible for text-only recovery after grace.
			const unsyncedRefs = refs.slice().sort((a, b) => {
				// Order by createdTime so the persisted cursor can advance as a
				// contiguous high-water mark (see earliestFailureTime below). Refs
				// without a createdTime (folder backend) keep a stable id order and
				// never touch the cursor.
				const at = a.createdTime ?? '';
				const bt = b.createdTime ?? '';
				if (at !== bt) {
					return at < bt ? -1 : 1;
				}
				return a.id.localeCompare(b.id);
			});
			let remaining = unsyncedRefs.length;
			// Announce only scans that will do work: not a re-check of a scan already
			// waiting for its photo, nor a re-list of one this session already synced.
			const workCount = unsyncedRefs.filter(
				(ref) => !this.companionGrace.has(ref.id) && !this.syncedThisSession.has(ref.id) && !this.failedForGood(ref)
			).length;

			this.state.setStatus('syncing', remaining);
			if (workCount > 0) {
				new Notice(STRINGS.NOTICE_SYNCING(workCount));
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

			batches: for (let i = 0; i < unsyncedRefs.length; i += BATCH_SIZE) {
				const chunk = unsyncedRefs.slice(i, i + BATCH_SIZE);

				for (const ref of chunk) {
					if (!this.active) {
						logger.info('Sync engine stopped mid-batch; leaving the rest for later');
						break batches;
					}
					if (this.failedForGood(ref)) {
						// Already announced; it no longer holds the cursor back.
						if (ref.createdTime) {processedTimes.push(ref.createdTime);}
						remaining--;
						continue;
					}
					// Set once the note holds this scan. A retry after that point (the
					// "synced" write-back failed) retries only the write-back: appending
					// again would duplicate the scan in the note.
					let written: ScanFile | null = null;
					let failure: SyncError | null = null;
					const result = await this.errorHandler.handleWithRetry(ref.id, async () => {
						try {
							if (written) {
								await this.backend.markSynced(ref, written);
								this.pendingNetwork.delete(ref.id);
								return 'synced';
							}
							const scanFile = await this.backend.fetchScan(ref);

							if (scanFile.synced) {
								this.pendingNetwork.delete(ref.id);
								this.companionGrace.complete(ref.id);
								logger.info(`Scan ${ref.id} already synced, skipping`);
								return 'skipped';
							}

							const imageData = downloadImages ? await this.backend.fetchImage(ref) : null;
							if (
								downloadImages &&
								imageData === null &&
								this.companionGrace.defer(ref.id, {
									windowMs: this.backend.companionGraceMs ?? COMPANION_GRACE_MS,
									uploadedAt: ref.createdTime,
								})
							) {
								this.pendingNetwork.delete(ref.id);
								return 'waiting-image';
							}
							await this.noteCreator.createOrAppend(scanFile, imageData, ref.id);
							written = scanFile;
							await this.backend.markSynced(ref, scanFile);
							this.pendingNetwork.delete(ref.id);
							this.companionGrace.complete(ref.id);
							return 'synced';
						} catch (err) {
							// Real access/write failures use normal recovery, not a one-second
							// expired-companion poll loop.
							this.companionGrace.complete(ref.id);
							// A scan deleted between discovery and fetch is not a failure —
							// the source of truth removed it. Skip without retries or notices.
							if (isSyncError(err) && err.type === 'scan_missing') {
								logger.info(`Scan ${ref.id} was removed from the source — skipping`);
								this.pendingNetwork.delete(ref.id);
								return 'skipped';
							}
							throw err;
						}
					}, (error) => {
						failure = error;
						if (error.retriable) {
							this.retryLater.add(ref.id);
						}
					});

					// The error handler already surfaced the failure's notice.
					const gaveUp = failure as SyncError | null;
					if (result === null && gaveUp && !gaveUp.retriable && PERMANENT_SCAN_ERRORS.has(gaveUp.type)) {
						this.permanentFailures.set(ref.id, ref.revision ?? '');
						this.pendingNetwork.delete(ref.id);
						if (ref.createdTime) {processedTimes.push(ref.createdTime);}
					} else if (result === null || result === 'waiting-image') {
						if (result === null && gaveUp && NETWORK_WAIT_ERRORS.has(gaveUp.type)) {
							this.pendingNetwork.add(ref.id);
						} else {
							this.pendingNetwork.delete(ref.id);
						}
						// Refs are processed in ascending createdTime order, so the first failure
						// we see is the earliest — record it once as the cursor ceiling.
						if (ref.createdTime && earliestFailureTime === null) {
							earliestFailureTime = ref.createdTime;
						}
					}

					if (result !== null) {
						this.retryLater.delete(ref.id);
					}
					if (result === 'synced' || result === 'skipped') {
						this.syncedThisSession.add(ref.id);
						if (ref.createdTime) {
							processedTimes.push(ref.createdTime);
						}
					}
					if (result === 'synced') {
						synced++;
					}
					// The source went away while this item was in flight: the rest cannot
					// be fetched, and a progress update would overwrite the error the
					// backend just reported. What finished still counts (cursor below).
					if (this.sourceUnavailable) {
						break batches;
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

			if (this.sourceUnavailable) {
				logger.info('Batch finished after the sync source went away; keeping its error');
			} else if (this.pendingNetwork.size > 0) {
				this.state.recordSyncCompleted(this.pendingNetwork.size + this.companionGrace.pendingCount);
				new Notice(STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(this.pendingNetwork.size));
			} else {
				this.state.recordSyncCompleted(this.companionGrace.pendingCount);
				// A manual Sync now that imported nothing still answers the user (this
				// branch means nothing failed): scans waiting for their photo, or nothing new.
				if (manual && synced === 0) {
					new Notice(
						this.companionGrace.pendingCount > 0
							? STRINGS.NOTICE_WAITING_FOR_DOWNLOAD(this.companionGrace.pendingCount)
							: STRINGS.NOTICE_NOTHING_NEW
					);
				}
			}
			this.errorHandler.resetRetries();
		} finally {
			// Release the lock no matter what so a future throw can't deadlock all syncs.
			this.state.setSyncing(false);
			this.afterBatch();
		}
	}

	private failedForGood(ref: ScanReference): boolean {
		return this.permanentFailures.get(ref.id) === (ref.revision ?? '');
	}

	// A background poll failed (the backend reports only while running, so never
	// after stop()). A lost sign-in, a refused permission or another
	// error that will not clear by itself shows at once; a network or server error
	// shows once it has failed POLL_FAILURES_SHOWN times in a row.
	private handlePollFailure(err: unknown): void {
		const error = this.errorHandler.classify(err);
		this.pollFailures++;
		if (!error.retriable || this.pollFailures >= POLL_FAILURES_SHOWN) {
			this.state.recordError(stateMessageFor(error));
		}
	}

	// A background poll listed nothing to sync: the listing is complete, so nothing
	// is waiting any more, and an error from earlier polls is over.
	private handleEmptyPoll(): void {
		this.pollFailures = 0;
		this.retryLater.clear();
		this.permanentFailures.clear();
		if (this.state.status === 'error' || this.pendingNetwork.size > 0) {
			this.pendingNetwork.clear();
			this.state.recordSyncCompleted(this.companionGrace.pendingCount);
		}
	}

	private afterBatch(): void {
		if (!this.active) {return;}
		if (this.rerunRequested) {
			this.rerunRequested = false;
			logger.info('Running the discovery that arrived during the last batch');
			void this.forceSyncNow({ quiet: true });
			return;
		}
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.retryLater.size === 0 || this.backend.polls) {
			this.clearRetryTimer();
			this.retryStep = 0;
			return;
		}
		if (this.retryTimer !== null) {return;}
		const delay = RETRY_SCHEDULE_MS[Math.min(this.retryStep, RETRY_SCHEDULE_MS.length - 1)]!;
		this.retryStep++;
		logger.info(`Retrying ${this.retryLater.size} failed scan(s) in ${delay / 1000}s`);
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.forceSyncNow({ quiet: true });
		}, delay);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private handleOnline = (): void => {
		this.companionGrace.resume();
		logger.info('Network restored — resuming sync');
		this.state.setStatus('idle');
		this.backend.stop();
		this.backend.start();
		// forceSyncNow not needed — backend.start() triggers the first poll
	};

	private handleOffline = (): void => {
		this.companionGrace.pause();
		logger.info('Network lost — pausing sync');
		this.state.setStatus('offline');
		this.backend.stop();
	};
}
