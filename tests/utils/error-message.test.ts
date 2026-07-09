import { errorMessage } from '@/utils/error-message';

describe('errorMessage', () => {
	it('returns the message of an Error instance', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
	});

	it('stringifies a non-Error value', () => {
		expect(errorMessage('plain string')).toBe('plain string');
		expect(errorMessage(42)).toBe('42');
		expect(errorMessage(null)).toBe('null');
	});

	it('surfaces .message from a message-carrying plain object (SyncError shape)', () => {
		// SyncError is a plain object, not an Error subclass. Pre-fix this rendered
		// as "[object Object]" in user-facing notices (found by the fake-Google E2E
		// lane: the Connect-failure notice).
		expect(errorMessage({ type: 'token_revoked', message: 'Google OAuth error: bad code', retriable: false }))
			.toBe('Google OAuth error: bad code');
	});

	it('stringifies objects whose message is missing or not a string', () => {
		expect(errorMessage({})).toBe('[object Object]');
		expect(errorMessage({ message: 42 })).toBe('[object Object]');
	});

	it('falls through to String() for an empty-string message (never surfaces a blank notice)', () => {
		expect(errorMessage({ message: '' })).toBe('[object Object]');
	});

	it('degrades to Unknown error when the message getter itself throws', () => {
		const hostile = {
			get message(): string {
				throw new Error('gotcha');
			},
		};
		expect(errorMessage(hostile)).toBe('Unknown error');
	});

	it('degrades to Unknown error for a null-prototype object (String() throws on it)', () => {
		expect(errorMessage(Object.create(null))).toBe('Unknown error');
	});

	it('still surfaces a valid message carried by a null-prototype object', () => {
		const err = Object.assign(Object.create(null) as Record<string, unknown>, { message: 'still readable' });
		expect(errorMessage(err)).toBe('still readable');
	});
});
