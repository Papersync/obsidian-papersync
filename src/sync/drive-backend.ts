import { requestUrl } from 'obsidian';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError } from '@/errors/sync-error';
import type { OAuthManager } from '@/auth/oauth-manager';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

import { GOOGLE_SCANS_FOLDER, MAX_POLL_INTERVAL_S } from '@/config';
import { resolveGoogleEndpoint } from '@/google-endpoints';
import type { GoogleEndpointsSupplier } from '@/google-endpoints';

interface DriveFile {
	id: string;
	name: string;
	createdTime?: string;
}

interface DriveListResponse {
	files: DriveFile[];
	nextPageToken?: string;
}

// Scans per by-name companion lookup: 3 names each keeps one query well under
// Drive's query length limit and inside a single 100-file page.
const COMPANION_LOOKUP_BATCH = 30;

function companionNames(baseName: string): string[] {
	return [`${baseName}.jpg`, `${baseName}.jpeg`, `${baseName}.png`];
}

export class DriveBackend implements SyncBackend {
	private oauthManager: OAuthManager;
	// Seconds, read live: an interval changed in Settings takes effect from the next
	// tick without restarting sync.
	private pollIntervalSeconds: () => number;
	private armedSeconds = 0;
	private intervalId: number | null = null;
	private onScanDiscovered: ((refs: ScanReference[]) => void) | null = null;
	private lastSyncTimestamp: string;
	// Same call-time supplier form as OAuthManager (main.ts hands the SAME supplier
	// to both), so OAuth and Drive can never split-brain across two snapshots of the
	// endpoint seam (token grant to one host, Drive calls to another).
	private endpointsSupplier: GoogleEndpointsSupplier | undefined;

	constructor(
		oauthManager: OAuthManager,
		pollIntervalSeconds: number | (() => number),
		lastSyncTimestamp?: string,
		endpointsSupplier?: GoogleEndpointsSupplier
	) {
		this.oauthManager = oauthManager;
		this.pollIntervalSeconds = typeof pollIntervalSeconds === 'function' ? pollIntervalSeconds : () => pollIntervalSeconds;
		this.lastSyncTimestamp = lastSyncTimestamp ?? '';
		this.endpointsSupplier = endpointsSupplier;
	}

	// Resolved at CALL time through the shared loopback-gated resolver (non-loopback /
	// malformed / empty overrides fall back to production defaults).
	private endpoint(key: 'driveApiBase' | 'driveUploadBase'): string {
		return resolveGoogleEndpoint(key, this.endpointsSupplier?.());
	}

	// Wraps requestUrl so a failed Drive call surfaces Google's real error message
	// (e.g. "Google Drive API has not been used in project ...") instead of a bare
	// status code. The status is kept in the message so ErrorHandler can still
	// classify it (403 -> permission, 401 -> token, 429 -> rate limit).
	private async driveRequest(params: RequestUrlParam): Promise<RequestUrlResponse> {
		const response = await requestUrl({ ...params, throw: false });
		if (response.status >= 400) {
			let detail = `status ${response.status}`;
			try {
				const body = response.json as { error?: { message?: string } } | null | undefined;
				if (body?.error?.message) {detail = body.error.message;}
			} catch {
				// Non-JSON error body; keep the status-only detail.
			}
			throw new Error(`Drive request failed (${response.status}): ${detail}`);
		}
		return response;
	}

	updateLastSyncTimestamp(timestamp: string): void {
		this.lastSyncTimestamp = timestamp;
	}

	setOnScanDiscovered(callback: (refs: ScanReference[]) => void): void {
		this.onScanDiscovered = callback;
	}

	start(): void {
		void this.poll();
		this.arm();
		logger.info(`Drive polling started (${this.armedSeconds}s interval)`);
	}

	stop(): void {
		this.disarm();
		logger.info('Drive polling stopped');
	}

	// Called when a new poll interval is committed in Settings: re-arm now, so a
	// shorter interval does not first wait out the old one. No-op when stopped.
	reschedule(): void {
		if (this.intervalId === null || this.intervalSeconds() === this.armedSeconds) {return;}
		this.disarm();
		this.arm();
		logger.info(`Drive poll interval now ${this.armedSeconds}s`);
	}

	private intervalSeconds(): number {
		return Math.min(this.pollIntervalSeconds(), MAX_POLL_INTERVAL_S);
	}

	private arm(): void {
		this.armedSeconds = this.intervalSeconds();
		this.intervalId = window.setInterval(() => { void this.poll(); }, this.armedSeconds * 1000);
	}

