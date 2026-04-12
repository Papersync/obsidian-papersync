import { createSyncError } from '@/errors/sync-error';

describe('createSyncError', () => {
	it('creates a retriable network_timeout error by default', () => {
		const error = createSyncError('network_timeout', 'timed out');
		expect(error.type).toBe('network_timeout');
		expect(error.message).toBe('timed out');
		expect(error.retriable).toBe(true);
	});

	it('creates a non-retriable permission_denied error by default', () => {
		const error = createSyncError('permission_denied', 'forbidden');
		expect(error.retriable).toBe(false);
	});

	it('creates a non-retriable schema_mismatch error by default', () => {
		const error = createSyncError('schema_mismatch', 'unknown version');
		expect(error.retriable).toBe(false);
	});

	it('allows overriding the default retriable flag', () => {
		const error = createSyncError('network_timeout', 'timed out', false);
		expect(error.retriable).toBe(false);
	});

	it('creates all error types with correct defaults', () => {
		const retriableTypes = ['network_timeout', 'rate_limit', 'token_expired', 'icloud_offloaded', 'vault_write_failed'] as const;
		const nonRetriableTypes = ['permission_denied', 'token_revoked', 'schema_mismatch', 'obsidian_version'] as const;

		for (const type of retriableTypes) {
			expect(createSyncError(type, 'test').retriable).toBe(true);
		}
		for (const type of nonRetriableTypes) {
			expect(createSyncError(type, 'test').retriable).toBe(false);
		}
	});
});
