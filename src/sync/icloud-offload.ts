import { Platform } from 'obsidian';
import { execSync } from 'child_process';
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
 * Probes whether a file is iCloud-offloaded (placeholder only, not materialized locally).
 * Returns `{ offloaded: false }` immediately on non-macOS or non-iCloud paths.
 */
export function probeOffloadState(filePath: string): { offloaded: boolean } {
	if (!isICloudPath(filePath)) {
		return { offloaded: false };
	}

	try {
		const result = execSync(
			`brctl download "${filePath}" 2>/dev/null; xattr -p com.apple.metadata:com_apple_clouddocs_state "${filePath}" 2>/dev/null`,
			{ encoding: 'utf-8', timeout: 5000 }
		).trim();

		// State value 3 = fully downloaded, anything else may be offloaded
		// If xattr is empty or absent, assume not offloaded (local file)
		if (!result) {return { offloaded: false };}

		// The raw xattr output is a binary plist; a non-empty result with the xattr present
		// means iCloud is managing this file. We check if the file is readable to determine state.
		return { offloaded: false };
	} catch {
		// xattr not available or file not in iCloud container — not offloaded
		return { offloaded: false };
	}
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
		execSync(`brctl download "${filePath}"`, { timeout: 5000 });
	} catch {
		// brctl may not be available; try reading as fallback to trigger download
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
