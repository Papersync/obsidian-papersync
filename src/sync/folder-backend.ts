import * as fs from 'fs';
import * as path from 'path';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError } from '@/errors/sync-error';
import { isICloudPath, triggerICloudDownload } from '@/sync/icloud-offload';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

const DEBOUNCE_MS = 500;

export class FolderBackend implements SyncBackend {
	private folderPath: string;
	private watcher: fs.FSWatcher | null = null;
	// window.setTimeout returns a DOM number (obsidianmd/prefer-window-timers);
	// keep the field type in the DOM domain to match.
	private debounceTimer: number | null = null;
	private onScanDiscovered: ((refs: ScanReference[]) => void) | null = null;

	constructor(folderPath: string) {
		this.folderPath = folderPath;
	}

	setOnScanDiscovered(callback: (refs: ScanReference[]) => void): void {
		this.onScanDiscovered = callback;
	}

	start(): void {
		try {
			this.watcher = fs.watch(this.folderPath, { recursive: false }, (eventType, filename) => {
				if (filename && filename.endsWith('.json')) {
					this.debouncedDiscovery();
				}
			});

			logger.info(`Folder watcher started on ${this.folderPath}`);
			this.debouncedDiscovery();
		} catch (err) {
			logger.error(`Failed to start Folder watcher: ${errorMessage(err)}`);
		}
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		logger.info('Folder watcher stopped');
	}

	private debouncedDiscovery(): void {
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = window.setTimeout(async () => {
			try {
				const refs = await this.discoverUnsynced();
				if (refs.length > 0) {
					this.onScanDiscovered?.(refs);
				}
			} catch (err) {
				logger.warn(`Folder discovery failed: ${errorMessage(err)}`);
			}
		}, DEBOUNCE_MS);
	}

	async discoverUnsynced(): Promise<ScanReference[]> {
		const entries = await fs.promises.readdir(this.folderPath);
		const entrySet = new Set(entries);
		const jsonFiles = entries.filter((e) => e.endsWith('.json'));
		const refs: ScanReference[] = [];

		for (const jsonFile of jsonFiles) {
			const jsonPath = path.join(this.folderPath, jsonFile);

			try {
				const content = await fs.promises.readFile(jsonPath, 'utf-8');
				const parsed = JSON.parse(content) as { synced?: boolean; imageFileName?: string };

				if (parsed.synced === true) {continue;}

				// Trust the JSON's imageFileName field first (the app writes `.jpg`
				// for new captures and `.png` for legacy archives). Fall back to
				// extension probing in case the field is missing or stale.
				const baseName = jsonFile.replace(/\.json$/, '');
				const candidate =
					(parsed.imageFileName && entrySet.has(parsed.imageFileName) ? parsed.imageFileName : null)
					?? (entrySet.has(`${baseName}.jpg`) ? `${baseName}.jpg` : null)
					?? (entrySet.has(`${baseName}.jpeg`) ? `${baseName}.jpeg` : null)
					?? (entrySet.has(`${baseName}.png`) ? `${baseName}.png` : null);

				if (!candidate) {
					logger.info(`Skipping ${jsonFile} — companion image not yet available`);
					continue;
				}

				const imagePath = path.join(this.folderPath, candidate);

				try {
					await fs.promises.access(imagePath, fs.constants.R_OK);
				} catch {
					logger.info(`Skipping ${jsonFile} — companion image not readable`);
					continue;
				}

				refs.push({
					id: baseName,
					jsonPath,
					imagePath,
				});
			} catch {
				logger.warn(`Failed to read ${jsonFile} — may be offloaded or corrupted`);
			}
		}

		return refs;
	}

	async fetchScan(ref: ScanReference): Promise<ScanFile> {
		// Check for iCloud offloaded files before reading
		if (isICloudPath(ref.jsonPath)) {
			try {
				const stat = await fs.promises.stat(ref.jsonPath);
				if (stat.size === 0) {
					const downloaded = await triggerICloudDownload(ref.jsonPath);
					if (!downloaded) {
						throw createSyncError('icloud_offloaded', `File not yet downloaded: ${ref.id}`);
					}
				}
			} catch (err) {
				if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'icloud_offloaded') {
					throw err;
				}
				// stat error — file may be inaccessible, continue to read attempt
			}
		}

		const content = await fs.promises.readFile(ref.jsonPath, 'utf-8');
		const raw = JSON.parse(content);

		const validated = validateScanFile(raw);
		if ('error' in validated) {
			throw createSyncError('schema_mismatch', validated.error);
		}

		return validated;
	}

	async fetchImage(ref: ScanReference): Promise<ArrayBuffer> {
		const buffer = await fs.promises.readFile(ref.imagePath);
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}

	async markSynced(ref: ScanReference): Promise<void> {
		const content = await fs.promises.readFile(ref.jsonPath, 'utf-8');
		const parsed = JSON.parse(content) as Record<string, unknown>;
		parsed.synced = true;
		await fs.promises.writeFile(ref.jsonPath, JSON.stringify(parsed, null, 2), 'utf-8');
		logger.info(`Marked scan ${ref.id} as synced on Folder`);
	}
}
