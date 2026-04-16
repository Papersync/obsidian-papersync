import { Platform } from 'obsidian';
import { isICloudPath } from '@/sync/icloud-offload';

beforeEach(() => {
	(Platform as { isMacOS: boolean }).isMacOS = false;
	(Platform as { isWin: boolean }).isWin = false;
});

describe('isICloudPath', () => {
	it('returns true for macOS iCloud container paths', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(isICloudPath('/Users/test/Library/Mobile Documents/com~apple~CloudDocs/PaperSynced/scans/scan.json')).toBe(true);
	});

	it('returns false for non-iCloud paths on macOS', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(isICloudPath('/Users/test/Dropbox/PaperSynced/scans/scan.json')).toBe(false);
	});

	it('returns false on Windows even for iCloud-like paths', () => {
		(Platform as { isWin: boolean }).isWin = true;
		expect(isICloudPath('/Users/test/Library/Mobile Documents/com~apple~CloudDocs/scan.json')).toBe(false);
	});

	it('returns false for arbitrary local paths', () => {
		(Platform as { isMacOS: boolean }).isMacOS = true;
		expect(isICloudPath('/Users/test/Documents/scans/scan.json')).toBe(false);
	});
});
