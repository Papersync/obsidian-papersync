import { logger } from '@/utils/logger';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface SyncStateSnapshot {
	status: SyncStatus;
	pendingCount: number;
	lastSyncTimestamp: string;
	isSyncing: boolean;
	lastError: string | null;
	lastSyncCompletedAt: number;
}

type SyncStateListener = (snapshot: SyncStateSnapshot) => void;

export class SyncState {
	private _status: SyncStatus = 'idle';
	private _pendingCount = 0;
	private _lastSyncTimestamp: string;
	private _isSyncing = false;
	private _lastError: string | null = null;
	private _lastSyncCompletedAt = 0;
	private listeners: SyncStateListener[] = [];

	constructor(lastSyncTimestamp: string) {
		this._lastSyncTimestamp = lastSyncTimestamp;
	}

	get status(): SyncStatus { return this._status; }
	get pendingCount(): number { return this._pendingCount; }
	get lastSyncTimestamp(): string { return this._lastSyncTimestamp; }
	get isSyncing(): boolean { return this._isSyncing; }

	get lastError(): string | null { return this._lastError; }
	get lastSyncCompletedAt(): number { return this._lastSyncCompletedAt; }

	get snapshot(): SyncStateSnapshot {
		return {
			status: this._status,
			pendingCount: this._pendingCount,
			lastSyncTimestamp: this._lastSyncTimestamp,
			isSyncing: this._isSyncing,
			lastError: this._lastError,
			lastSyncCompletedAt: this._lastSyncCompletedAt,
		};
	}

	subscribe(listener: SyncStateListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	private notify(): void {
		const snap = this.snapshot;
		for (const listener of this.listeners) {
			listener(snap);
		}
	}

	setStatus(status: SyncStatus, pendingCount?: number): void {
		const changed = status !== this._status || (pendingCount !== undefined && pendingCount !== this._pendingCount);
		this._status = status;
		if (pendingCount !== undefined) {this._pendingCount = pendingCount;}
		// A recovery clears any stale error detail so the UI stops showing it.
		if (status !== 'error') {this._lastError = null;}
		if (changed) {
			logger.info(`Sync state: ${status}${pendingCount !== undefined ? ` (${pendingCount} pending)` : ''}`);
			this.notify();
		}
	}

	// Marks the end of a completed sync cycle with wall-clock time, always
	// notifying — setStatus alone skips notify when nothing changed, so a
	// force-sync that found nothing new (already 'synced', 0 pending) would
	// never reach listeners and the UI's "Last sync" time would stay frozen.
	recordSyncCompleted(pendingCount: number): void {
		this._status = 'synced';
		this._pendingCount = pendingCount;
		this._lastError = null;
		this._lastSyncCompletedAt = Date.now();
		logger.info(`Sync state: synced (${pendingCount} pending)`);
		this.notify();
	}

	// Records a sync failure with its real message and moves to the error state,
	// always notifying so the surfaced detail refreshes even on a repeat error.
	recordError(message: string): void {
		this._lastError = message;
		this._status = 'error';
		logger.warn(`Sync error: ${message}`);
		this.notify();
	}

	tryStartSync(): boolean {
		if (this._isSyncing) {return false;}
		this._isSyncing = true;
		return true;
	}

	setSyncing(syncing: boolean): void {
		this._isSyncing = syncing;
	}

	advanceTimestamp(timestamp: string): void {
		if (timestamp > this._lastSyncTimestamp) {
			this._lastSyncTimestamp = timestamp;
			logger.info(`Sync cursor advanced to ${timestamp}`);
		}
	}
}
