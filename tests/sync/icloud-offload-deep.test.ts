import { Platform } from 'obsidian';

import { triggerICloudDownload } from '@/sync/icloud-offload';

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
