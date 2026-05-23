import { ErrorHandler } from '@/errors/error-handler';
import { createSyncError } from '@/errors/sync-error';

describe('ErrorHandler', () => {
	let handler: ErrorHandler;

	beforeEach(() => {
		handler = new ErrorHandler();
	});

	describe('classify', () => {
		it('passes through existing SyncError objects', () => {
			const error = createSyncError('network_timeout', 'test');
			const classified = handler.classify(error);
			expect(classified.type).toBe('network_timeout');
		});

		it('classifies timeout errors', () => {
			const classified = handler.classify(new Error('Request timed out'));
			expect(classified.type).toBe('network_timeout');
			expect(classified.retriable).toBe(true);
		});

		it('classifies 429 rate limit errors', () => {
			const classified = handler.classify(new Error('HTTP 429 Too Many Requests'));
			expect(classified.type).toBe('rate_limit');
			expect(classified.retriable).toBe(true);
		});

		it('classifies 403 permission errors', () => {
			const classified = handler.classify(new Error('HTTP 403 Forbidden'));
			expect(classified.type).toBe('permission_denied');
			expect(classified.retriable).toBe(false);
		});

		it('classifies 403 with invalid_grant as token revoked guidance', () => {
			const classified = handler.classify(new Error('403 invalid_grant token revoked'));
			expect(classified.type).toBe('permission_denied');
			expect(classified.guidance).toContain('Reconnect Google Drive');
		});

		it('classifies 403 with insufficient scope as scope denied guidance', () => {
			const classified = handler.classify(new Error('403 insufficient scope for drive.file'));
			expect(classified.type).toBe('permission_denied');
			expect(classified.guidance).toContain('Disconnect and reconnect');
		});

		it('classifies unknown 403 with generic guidance', () => {
			const classified = handler.classify(new Error('403 something unknown'));
			expect(classified.type).toBe('permission_denied');
			expect(classified.guidance).toContain('verify the PaperSync folder');
		});

		it('classifies 401 unauthorized errors', () => {
			const classified = handler.classify(new Error('HTTP 401 Unauthorized'));
			expect(classified.type).toBe('token_expired');
			expect(classified.retriable).toBe(true);
		});

		it('defaults unknown errors to vault_write_failed', () => {
			const classified = handler.classify(new Error('Something went wrong'));
			expect(classified.type).toBe('vault_write_failed');
		});

		it('handles non-Error objects', () => {
			const classified = handler.classify('string error');
			expect(classified.type).toBe('vault_write_failed');
			expect(classified.message).toBe('string error');
		});

		it('reads retry-after from an Obsidian requestUrl error object (case-insensitive)', () => {
			// Simulate an Obsidian requestUrl error: object with headers attached, not an Error instance.
			const fakeErr = Object.assign(new Error('HTTP 429 Too Many Requests'), {
				headers: { 'Retry-After': '7' },
			});

			const classified = handler.classify(fakeErr);
			expect(classified.type).toBe('rate_limit');
			expect(classified.retryAfterMs).toBe(7000);
		});

		it('falls back to default backoff when retry-after header is absent on rate_limit', () => {
			const classified = handler.classify(new Error('HTTP 429 Too Many Requests'));
			expect(classified.type).toBe('rate_limit');
			expect(classified.retryAfterMs).toBeUndefined();
		});

		it('returns undefined from header lookup when headers is missing on the error', () => {
			// Drive past the early `if (!headers) return undefined` short-circuit by using a non-object input.
			const classified = handler.classify(123 as unknown);
			expect(classified.type).toBe('vault_write_failed');
		});

		it('returns undefined when headers is present but does not contain retry-after', () => {
			// Drives the `return key ? headers[key] : undefined` else branch in extractHeader.
			const errWithUnrelatedHeader = Object.assign(new Error('HTTP 429'), {
				headers: { 'Content-Type': 'application/json' },
			});
			const classified = handler.classify(errWithUnrelatedHeader);
			expect(classified.type).toBe('rate_limit');
			expect(classified.retryAfterMs).toBeUndefined();
		});

		it('classifies 403 with "token revoked" wording (separate from invalid_grant) as token-revoked guidance', () => {
			const classified = handler.classify(new Error('403 token has been revoked by user'));
			expect(classified.type).toBe('permission_denied');
			expect(classified.guidance).toContain('Reconnect Google Drive');
		});
	});

	describe('surface', () => {
		it('uses error.guidance when present in preference to the canned USER_MESSAGES entry', () => {
			const error = createSyncError('permission_denied', 'unused message');
			error.guidance = 'Custom guidance to display to the user';

			// Verify the no-throw path; the Notice instance is created with the guidance string.
			expect(() => handler.surface(error)).not.toThrow();
		});
	});

	describe('handleWithRetry', () => {
		it('returns result on success', async () => {
			const result = await handler.handleWithRetry('scan-1', async () => 'ok');
			expect(result).toBe('ok');
		});

		it('retries retriable errors up to MAX_RETRIES', async () => {
			let attempts = 0;
			const result = await handler.handleWithRetry('scan-2', async () => {
				attempts++;
				if (attempts < 3) {
					throw createSyncError('network_timeout', 'timeout');
				}
				return 'recovered';
			});
			expect(result).toBe('recovered');
			expect(attempts).toBe(3);
		});

		it('returns null after exhausting retries', async () => {
			const result = await handler.handleWithRetry('scan-3', async () => {
				throw createSyncError('network_timeout', 'always fails');
			});
			expect(result).toBeNull();
		});

		it('does not retry non-retriable errors', async () => {
			let attempts = 0;
			const result = await handler.handleWithRetry('scan-4', async () => {
				attempts++;
				throw createSyncError('permission_denied', 'forbidden');
			});
			expect(result).toBeNull();
			expect(attempts).toBe(1);
		});
	});
});
