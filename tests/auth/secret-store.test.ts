import { SecretStorage } from 'obsidian';
import type { App } from 'obsidian';
import { readSecret, writeSecret } from '@/auth/secret-store';
import { clearLogBuffer, getLogBuffer } from '@/utils/logger';

function makeApp(): { app: App; storage: SecretStorage } {
	const storage = new SecretStorage();
	const app = { secretStorage: storage } as unknown as App;
	return { app, storage };
}

// Flip the mock's force-throw flag to simulate an absent/throwing OS backend.
function makeUnavailable(storage: SecretStorage): void {
	(storage as unknown as { unavailable: boolean }).unavailable = true;
}

describe('secret-store guarded wrappers', () => {
	beforeEach(() => {
		clearLogBuffer();
	});

	describe('writeSecret', () => {
		it('stores the value and returns true on success', () => {
			const { app, storage } = makeApp();

			const ok = writeSecret(app, 'papersync-oauth-refresh-token', 'refresh-abc');

			expect(ok).toBe(true);
			expect(storage.getSecret('papersync-oauth-refresh-token')).toBe('refresh-abc');
		});

		it('returns false and logs when the backend throws', () => {
			const { app, storage } = makeApp();
			makeUnavailable(storage);

			const ok = writeSecret(app, 'papersync-oauth-refresh-token', 'refresh-abc');

			expect(ok).toBe(false);
			expect(getLogBuffer().some((l) => l.includes('Secret storage write failed'))).toBe(true);
		});
	});

	describe('readSecret', () => {
		it('returns the stored value', () => {
			const { app } = makeApp();
			writeSecret(app, 'papersync-oauth-refresh-token', 'refresh-xyz');

			expect(readSecret(app, 'papersync-oauth-refresh-token')).toBe('refresh-xyz');
		});

		it('returns null when the secret is absent', () => {
			const { app } = makeApp();

			expect(readSecret(app, 'papersync-oauth-refresh-token')).toBeNull();
		});

		it('returns null and logs when the backend throws', () => {
			const { app, storage } = makeApp();
			makeUnavailable(storage);

			const value = readSecret(app, 'papersync-oauth-refresh-token');

			expect(value).toBeNull();
			expect(getLogBuffer().some((l) => l.includes('Secret storage read failed'))).toBe(true);
		});
	});
});
