import { logger } from '@/utils/logger';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline';

export interface SyncStateSnapshot {
	status: SyncStatus;
	pendingCount: number;
	lastSyncTimestamp: string;
	isSyncing: boolean;
}

type SyncStateListener = (snapshot: SyncStateSnapshot) => void;

export class SyncState {
	private _status: SyncStatus = 'idle';
	private _pendingCount = 0;
	private _lastSyncTimestamp: string;
	private _isSyncing = false;
	private listeners: SyncStateListener[] = [];

	constructor(lastSyncTimestamp: string) {
		this._lastSyncTimestamp = lastSyncTimestamp;
	}

	get status(): SyncStatus { return this._status; }
	get pendingCount(): number { return this._pendingCount; }
	get lastSyncTimestamp(): string { return this._lastSyncTimestamp; }
	get isSyncing(): boolean { return this._isSyncing; }

	get snapshot(): SyncStateSnapshot {
		return {
			status: this._status,
			pendingCount: this._pendingCount,
			lastSyncTimestamp: this._lastSyncTimestamp,
			isSyncing: this._isSyncing,
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
		if (changed) {
			logger.info(`Sync state: ${status}${pendingCount !== undefined ? ` (${pendingCount} pending)` : ''}`);
			this.notify();
		}
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
