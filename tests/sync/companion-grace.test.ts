import { CompanionGrace } from '@/sync/companion-grace';

describe('companion arrival grace', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(new Date('2026-10-03T12:00:00Z'));
	});
	afterEach(() => jest.useRealTimers());

	it('keeps old scans eligible from first local discovery', () => {
		const grace = new CompanionGrace(jest.fn());
		expect(grace.defer('old')).toBe(true);
		expect(grace.pendingCount).toBe(1);
		grace.complete('old');
		grace.resume();
		grace.pause();
		expect(jest.getTimerCount()).toBe(0);
	});

	it('rechecks a fresh upload at the deadline, without resetting its window', async () => {
		const retry = jest.fn().mockResolvedValue(undefined);
		const grace = new CompanionGrace(retry);
		expect(grace.defer('new')).toBe(true);
		expect(grace.defer('new')).toBe(true);
		expect(grace.pendingCount).toBe(1);
		await jest.advanceTimersByTimeAsync(60_000);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(grace.defer('new')).toBe(false);
		grace.complete('new');
		await jest.advanceTimersByTimeAsync(1000);
		expect(grace.pendingCount).toBe(0);
		expect(jest.getTimerCount()).toBe(0);
	});

	it('caps future clock skew, pauses on stop/offline and resumes pending scans', async () => {
		const grace = new CompanionGrace(jest.fn().mockResolvedValue(undefined));
		grace.pause();
		grace.defer('future');
		expect(jest.getTimerCount()).toBe(0);
		grace.resume();
		expect(jest.getTimerCount()).toBe(1);
		grace.pause();
		expect(jest.getTimerCount()).toBe(0);
		await jest.advanceTimersByTimeAsync(60_000);
		expect(grace.defer('future')).toBe(false);
		grace.complete('future');
	});
});

it('drops pending companions when their JSON disappears from discovery', async () => {
	jest.useFakeTimers();
	const retry = jest.fn().mockResolvedValue(undefined);
	const grace = new CompanionGrace(retry);
	grace.defer('gone');
	grace.defer('kept');
	grace.retain(['kept']);
	expect(grace.pendingCount).toBe(1);
	grace.retain([]);
	await jest.advanceTimersByTimeAsync(60_000);
	expect(grace.pendingCount).toBe(0);
	expect(jest.getTimerCount()).toBe(0);
	jest.useRealTimers();
});
