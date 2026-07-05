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
});
