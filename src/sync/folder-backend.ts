import { imageFileNameFor } from '@papersync/scan-format';
import * as fs from 'fs';
import * as path from 'path';
import type { SyncBackend, ScanReference } from '@/sync/sync-backend';
import type { ScanFile } from '@/validation/scan-file-schema';
import { validateScanFile } from '@/validation/scan-file-schema';
import { createSyncError, scanTooLargeError } from '@/errors/sync-error';
import { MAX_SCAN_IMAGE_BYTES, MAX_SCAN_JSON_BYTES } from '@/config';
import type { SyncError } from '@/errors/sync-error';
import { isSyncError } from '@/errors/error-handler';
import { isICloudPath, triggerICloudDownload, isDataless } from '@/sync/icloud-offload';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';
import { isExistingDirectory } from '@/utils/fs';

const DEBOUNCE_MS = 500;
// How often a running folder backend checks that its folder is still there, and
// whether a missing one (deleted, renamed, drive unplugged) has come back.
export const FOLDER_CHECK_MS = 5000;

export function isENOENT(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

// A filesystem error other than ENOENT (EACCES, EPERM, EROFS, a sync client's
// EBUSY lock) becomes a folder_access error naming the file and the code, so the
// user is not told a Drive or vault problem. Errors without a code pass through.
// Codes a sync client or the OS clears on its own (a held lock, too many open
// files, a flaky read); the rest (EACCES, EROFS, EISDIR) need the user.
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EAGAIN', 'EPERM', 'EMFILE', 'ENFILE', 'EIO']);

function folderAccessError(err: unknown, filePath: string): unknown {
	const code = (err as NodeJS.ErrnoException).code;
	return typeof code === 'string'
		? createSyncError(
			'folder_access',
			`Cannot access ${path.basename(filePath)} in the Papersync folder (${code})`,
			TRANSIENT_FS_CODES.has(code)
		)
		: err;
}

function parseScanJson(content: string, filePath: string): unknown {
	try {
		return JSON.parse(content);
	} catch (err) {
		// A truncated or half-synced file: retrying reads the same bytes.
		throw createSyncError('schema_mismatch', `${path.basename(filePath)} is not valid JSON: ${errorMessage(err)}`);
	}
}

// Refuses a file over maxBytes before reading it. A stat failure is left to the
// read, which reports it the usual way.
//
// Symlinks are never followed (lstat): a synced folder can carry one (Syncthing
// keeps them), and `scan.jpg -> ~/.ssh/id_ed25519` would copy that file into the
// vault. Only regular files are read.
async function readCapped(filePath: string, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
	const stat = await fs.promises.lstat(filePath).catch(() => null);
	if (stat?.isSymbolicLink()) {
		// Treated as no file at all: a linked photo is absent, a linked JSON skipped.
		throw createSyncError('scan_missing', `${path.basename(filePath)} is a link; links are not followed`);
	}
	if (stat && !stat.isFile()) {
		throw createSyncError('folder_access', `${path.basename(filePath)} is not a regular file`, false);
	}
	if (stat && stat.size > maxBytes) {
		throw scanTooLargeError(path.basename(filePath), stat.size, maxBytes);
	}
	return fs.promises.readFile(filePath);
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
	private monitorTimer: number | null = null;
	// Set when the watch is re-armed after the folder came back, so that pass
	// reports even an empty discovery: the engine turns it into a completed sync,
	// which is what clears the folder_missing error from the status bar and settings.
	private recovering = false;
	// One report per disappearance, however many paths notice it (the watch event,
	// the monitor, a background pass). Cleared when the watch is armed again.
	private goneReported = false;
	// The folder has been seen missing since the watch was last armed, by anyone
	// (including a Sync now whose discovery hit ENOENT). Only then is there an
	// error to clear, so only then does a re-arm run the recovery pass. A watch
	// that merely broke on a present folder re-arms quietly: no completed sync, no
	// data.json write every 5 s if it keeps breaking.
	private lost = false;
	private onScanDiscovered: ((refs: ScanReference[]) => Promise<void>) | null = null;
	// False once stopped: a pass still reading then must not hand its scans over.
	private running = false;
	private onUnavailable: ((error: SyncError) => void) | null = null;

	// checkIntervalMs is injectable so tests can exercise the monitor without a 5 s wait.
	constructor(folderPath: string, private readonly checkIntervalMs = FOLDER_CHECK_MS) {
		this.folderPath = folderPath;
	}

	setOnScanDiscovered(callback: (refs: ScanReference[]) => Promise<void>): void {
		this.onScanDiscovered = callback;
	}

	setOnUnavailable(callback: (error: SyncError) => void): void {
		this.onUnavailable = callback;
	}

	start(): void {
		this.running = true;
		this.startMonitor();
		this.startWatch();
	}

	stop(): void {
		this.running = false;
		this.closeWatcher();
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.monitorTimer !== null) {
			window.clearInterval(this.monitorTimer);
			this.monitorTimer = null;
		}
		logger.info('Folder watcher stopped');
	}

	// Arms fs.watch on the folder and runs a discovery pass. start() calls it, and
	// the monitor calls it again once a missing folder is back.
	private startWatch(): void {
		try {
			this.watcher = fs.watch(this.folderPath, { recursive: false }, (eventType, filename) => {
				if (filename && filename.endsWith('.json')) {
					this.debouncedDiscovery();
					return;
				}
				// Deleting, moving, or unmounting the watched folder itself arrives, where
				// it arrives at all, as a plain 'rename'. The fast path; the monitor is
				// the guarantee.
				if (eventType === 'rename' && !isExistingDirectory(this.folderPath)) {
					this.folderGone();
				}
			});

			// fs.watch emits 'error' asynchronously; without a listener Node throws it
			// uncaught. Whatever broke the watch, drop it: the monitor re-arms it on
			// its next tick if the folder is there.
			this.watcher.on('error', (err) => {
				logger.error(`Folder watcher error: ${errorMessage(err)}`);
				this.closeWatcher();
				if (!isExistingDirectory(this.folderPath)) {
					this.folderGone();
				}
			});

			this.goneReported = false;
			this.lost = false;
			logger.info(`Folder watcher started on ${this.folderPath}`);
			this.debouncedDiscovery();
		} catch (err) {
			// Typically the folder is missing (at startup, or it went away again).
			// Say so now; the monitor resumes the watch once the folder exists.
			logger.error(`Failed to start Folder watcher: ${errorMessage(err)}`);
			if (!isExistingDirectory(this.folderPath)) {
				this.folderGone();
			}
		}
	}

	// fs.watch reports its own folder vanishing only on some platforms: Electron 28
	// (Obsidian installer 1.5.8) on macOS never does, and its watch stays "live" on
	// a deleted folder forever. So while the backend runs, check the folder on an
	// interval: gone while watching means report it and drop the dead watch; back
	// while not watching means re-arm. The watch event only makes the first faster.
	private startMonitor(): void {
		if (this.monitorTimer !== null) {return;}
		this.monitorTimer = window.setInterval(() => this.checkFolder(), this.checkIntervalMs);
	}

	private checkFolder(): void {
		const present = isExistingDirectory(this.folderPath);
		if (this.watcher && !present) {
			this.folderGone();
			return;
		}
		if (!this.watcher && present) {
			logger.info(`Resuming the watch on ${this.folderPath}`);
			this.recovering = this.lost;
			this.startWatch();
		}
	}

	// The watched folder is gone: drop the dead watch and tell the engine (once),
	// so the status bar and settings show it now rather than at the next sync.
	private folderGone(): void {
		this.closeWatcher();
		this.lost = true;
		if (this.goneReported) {return;}
		this.goneReported = true;
		this.onUnavailable?.(this.folderMissingError());
	}

	private folderMissingError(): SyncError {
		return createSyncError('folder_missing', `Papersync folder not found: ${this.folderPath}`);
	}

	private closeWatcher(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}

	private debouncedDiscovery(): void {
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = window.setTimeout(() => {
			void this.runDebouncedDiscovery();
		}, DEBOUNCE_MS);
	}

	// A debounced background pass: errors are logged and reported here.
	private async runDebouncedDiscovery(): Promise<void> {
		try {
			const refs = await this.discoverUnsynced();
			if (!this.running) {return;}
			if (refs.length > 0 || this.recovering) {
				this.recovering = false;
				await this.onScanDiscovered?.(refs);
			}
		} catch (err) {
			logger.warn(`Folder discovery failed: ${errorMessage(err)}`);
			// A background pass has no caller to report to, so a missing folder is
			// handed to the engine here.
			if (isSyncError(err) && err.type === 'folder_missing') {
				this.folderGone();
			}
		}
	}

	async discoverUnsynced(): Promise<ScanReference[]> {
		let entries: string[];
		try {
			entries = await fs.promises.readdir(this.folderPath);
		} catch (err) {
			if (isENOENT(err)) {
				// Whoever asked (Sync now, or a background pass) reports the error. The
				// backend only drops the dead watch; its monitor re-arms it, and runs
				// the recovery pass, once the folder is back.
				this.closeWatcher();
				this.lost = true;
				throw this.folderMissingError();
			}
			throw folderAccessError(err, this.folderPath);
		}
		const presentSet = new Set(entries);
		// Evicted iCloud files are listed only as `.name.icloud` placeholders;
		// fold them back to their real names so offloaded scans stay discoverable.
		const entrySet = new Set(entries.map(materializedName));
		const availableFileNames = [...entrySet];
		const jsonFiles = availableFileNames.filter((e) => e.endsWith('.json'));
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
				let imageFileName = '';
				const stat = presentSet.has(jsonFile) ? await fs.promises.lstat(jsonPath) : null;
				if (stat?.isSymbolicLink()) {
					logger.warn(`${jsonFile} is a link; links are not followed`);
					continue;
				}
				if (stat && stat.size > MAX_SCAN_JSON_BYTES) {
					// Discovered unread, so fetchScan reports it instead of every pass
					// loading it.
					logger.warn(`${jsonFile} is over the scan size limit`);
				} else if (stat) {
					const content = await fs.promises.readFile(jsonPath, 'utf-8');
					const parsed = JSON.parse(content) as { synced?: boolean; imageFileName?: string };

					if (parsed.synced === true) {
						continue;
					}
					imageFileName = typeof parsed.imageFileName === 'string' ? parsed.imageFileName : '';
				} else {
					logger.info(`${jsonFile} is offloaded — discovering it for download`);
				}

				const candidate = imageFileNameFor({ imageFileName }, {
					jsonFileName: jsonFile,
					availableFileNames,
				});

				// JSON owns the text. Keep orphaned scans discoverable; the engine
				// gives new uploads time to finish before importing without a photo.
				const imagePath = candidate ? path.join(this.folderPath, candidate) : '';

				refs.push({
					id: baseName,
					jsonPath,
					imagePath,
					// Unknown for an offloaded JSON, which has not been read yet.
					revision: stat ? `${stat.mtimeMs}:${stat.size}` : undefined,
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
	private async readScanFile(filePath: string, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
		try {
			return await readCapped(filePath, maxBytes);
		} catch (err) {
			if (isSyncError(err)) {throw err;}
			if (!isENOENT(err)) {
				// A dataless read materializes on demand, so a failure here means the
				// content could not be fetched (offline, or iCloud declined). That is a
				// retriable "not downloaded yet", not a corrupt scan.
				if (await this.isNotYetDownloaded(filePath)) {
					throw createSyncError('icloud_offloaded', `File not downloaded yet: ${path.basename(filePath)}`);
				}
				throw folderAccessError(err, filePath);
			}
			if (fs.existsSync(placeholderPath(filePath))) {
				const downloaded = await triggerICloudDownload(filePath);
				if (downloaded) {
					return await readCapped(filePath, maxBytes);
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

		const content = (await this.readScanFile(ref.jsonPath, MAX_SCAN_JSON_BYTES)).toString('utf-8');
		const raw = parseScanJson(content, ref.jsonPath);

		const validated = validateScanFile(raw);
		if ('error' in validated) {
			throw createSyncError(validated.newerVersion ? 'scan_newer_version' : 'schema_mismatch', validated.error);
		}

		return validated;
	}

	async fetchImage(ref: ScanReference): Promise<ArrayBuffer | null> {
		if (!ref.imagePath) {
			return null;
		}
		try {
			const buffer = await this.readScanFile(ref.imagePath, MAX_SCAN_IMAGE_BYTES);
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
		} catch (err) {
			if (isSyncError(err) && err.type === 'scan_missing') {
				return null;
			}
			throw err;
		}
	}

	async markSynced(ref: ScanReference): Promise<void> {
		const content = (await this.readScanFile(ref.jsonPath, MAX_SCAN_JSON_BYTES)).toString('utf-8');
		const parsed = parseScanJson(content, ref.jsonPath) as Record<string, unknown>;
		parsed.synced = true;
		try {
			await fs.promises.writeFile(ref.jsonPath, JSON.stringify(parsed, null, 2), 'utf-8');
		} catch (err) {
			throw folderAccessError(err, ref.jsonPath);
		}
		logger.info(`Marked scan ${ref.id} as synced on Folder`);
	}
}
