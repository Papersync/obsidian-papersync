import { Platform } from 'obsidian';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/utils/logger';

const ICLOUD_CONTAINER_PREFIX_MACOS = '/Library/Mobile Documents/';

/**
 * Checks whether a file path is inside an iCloud container on macOS.
 * Returns false on non-macOS platforms or non-iCloud paths.
 */
export function isICloudPath(filePath: string): boolean {
	return Platform.isMacOS && filePath.includes(ICLOUD_CONTAINER_PREFIX_MACOS);
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
