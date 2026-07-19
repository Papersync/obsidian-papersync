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
		vault_write_failed: true,
	};

	return {
		type,
		message,
		retriable: retriable ?? defaultRetriable[type],
		retryAfterMs,
	};
}
