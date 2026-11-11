import { Notice } from 'obsidian';
import type { SyncErrorType } from '@/errors/sync-error';
import type { SyncError } from '@/errors/sync-error';
import { HttpStatusError, createSyncError, isRateLimitReason, parseRetryAfter } from '@/errors/sync-error';
import { logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';

const MAX_RETRIES = 2;
const BACKOFF_MS = [1000, 3000] as const;
// A longer Retry-After is not waited out inside a batch (it holds the sync lock);
// the scan stays unsynced and the next sync picks it up.
const MAX_RETRY_AFTER_MS = 60_000;

const USER_MESSAGES: Record<SyncErrorType, string> = {
	network_timeout: 'Network timeout, retrying shortly',
	rate_limit: 'Rate limited, backing off',
	permission_denied: STRINGS.NOTICE_DRIVE_PERMISSION,
	token_expired: STRINGS.NOTICE_TOKEN_EXPIRED,
	token_revoked: STRINGS.NOTICE_TOKEN_EXPIRED,
	schema_mismatch: STRINGS.NOTICE_SCAN_UNREADABLE,
	scan_newer_version: STRINGS.NOTICE_SCAN_NEWER_VERSION,
	obsidian_version: STRINGS.NOTICE_OBSIDIAN_VERSION,
	icloud_offloaded: STRINGS.NOTICE_DOWNLOADING_OFFLOADED,
	folder_missing: STRINGS.NOTICE_FOLDER_MISSING,
	scan_missing: STRINGS.NOTICE_SCAN_REMOVED,
	folder_access: STRINGS.NOTICE_FOLDER_ACCESS,
	scan_too_large: STRINGS.NOTICE_SCAN_TOO_LARGE,
	drive_error: STRINGS.NOTICE_DRIVE_ERROR,
	vault_write_failed: 'Failed to write note to vault',
};

// What the sync state records for a failed sync, which the error Notice and the
// settings tab then show. Most types keep their real reason: a Drive API body or
// a token failure is the most useful thing a user can read, or paste into a bug
// report. A missing folder is the exception. Its raw message is an absolute local
// path, and the settings tab already names the folder in its own warning, so the
// plain-language guidance reads better than the internal detail.
// A scan the plugin gave up on names its file, so the user can find it. Scan ids
// are the file name stem on both backends.
const SCAN_NAMED_MESSAGES: Partial<Record<SyncErrorType, (fileName: string) => string>> = {
	schema_mismatch: STRINGS.NOTICE_SCAN_UNREADABLE_NAMED,
	scan_newer_version: STRINGS.NOTICE_SCAN_NEWER_VERSION_NAMED,
};

export function stateMessageFor(error: SyncError): string {
	return error.type === 'folder_missing' ? USER_MESSAGES.folder_missing : error.message;
}

export class ErrorHandler {
	private retryCountMap = new Map<string, number>();

	// onGiveUp receives the final error when the retries ran out (or the error was
	// not retriable), so a caller can schedule a later attempt for a retriable one.
	async handleWithRetry<T>(
		scanId: string,
		operation: () => Promise<T>,
		onGiveUp?: (error: SyncError) => void
	): Promise<T | null> {
		const retryCount = this.retryCountMap.get(scanId) ?? 0;

		try {
			const result = await operation();
			this.retryCountMap.delete(scanId);
			return result;
		} catch (err) {
			const syncError = this.classify(err);

			const waitable = (syncError.retryAfterMs ?? 0) <= MAX_RETRY_AFTER_MS;
			if (syncError.retriable && waitable && retryCount < MAX_RETRIES) {
				this.retryCountMap.set(scanId, retryCount + 1);
				const defaultDelay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)]!;
				const delay = syncError.retryAfterMs ?? defaultDelay;
				const source = syncError.retryAfterMs ? 'header' : 'default';
				logger.warn(`Retry ${retryCount + 1}/${MAX_RETRIES} for ${scanId} after ${delay}ms (source=${source}): ${syncError.message}`);
				await sleep(delay);
				return this.handleWithRetry(scanId, operation, onGiveUp);
			}

			this.surface(syncError, scanId);
			onGiveUp?.(syncError);
			this.retryCountMap.delete(scanId);
			return null;
		}
	}

	// Classifies on structured fields only (the SyncError type, the HTTP status
	// and Drive reason, the error class), never on message wording: a local path
	// or a JSON parse position can contain "403" or "permission".
	classify(err: unknown): SyncError {
		if (isSyncError(err)) {return err;}

		if (err instanceof HttpStatusError) {
			return this.classifyHttp(err);
		}
		// A corrupt or half-synced scan JSON: retrying reads the same bytes.
		if (err instanceof SyntaxError) {
			return createSyncError('schema_mismatch', err.message);
		}
		// Anything else escaped the backends' own conversion, so it comes from
		// writing the note (the Vault API) or from a bug.
		return createSyncError('vault_write_failed', err instanceof Error ? err.message : String(err));
	}

	private classifyHttp(err: HttpStatusError): SyncError {
		const retryAfterMs = parseRetryAfter(err.retryAfter);
		if (retryAfterMs) {
			logger.info(`HTTP ${err.status} retry-after ${retryAfterMs}ms (source=header)`);
		}
		if (err.status === 429 || (err.status === 403 && isRateLimitReason(err.reason))) {
			return createSyncError('rate_limit', err.message, undefined, retryAfterMs);
		}
		if (err.status === 401) {
			return createSyncError('token_expired', err.message);
		}
		if (err.status === 403) {
			const error = createSyncError('permission_denied', err.message);
			error.guidance = this.classify403Guidance(`${err.reason ?? ''} ${err.message}`.toLowerCase());
			return error;
		}
		if (err.status === 404) {
			return createSyncError('scan_missing', err.message);
		}
		if (err.status === 408) {
			return createSyncError('network_timeout', err.message);
		}
		return createSyncError('drive_error', err.message, err.status >= 500, retryAfterMs);
	}

	// Google's own error text for a 403 (not a local message) picks the guidance.
	private classify403Guidance(msg: string): string {
		if (msg.includes('invalid_grant') || (msg.includes('token') && msg.includes('revoked'))) {
			return STRINGS.NOTICE_DRIVE_403_TOKEN_REVOKED;
		}
		if (msg.includes('insufficient') || msg.includes('scope') || msg.includes('drive.file')) {
			return STRINGS.NOTICE_DRIVE_403_SCOPE_DENIED;
		}
		return STRINGS.NOTICE_DRIVE_403_UNKNOWN;
	}

	surface(error: SyncError, scanId?: string): void {
		const named = scanId === undefined ? undefined : SCAN_NAMED_MESSAGES[error.type]?.(`${scanId}.json`);
		const userMessage = error.guidance ?? named ?? USER_MESSAGES[error.type];
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
