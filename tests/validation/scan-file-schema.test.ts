import { validateScanFile } from '@/validation/scan-file-schema';

const validScanFile = {
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Test notes',
	confidence: 87,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName: '2026-04-12-143000.jpg',
	synced: false,
};

describe('validateScanFile', () => {
	it('accepts a valid scan file', () => {
		const result = validateScanFile(validScanFile);
		expect('error' in result).toBe(false);
		if (!('error' in result)) {
			expect(result.version).toBe('1');
			expect(result.confidence).toBe(87);
			expect(result.synced).toBe(false);
		}
	});

	it('accepts a synced scan file', () => {
		const result = validateScanFile({ ...validScanFile, synced: true });
		expect('error' in result).toBe(false);
	});

	it('rejects missing required fields', () => {
		const { markdown, ...incomplete } = validScanFile;
		const result = validateScanFile(incomplete);
		expect('error' in result).toBe(true);
	});

	it('rejects confidence below 0', () => {
		const result = validateScanFile({ ...validScanFile, confidence: -1 });
		expect('error' in result).toBe(true);
	});

	it('rejects confidence above 100', () => {
		const result = validateScanFile({ ...validScanFile, confidence: 101 });
		expect('error' in result).toBe(true);
	});

	it('rejects non-integer confidence', () => {
		const result = validateScanFile({ ...validScanFile, confidence: 87.5 });
		expect('error' in result).toBe(true);
	});

	it('rejects unsupported schema version', () => {
		const result = validateScanFile({ ...validScanFile, version: '99' });
		expect('error' in result).toBe(true);
		if ('error' in result) {
			expect(result.error).toContain('Unsupported schema version');
		}
	});

	it('rejects null input', () => {
		const result = validateScanFile(null);
		expect('error' in result).toBe(true);
	});

	it('rejects non-object input', () => {
		const result = validateScanFile('not an object');
		expect('error' in result).toBe(true);
	});

	it('rejects wrong type for synced field', () => {
		const result = validateScanFile({ ...validScanFile, synced: 'false' });
		expect('error' in result).toBe(true);
	});
});
