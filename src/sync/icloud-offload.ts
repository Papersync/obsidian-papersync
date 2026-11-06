import { Platform } from 'obsidian';
import { promises as fsp, constants as fsConstants } from 'fs';
import { logger } from '@/utils/logger';

const ICLOUD_CONTAINER_PREFIX_MACOS = '/Library/Mobile Documents/';

/**
 * Whether a path is in an iCloud container on macOS, where the plugin nudges an
 * offloaded file to download before reading it.
 *
 * Intentionally macOS-only, and NOT a general "is this an iCloud file" test.
 * iCloud Drive also runs on Windows (`%USERPROFILE%\iCloudDrive`), but the
 * download nudge is only proven on macOS, so widening this would route Windows
 * callers into handling nobody has verified there. Detecting
 * not-yet-downloaded content is handled provider- and platform-agnostically by
 * `isDataless` instead, which is what covers Windows iCloud, OneDrive
 * Files On-Demand and Dropbox online-only without naming any of them.
 */
export function isICloudPath(filePath: string): boolean {
	return Platform.isMacOS && filePath.includes(ICLOUD_CONTAINER_PREFIX_MACOS);
}

/**
 * True when a file exists but its content is NOT on disk yet.
 *
 * Modern macOS evicts an iCloud file to a "dataless" file: it keeps its real
 * name, `readdir` lists it normally, and `stat` still reports the LOGICAL size,
 * so neither a name check nor a `size === 0` check detects it. The reliable
 * signal is allocated blocks — a dataless file reports `blocks === 0` while
 * claiming a non-zero size. Verified on this macOS: before download
 * `size=35 blocks=0 flags=compressed,dataless`; after, `size=35 blocks=8`.
 *
 * (Older macOS and iOS instead leave a `.name.icloud` placeholder; that path is
 * handled separately in the folder backend and still applies there.)
 */
export function isDataless(stat: { size: number; blocks: number }): boolean {
	return stat.size > 0 && stat.blocks === 0;
}

/**
 * Asks iCloud to download an offloaded file by reading it, then waits until its
 * content is on disk. Returns true once materialized, false on timeout.
 *
 * On macOS a read of a dataless file makes the File Provider fetch the whole
 * file, so no shell command is needed. Verified on macOS 27: after
 * `brctl evict` (`size=26 blocks=0 flags=compressed,dataless`) a plain
 * `readFile` returned the content in about a second and stat then showed
 * `blocks=8`. One byte is enough to start it; the stat poll below decides.
 */
export async function triggerICloudDownload(filePath: string, timeoutMs = 30000): Promise<boolean> {
	if (!Platform.isMacOS) {return false;}

	const filename = filePath.slice(filePath.lastIndexOf('/') + 1);
	logger.info(`File offloaded — triggering iCloud download: ${filename}`);

	const start = Date.now();
	await withTimeout(readOneByte(filePath), timeoutMs);

	// Poll until the file has content on disk (non-zero size and allocated
	// blocks), or timeout. The caller reads it in full once it is down.
	while (Date.now() - start < timeoutMs) {
		try {
			const stat = await fsp.stat(filePath);
			if (stat.size > 0 && !isDataless(stat)) {return true;}
		} catch {
			// File not yet materialized
		}
		await sleep(2000);
	}

	return false;
}

/**
 * Reads the first byte of a file so the File Provider materializes it. Never
 * follows a symlink (O_NOFOLLOW), matching the folder backend's regular-files
 * rule. Never throws: a failed read only means the nudge did not help.
 */
async function readOneByte(filePath: string): Promise<void> {
	try {
		const handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			await handle.read(Buffer.alloc(1), 0, 1, 0);
		} finally {
			await handle.close();
		}
	} catch {
		// Missing, offline or not a regular file: the stat poll decides.
	}
}

/**
 * Waits for `work` or `ms`, whichever comes first. `work` must not reject (a
 * late rejection would be unhandled); readOneByte never does. A read still
 * running at the deadline keeps going in the background and closes its handle.
 */
async function withTimeout(work: Promise<void>, ms: number): Promise<void> {
	let timer: number | undefined;
	const deadline = new Promise<void>(resolve => { timer = window.setTimeout(resolve, ms); });
	try {
		await Promise.race([work, deadline]);
	} finally {
		window.clearTimeout(timer);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}
