export type SyncErrorType =
	| 'network_timeout'
	| 'rate_limit'
	| 'permission_denied'
	| 'token_expired'
	| 'token_revoked'
	| 'schema_mismatch'
	| 'obsidian_version'
	| 'icloud_offloaded'
	| 'vault_write_failed';

export interface SyncError {
	type: SyncErrorType;
	message: string;
	retriable: boolean;
}

export function createSyncError(
	type: SyncErrorType,
	message: string,
	retriable?: boolean
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
		vault_write_failed: true,
	};

	return {
		type,
		message,
		retriable: retriable ?? defaultRetriable[type],
	};
}
