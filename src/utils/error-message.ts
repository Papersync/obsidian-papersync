/**
 * Extracts a human-readable message from an unknown thrown value.
 * `Error` instances and message-carrying plain objects (SyncError is a plain
 * object, not an Error subclass — String() on it yields "[object Object]")
 * surface their `.message`; anything else is coerced with `String()`.
 */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) {return err.message;}
	if (typeof err === 'object' && err !== null) {
		const message = (err as { message?: unknown }).message;
		if (typeof message === 'string') {return message;}
	}
	return String(err);
}
