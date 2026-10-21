import { createScanFile } from '@papersync/scan-format';
import { validateScanFile } from '@/validation/scan-file-schema';

const validScanFile = {
	version: 1,
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
			expect(result.version).toBe(1);
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

	it.each([[-1, 0], [101, 100], [87.5, 88], [0.9, 90], [1, 1], [0.145, 15], [0.995, 100]])(
		'normalizes legacy confidence %s to %s', (confidence, expected) => {
			expect(validateScanFile({ ...validScanFile, confidence })).toMatchObject({ confidence: expected });
		}
	);

	it('rejects unsupported schema version', () => {
		const result = validateScanFile({ ...validScanFile, version: '99' });
		expect('error' in result).toBe(true);
		if ('error' in result) {
			expect(result.error).toContain('Unsupported Papersync scan version');
			expect(result.error).toContain('update the Papersync plugin');
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

	it.each(['false', 'true', 0, 1, null, {}, []])('reads non-boolean synced %j as false', (synced) => {
		expect(validateScanFile({ ...validScanFile, synced })).toMatchObject({ synced: false });
	});

	it.each(['../scan.jpg', 'folder/scan.jpg', 'folder\\scan.jpg', 'C:scan.jpg', 'scan..jpg', 'scan\u0000.jpg', '.jpg', 'scan.JPG', 'scan.txt', ''])(
		'keeps the scan but clears unsafe image name %j; writer rejects it', (imageFileName) => {
			expect(validateScanFile({ ...validScanFile, imageFileName })).toMatchObject({
				imageFileName: '', markdown: validScanFile.markdown,
			});
			expect(() => createScanFile({ ...validScanFile, imageFileName })).toThrow();
		}
	);

	it.each([0, -1, 2.5, '01', '2.0', '2e0', 'foo', Infinity, NaN, 1e9, null, true])(
		'reports malformed version %j as a schema error', (version) => {
			const result = validateScanFile({ ...validScanFile, version });
			expect(result).toEqual({ error: expect.stringContaining('Invalid Papersync scan file:') });
		}
	);

	it('does not suggest updating the plugin for an unrelated object with a version', () => {
		expect(validateScanFile({ version: 2 })).toEqual({ error: expect.stringContaining('Invalid Papersync scan file:') });
	});

	it.each([2, '2', 999999999])('recognizes future version %j even with other invalid fields', (version) => {
		expect(validateScanFile({ version, markdown: '' })).toEqual({ error: expect.stringContaining('update the Papersync plugin') });
	});

	it('rejects a non-ISO createdAt so it never reaches new Date() as garbage (#10)', () => {
		// A loose z.string() would let this through and yield an "Invalid Date" note
		// filename with a NaN:NaN time; z.iso.datetime() turns it into a schema_mismatch.
		const result = validateScanFile({ ...validScanFile, createdAt: 'not-a-real-date' });
		expect('error' in result).toBe(true);
	});
});

describe('optional title and summary', () => {
	it.each(['title', 'summary'])('treats non-string %s as absent without dropping the scan', (field) => {
		for (const input of [null, 42, {}, { text: 'Page' }, [], ['Page'], true]) {
			const result = validateScanFile({ ...validScanFile, [field]: input });
			expect(result).not.toHaveProperty('error');
			expect(result).toMatchObject(validScanFile);
			if (!('error' in result)) {
				expect(result[field as 'title' | 'summary']).toBeUndefined();
			}
		}
	});

	it.each(['title', 'summary'])('normalizes %s without imposing a length limit', (field) => {
		for (const [input, expected] of [['  Page  ', 'Page'], [' \n ', undefined], ['x'.repeat(500), 'x'.repeat(500)]]) {
			const result = validateScanFile({ ...validScanFile, [field]: input });
			expect(result).not.toHaveProperty('error');
			expect(result).toHaveProperty(field, expected);
		}
		const old = validateScanFile(validScanFile);
		expect(old).not.toHaveProperty(field);
	});
});
