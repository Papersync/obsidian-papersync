import { DEFAULT_GOOGLE_ENDPOINTS } from '@/config';
import type { GoogleEndpoints } from '@/config';

// Resolved at CALL time (not construction): both consumers (OAuthManager and
// DriveBackend) are handed a supplier, so a late-written settings.endpointOverrides
// still takes effect AND the two can never split-brain across different snapshots
// of the same seam (token grant to one host, Drive calls to another).
export type GoogleEndpointsSupplier = () => Partial<GoogleEndpoints> | undefined;

// The endpointOverrides seam exists solely so E2E can point the plugin at an
// in-repo fake on loopback (test/e2e/fake-google.ts). Honoring arbitrary hosts
// would let a tampered data.json silently redirect the OAuth code, client secret,
// and tokens to an attacker, so an override is used ONLY when it is a non-empty,
// parseable URL whose hostname is loopback; anything else silently falls back to
// the production default for that key.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export function resolveGoogleEndpoint(
	key: keyof GoogleEndpoints,
	overrides: Partial<GoogleEndpoints> | undefined
): string {
	const value = overrides?.[key];
	if (!value || !URL.canParse(value)) {
		return DEFAULT_GOOGLE_ENDPOINTS[key];
	}
	return LOOPBACK_HOSTNAMES.has(new URL(value).hostname) ? value : DEFAULT_GOOGLE_ENDPOINTS[key];
}
