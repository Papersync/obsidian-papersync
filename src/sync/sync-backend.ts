import type { ScanFile } from '@/validation/scan-file-schema';
import type { SyncError } from '@/errors/sync-error';

export interface ScanReference {
	id: string;
	jsonPath: string;
	imagePath: string;
	createdTime?: string;
}

export interface SyncBackend {
	discoverUnsynced(): Promise<ScanReference[]>;
	fetchScan(ref: ScanReference): Promise<ScanFile>;
	/** null means the companion is absent, not inaccessible or offloaded. */
	fetchImage(ref: ScanReference): Promise<ArrayBuffer | null>;
	markSynced(ref: ScanReference, scanData?: ScanFile): Promise<void>;
	start(): void;
	stop(): void;
	// Push-based backends (FolderBackend, DriveBackend) report freshly discovered
	// scans through this callback; backends without a watcher omit it.
	setOnScanDiscovered?(callback: (refs: ScanReference[]) => void): void;
	// Cursor-based backends (DriveBackend) persist the sync high-water mark so the
	// next poll only re-queries newer scans; folder scanning does not use a cursor.
	updateLastSyncTimestamp?(timestamp: string): void;
	// Backends that notice their source disappearing on their own (FolderBackend's
	// watcher sees its folder deleted) report it here, so the failure reaches the
	// sync state instead of only a log line.
	setOnUnavailable?(callback: (error: SyncError) => void): void;
	// How long a JSON whose companion photo is missing waits for it, measured from
	// the ref's createdTime when valid (else first sight). Backends without one use
	// the first-sight folder grace (COMPANION_GRACE_MS).
	readonly companionGraceMs?: number;
	// Backends that rediscover on a timer of their own (Drive polls) retry failed
	// scans anyway; the engine schedules its own retries only for the others.
	readonly polls?: boolean;
}
