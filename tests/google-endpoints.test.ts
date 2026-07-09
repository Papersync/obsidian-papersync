// The endpointOverrides seam must never be able to steer OAuth/Drive traffic at an
// arbitrary host — a tampered data.json would otherwise redirect the auth code,
// client secret, and tokens. An override is honored only when it is a non-empty,
// parseable URL whose hostname is loopback; every other shape silently falls back
// to the production default for that key.

import { resolveGoogleEndpoint } from '@/google-endpoints';
import { DEFAULT_GOOGLE_ENDPOINTS } from '@/config';

describe('resolveGoogleEndpoint', () => {
	it('falls back to the default when no overrides object exists', () => {
		expect(resolveGoogleEndpoint('tokenUrl', undefined)).toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('falls back to the default when the key is absent from the overrides', () => {
		expect(resolveGoogleEndpoint('tokenUrl', { authUrl: 'http://127.0.0.1:9/auth' }))
			.toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('falls back to the default for an empty-string override (pre-gate this crashed new URL(""))', () => {
		expect(resolveGoogleEndpoint('authUrl', { authUrl: '' })).toBe(DEFAULT_GOOGLE_ENDPOINTS.authUrl);
	});

	it('falls back to the default for a malformed override URL', () => {
		expect(resolveGoogleEndpoint('driveApiBase', { driveApiBase: 'not a url' }))
			.toBe(DEFAULT_GOOGLE_ENDPOINTS.driveApiBase);
	});

	it('falls back to the default for a non-loopback host (credential-redirect hardening)', () => {
		expect(resolveGoogleEndpoint('tokenUrl', { tokenUrl: 'https://attacker.example.com/token' }))
			.toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('falls back for a lookalike host that merely contains a loopback substring', () => {
		expect(resolveGoogleEndpoint('tokenUrl', { tokenUrl: 'https://127.0.0.1.evil.example/token' }))
			.toBe(DEFAULT_GOOGLE_ENDPOINTS.tokenUrl);
	});

	it('honors a loopback http override on 127.0.0.1', () => {
		expect(resolveGoogleEndpoint('tokenUrl', { tokenUrl: 'http://127.0.0.1:8123/token' }))
			.toBe('http://127.0.0.1:8123/token');
	});

	it('honors localhost and [::1] loopback hosts', () => {
		expect(resolveGoogleEndpoint('authUrl', { authUrl: 'http://localhost:8123/auth' }))
			.toBe('http://localhost:8123/auth');
		expect(resolveGoogleEndpoint('driveUploadBase', { driveUploadBase: 'http://[::1]:8123/upload/drive/v3' }))
			.toBe('http://[::1]:8123/upload/drive/v3');
	});
});
