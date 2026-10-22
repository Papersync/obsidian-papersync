export type SyncErrorType =
	| 'network_timeout'
	| 'rate_limit'
	| 'permission_denied'
	| 'token_expired'
	| 'token_revoked'
	| 'schema_mismatch'
	| 'obsidian_version'
	| 'icloud_offloaded'
	| 'folder_missing'
	| 'scan_missing'
	| 'folder_access'
	| 'drive_error'
	| 'vault_write_failed';

export interface SyncError {
	type: SyncErrorType;
	message: string;
	retriable: boolean;
	retryAfterMs?: number;
	guidance?: string;
}

export function parseRetryAfter(headerValue: string | undefined | null): number | undefined {
	if (!headerValue) {return undefined;}

	// Try seconds format first
	const seconds = Number(headerValue);
	if (!isNaN(seconds) && seconds > 0) {
		return Math.ceil(seconds * 1000);
	}

	// Try HTTP-date format (RFC 7231)
	const date = new Date(headerValue);
	if (!isNaN(date.getTime())) {
		const ms = date.getTime() - Date.now();
		return ms > 0 ? ms : undefined;
	}

	return undefined;
}

export function createSyncError(
	type: SyncErrorType,
	message: string,
	retriable?: boolean,
	retryAfterMs?: number
): SyncError {
	const defaultRetriable: Record<SyncErrorType, boolean> = {
		network_timeout: true,
		rate_limit: true,
		permission_denied: false,
		token_expired: true,
		token_revoked: false,
		schema_mismatch: false,
		obsidian_version: false,
		icloud_offloaded: true,
		folder_missing: false,
		scan_missing: false,
		// Set per errno code by the folder backend (EBUSY retriable, EACCES not).
		folder_access: false,
		// Set per status by the classifier (5xx retriable, other 4xx not).
		drive_error: false,
		vault_write_failed: true,
	};

	return {
		type,
		message,
		retriable: retriable ?? defaultRetriable[type],
		retryAfterMs,
	};
}

// A failed HTTP call to Google, thrown by the Drive backend with what the
// classifier needs: the status, Drive's error reason and the Retry-After header.
export class HttpStatusError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly reason?: string,
		readonly retryAfter?: string
	) {
		super(message);
		this.name = 'HttpStatusError';
	}
}

// Drive reports per-user and per-project quota as 403 with these reasons.
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export function isRateLimitReason(reason: string | undefined): boolean {
	return reason !== undefined && RATE_LIMIT_REASONS.has(reason);
}
