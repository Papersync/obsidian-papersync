import { DEFAULT_POLL_INTERVAL_S, MAX_POLL_INTERVAL_S, MIN_POLL_INTERVAL_S } from '@/config';

/** A Drive poll interval in whole seconds, always inside the supported range. */
export function clampPollInterval(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULT_POLL_INTERVAL_S;
	}
	return Math.min(MAX_POLL_INTERVAL_S, Math.max(MIN_POLL_INTERVAL_S, Math.round(value)));
}
