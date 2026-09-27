// The Drive poll interval is read live, so changing it in Settings takes effect
// from the next tick without restarting sync (it used to be fixed at startSync).
import { DriveBackend } from '@/sync/drive-backend';
import type { OAuthManager } from '@/auth/oauth-manager';

function makeBackend(interval: number | (() => number)): { backend: DriveBackend; polls: () => number } {
	const backend = new DriveBackend({} as OAuthManager, interval);
	let count = 0;
	// poll() does network work; only its schedule matters here.
	(backend as unknown as { poll: () => Promise<void> }).poll = () => { count++; return Promise.resolve(); };
	return { backend, polls: () => count };
}

describe('DriveBackend poll interval', () => {
	beforeEach(() => { jest.useFakeTimers(); });
	afterEach(() => { jest.useRealTimers(); });

	it('polls at start and then every interval (fixed number)', () => {
		const { backend, polls } = makeBackend(30);
		backend.start();
		expect(polls()).toBe(1);
		jest.advanceTimersByTime(30_000);
		expect(polls()).toBe(2);
		jest.advanceTimersByTime(30_000);
		expect(polls()).toBe(3);
		backend.stop();
		jest.advanceTimersByTime(120_000);
		expect(polls()).toBe(3);
	});

	it('re-arms at a new interval from the next tick when the setting changes', () => {
		let seconds = 30;
		const { backend, polls } = makeBackend(() => seconds);
		backend.start();
		seconds = 10;
		jest.advanceTimersByTime(30_000); // old rate still due once, then re-armed
		expect(polls()).toBe(2);
		jest.advanceTimersByTime(10_000);
		expect(polls()).toBe(3);
		jest.advanceTimersByTime(10_000);
		expect(polls()).toBe(4);
		backend.stop();
	});

	it('stop() before start() is harmless', () => {
		const { backend } = makeBackend(30);
		expect(() => backend.stop()).not.toThrow();
	});
});
