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

// Persists `value` under `id`. Returns true only after a confirmed write, so a
// caller can safely strip a plaintext copy only once the secret is stored.
export function writeSecret(app: App, id: string, value: string): boolean {
	try {
		app.secretStorage.setSecret(id, value);
		return true;
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
