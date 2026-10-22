import { requestUrl } from 'obsidian';
import { IMAGE_EXTENSIONS } from '@papersync/scan-format';
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { HttpStatusError, createSyncError, parseRetryAfter, scanTooLargeError } from '@/errors/sync-error';
import type { OAuthManager } from '@/auth/oauth-manager';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

import { GOOGLE_SCANS_FOLDER, MAX_SCAN_IMAGE_BYTES, MAX_SCAN_JSON_BYTES } from '@/config';
import { clampPollInterval } from '@/utils/poll-interval';
import { resolveGoogleEndpoint } from '@/google-endpoints';
import { DRIVE_COMPANION_GRACE_MS } from '@/sync/companion-grace';
import type { GoogleEndpointsSupplier } from '@/google-endpoints';

interface DriveFile {
	id: string;
	name: string;
	createdTime?: string;
	// int64 as a decimal string; absent for Google Docs types.
	size?: string;
}

interface DriveListResponse {
	files: DriveFile[];
	nextPageToken?: string;
}

// Scans per by-name companion lookup: 3 names each keeps one query well under
// Drive's query length limit and inside a single 100-file page.
const COMPANION_LOOKUP_BATCH = 30;

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
	return key === undefined ? undefined : headers![key];
}

// A string literal inside a Drive `q` query: backslash and quote escaped.
function escapeQueryValue(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function byteSize(file: DriveFile): number | undefined {
	const bytes = Number(file.size);
	return file.size !== undefined && Number.isFinite(bytes) ? bytes : undefined;
}

function downloadedBytes(response: RequestUrlResponse): number | undefined {
	// Unknown when the response carries no body buffer.
	const body: unknown = response.arrayBuffer;
	return body instanceof ArrayBuffer ? body.byteLength : undefined;
}

// Refuses a file whose listed size, or (when Drive listed none) downloaded size,
// is over the limit.
function checkSize(name: string, bytes: number | undefined, maxBytes: number): void {
	if (bytes !== undefined && bytes > maxBytes) {
		throw scanTooLargeError(name, bytes, maxBytes);
	}
}

function companionNames(baseName: string): string[] {
	return IMAGE_EXTENSIONS.map((extension) => `${baseName}${extension}`);
}

export class DriveBackend implements SyncBackend {
	// JSON and photo uploads can become visible at different times or finish
	// out of order. Wait up to 5 minutes from the JSON createdTime for its photo.
	readonly companionGraceMs = DRIVE_COMPANION_GRACE_MS;
	readonly polls = true;
	private oauthManager: OAuthManager;
	// Seconds, read live: an interval changed in Settings takes effect from the next
	// tick without restarting sync.
	private pollIntervalSeconds: () => number;
	private armedSeconds = 0;
	private intervalId: number | null = null;
	private onScanDiscovered: ((refs: ScanReference[]) => Promise<void>) | null = null;
	// False once stopped: a poll still listing then must not hand its scans over.
	private running = false;
	private lastSyncTimestamp: string;
	private backoffUntil = 0;
	private polling = false;
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
	// status code, as an HttpStatusError carrying the status, Drive's error reason
	// and Retry-After for the classifier. A request that never got a response
	// (offline, DNS, reset) is a retriable network error.
	private async driveRequest(params: RequestUrlParam): Promise<RequestUrlResponse> {
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({ ...params, throw: false });
		} catch (err) {
			throw createSyncError('network_timeout', `Drive request failed: ${errorMessage(err)}`);
		}
		if (response.status >= 400) {
			let detail = `status ${response.status}`;
			let reason: string | undefined;
			try {
				const body = response.json as { error?: { message?: unknown; errors?: Array<{ reason?: unknown }> } } | null | undefined;
				if (typeof body?.error?.message === 'string' && body.error.message) {detail = body.error.message;}
				const first = body?.error?.errors?.[0]?.reason;
				if (typeof first === 'string') {reason = first;}
			} catch {
				// Non-JSON error body; keep the status-only detail.
			}
			throw new HttpStatusError(
				response.status,
				`Drive request failed (${response.status}): ${detail}`,
				reason,
				headerValue(response.headers, 'retry-after')
			);
		}
		return response;
	}

	updateLastSyncTimestamp(timestamp: string): void {
		this.lastSyncTimestamp = timestamp;
	}

	setOnScanDiscovered(callback: (refs: ScanReference[]) => Promise<void>): void {
		this.onScanDiscovered = callback;
	}

	start(): void {
		this.running = true;
		void this.poll();
		this.arm();
		logger.info(`Drive polling started (${this.armedSeconds}s interval)`);
	}

	stop(): void {
		this.running = false;
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

	// Clamped again here, not only on load and in Settings: a bad value would
	// make setInterval(…, 0 or NaN) poll Drive in a tight loop.
	private intervalSeconds(): number {
		return clampPollInterval(this.pollIntervalSeconds());
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
		// Google asked for a pause (Retry-After on a 429 or 503): skip polls until then.
		if (Date.now() < this.backoffUntil) {
			logger.info('Drive poll skipped: waiting out Retry-After');
			return;
		}
		// A slow listing must not overlap the next tick's.
		if (this.polling) {
			logger.info('Drive poll skipped: the previous one is still running');
			return;
		}
		this.polling = true;
		logger.info('Drive poll cycle starting...');
		try {
			const refs = await this.discoverUnsynced();
			logger.info(`Drive poll found ${refs.length} unsynced scans`);
			if (refs.length > 0 && this.running) {
				await this.onScanDiscovered?.(refs);
			}
		} catch (err) {
			logger.warn(`Drive poll failed: ${errorMessage(err)}`);
			if (err instanceof HttpStatusError) {
				const retryAfterMs = parseRetryAfter(err.retryAfter);
				if (retryAfterMs) {
					this.backoffUntil = Date.now() + retryAfterMs;
				}
			}
		} finally {
			this.polling = false;
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
			query += ` and createdTime > '${escapeQueryValue(this.lastSyncTimestamp)}'`;
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
				const byName = names.map((n) => `name = '${escapeQueryValue(n)}'`).join(' or ');
				try {
					imageFiles.push(...(await this.listFiles(token, `'${folderId}' in parents and trashed = false and (${byName})`)));
				} catch (err) {
					// Best effort: a failed lookup leaves these scans photo-less (the
					// missing-photo grace still applies) instead of failing discovery
					// for every scan.
					logger.warn(`Photo lookup by name failed: ${errorMessage(err)}`);
				}
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
				jsonBytes: byteSize(file),
				imageBytes: imageFile ? byteSize(imageFile) : undefined,
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
			let url = `${this.endpoint('driveApiBase')}/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime,size),nextPageToken&orderBy=createdTime&pageSize=100`;
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
		const response = await this.fetchRawJson(ref);

		let raw: unknown;
		try {
			raw = response.json;
		} catch (err) {
			// A truncated or non-JSON file: retrying reads the same bytes.
			throw createSyncError('schema_mismatch', `Scan file is not valid JSON: ${errorMessage(err)}`);
		}
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

		checkSize(`${ref.id} photo`, ref.imageBytes, MAX_SCAN_IMAGE_BYTES);
		const token = await this.oauthManager.getValidAccessToken();

		let response: RequestUrlResponse;
		try {
			response = await this.driveRequest({
				url: `${this.endpoint('driveApiBase')}/files/${ref.imagePath}?alt=media`,
				headers: { Authorization: `Bearer ${token}` },
			});
		} catch (err) {
			// Deleted since discovery: the companion is absent, like the folder
			// backend's removed photo. A 404 must not read as "scan removed", which
			// would skip the scan's text too.
			if (err instanceof HttpStatusError && err.status === 404) {
				return null;
			}
			throw err;
		}

		checkSize(`${ref.id} photo`, downloadedBytes(response), MAX_SCAN_IMAGE_BYTES);
		return response.arrayBuffer;
	}

	// The scan JSON's bytes, refused when over the size limit.
	private async fetchRawJson(ref: ScanReference): Promise<RequestUrlResponse> {
		const name = `${ref.id}.json`;
		checkSize(name, ref.jsonBytes, MAX_SCAN_JSON_BYTES);
		const token = await this.oauthManager.getValidAccessToken();
		const response = await this.driveRequest({
			url: `${this.endpoint('driveApiBase')}/files/${ref.jsonPath}?alt=media`,
			headers: { Authorization: `Bearer ${token}` },
		});
		checkSize(name, downloadedBytes(response), MAX_SCAN_JSON_BYTES);
		return response;
	}

	async markSynced(ref: ScanReference): Promise<void> {
		const token = await this.oauthManager.getValidAccessToken();

		// Re-fetch the RAW JSON (not the zod-parsed ScanFile, which drops unmodeled fields
		// and normalizes version, confidence and metadata) so the PATCH round-trips every
		// original field untouched. Mirrors FolderBackend.markSynced.
		const response = await this.fetchRawJson(ref);
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
