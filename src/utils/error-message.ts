/**
 * Extracts a human-readable message from an unknown thrown value.
 * `Error` instances yield their `.message`; anything else is coerced with `String()`.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
