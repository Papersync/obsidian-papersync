import type { App } from 'obsidian';
import { logger } from '@/utils/logger';
import { errorMessage } from '@/utils/error-message';

// Guarded wrappers around Obsidian's secret storage (app.secretStorage, 1.11.4+).
// Obsidian keeps secrets in its own app data, encrypted with an OS-protected key
// where the OS offers one and unencrypted where it does not; the public API gives
// no way to tell which. Every secretStorage access goes through these so an absent
// or throwing backend degrades to "not stored / not found" and never crashes plugin
// load or a token change — Drive simply requires a re-connect. The public API is
// synchronous and has no deleteSecret: clear a secret by writing an empty string.

// True when the backend read back exactly what we asked it to store. Clearing a
// token (value === "") has no deleteSecret in the public API, so an empty read OR
// a null (absent) reading both count as cleared.
export function isSecretPersisted(written: string, readBack: string | null): boolean {
	return written === '' ? readBack === '' || readBack === null : readBack === written;
}

// Hands `value` to secret storage under `id` and reads it back. getSecret answers
// from Obsidian's in-memory copy, so a match proves Obsidian accepted the value, NOT
// that it reached disk or was encrypted. Returns false when setSecret throws or the
// value does not read back.
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
