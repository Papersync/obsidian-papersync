// The Drive poll interval is read from a supplier, and reschedule() re-arms at a
// newly committed value at once, without restarting sync (it used to be fixed at
// startSync).
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

	it('reschedule() re-arms at a new interval at once, not after the old one', () => {
		let seconds = 600;
		const { backend, polls } = makeBackend(() => seconds);
		backend.start();
		seconds = 10;
		backend.reschedule();
		jest.advanceTimersByTime(10_000);
		expect(polls()).toBe(2);
		jest.advanceTimersByTime(10_000);
		expect(polls()).toBe(3);
		backend.stop();
	});

	it('reschedule() keeps the running timer when the interval is unchanged', () => {
		const { backend, polls } = makeBackend(30);
		backend.start();
		jest.advanceTimersByTime(20_000);
		backend.reschedule();
		jest.advanceTimersByTime(10_000); // still due at 30 s, not pushed to 50 s
		expect(polls()).toBe(2);
		backend.stop();
	});

	it('reschedule() does not start a stopped backend', () => {
		const { backend, polls } = makeBackend(30);
		backend.reschedule();
		jest.advanceTimersByTime(120_000);
		expect(polls()).toBe(0);
	});

	it('caps the interval at one day so the timer cannot overflow', () => {
		const { backend, polls } = makeBackend(99_999_999);
		backend.start();
		jest.advanceTimersByTime(1_000);
		expect(polls()).toBe(1); // no 1 ms overflow loop
		jest.advanceTimersByTime(86_400_000);
		expect(polls()).toBe(2);
		backend.stop();
	});

	it('stop() before start() is harmless', () => {
		const { backend } = makeBackend(30);
		expect(() => backend.stop()).not.toThrow();
	});
});

describe('DriveBackend poll interval bounds', () => {
	beforeEach(() => { jest.useFakeTimers(); });
	afterEach(() => { jest.useRealTimers(); });

	it('never polls faster than the minimum, even for a zero or NaN interval', () => {
		for (const interval of [0, Number.NaN, -1]) {
			const { backend, polls } = makeBackend(interval);
			backend.start();
			jest.advanceTimersByTime(4_999);
			expect(polls()).toBe(1);
			backend.stop();
		}
	});
});

describe('DriveBackend overlapping polls', () => {
	it('skips a poll while the previous one is still running', async () => {
		let finish!: () => void;
		const oauth = { getValidAccessToken: jest.fn(() => new Promise<string>((resolve) => { finish = () => resolve('t'); })) };
		const backend = new DriveBackend(oauth as unknown as OAuthManager, 30);
		const poll = (): Promise<void> => (backend as unknown as { poll: () => Promise<void> }).poll();
		const first = poll();
		await poll();
		expect(oauth.getValidAccessToken).toHaveBeenCalledTimes(1);
		finish();
		await first; // fails later on the unmocked request; only the overlap matters
	});
});
