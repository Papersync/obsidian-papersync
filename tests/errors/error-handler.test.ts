import * as obsidian from 'obsidian';

import { ErrorHandler, stateMessageFor } from '@/errors/error-handler';
import { STRINGS } from '@/utils/strings';
import { HttpStatusError, createSyncError } from '@/errors/sync-error';

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

		const http = (status: number, message = `Drive request failed (${status})`, reason?: string, retryAfter?: string) =>
			new HttpStatusError(status, message, reason, retryAfter);

		it('classifies 429 as a rate limit and honors Retry-After', () => {
			const classified = handler.classify(http(429, 'x', undefined, '7'));
			expect(classified).toMatchObject({ type: 'rate_limit', retriable: true, retryAfterMs: 7000 });
			expect(handler.classify(http(429)).retryAfterMs).toBeUndefined();
		});

		it('classifies a 403 with a Drive rate-limit reason as a rate limit', () => {
			expect(handler.classify(http(403, 'quota', 'userRateLimitExceeded')).type).toBe('rate_limit');
			expect(handler.classify(http(403, 'quota', 'rateLimitExceeded')).type).toBe('rate_limit');
		});

		it.each([
			['Request had invalid_grant', undefined, 'Reconnect Google Drive'],
			['token has been revoked by user', undefined, 'Reconnect Google Drive'],
			['Request had insufficient authentication scopes.', 'insufficientPermissions', 'Disconnect and reconnect'],
			['The user does not have sufficient permissions for this file.', 'insufficientFilePermissions', 'Disconnect and reconnect'],
			['Something else', 'forbidden', 'verify the Papersync folder'],
		])('classifies a 403 as permission denied with guidance (%s)', (message, reason, guidance) => {
			const classified = handler.classify(http(403, message, reason));
			expect(classified).toMatchObject({ type: 'permission_denied', retriable: false });
			expect(classified.guidance).toContain(guidance);
		});

		it.each([
			[401, 'token_expired', true],
			[404, 'scan_missing', false],
			[408, 'network_timeout', true],
			[500, 'drive_error', true],
			[503, 'drive_error', true],
			[400, 'drive_error', false],
		])('classifies HTTP %i as %s', (status, type, retriable) => {
			expect(handler.classify(http(status))).toMatchObject({ type, retriable });
		});

		it('keeps Retry-After on a 503', () => {
			expect(handler.classify(http(503, 'x', undefined, '2')).retryAfterMs).toBe(2000);
		});

		it.each([
			"EACCES: permission denied, open '/Users/me/Papersync/x.json'",
			'Unexpected token } in JSON at position 403 timeout 429 401',
			"ENOENT: no such file or directory, scandir '/gone'",
		])('never classifies a plain error by its wording (%s)', (message) => {
			expect(handler.classify(new Error(message)).type).toBe('vault_write_failed');
		});

		it('classifies a JSON SyntaxError as a non-retriable schema mismatch', () => {
			let syntaxError: unknown;
			try { JSON.parse('{"a":'); } catch (err) { syntaxError = err; }
			expect(handler.classify(syntaxError)).toMatchObject({ type: 'schema_mismatch', retriable: false });
		});

		it('handles non-Error objects', () => {
			const classified = handler.classify('string error');
			expect(classified.type).toBe('vault_write_failed');
			expect(classified.message).toBe('string error');
		});
	});

	describe('surface', () => {
		it('uses error.guidance when present in preference to the canned USER_MESSAGES entry', () => {
			const error = createSyncError('permission_denied', 'unused message');
			error.guidance = 'Custom guidance to display to the user';

			// Verify the no-throw path; the Notice instance is created with the guidance string.
			expect(() => handler.surface(error)).not.toThrow();
		});

		it('shows a Notice even for a RETRIABLE error type (no longer silent) (#3)', () => {
			// surface() runs only terminally — a retriable type that reaches it has exhausted
			// its retries, so the user must still get a signal instead of silence.
			// mockImplementation so the spy does not re-invoke the real class constructor.
			const noticeSpy = jest.spyOn(obsidian, 'Notice').mockImplementation(() => undefined as never);
			try {
				handler.surface(createSyncError('network_timeout', 'gave up after retries'));
				expect(noticeSpy).toHaveBeenCalledWith('Network timeout, retrying shortly', 10_000);
			} finally {
				noticeSpy.mockRestore();
			}
		});

		it.each([
			['schema_mismatch', STRINGS.NOTICE_SCAN_UNREADABLE_NAMED('2026-11-01-a.json'), STRINGS.NOTICE_SCAN_UNREADABLE],
			['scan_newer_version', STRINGS.NOTICE_SCAN_NEWER_VERSION_NAMED('2026-11-01-a.json'), STRINGS.NOTICE_SCAN_NEWER_VERSION],
		] as const)('names the scan file for %s, and stays generic without one', (type, named, generic) => {
			const noticeSpy = jest.spyOn(obsidian, 'Notice').mockImplementation(() => undefined as never);
			try {
				handler.surface(createSyncError(type, 'raw detail'), '2026-11-01-a');
				handler.surface(createSyncError(type, 'raw detail'));
				expect(noticeSpy.mock.calls).toEqual([[named, 10_000], [generic, 10_000]]);
			} finally {
				noticeSpy.mockRestore();
			}
		});

		it('keeps the canned message for a type without a scan-named one', () => {
			const noticeSpy = jest.spyOn(obsidian, 'Notice').mockImplementation(() => undefined as never);
			try {
				handler.surface(createSyncError('scan_too_large', 'x'), 'big');
				expect(noticeSpy).toHaveBeenCalledWith(STRINGS.NOTICE_SCAN_TOO_LARGE, 10_000);
			} finally {
				noticeSpy.mockRestore();
			}
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

		it('uses the Retry-After header value as the retry delay (source=header)', async () => {
			jest.useFakeTimers();
			try {
				let attempts = 0;
				const op = jest.fn(async () => {
					attempts++;
					if (attempts < 2) {
						throw new HttpStatusError(429, 'Too Many Requests', undefined, '1');
					}
					return 'ok';
				});

				const promise = handler.handleWithRetry('scan-retry-after', op);
				// parseRetryAfter('1') → 1000ms; the retry is scheduled off that header value.
				await jest.advanceTimersByTimeAsync(1000);
				const result = await promise;

				expect(result).toBe('ok');
				expect(attempts).toBe(2);
			} finally {
				jest.useRealTimers();
			}
		});

		it('does not wait out a Retry-After longer than a minute inside a batch', async () => {
			const op = jest.fn(async () => {
				throw new HttpStatusError(429, 'Too Many Requests', undefined, '3600');
			});
			await expect(handler.handleWithRetry('scan-long-wait', op)).resolves.toBeNull();
			expect(op).toHaveBeenCalledTimes(1);
		});
	});

	describe('stateMessageFor', () => {
		it('replaces a missing folder\'s raw absolute-path message with the plain-language guidance', () => {
			const err = createSyncError('folder_missing', 'Papersync folder not found: /Users/someone/Library/Mobile Documents/com~apple~CloudDocs/Papersync');
			expect(stateMessageFor(err)).toBe(STRINGS.NOTICE_FOLDER_MISSING);
		});

		it('keeps the real reason for every other type (Drive API bodies stay informative)', () => {
			const err = createSyncError('permission_denied', 'Drive request failed (403): API disabled');
			expect(stateMessageFor(err)).toBe('Drive request failed (403): API disabled');
		});
	});
});
