import {
	logger,
	setDebugLogging,
	getLogBuffer,
	clearLogBuffer,
} from '@/utils/logger';

describe('logger', () => {
	beforeEach(() => {
		clearLogBuffer();
		setDebugLogging(false);
		jest.spyOn(console, 'log').mockImplementation(() => undefined);
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		jest.spyOn(console, 'error').mockImplementation(() => undefined);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('logs info to buffer with timestamp + level prefix', () => {
		logger.info('hello');
		const buf = getLogBuffer();
		expect(buf).toHaveLength(1);
		expect(buf[0]).toMatch(/^\d{2}:\d{2}:\d{2} \[info\] hello$/);
	});

	it('does not console.log info when debugLogging is off', () => {
		logger.info('quiet');
		expect(console.log).not.toHaveBeenCalled();
	});

	it('console.logs info when debugLogging is on', () => {
		setDebugLogging(true);
		logger.info('loud');
		expect(console.log).toHaveBeenCalledWith('[PaperSync] info: loud');
	});

	it('logs warn quietly when debug is off, noisily when on', () => {
		logger.warn('soft');
		expect(console.warn).not.toHaveBeenCalled();

		setDebugLogging(true);
		logger.warn('hard');
		expect(console.warn).toHaveBeenCalledWith('[PaperSync] warn: hard');
	});

	it('always console.errors regardless of debug flag', () => {
		logger.error('boom');
		expect(console.error).toHaveBeenCalledWith('[PaperSync] error: boom');
	});

	it('caps the log buffer at 200 entries (oldest evicted)', () => {
		for (let i = 0; i < 250; i++) {logger.info(`msg-${i}`);}
		const buf = getLogBuffer();
		expect(buf).toHaveLength(200);
		// First entry should be msg-50 (250 minus 200 cap)
		expect(buf[0]).toContain('msg-50');
		expect(buf[buf.length - 1]).toContain('msg-249');
	});

	it('clearLogBuffer empties the buffer', () => {
		logger.info('one');
		logger.warn('two');
		expect(getLogBuffer()).toHaveLength(2);
		clearLogBuffer();
		expect(getLogBuffer()).toHaveLength(0);
	});
});
