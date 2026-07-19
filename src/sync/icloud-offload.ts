import { Platform } from 'obsidian';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/utils/logger';

const ICLOUD_CONTAINER_PREFIX_MACOS = '/Library/Mobile Documents/';

/**
 * Whether a path is somewhere `brctl` can act on: an iCloud container on macOS.
 *
 * Intentionally macOS-only, and NOT a general "is this an iCloud file" test.
 * iCloud Drive also runs on Windows (`%USERPROFILE%\iCloudDrive`), but `brctl`
 * is a macOS binary with no Windows counterpart, so widening this would only
 * route Windows callers into a download nudge that always fails. Detecting
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
 * Attempts to trigger iCloud to download an offloaded file by invoking `brctl download`.
 * Returns true if the file appears materialized after the attempt, false otherwise.
 */
export async function triggerICloudDownload(filePath: string, timeoutMs = 30000): Promise<boolean> {
	if (!Platform.isMacOS) {return false;}

	const filename = filePath.slice(filePath.lastIndexOf('/') + 1);
	logger.info(`File offloaded — triggering iCloud download: ${filename}`);

	try {
		// execFile (not execSync/`sh -c`) so the file path is passed as a single argv
		// element — shell metacharacters in a filename can never be interpreted. Promisify
		// at call time (not module load) so the module never crashes if child_process is
		// mocked without execFile, and the mock is resolved deterministically per call.
		await promisify(execFile)('brctl', ['download', filePath], { timeout: 5000 });
	} catch {
		// brctl may not be available; fall through to the read-poll fallback below.
	}

	// Poll until the file is readable with non-zero content, or timeout
	const start = Date.now();
	const { promises: fsp } = await import('fs');

	while (Date.now() - start < timeoutMs) {
		try {
			const stat = await fsp.stat(filePath);
			if (stat.size > 0) {
				const content = await fsp.readFile(filePath, 'utf-8');
				if (content.length > 0) {return true;}
			}
		} catch {
			// File not yet materialized
		}
		await new Promise(resolve => window.setTimeout(resolve, 2000));
	}

	return false;
}
