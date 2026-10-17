import { CompanionGrace, COMPANION_GRACE_MS, DRIVE_COMPANION_GRACE_MS } from '@/sync/companion-grace';

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

describe('Drive grace measured from the JSON createdTime', () => {
	const T0 = new Date('2026-10-17T12:00:00Z').getTime();
	const drive = (uploadedAt?: string) => ({ windowMs: DRIVE_COMPANION_GRACE_MS, uploadedAt });
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => jest.useRealTimers());

	it('is about 5 minutes, longer than the folder grace', () => {
		expect(DRIVE_COMPANION_GRACE_MS).toBe(300_000);
		expect(COMPANION_GRACE_MS).toBe(60_000);
	});

	it('keeps waiting just under 5 minutes after upload and gives up at 5 minutes', () => {
		const grace = new CompanionGrace(jest.fn());
		// First seen 2 min after upload: the window still ends at upload + 5 min.
		jest.setSystemTime(T0 + 120_000);
		expect(grace.defer('s', drive(new Date(T0).toISOString()))).toBe(true);
		jest.setSystemTime(T0 + DRIVE_COMPANION_GRACE_MS - 1);
		expect(grace.defer('s', drive(new Date(T0).toISOString()))).toBe(true);
		jest.setSystemTime(T0 + DRIVE_COMPANION_GRACE_MS);
		expect(grace.defer('s', drive(new Date(T0).toISOString()))).toBe(false);
		grace.complete('s');
	});

	it('rechecks at upload + 5 minutes, not first sight + 5 minutes', async () => {
		const retry = jest.fn().mockResolvedValue(undefined);
		const grace = new CompanionGrace(retry);
		jest.setSystemTime(T0 + 120_000);
		grace.defer('s', drive(new Date(T0).toISOString()));
		await jest.advanceTimersByTimeAsync(180_000 - 1);
		expect(retry).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(1);
		expect(retry).toHaveBeenCalledTimes(1);
		grace.complete('s');
	});

	it('never waits less than the first-sight floor for a long-past upload', () => {
		const grace = new CompanionGrace(jest.fn());
		jest.setSystemTime(T0 + 3_600_000);
		expect(grace.defer('old', drive(new Date(T0).toISOString()))).toBe(true);
		jest.setSystemTime(T0 + 3_600_000 + COMPANION_GRACE_MS - 1);
		expect(grace.defer('old', drive())).toBe(true);
		jest.setSystemTime(T0 + 3_600_000 + COMPANION_GRACE_MS);
		expect(grace.defer('old', drive())).toBe(false);
		grace.complete('old');
	});

	it('caps a createdTime ahead of the local clock at 5 minutes from now', () => {
		const grace = new CompanionGrace(jest.fn());
		jest.setSystemTime(T0);
		expect(grace.defer('skew', drive(new Date(T0 + 86_400_000).toISOString()))).toBe(true);
		jest.setSystemTime(T0 + DRIVE_COMPANION_GRACE_MS);
		expect(grace.defer('skew', drive())).toBe(false);
		grace.complete('skew');
	});

	it.each([undefined, '', 'not-a-date'])('falls back to first sight + 5 minutes for createdTime %p', (bad) => {
		const grace = new CompanionGrace(jest.fn());
		jest.setSystemTime(T0);
		expect(grace.defer('bad', drive(bad))).toBe(true);
		jest.setSystemTime(T0 + DRIVE_COMPANION_GRACE_MS - 1);
		expect(grace.defer('bad', drive(bad))).toBe(true);
		jest.setSystemTime(T0 + DRIVE_COMPANION_GRACE_MS);
		expect(grace.defer('bad', drive(bad))).toBe(false);
		grace.complete('bad');
	});
});

describe('test-only grace override', () => {
	const T0 = new Date('2026-10-17T12:00:00Z').getTime();
	beforeEach(() => {
		jest.useFakeTimers();
		jest.setSystemTime(T0);
	});
	afterEach(() => jest.useRealTimers());

	it('shortens the window from first sight, ignoring createdTime', () => {
		const grace = new CompanionGrace(jest.fn(), () => 3000);
		expect(
			grace.defer('o', { windowMs: DRIVE_COMPANION_GRACE_MS, uploadedAt: new Date(T0).toISOString() })
		).toBe(true);
		jest.setSystemTime(T0 + 2999);
		expect(grace.defer('o')).toBe(true);
		jest.setSystemTime(T0 + 3000);
		expect(grace.defer('o')).toBe(false);
		grace.complete('o');
	});

	it.each([undefined, '3000', NaN, Infinity, 999, 0, -5, COMPANION_GRACE_MS, 10 * 60_000])(
		'ignores an unusable or lengthening override %p',
		(value) => {
			const grace = new CompanionGrace(jest.fn(), () => value);
			expect(grace.defer('o')).toBe(true);
			jest.setSystemTime(T0 + COMPANION_GRACE_MS - 1);
			expect(grace.defer('o')).toBe(true);
			jest.setSystemTime(T0 + COMPANION_GRACE_MS);
			expect(grace.defer('o')).toBe(false);
			grace.complete('o');
		}
	);
});
