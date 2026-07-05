// Drives both sides of probeOffloadState's `if (!result)` guard. The real-execSync
// suite (icloud-offload-deep.test.ts) only exercises the throw path, since the jest
// host has no brctl/xattr. Here we mock child_process so execSync returns a payload.

jest.mock('child_process', () => ({ execSync: jest.fn() }));

import { execSync } from 'child_process';
import { Platform } from 'obsidian';

import { probeOffloadState } from '@/sync/icloud-offload';

const mockedExec = execSync as jest.Mock;
const ICLOUD_PATH = '/Users/test/Library/Mobile Documents/com~apple~CloudDocs/scan.json';

describe('probeOffloadState — mocked execSync payload branches', () => {
	beforeEach(() => {
		mockedExec.mockReset();
		(Platform as { isMacOS: boolean }).isMacOS = true;
	});

	it('returns {offloaded:false} after reading a non-empty xattr payload (!result false)', () => {
		mockedExec.mockReturnValue('  com.apple.metadata:...binary-plist-bytes...  ');
		expect(probeOffloadState(ICLOUD_PATH)).toEqual({ offloaded: false });
	});

	it('returns {offloaded:false} when the xattr payload is empty/whitespace (!result true)', () => {
		mockedExec.mockReturnValue('   ');
		expect(probeOffloadState(ICLOUD_PATH)).toEqual({ offloaded: false });
	});
});
