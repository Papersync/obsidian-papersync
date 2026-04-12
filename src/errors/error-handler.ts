import { Notice } from 'obsidian';
import type { SyncErrorType } from '@/errors/sync-error';
import type { SyncError } from '@/errors/sync-error';
import { createSyncError } from '@/errors/sync-error';
import { logger } from '@/utils/logger';
import { STRINGS } from '@/utils/strings';

const MAX_RETRIES = 2;
const BACKOFF_MS = [1000, 3000] as const;

const USER_MESSAGES: Record<SyncErrorType, string> = {
	network_timeout: 'Network timeout — will retry',
	rate_limit: 'Rate limited — backing off',
	permission_denied: STRINGS.NOTICE_DRIVE_PERMISSION,
	token_expired: STRINGS.NOTICE_TOKEN_EXPIRED,
	token_revoked: STRINGS.NOTICE_TOKEN_EXPIRED,
	schema_mismatch: STRINGS.NOTICE_SCHEMA_MISMATCH,
	obsidian_version: STRINGS.NOTICE_OBSIDIAN_VERSION,
	icloud_offloaded: STRINGS.NOTICE_DOWNLOADING_OFFLOADED,
	vault_write_failed: 'Failed to write note to vault',
};

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
				const delay = BACKOFF_MS[retryCount] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
				logger.warn(`Retry ${retryCount + 1}/${MAX_RETRIES} for ${scanId} after ${delay}ms: ${syncError.message}`);
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

		if (err instanceof Error) {
			const msg = err.message.toLowerCase();
			if (msg.includes('timeout') || msg.includes('timed out')) {
				return createSyncError('network_timeout', err.message);
			}
			if (msg.includes('429') || msg.includes('rate limit')) {
				return createSyncError('rate_limit', err.message);
			}
			if (msg.includes('403') || msg.includes('permission')) {
				return createSyncError('permission_denied', err.message);
			}
			if (msg.includes('401') || msg.includes('unauthorized')) {
				return createSyncError('token_expired', err.message);
			}
			return createSyncError('vault_write_failed', err.message);
		}

		return createSyncError('vault_write_failed', String(err));
	}

	surface(error: SyncError): void {
		const userMessage = USER_MESSAGES[error.type];
		logger.error(`${error.type}: ${error.message}`);

		if (!error.retriable) {
			new Notice(userMessage, 10_000);
		}
	}

	resetRetries(): void {
		this.retryCountMap.clear();
	}
}

function isSyncError(err: unknown): err is SyncError {
	return (
		typeof err === 'object' &&
		err !== null &&
		'type' in err &&
		'message' in err &&
		'retriable' in err
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
