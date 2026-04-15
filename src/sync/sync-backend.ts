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
}
