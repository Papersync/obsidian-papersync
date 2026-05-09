let debugEnabled = false;

const MAX_LOG_ENTRIES = 200;
const logBuffer: string[] = [];

export function setDebugLogging(enabled: boolean): void {
	debugEnabled = enabled;
}

export function getLogBuffer(): readonly string[] {
	return logBuffer;
}

export function clearLogBuffer(): void {
	logBuffer.length = 0;
}

function timestamp(): string {
	return new Date().toISOString().slice(11, 19);
}

function pushLog(level: string, message: string): void {
	const entry = `${timestamp()} [${level}] ${message}`;
	logBuffer.push(entry);
	if (logBuffer.length > MAX_LOG_ENTRIES) {
		logBuffer.shift();
	}
}

export const logger = {
	info(message: string): void {
		pushLog('info', message);
		if (debugEnabled) {
			// eslint-disable-next-line no-console
			console.log(`[PaperSync] info: ${message}`);
		}
	},

	warn(message: string): void {
		pushLog('warn', message);
		if (debugEnabled) {
			console.warn(`[PaperSync] warn: ${message}`);
		}
	},

	error(message: string): void {
		pushLog('ERROR', message);
		console.error(`[PaperSync] error: ${message}`);
	},
};
