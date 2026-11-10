import type { ScanFile } from '@/validation/scan-file-schema';
import type { SyncError } from '@/errors/sync-error';

export interface ScanReference {
	id: string;
	jsonPath: string;
	imagePath: string;
	createdTime?: string;
	// Changes whenever the scan JSON changes (Drive's modifiedTime, a folder file's
	// mtime and size). A scan that failed for good is tried again only once this
	// differs from the revision that failed.
	revision?: string;
	// File sizes in bytes when the backend lists them (Drive), so an oversized
	// file is refused before it is downloaded.
	jsonBytes?: number;
	imageBytes?: number;
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
	// The callback runs the import, so a backend must catch its promise.
	setOnScanDiscovered?(callback: (refs: ScanReference[]) => Promise<void>): void;
	// Cursor-based backends (DriveBackend) persist the sync high-water mark so the
	// next poll only re-queries newer scans; folder scanning does not use a cursor.
	updateLastSyncTimestamp?(timestamp: string): void;
	// Backends that notice their source disappearing on their own (FolderBackend's
	// watcher sees its folder deleted) report it here, so the failure reaches the
	// sync state instead of only a log line.
	setOnUnavailable?(callback: (error: SyncError) => void): void;
	// Backends that rediscover on a timer of their own (Drive polls) report how
	// each background discovery ended, so a failing poll reaches the sync state
	// instead of only a log line, and the next good one clears it. A poll that
	// found scans is reported through setOnScanDiscovered instead of succeeded.
	setOnPollResult?(callbacks: { failed: (err: unknown) => void; succeeded: () => void }): void;
	// How long a JSON whose companion photo is missing waits for it, measured from
	// the ref's createdTime when valid (else first sight). Backends without one use
	// the first-sight folder grace (COMPANION_GRACE_MS).
	readonly companionGraceMs?: number;
	// Backends that rediscover on a timer of their own (Drive polls) retry failed
	// scans anyway; the engine schedules its own retries only for the others.
	readonly polls?: boolean;
	// Backends that cannot work without the network (Drive) pause while the
	// computer is offline. A local or synced folder keeps syncing.
	readonly needsNetwork?: boolean;
}
