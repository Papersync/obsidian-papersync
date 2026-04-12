import { generateCodeVerifier, computeCodeChallenge } from '@/auth/pkce';

describe('generateCodeVerifier', () => {
	it('returns a non-empty string', () => {
		const verifier = generateCodeVerifier();
		expect(verifier.length).toBeGreaterThan(0);
	});

	it('returns different values on each call', () => {
		const a = generateCodeVerifier();
		const b = generateCodeVerifier();
		expect(a).not.toBe(b);
	});

	it('produces a base64url-safe string (no +, /, or = characters)', () => {
		const verifier = generateCodeVerifier();
		expect(verifier).not.toMatch(/[+/=]/);
	});
});

describe('computeCodeChallenge', () => {
	it('returns a non-empty string', async () => {
		const verifier = generateCodeVerifier();
		const challenge = await computeCodeChallenge(verifier);
		expect(challenge.length).toBeGreaterThan(0);
	});

	it('produces a base64url-safe string', async () => {
		const challenge = await computeCodeChallenge('test-verifier');
		expect(challenge).not.toMatch(/[+/=]/);
	});

	it('produces the same challenge for the same verifier', async () => {
		const verifier = 'deterministic-test-verifier';
		const a = await computeCodeChallenge(verifier);
		const b = await computeCodeChallenge(verifier);
		expect(a).toBe(b);
	});

	it('produces different challenges for different verifiers', async () => {
		const a = await computeCodeChallenge('verifier-one');
		const b = await computeCodeChallenge('verifier-two');
		expect(a).not.toBe(b);
	});
});
