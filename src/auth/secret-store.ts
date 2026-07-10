import type { App } from 'obsidian';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

// Guarded wrappers around Obsidian's OS-integrated Secret Storage
// (macOS Keychain / Windows Credential Manager / Linux Secret Service). Every
// secretStorage access goes through these so an absent or throwing backend
// (headless CI without a Secret Service, a locked keychain) degrades to
// "not stored / not found" and never crashes plugin load or a token change —
// Drive simply requires a re-connect. The 1.11.4+ API is synchronous and has no
// deleteSecret: clear a secret by writing an empty string.

// True when the backend read back exactly what we asked it to store. Clearing a
// token (value === "") has no deleteSecret at the 1.11.4 floor, so an empty read OR
// a null (absent) reading both count as a durable clear.
export function isSecretPersisted(written: string, readBack: string | null): boolean {
	return written === '' ? readBack === '' || readBack === null : readBack === written;
}

// Persists `value` under `id` and READ-BACK VERIFIES it — "setSecret didn't throw" is
// not proof of a durable write, because an unavailable or locked backend can silently
// no-op. Returns true only when the stored value reads back, so a caller can trust the
// token actually landed in the OS credential vault.
export function writeSecret(app: App, id: string, value: string): boolean {
	try {
		app.secretStorage.setSecret(id, value);
		if (isSecretPersisted(value, app.secretStorage.getSecret(id))) {
			return true;
		}
		logger.error(`Secret storage write unverified for "${id}" (read-back mismatch)`);
		return false;
	} catch (err) {
		logger.error(`Secret storage write failed for "${id}": ${errorMessage(err)}`);
		return false;
	}
}

// Reads the secret under `id`, or null when absent or the backend is unavailable.
export function readSecret(app: App, id: string): string | null {
	try {
		return app.secretStorage.getSecret(id);
	} catch (err) {
		logger.error(`Secret storage read failed for "${id}": ${errorMessage(err)}`);
		return null;
	}
}
