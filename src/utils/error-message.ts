/**
 * Extracts a human-readable message from an unknown thrown value.
 * `Error` instances and message-carrying plain objects (SyncError is a plain
 * object, not an Error subclass — String() on it yields "[object Object]")
 * surface their non-empty `.message`; anything else is coerced with `String()`.
 * The whole body is guarded because this runs inside catch paths: a throwing
 * `message` getter, or a null-prototype value (where `String(err)` itself
 * throws), degrades to 'Unknown error' instead of throwing again.
 */
export function errorMessage(err: unknown): string {
	try {
		if (err instanceof Error) {return err.message;}
		if (typeof err === 'object' && err !== null) {
			const message = (err as { message?: unknown }).message;
			if (typeof message === 'string' && message !== '') {return message;}
		}
		return String(err);
	} catch {
		return 'Unknown error';
	}
}
