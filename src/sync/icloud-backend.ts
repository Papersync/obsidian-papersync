import * as fs from 'fs';
import * as path from 'path';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError } from '@/errors/sync-error';
import { logger } from '@/utils/logger';

const DEBOUNCE_MS = 500;

export class ICloudBackend implements SyncBackend {
	private folderPath: string;
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
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

			logger.info(`iCloud watcher started on ${this.folderPath}`);
			this.debouncedDiscovery();
		} catch (err) {
			logger.error(`Failed to start iCloud watcher: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		logger.info('iCloud watcher stopped');
	}

	private debouncedDiscovery(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(async () => {
			try {
				const refs = await this.discoverUnsynced();
				if (refs.length > 0) {
					this.onScanDiscovered?.(refs);
				}
			} catch (err) {
				logger.warn(`iCloud discovery failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}, DEBOUNCE_MS);
	}

	async discoverUnsynced(): Promise<ScanReference[]> {
		const entries = await fs.promises.readdir(this.folderPath);
		const jsonFiles = entries.filter((e) => e.endsWith('.json'));
		const refs: ScanReference[] = [];

		for (const jsonFile of jsonFiles) {
			const jsonPath = path.join(this.folderPath, jsonFile);

			try {
				const content = await fs.promises.readFile(jsonPath, 'utf-8');
				const parsed = JSON.parse(content) as { synced?: boolean };

				if (parsed.synced === true) {continue;}

				const imageFileName = jsonFile.replace('.json', '.jpg');
				const imagePath = path.join(this.folderPath, imageFileName);

				try {
					await fs.promises.access(imagePath, fs.constants.R_OK);
				} catch {
					logger.info(`Skipping ${jsonFile} — companion image not yet available`);
					continue;
				}

				refs.push({
					id: jsonFile.replace('.json', ''),
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
		logger.info(`Marked scan ${ref.id} as synced on iCloud`);
	}
}
