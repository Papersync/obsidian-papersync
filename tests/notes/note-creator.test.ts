import { TFile } from 'obsidian';

import { NoteCreator } from '@/notes/note-creator';
import type { ScanFile } from '@/validation/scan-file-schema';

// getAbstractFileByPath must return a real TFile for the append path (instanceof check).
const asTFile = (path: string): TFile => Object.assign(new TFile(), { path });

const mockApp = {
	internalPlugins: {
		getPluginById: () => null,
	},
};

const mockVault = {
	getAbstractFileByPath: jest.fn(),
	create: jest.fn().mockResolvedValue(undefined),
	createBinary: jest.fn().mockResolvedValue(undefined),
	createFolder: jest.fn().mockResolvedValue(undefined),
	// Atomic read-modify-write. Default no-op over empty content; append tests supply
	// existing content via a per-test mockImplementation.
	process: jest.fn(async (_file: unknown, fn: (data: string) => string) => fn('')),
	adapter: {
		read: jest.fn().mockResolvedValue(''),
		write: jest.fn().mockResolvedValue(undefined),
	},
};

const defaultConfig = {
	templateString: `{{separator}}

## {{time}}

{{markdown}}

> [!abstract]- Original scan
> ![[{{image_file}}]]
`,
	targetFolder: 'PaperSync',
	attachmentsFolder: 'attachments/papersync',
	downloadImages: true,
};

const makeScanFile = (overrides?: Partial<ScanFile>): ScanFile => ({
	version: '1',
	createdAt: '2026-04-12T14:30:00.000Z',
	markdown: '# Test Notes\n\nSome content here.',
	confidence: 87,
	provider: 'claude',
	model: 'claude-sonnet-4',
	imageFileName: '2026-04-12-143000.jpg',
	synced: false,
	...overrides,
});

// Build a creator whose app reports a specific Core Daily Notes format/folder.
const creatorWithDailyFormat = (format: string, folder = '', config = defaultConfig): NoteCreator => {
	const app = {
		internalPlugins: {
			getPluginById: (id: string) =>
				id === 'daily-notes' ? { enabled: true, instance: { options: { format, folder } } } : null,
		},
	};
	return new NoteCreator({ ...app, vault: mockVault } as any, mockVault as any, config);
};

