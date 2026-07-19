import * as fs from 'fs';
import * as path from 'path';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError } from '@/errors/sync-error';
import { isSyncError } from '@/errors/error-handler';
import { isICloudPath, triggerICloudDownload, isDataless } from '@/sync/icloud-offload';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

const DEBOUNCE_MS = 500;

export function isENOENT(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

// iCloud represents an evicted (offloaded) file as a hidden `.name.icloud`
// placeholder in the same directory; the real name reappears once downloaded.
const ICLOUD_PLACEHOLDER_RE = /^\.(.+)\.icloud$/;

function materializedName(entry: string): string {
	const match = ICLOUD_PLACEHOLDER_RE.exec(entry);
	return match ? match[1]! : entry;
}

function placeholderPath(filePath: string): string {
	return path.join(path.dirname(filePath), `.${path.basename(filePath)}.icloud`);
}

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

			// fs.watch emits 'error' (e.g. the watched folder is deleted or becomes
			// unavailable) asynchronously; without a listener Node throws it uncaught.
			// Log and tear the watcher down cleanly instead.
			this.watcher.on('error', (err) => {
				logger.error(`Folder watcher error: ${errorMessage(err)}`);
				this.stop();
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
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.folderPath);
		} catch (err) {
			if (isENOENT(err)) {
				throw createSyncError('folder_missing', `Papersync folder not found: ${this.folderPath}`);
			}
			throw err;
		}
		const presentSet = new Set(entries);
		// Evicted iCloud files are listed only as `.name.icloud` placeholders;
		// fold them back to their real names so offloaded scans stay discoverable.
		const entrySet = new Set(entries.map(materializedName));
		const jsonFiles = [...entrySet].filter((e) => e.endsWith('.json'));
		const refs: ScanReference[] = [];

		for (const jsonFile of jsonFiles) {
			const jsonPath = path.join(this.folderPath, jsonFile);
			const baseName = jsonFile.replace(/\.json$/, '');

			try {
				// Trust the JSON's imageFileName field first (the app writes `.jpg`
				// for new captures and `.png` for legacy archives). Fall back to
				// extension probing in case the field is missing or stale. An
				// evicted JSON can't be read yet — its synced flag is unknowable
				// until fetchScan triggers the download, so discover it anyway.
				let imageFileName: string | null = null;
				if (presentSet.has(jsonFile)) {
					const content = await fs.promises.readFile(jsonPath, 'utf-8');
					const parsed = JSON.parse(content) as { synced?: boolean; imageFileName?: string };

					if (parsed.synced === true) {continue;}
					imageFileName =
						parsed.imageFileName && entrySet.has(parsed.imageFileName) ? parsed.imageFileName : null;
				} else {
					logger.info(`${jsonFile} is offloaded — discovering it for download`);
				}

				const candidate =
					imageFileName
					?? (entrySet.has(`${baseName}.jpg`) ? `${baseName}.jpg` : null)
					?? (entrySet.has(`${baseName}.jpeg`) ? `${baseName}.jpeg` : null)
					?? (entrySet.has(`${baseName}.png`) ? `${baseName}.png` : null);

				if (!candidate) {
					logger.info(`Skipping ${jsonFile} — companion image not yet available`);
					continue;
				}

				const imagePath = path.join(this.folderPath, candidate);

				// An evicted image is unreadable until downloaded; fetchImage
				// recovers it, so only gate on readability when it's present.
				if (presentSet.has(candidate)) {
					try {
						await fs.promises.access(imagePath, fs.constants.R_OK);
					} catch {
						logger.info(`Skipping ${jsonFile} — companion image not readable`);
						continue;
					}
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

	/**
	 * Reads a file, recovering from iCloud eviction: on ENOENT with a
	 * `.name.icloud` placeholder present, triggers the download and reads again.
	 * Throws `scan_missing` when the file is genuinely gone.
	 */
	private async readScanFile(filePath: string): Promise<Buffer<ArrayBuffer>> {
		try {
			return await fs.promises.readFile(filePath);
		} catch (err) {
			if (!isENOENT(err)) {
				// A dataless read materializes on demand, so a failure here means the
				// content could not be fetched (offline, or iCloud declined). That is a
				// retriable "not downloaded yet", not a corrupt scan.
				if (await this.isNotYetDownloaded(filePath)) {
					throw createSyncError('icloud_offloaded', `File not downloaded yet: ${path.basename(filePath)}`);
				}
				throw err;
			}
			if (fs.existsSync(placeholderPath(filePath))) {
				const downloaded = await triggerICloudDownload(filePath);
				if (downloaded) {
					return await fs.promises.readFile(filePath);
				}
				throw createSyncError('icloud_offloaded', `File not yet downloaded: ${path.basename(filePath)}`);
			}
			throw createSyncError('scan_missing', `File removed from the Papersync folder: ${path.basename(filePath)}`);
		}
	}

	// Deliberately provider-AGNOSTIC. Every on-demand sync client (iCloud Drive on
	// macOS and Windows, OneDrive Files On-Demand, Dropbox online-only) leaves a
	// file that lists and stats normally while its content is absent, so asking
	// the filesystem "is the content here?" is both simpler and safer than
	// enumerating providers and their paths per platform — a list we would have to
	// keep correct forever, and would get wrong the first time a user picks a
	// provider we never thought of.
	//
	// Restricted to regular files: a directory can also report zero blocks against
	// a non-zero size, and reading one (EISDIR) must stay a real error rather than
	// be mistaken for a pending download. Never throws — a stat failure means
	// "can't tell", and the caller rethrows the original error.
	private async isNotYetDownloaded(filePath: string): Promise<boolean> {
		try {
			const stat = await fs.promises.stat(filePath);
			return stat.isFile() && isDataless(stat);
		} catch {
			return false;
		}
	}

	async fetchScan(ref: ScanReference): Promise<ScanFile> {
		// Nudge iCloud before reading an evicted file. The read below would
		// materialize it on demand anyway, but that blocks for as long as the
		// download takes, so asking first keeps the wait explicit and lets an
		// offline failure surface as a retriable icloud_offloaded rather than a
		// stalled sync. Detection is blocks-based: an evicted file keeps its name
		// AND its logical size, so the old `size === 0` test never fired.
		if (isICloudPath(ref.jsonPath)) {
			try {
				const stat = await fs.promises.stat(ref.jsonPath);
				if (isDataless(stat)) {
					const downloaded = await triggerICloudDownload(ref.jsonPath);
					if (!downloaded) {
						throw createSyncError('icloud_offloaded', `File not yet downloaded: ${ref.id}`);
					}
				}
			} catch (err) {
				if (isSyncError(err) && err.type === 'icloud_offloaded') {
					throw err;
				}
				// stat error — file may be inaccessible, continue to read attempt
			}
		}

		const content = (await this.readScanFile(ref.jsonPath)).toString('utf-8');
		const raw = JSON.parse(content);

		const validated = validateScanFile(raw);
		if ('error' in validated) {
			throw createSyncError('schema_mismatch', validated.error);
		}

		return validated;
	}

	async fetchImage(ref: ScanReference): Promise<ArrayBuffer> {
		const buffer = await this.readScanFile(ref.imagePath);
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}

	async markSynced(ref: ScanReference): Promise<void> {
		const content = (await this.readScanFile(ref.jsonPath)).toString('utf-8');
		const parsed = JSON.parse(content) as Record<string, unknown>;
		parsed.synced = true;
		await fs.promises.writeFile(ref.jsonPath, JSON.stringify(parsed, null, 2), 'utf-8');
		logger.info(`Marked scan ${ref.id} as synced on Folder`);
	}
}
