import type { ScanFile } from '@/validation/scan-file-schema';

export interface ScanReference {
	id: string;
	jsonPath: string;
	imagePath: string;
	createdTime?: string;
}

export interface SyncBackend {
	discoverUnsynced(): Promise<ScanReference[]>;
	fetchScan(ref: ScanReference): Promise<ScanFile>;
	fetchImage(ref: ScanReference): Promise<ArrayBuffer>;
	markSynced(ref: ScanReference, scanData?: ScanFile): Promise<void>;
	start(): void;
	stop(): void;
	// Push-based backends (FolderBackend, DriveBackend) report freshly discovered
	// scans through this callback; backends without a watcher omit it.
	setOnScanDiscovered?(callback: (refs: ScanReference[]) => void): void;
	// Cursor-based backends (DriveBackend) persist the sync high-water mark so the
	// next poll only re-queries newer scans; folder scanning does not use a cursor.
	updateLastSyncTimestamp?(timestamp: string): void;
}