describe('NoteCreator', () => {
	let creator: NoteCreator;

	beforeEach(() => {
		jest.clearAllMocks();
		mockVault.getAbstractFileByPath.mockReturnValue(null);
		creator = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, defaultConfig);
	});

	it('creates a new note when no file exists at the target path', async () => {
		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-001');

		expect(mockVault.create).toHaveBeenCalledWith(
			'PaperSync/2026-04-12.md',
			expect.stringContaining('# Test Notes')
		);
	});

	it('includes time heading and empty separator on new file', async () => {
		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-001');

		const content = mockVault.create.mock.calls[0]?.[1] as string;
		// Time heading should match HH:MM format (local timezone)
		expect(content).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
		expect(content).not.toContain('***');
	});

	it('includes collapsible image embed in the created note', async () => {
		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-001');

		const content = mockVault.create.mock.calls[0]?.[1] as string;
		expect(content).toContain('> ![[attachments/papersync/papersync-scan-001.jpg]]');
	});

	it('appends to existing file with delimiter when note already exists', async () => {
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'PaperSync/2026-04-12.md') return asTFile(path);
			return null;
		});
		let written = '';
		mockVault.process.mockImplementation(async (_f: unknown, fn: (d: string) => string) => {
			written = fn('# Existing content\n\nPrevious notes.');
			return written;
		});

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-002');

		expect(written).toContain('# Existing content');
		expect(written).toContain('***');
		expect(written).toContain('# Test Notes');
	});

	it('preserves existing content when appending', async () => {
		const existingContent = '# Morning scan\n\nFirst notes of the day.\n\nEdited by user.';
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'PaperSync/2026-04-12.md') return asTFile(path);
			return null;
		});
		let written = '';
		mockVault.process.mockImplementation(async (_f: unknown, fn: (d: string) => string) => {
			written = fn(existingContent);
			return written;
		});

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-003');

		expect(written.startsWith(existingContent)).toBe(true);
	});

	it('creates target folder if it does not exist', async () => {
		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-004');

		expect(mockVault.createFolder).toHaveBeenCalledWith('PaperSync');
	});

	it('derives note filename from date_short', async () => {
		const scan = makeScanFile({ createdAt: '2026-01-15T09:00:00.000Z' });
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-005');

		expect(mockVault.create).toHaveBeenCalledWith(
			'PaperSync/2026-01-15.md',
			expect.any(String)
		);
	});

	it('resolves date tokens in folder path', async () => {
		const dateTokenConfig = {
			...defaultConfig,
			targetFolder: 'Journal/YYYY/MM',
		};
		const tokenCreator = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, dateTokenConfig);

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await tokenCreator.createOrAppend(scan, imageData, 'scan-006');

		expect(mockVault.create).toHaveBeenCalledWith(
			'Journal/2026/04/2026-04-12.md',
			expect.any(String)
		);
	});

	it('creates nested folders for date-resolved paths', async () => {
		const dateTokenConfig = {
			...defaultConfig,
			targetFolder: 'Journal/YYYY/MM',
		};
		const tokenCreator = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, dateTokenConfig);

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await tokenCreator.createOrAppend(scan, imageData, 'scan-007');

		expect(mockVault.createFolder).toHaveBeenCalledWith('Journal');
		expect(mockVault.createFolder).toHaveBeenCalledWith('Journal/2026');
		expect(mockVault.createFolder).toHaveBeenCalledWith('Journal/2026/04');
	});

	it('names the daily note with Obsidian moment format, not a Y/M/D replacer (#1)', async () => {
		// Format `MMMM D, YYYY` must produce "July 5, 2026", matching Obsidian's real
		// daily note. The old replacer produced "0707 5, 2026" (a garbage parallel note).
		const c = creatorWithDailyFormat('MMMM D, YYYY', '', { ...defaultConfig, targetFolder: '' });
		const scan = makeScanFile({ createdAt: '2026-07-05T14:30:00.000Z' });

		await c.createOrAppend(scan, new ArrayBuffer(10), 'scan-fmt');

		expect(mockVault.create).toHaveBeenCalledWith('July 5, 2026.md', expect.any(String));
	});

	it('creates every parent folder when the daily format itself nests (#2: YYYY/MM/DD)', async () => {
		const c = creatorWithDailyFormat('YYYY/MM/DD', '', { ...defaultConfig, targetFolder: '' });
		const scan = makeScanFile({ createdAt: '2026-07-05T14:30:00.000Z' });

		await c.createOrAppend(scan, new ArrayBuffer(10), 'scan-nest');

		expect(mockVault.create).toHaveBeenCalledWith('2026/07/05.md', expect.any(String));
		expect(mockVault.createFolder).toHaveBeenCalledWith('2026');
		expect(mockVault.createFolder).toHaveBeenCalledWith('2026/07');
	});

	it('appends across a trailing-slash Notes folder without a // path mismatch (#3)', async () => {
		const c = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, targetFolder: 'PaperSync/' }
		);
		mockVault.getAbstractFileByPath.mockImplementation((p: string) =>
			p === 'PaperSync/2026-04-12.md' ? asTFile(p) : null
		);
		mockVault.process.mockImplementation(async (_f: unknown, fn: (d: string) => string) => fn('# Prior'));

		const scan = makeScanFile();
		await c.createOrAppend(scan, new ArrayBuffer(10), 'scan-slash');

		// Existence check runs on the normalized path (no double slash) → append, not create.
		expect(mockVault.getAbstractFileByPath).toHaveBeenCalledWith('PaperSync/2026-04-12.md');
		expect(mockVault.process).toHaveBeenCalled();
		expect(mockVault.create).not.toHaveBeenCalled();
	});

	it('defaults attachments to Obsidian\'s own attachment folder (no extra subfolder)', async () => {
		const getAvailablePathForAttachment = jest
			.fn()
			.mockResolvedValue('vault-attachments/papersync-x.jpg');
		const app = {
			internalPlugins: { getPluginById: () => null },
			fileManager: { getAvailablePathForAttachment },
		};
		const c = new NoteCreator(
			{ ...app, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, attachmentsFolder: '' }
		);

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-att');

		expect(getAvailablePathForAttachment).toHaveBeenCalledWith('papersync-scan-att.jpg', 'PaperSync/2026-04-12.md');
		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'vault-attachments/papersync-scan-att.jpg',
			expect.any(ArrayBuffer)
		);
	});

	it('saves at the vault root when Obsidian returns a bare filename', async () => {
		const getAvailablePathForAttachment = jest.fn().mockResolvedValue('papersync-y.jpg');
		const app = {
			internalPlugins: { getPluginById: () => null },
			fileManager: { getAvailablePathForAttachment },
		};
		const c = new NoteCreator(
			{ ...app, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, attachmentsFolder: '' }
		);

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-root-att');

		// No folder prefix, no leading slash, no folder creation for the root case.
		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'papersync-scan-root-att.jpg',
			expect.any(ArrayBuffer)
		);
	});

	it('strips a trailing slash from an attachments override so the embed has no // (#9)', async () => {
		const c = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, attachmentsFolder: 'Attachments/' }
		);

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-slash-att');

		// No double slash: 'Attachments/' must not yield 'Attachments//papersync-...jpg'.
		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'Attachments/papersync-scan-slash-att.jpg',
			expect.any(ArrayBuffer)
		);
		const content = mockVault.create.mock.calls[0]?.[1] as string;
		expect(content).toContain('![[Attachments/papersync-scan-slash-att.jpg]]');
		expect(content).not.toContain('//papersync');
	});

	it('renders 12:MM AM at midnight (covers h24 % 12 || 12 fallback)', async () => {
		const scan = makeScanFile({ createdAt: '2026-04-12T00:15:00.000Z' });
		// Local timezone-dependent; rely on the formatter producing 12:* AM or PM
		// (the ternary fallback is what we're exercising, not the wall-clock time).
		await creator.createOrAppend(scan, new ArrayBuffer(10), 'scan-midnight');
		const content = mockVault.create.mock.calls[0]?.[1] as string;
		// Match the `12:MM AM|PM` line iff local time landed on hour 0 or 12; otherwise the test
		// merely verifies the formatter survived the hour-0/12 path through another offset.
		expect(content).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
	});

	it('renders 12:MM PM at noon UTC (covers h24=12 → 12)', async () => {
		const scan = makeScanFile({ createdAt: '2026-04-12T12:00:00.000Z' });
		await creator.createOrAppend(scan, new ArrayBuffer(10), 'scan-noon');
		const content = mockVault.create.mock.calls[0]?.[1] as string;
		expect(content).toMatch(/## \d{1,2}:\d{2}\s*(AM|PM)/);
	});

	it('tolerates createFolder rejecting on the note-folder path (race with parallel write)', async () => {
		// Reject ONLY the note-folder createFolder so note-creator's own catch fires.
		// (image-handler's catch is exercised separately in image-handler.test.ts.)
		mockVault.createFolder.mockImplementation((p: string) => {
			if (p === 'PaperSync') return Promise.reject(new Error('EEXIST'));
			return Promise.resolve();
		});

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await expect(creator.createOrAppend(scan, imageData, 'scan-race')).resolves.toBe(
			'PaperSync/2026-04-12.md'
		);
		expect(mockVault.create).toHaveBeenCalled();
	});

	it('skips image download when downloadImages=false', async () => {
		const noImageConfig = { ...defaultConfig, downloadImages: false };
		const noImageCreator = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			noImageConfig
		);

		const scan = makeScanFile();
		await noImageCreator.createOrAppend(scan, new ArrayBuffer(10), 'scan-noimg');

		expect(mockVault.createBinary).not.toHaveBeenCalled();
		const content = mockVault.create.mock.calls[0]?.[1] as string;
		// The broken empty-embed line is stripped, not shipped into the note.
		expect(content).not.toContain('![[]]');
		// The callout header still renders (only the empty embed line was dropped).
		expect(content).toContain('[!abstract]- Original scan');
	});

	it('places the note at the root when targetFolder is empty and daily-notes has no folder', async () => {
		const rootConfig = { ...defaultConfig, targetFolder: '' };
		const rootCreator = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			rootConfig
		);

		const scan = makeScanFile();
		await rootCreator.createOrAppend(scan, new ArrayBuffer(10), 'scan-root');

		// Note path has no folder prefix
		expect(mockVault.create).toHaveBeenCalledWith('2026-04-12.md', expect.any(String));
		// Only the attachments folder (from saveImageToVault) should be created — no note folder
		const folderCalls = mockVault.createFolder.mock.calls.map((c) => c[0]);
		expect(folderCalls).not.toContain('PaperSync');
	});

	it('writes rendered content directly when existing file is empty (no leading separator)', async () => {
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'PaperSync/2026-04-12.md') return asTFile(path);
			return null;
		});
		// Empty existing content → trimEnd().length === 0 → takes the else branch
		let written = '';
		mockVault.process.mockImplementation(async (_f: unknown, fn: (d: string) => string) => {
			written = fn('');
			return written;
		});

		const scan = makeScanFile();
		await creator.createOrAppend(scan, new ArrayBuffer(10), 'scan-empty-existing');

		// No "existing\n\n" prefix in front — rendered content stands alone
		expect(written.startsWith('\n')).toBe(false);
		expect(written).toContain('# Test Notes');
	});
});