	private disarm(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
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

		const allFiles = await this.listFiles(token, query);

		logger.info(`Drive returned ${allFiles.length} files total`);
		const jsonFiles = allFiles.filter((f) => f.name.endsWith('.json'));
		const imageFiles = allFiles.filter((f) => f.name.endsWith('.jpg') || f.name.endsWith('.jpeg') || f.name.endsWith('.png'));
		logger.info(`Drive returned ${allFiles.length} files (${jsonFiles.length} JSON, ${imageFiles.length} images)`);

		const imageFor = (baseName: string, images: DriveFile[]): DriveFile | undefined => {
			// Exact companion match only — a prefix match would pair base "abc" with an
			// unrelated "abcd.jpg" or a "abc-thumb.jpg". Mirror folder-backend's candidates.
			const candidateNames = companionNames(baseName);
			return images.find((f) => candidateNames.includes(f.name));
		};

		// The cursor filter also hides a photo created at or before the cursor whose
		// JSON landed after it (uploads finishing out of order). Look such companions
		// up by name, with no time filter, before reporting them missing.
		if (this.lastSyncTimestamp) {
			const unpaired = jsonFiles
				.map((f) => f.name.replace(/\.json$/, ''))
				.filter((baseName) => !imageFor(baseName, imageFiles));
			for (let i = 0; i < unpaired.length; i += COMPANION_LOOKUP_BATCH) {
				const names = unpaired.slice(i, i + COMPANION_LOOKUP_BATCH).flatMap(companionNames);
				const byName = names.map((n) => `name = '${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(' or ');
				imageFiles.push(...(await this.listFiles(token, `'${folderId}' in parents and trashed = false and (${byName})`)));
			}
		}

		const refs: ScanReference[] = [];

		for (const file of jsonFiles) {
			const baseName = file.name.replace(/\.json$/, '');
			const imageFile = imageFor(baseName, imageFiles);

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

	private async listFiles(token: string, query: string): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			let url = `${this.endpoint('driveApiBase')}/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime),nextPageToken&orderBy=createdTime&pageSize=100`;
			if (pageToken) {
				url += `&pageToken=${encodeURIComponent(pageToken)}`;
			}

			const response = await this.driveRequest({
				url,
				headers: { Authorization: `Bearer ${token}` },
			});

			const listData = response.json as DriveListResponse;
			files.push(...(listData.files ?? []));
			pageToken = listData.nextPageToken;
		} while (pageToken);

		return files;
	}

	async fetchScan(ref: ScanReference): Promise<ScanFile> {
		const token = await this.oauthManager.getValidAccessToken();

		const response = await this.driveRequest({
			url: `${this.endpoint('driveApiBase')}/files/${ref.jsonPath}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});

		const raw = response.json;
		const validated = validateScanFile(raw);

		if ('error' in validated) {
			throw createSyncError('schema_mismatch', validated.error);
		}

		return validated;
	}

	async fetchImage(ref: ScanReference): Promise<ArrayBuffer | null> {
		if (!ref.imagePath) {
			return null;
		}

		const token = await this.oauthManager.getValidAccessToken();

		const response = await this.driveRequest(
			{
				url: `${this.endpoint('driveApiBase')}/files/${ref.imagePath}?alt=media`,
				headers: { Authorization: `Bearer ${token}` },
			}
		);

		return response.arrayBuffer;
	}

	async markSynced(ref: ScanReference): Promise<void> {
		const token = await this.oauthManager.getValidAccessToken();

		// Re-fetch the RAW JSON (not the zod-parsed ScanFile, which drops unmodeled fields
		// and coerces types e.g. version number->string) so the PATCH round-trips every
		// original field untouched. Mirrors FolderBackend.markSynced.
		const response = await this.driveRequest({
			url: `${this.endpoint('driveApiBase')}/files/${ref.jsonPath}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const raw = (response.json ?? {}) as Record<string, unknown>;
		raw.synced = true;

		await this.driveRequest({
			url: `${this.endpoint('driveUploadBase')}/files/${ref.jsonPath}?uploadType=media`,
			method: 'PATCH',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(raw),
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
			const response = await this.driveRequest({
				url: `${this.endpoint('driveApiBase')}/files?q=${encodeURIComponent(query)}&fields=files(id)`,
				headers: { Authorization: `Bearer ${token}` },
			});

			const folderData = response.json as DriveListResponse;
			const folders = folderData.files ?? [];
			if (folders.length === 0 || !folders[0]) {
				logger.warn(`Papersync folder not found on Drive (missing: ${part})`);
				return null;
			}
			parentId = folders[0].id;
		}

		this.scansFolderId = parentId;
		return parentId;
	}
}
