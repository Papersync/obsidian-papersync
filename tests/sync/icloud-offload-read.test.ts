// Drives triggerICloudDownload's read nudge (no shell): the one-byte read that
// makes the macOS File Provider materialize an offloaded file, its failure
// path, and the timeout that bounds a read that never returns.

import { Platform } from 'obsidian';
import * as os from 'os';
import * as fs from 'fs';

import { triggerICloudDownload } from '@/sync/icloud-offload';

describe('triggerICloudDownload — read nudge', () => {
	beforeEach(() => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('reads one byte without following symlinks, closes the handle, then returns true', async () => {
		const tmp = `${os.tmpdir()}/icloud-read-${Date.now()}.json`;
		fs.writeFileSync(tmp, '{"ok":true}');
		const read = jest.fn().mockResolvedValue({ bytesRead: 1 });
		const close = jest.fn().mockResolvedValue(undefined);
		const open = jest.spyOn(fs.promises, 'open').mockResolvedValue({ read, close } as unknown as fs.promises.FileHandle);

		const result = await triggerICloudDownload(tmp, 3_000);

		expect(result).toBe(true);
		expect(open).toHaveBeenCalledWith(tmp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		expect(read).toHaveBeenCalledWith(expect.any(Buffer), 0, 1, 0);
		expect(close).toHaveBeenCalledTimes(1);
		fs.unlinkSync(tmp);
	});

	it('closes the handle even when the read fails, and still polls', async () => {
		const tmp = `${os.tmpdir()}/icloud-read-fail-${Date.now()}.json`;
		fs.writeFileSync(tmp, '{"ok":true}');
		const read = jest.fn().mockRejectedValue(new Error('EDEADLK'));
		const close = jest.fn().mockResolvedValue(undefined);
		jest.spyOn(fs.promises, 'open').mockResolvedValue({ read, close } as unknown as fs.promises.FileHandle);

		await expect(triggerICloudDownload(tmp, 3_000)).resolves.toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
		fs.unlinkSync(tmp);
	});

	it('swallows an open failure (missing file) and returns false at the timeout', async () => {
		const result = await triggerICloudDownload('/non/existent/read-nudge.json', 1_500);
		expect(result).toBe(false);
	}, 10_000);

	it('does not wait past the timeout for a read that never returns', async () => {
		jest.spyOn(fs.promises, 'open').mockReturnValue(new Promise<fs.promises.FileHandle>(() => {}));

		const start = Date.now();
		const result = await triggerICloudDownload('/non/existent/hung.json', 300);

		expect(result).toBe(false);
		expect(Date.now() - start).toBeLessThan(2_000);
	});
});
