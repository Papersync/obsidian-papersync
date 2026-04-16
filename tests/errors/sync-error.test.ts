import { createSyncError, parseRetryAfter } from '@/errors/sync-error';

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

	it('includes retryAfterMs when provided', () => {
		const error = createSyncError('rate_limit', '429', undefined, 10000);
		expect(error.retryAfterMs).toBe(10000);
	});
});

describe('parseRetryAfter', () => {
	it('parses seconds-based Retry-After header', () => {
		expect(parseRetryAfter('10')).toBe(10000);
	});

	it('parses decimal seconds', () => {
		expect(parseRetryAfter('1.5')).toBe(1500);
	});

	it('returns undefined for missing header', () => {
		expect(parseRetryAfter(undefined)).toBeUndefined();
		expect(parseRetryAfter(null)).toBeUndefined();
		expect(parseRetryAfter('')).toBeUndefined();
	});

	it('returns undefined for zero or negative seconds', () => {
		expect(parseRetryAfter('0')).toBeUndefined();
		expect(parseRetryAfter('-5')).toBeUndefined();
	});

	it('returns undefined for unparseable value', () => {
		expect(parseRetryAfter('not-a-number')).toBeUndefined();
	});

	it('parses HTTP-date format Retry-After header', () => {
		const future = new Date(Date.now() + 60000).toUTCString();
		const result = parseRetryAfter(future);
		expect(result).toBeGreaterThan(50000);
		expect(result).toBeLessThanOrEqual(60000);
	});

	it('returns undefined for past HTTP-date', () => {
		const past = new Date(Date.now() - 60000).toUTCString();
		expect(parseRetryAfter(past)).toBeUndefined();
	});
});
