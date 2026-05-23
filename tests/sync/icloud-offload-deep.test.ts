import { Platform } from 'obsidian';

import { probeOffloadState, triggerICloudDownload } from '@/sync/icloud-offload';

describe('probeOffloadState (non-iCloud / non-macOS paths)', () => {
	beforeEach(() => {
		(Platform as { isMacOS: boolean }).isMacOS = false;
	});

	it('returns {offloaded:false} for paths outside the iCloud container', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(probeOffloadState('/Users/me/Documents/scan.json')).toEqual({ offloaded: false });
	});

	it('returns {offloaded:false} on non-macOS regardless of path shape', () => {
		expect(
			probeOffloadState('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/scan.json')
		).toEqual({ offloaded: false });
	});

	it('returns {offloaded:false} when execSync throws (xattr unavailable)', () => {
		// On the jest jsdom platform there's no brctl/xattr — execSync will throw,
		// which the implementation catches and returns offloaded:false.
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(
			probeOffloadState('/Users/test/Library/Mobile Documents/com~apple~CloudDocs/scan.json')
		).toEqual({ offloaded: false });
	});
});

describe('triggerICloudDownload (non-macOS short-circuit)', () => {
	beforeEach(() => {
		(Platform as { isMacOS: boolean }).isMacOS = false;
	});

	it('returns false immediately when not on macOS', async () => {
		const start = Date.now();
		const result = await triggerICloudDownload('/some/path.json', 10_000);
		expect(result).toBe(false);
		expect(Date.now() - start).toBeLessThan(200); // immediate, no polling
	});
});

describe('triggerICloudDownload (macOS poll loop on a real file)', () => {
	it('returns true when the file is already materialized with content', async () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const tmp = `${require('os').tmpdir()}/icloud-poll-${Date.now()}.json`;
		require('fs').writeFileSync(tmp, '{"hello":"world"}');

		const result = await triggerICloudDownload(tmp, 3_000);
		expect(result).toBe(true);

		require('fs').unlinkSync(tmp);
	});

	it('returns false when the file never materializes within the timeout', async () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		const result = await triggerICloudDownload('/non/existent/path.json', 2_500);
		expect(result).toBe(false);
	}, 10000);
});
