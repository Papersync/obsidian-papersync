import { requestUrl } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError } from '@/errors/sync-error';
import type { OAuthManager } from '@/auth/oauth-manager';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

import { GOOGLE_SCANS_FOLDER } from '@/config';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

interface DriveFile {
	id: string;
	name: string;
	createdTime?: string;
}

interface DriveListResponse {
	files: DriveFile[];
	nextPageToken?: string;
}

export class DriveBackend implements SyncBackend {
	private oauthManager: OAuthManager;
	private pollIntervalMs: number;
	private intervalId: number | null = null;
	private onScanDiscovered: ((refs: ScanReference[]) => void) | null = null;
	private lastSyncTimestamp: string;

	constructor(oauthManager: OAuthManager, pollIntervalSeconds: number, lastSyncTimestamp?: string) {
		this.oauthManager = oauthManager;
		this.pollIntervalMs = pollIntervalSeconds * 1000;
		this.lastSyncTimestamp = lastSyncTimestamp ?? '';
	}

	updateLastSyncTimestamp(timestamp: string): void {
		this.lastSyncTimestamp = timestamp;
	}

	setOnScanDiscovered(callback: (refs: ScanReference[]) => void): void {
		this.onScanDiscovered = callback;
	}

	start(): void {
		void this.poll();
		this.intervalId = window.setInterval(() => void this.poll(), this.pollIntervalMs);
		logger.info(`Drive polling started (${this.pollIntervalMs / 1000}s interval)`);
	}

	stop(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		logger.info('Drive polling stopped');
	}

	private async poll(): Promise<void> {
		logger.info('Drive poll cycle starting...');
		try {
			const refs = await this.discoverUnsynced();
			logger.info(`Drive poll found ${refs.length} unsynced scans`);
			if (refs.length > 0) {
				this.onScanDiscovered?.(refs);
			}
		} catch (err) {
			logger.warn(`Drive poll failed: ${errorMessage(err)}`);
		}
	}

	async discoverUnsynced(): Promise<ScanReference[]> {
		const token = await this.oauthManager.getValidAccessToken();
		logger.info('Got valid access token for Drive');

		const folderId = await this.findScansFolder(token);
		if (!folderId) {
			logger.warn('PaperSync scans folder not found on Drive — nothing to sync');
			return [];
		}
		logger.info(`Found scans folder on Drive: ${folderId}`);

		let query = `'${folderId}' in parents and trashed = false`;
		if (this.lastSyncTimestamp) {
			query += ` and createdTime > '${this.lastSyncTimestamp}'`;
			logger.info(`Filtering for files created after ${this.lastSyncTimestamp}`);
		}

		const allFiles: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			let url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime),nextPageToken&orderBy=createdTime&pageSize=100`;
			if (pageToken) {
				url += `&pageToken=${encodeURIComponent(pageToken)}`;
			}

			const response = await requestUrl({
				url,
				headers: { Authorization: `Bearer ${token}` },
			});

			const listData = response.json as DriveListResponse;
			allFiles.push(...(listData.files ?? []));
			pageToken = listData.nextPageToken;
		} while (pageToken);

		logger.info(`Drive returned ${allFiles.length} files total`);
		const jsonFiles = allFiles.filter((f) => f.name.endsWith('.json'));
		const imageFiles = allFiles.filter((f) => f.name.endsWith('.jpg') || f.name.endsWith('.jpeg') || f.name.endsWith('.png'));
		logger.info(`Drive returned ${allFiles.length} files (${jsonFiles.length} JSON, ${imageFiles.length} images)`);

		const refs: ScanReference[] = [];

		for (const file of jsonFiles) {
			const baseName = file.name.replace('.json', '');
			const imageFile = imageFiles.find((f) => f.name.startsWith(baseName));

			refs.push({
				id: baseName,
				jsonPath: file.id,
				imagePath: imageFile?.id ?? '',
				createdTime: file.createdTime,
			});
		}

		const withImages = refs.filter((r) => r.imagePath !== '');
		logger.info(`Found ${refs.length} scans, ${withImages.length} with paired images`);

		return refs;
	}

	async fetchScan(ref: ScanReference): Promise<ScanFile> {
		const token = await this.oauthManager.getValidAccessToken();

		const response = await requestUrl({
			url: `${DRIVE_API_BASE}/files/${ref.jsonPath}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});

		const raw = response.json;
		const validated = validateScanFile(raw);

		if ('error' in validated) {
			throw createSyncError('schema_mismatch', validated.error);
		}

		return validated;
	}

	async fetchImage(ref: ScanReference): Promise<ArrayBuffer> {
		if (!ref.imagePath) {
			throw createSyncError('vault_write_failed', `No image file found for scan ${ref.id}`);
		}

		const token = await this.oauthManager.getValidAccessToken();

		const response = await requestUrl({
			url: `${DRIVE_API_BASE}/files/${ref.imagePath}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});

		return response.arrayBuffer;
	}

	async markSynced(ref: ScanReference, scanData?: ScanFile): Promise<void> {
		const token = await this.oauthManager.getValidAccessToken();

		const scan = scanData ?? await this.fetchScan(ref);
		const updated = { ...scan, synced: true };

		await requestUrl({
			url: `${DRIVE_UPLOAD_BASE}/files/${ref.jsonPath}?uploadType=media`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(updated),
		});

		logger.info(`Marked scan ${ref.id} as synced on Drive`);
	}

	private scansFolderId: string | null = null;

	private async findScansFolder(token: string): Promise<string | null> {
		if (this.scansFolderId) {return this.scansFolderId;}

		const parts = GOOGLE_SCANS_FOLDER.split('/');
		let parentId = 'root';

		for (const part of parts) {
			const query = `name = '${part}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
			const response = await requestUrl({
				url: `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id)`,
				headers: { Authorization: `Bearer ${token}` },
			});

			const folderData = response.json as DriveListResponse;
			const folders = folderData.files ?? [];
			if (folders.length === 0 || !folders[0]) {
				logger.warn(`PaperSync scans folder not found on Drive (missing: ${part})`);
				return null;
			}
			parentId = folders[0].id;
		}

		this.scansFolderId = parentId;
		return parentId;
	}
}
