import { Notice } from 'obsidian';
import type { SyncErrorType } from '@/errors/sync-error';
import type { SyncError } from '@/errors/sync-error';
import { createSyncError, parseRetryAfter } from '@/errors/sync-error';
import { logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';

const MAX_RETRIES = 2;
const BACKOFF_MS = [1000, 3000] as const;

const USER_MESSAGES: Record<SyncErrorType, string> = {
	network_timeout: 'Network timeout, retrying shortly',
	rate_limit: 'Rate limited, backing off',
	permission_denied: STRINGS.NOTICE_DRIVE_PERMISSION,
	token_expired: STRINGS.NOTICE_TOKEN_EXPIRED,
	token_revoked: STRINGS.NOTICE_TOKEN_EXPIRED,
	schema_mismatch: STRINGS.NOTICE_SCHEMA_MISMATCH,
	obsidian_version: STRINGS.NOTICE_OBSIDIAN_VERSION,
	icloud_offloaded: STRINGS.NOTICE_DOWNLOADING_OFFLOADED,
	folder_missing: STRINGS.NOTICE_FOLDER_MISSING,
	scan_missing: STRINGS.NOTICE_SCAN_REMOVED,
	vault_write_failed: 'Failed to write note to vault',
};

// What the sync state records for a failed sync, which the error Notice and the
// settings tab then show. Most types keep their real reason: a Drive API body or
// a token failure is the most useful thing a user can read, or paste into a bug
// report. A missing folder is the exception. Its raw message is an absolute local
// path, and the settings tab already names the folder in its own warning, so the
// plain-language guidance reads better than the internal detail.
export function stateMessageFor(error: SyncError): string {
	return error.type === 'folder_missing' ? USER_MESSAGES.folder_missing : error.message;
}

export class ErrorHandler {
	private retryCountMap = new Map<string, number>();

	async handleWithRetry<T>(
		scanId: string,
		operation: () => Promise<T>
	): Promise<T | null> {
		const retryCount = this.retryCountMap.get(scanId) ?? 0;

		try {
			const result = await operation();
			this.retryCountMap.delete(scanId);
			return result;
		} catch (err) {
			const syncError = this.classify(err);

			if (syncError.retriable && retryCount < MAX_RETRIES) {
				this.retryCountMap.set(scanId, retryCount + 1);
				const defaultDelay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)]!;
				const delay = syncError.retryAfterMs ?? defaultDelay;
				const source = syncError.retryAfterMs ? 'header' : 'default';
				logger.warn(`Retry ${retryCount + 1}/${MAX_RETRIES} for ${scanId} after ${delay}ms (source=${source}): ${syncError.message}`);
				await sleep(delay);
				return this.handleWithRetry(scanId, operation);
			}

			this.surface(syncError);
			this.retryCountMap.delete(scanId);
			return null;
		}
	}

	classify(err: unknown): SyncError {
		if (isSyncError(err)) {return err;}

		// Extract Retry-After header if available (Obsidian requestUrl errors may have headers)
		const retryAfterHeader = extractHeader(err, 'retry-after');
		const retryAfterMs = parseRetryAfter(retryAfterHeader);

		if (err instanceof Error) {
			const msg = err.message.toLowerCase();
			if (msg.includes('timeout') || msg.includes('timed out')) {
				return createSyncError('network_timeout', err.message);
			}
			if (msg.includes('429') || msg.includes('rate limit')) {
				if (retryAfterMs) {
					logger.info(`429 retry-after ${retryAfterMs}ms (source=header)`);
				}
				return createSyncError('rate_limit', err.message, undefined, retryAfterMs);
			}
			if (msg.includes('403') || msg.includes('permission')) {
				const guidance = this.classify403Guidance(msg);
				const error = createSyncError('permission_denied', err.message);
				error.guidance = guidance;
				return error;
			}
			if (msg.includes('401') || msg.includes('unauthorized')) {
				return createSyncError('token_expired', err.message);
			}
			// Raw fs errors that escaped backend-level conversion (belt for the
			// folder backend's watched folder disappearing mid-operation).
			if (msg.includes('enoent') || msg.includes('no such file')) {
				return createSyncError('folder_missing', err.message);
			}
			return createSyncError('vault_write_failed', err.message);
		}

		return createSyncError('vault_write_failed', String(err));
	}

	private classify403Guidance(msg: string): string {
		if (msg.includes('invalid_grant') || (msg.includes('token') && msg.includes('revoked'))) {
			return STRINGS.NOTICE_DRIVE_403_TOKEN_REVOKED;
		}
		if (msg.includes('insufficient') || msg.includes('scope') || msg.includes('drive.file')) {
			return STRINGS.NOTICE_DRIVE_403_SCOPE_DENIED;
		}
		return STRINGS.NOTICE_DRIVE_403_UNKNOWN;
	}

	surface(error: SyncError): void {
		const userMessage = error.guidance ?? USER_MESSAGES[error.type];
		logger.error(`${error.type}: ${error.message}`);

		// Always notify. surface() runs only terminally (after retries are exhausted),
		// so a retriable type that reached here has given up — suppressing the Notice
		// would leave the user with zero signal that the scan did not sync.
		new Notice(userMessage, 10_000);
	}

	resetRetries(): void {
		this.retryCountMap.clear();
	}
}

export function isSyncError(err: unknown): err is SyncError {
	return (
		typeof err === 'object' &&
		err !== null &&
		'type' in err &&
		'message' in err &&
		'retriable' in err
	);
}

function extractHeader(err: unknown, headerName: string): string | undefined {
	if (typeof err !== 'object' || err === null) {return undefined;}
	const e = err as Record<string, unknown>;
	// Obsidian requestUrl errors may include headers as a Record
	const headers = e.headers as Record<string, string> | undefined;
	if (!headers) {return undefined;}
	// Case-insensitive header lookup
	const key = Object.keys(headers).find(k => k.toLowerCase() === headerName.toLowerCase());
	return key ? headers[key] : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
