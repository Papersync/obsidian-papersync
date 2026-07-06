// Drives both branches of triggerICloudDownload's `try { execFile } catch` by
// mocking child_process.execFile (no shell, no real brctl dependency). Replaces
// the old probeOffloadState execSync suite — probeOffloadState was a dead-code
// no-op and its shell-injection sink was removed.

jest.mock('child_process', () => ({ execFile: jest.fn() }));

import { execFile } from 'child_process';
import { Platform } from 'obsidian';
import * as os from 'os';
import * as fs from 'fs';

import { triggerICloudDownload } from '@/sync/icloud-offload';

const mockedExecFile = execFile as unknown as jest.Mock;

describe('triggerICloudDownload — execFile branches', () => {
	beforeEach(() => {
		mockedExecFile.mockReset();
		(Platform as { isMacOS: boolean }).isMacOS = true;
	});

	it('resolves brctl (success path) then returns true on a materialized file', async () => {
		mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
		const tmp = `${os.tmpdir()}/icloud-execfile-${Date.now()}.json`;
		fs.writeFileSync(tmp, '{"ok":true}');

		const result = await triggerICloudDownload(tmp, 3_000);
		expect(result).toBe(true);
		expect(mockedExecFile).toHaveBeenCalledWith('brctl', ['download', tmp], expect.any(Object), expect.any(Function));

		fs.unlinkSync(tmp);
	});

	it('swallows a brctl error (catch path) and falls back to polling', async () => {
		mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('brctl missing')));

		const result = await triggerICloudDownload('/non/existent/execfile.json', 2_000);
		expect(result).toBe(false);
	}, 10_000);
});
