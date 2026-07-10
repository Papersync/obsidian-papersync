import { SecretStorage } from 'obsidian';
import type { App } from 'obsidian';
import { isSecretPersisted, readSecret, writeSecret } from '@/auth/secret-store';
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

// Flip the mock's silent-no-op flag: setSecret returns without storing (a locked
// backend that quietly drops the write), so the read-back verify must catch it.
function makeSilentNoop(storage: SecretStorage): void {
	(storage as unknown as { silentNoop: boolean }).silentNoop = true;
}

describe('secret-store guarded wrappers', () => {
	beforeEach(() => {
		clearLogBuffer();
	});

	describe('isSecretPersisted', () => {
		it('confirms a non-empty write only when the read-back matches exactly', () => {
			expect(isSecretPersisted('refresh-abc', 'refresh-abc')).toBe(true);
			expect(isSecretPersisted('refresh-abc', 'refresh-xyz')).toBe(false);
			expect(isSecretPersisted('refresh-abc', null)).toBe(false);
		});

		it('accepts an empty OR null read-back as a durable clear (no deleteSecret at 1.11.4)', () => {
			expect(isSecretPersisted('', '')).toBe(true);
			expect(isSecretPersisted('', null)).toBe(true);
			expect(isSecretPersisted('', 'leftover')).toBe(false);
		});
	});

	describe('writeSecret', () => {
		it('stores the value and returns true on success', () => {
			const { app, storage } = makeApp();

			const ok = writeSecret(app, 'papersync-oauth-refresh-token', 'refresh-abc');

			expect(ok).toBe(true);
			expect(storage.getSecret('papersync-oauth-refresh-token')).toBe('refresh-abc');
		});

		it('confirms a clear (empty value) once the secret reads back empty', () => {
			const { app, storage } = makeApp();
			storage.setSecret('papersync-oauth-refresh-token', 'refresh-abc');

			const ok = writeSecret(app, 'papersync-oauth-refresh-token', '');

			expect(ok).toBe(true);
			expect(storage.getSecret('papersync-oauth-refresh-token')).toBe('');
		});

		it('returns false and logs when the write silently no-ops (read-back mismatch)', () => {
			const { app, storage } = makeApp();
			makeSilentNoop(storage);

			const ok = writeSecret(app, 'papersync-oauth-refresh-token', 'refresh-abc');

			expect(ok).toBe(false);
			expect(getLogBuffer().some((l) => l.includes('write unverified'))).toBe(true);
			expect(storage.getSecret('papersync-oauth-refresh-token')).toBeNull(); // nothing landed
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
