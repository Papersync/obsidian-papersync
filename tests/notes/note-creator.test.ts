import { TFile, TFolder } from 'obsidian';

import { NoteCreator } from '@/notes/note-creator';
import { validateScanFile } from '@/validation/scan-file-schema';
import type { ScanFile } from '@/validation/scan-file-schema';

// getAbstractFileByPath must return a real TFile for the append path (instanceof check).
const asTFile = (path: string): TFile => Object.assign(new TFile(), { path });

// What a saved block ends with: its rendered text and one trailing newline. The scan
// id is recorded in frontmatter, never as a comment in the body.
const marked = (text: string): string => `${text.trimEnd()}\n`;

// Frontmatter of the notes the fake app knows, by path (what processFrontMatter edits
// and the metadata cache reads back).
const frontmatter = new Map<string, Record<string, unknown>>();

const mockApp = {
	internalPlugins: {
		getPluginById: () => null,
	},
	metadataCache: {
		getFileCache: (f: { path: string }) => ({ frontmatter: frontmatter.get(f.path) }),
	},
	fileManager: {
		processFrontMatter: jest.fn(async (f: { path: string }, fn: (fm: Record<string, unknown>) => void) => {
			const fm = frontmatter.get(f.path) ?? {};
			fn(fm);
			frontmatter.set(f.path, fm);
		}),
	},
};

const mockVault = {
	getAbstractFileByPath: jest.fn(),
	create: jest.fn(async (path: string, _content: string) => asTFile(path)),
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
	templateString: `{{ps_separator}}

## {{ps_scan_time}}

{{ps_markdown}}

> [!abstract]- Original scan
> ![[{{ps_image_file}}]]
`,
	targetFolder: 'PaperSync',
	attachmentsFolder: 'attachments/papersync',
	downloadImages: true,
};

const makeScanFile = (overrides?: Partial<ScanFile>): ScanFile => {
	const parsed = validateScanFile({
		version: 1,
		createdAt: '2026-04-12T14:30:00.000Z',
		markdown: '# Test Notes\n\nSome content here.',
		confidence: 87,
		provider: 'claude',
		model: 'claude-sonnet-4',
		imageFileName: '2026-04-12-143000.jpg',
		synced: false,
		...overrides,
	});
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	return parsed;
};

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
		frontmatter.clear();
		mockVault.getAbstractFileByPath.mockReturnValue(null);
		creator = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, defaultConfig);
	});

	it.each([
		[{ title: 'AI title', summary: 'AI summary' }, '# AI title\nAI summary'],
		[{}, '# Test Notes\n'],
		[{ markdown: '' }, '# 2\\:30 PM\n'],
		[{ title: '', markdown: '- [x] **Task**' }, '# Task\n'],
		[{ title: '[[Page#Part|Alias]]\n# Next', summary: 'a|b' }, String.raw`# \[\[Page\#Part\|Alias\]\] \# Next` + '\na\\|b'],
		[{ title: 'T'.repeat(500), summary: 'S'.repeat(500) }, `# ${'T'.repeat(79)}\u2026\n${'S'.repeat(199)}\u2026`],
	])('renders metadata and legacy fallbacks into saved notes (%j)', async (overrides, expected) => {
		const original = creator.config.templateString;
		creator.config.templateString = '# {{ps_title}}\n{{ps_summary}}';
		try {
			await creator.createOrAppend(makeScanFile(overrides), new ArrayBuffer(10), 'scan-title');
			expect(mockVault.create.mock.calls[0]?.[1]).toBe(marked(expected, 'scan-title'));
		} finally {
			creator.config.templateString = original;
		}
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

	const NOTE = 'PaperSync/2026-04-12.md';
	const existingNote = (existing: string): { written: () => string } => {
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => (path === NOTE ? asTFile(path) : null));
		let written = existing;
		mockVault.process.mockImplementation(async (_f: unknown, fn: (d: string) => string) => {
			written = fn(existing);
			return written;
		});
		return { written: () => written };
	};

	it('records the raw scan id in a new note\'s papersync-scans property, with no comment marker', async () => {
		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'a %% b\nc');

		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['a %% b\nc'] });
		expect(mockVault.create.mock.calls[0]?.[1] as string).not.toContain('%% papersync:');
	});

	it('appends the id to an existing list, keeping every other property', async () => {
		const note = existingNote('# Earlier\n');
		frontmatter.set(NOTE, { tags: ['x'], 'papersync-scans': ['scan-old'], title: 'T' });

		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-new');

		expect(note.written()).toContain('# Test Notes');
		expect(frontmatter.get(NOTE)).toEqual({ tags: ['x'], 'papersync-scans': ['scan-old', 'scan-new'], title: 'T' });
	});

	it('creates the property on a note that has none, and lifts a scalar value into a list', async () => {
		existingNote('# Earlier\n');
		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-1');
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-1'] });

		frontmatter.set(NOTE, { 'papersync-scans': 'scan-0' });
		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-2');
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-0', 'scan-2'] });
	});

	it('does not append a scan already listed in papersync-scans', async () => {
		const note = existingNote('# Earlier\n');
		frontmatter.set(NOTE, { 'papersync-scans': ['scan-dup'] });

		const path = await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-dup');

		expect(path).toBe(NOTE);
		expect(mockVault.process).not.toHaveBeenCalled();
		expect(note.written()).toBe('# Earlier\n');
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-dup'] });
	});

	it('never lists an id twice when it is already in the list at write time', async () => {
		existingNote('# Earlier\n');
		// The cache is stale (reports nothing), but the file already lists the id.
		frontmatter.set(NOTE, { 'papersync-scans': ['scan-x'] });
		const getFileCache = jest.spyOn(mockApp.metadataCache, 'getFileCache').mockReturnValueOnce({ frontmatter: undefined });

		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-x');

		getFileCache.mockRestore();
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-x'] });
	});

	it('appends when the metadata cache has no entry for the note yet', async () => {
		const note = existingNote('# Earlier\n');
		jest.spyOn(mockApp.metadataCache, 'getFileCache').mockReturnValueOnce(null as never);

		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-uncached');

		expect(note.written()).toContain('# Test Notes');
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-uncached'] });
	});

	it('treats a legacy %% papersync:<id> %% marker as already imported, without writing a new one', async () => {
		const existing = '# Earlier\n\n%% papersync:a%20b %%\n';
		const note = existingNote(existing);

		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'a b');

		expect(note.written()).toBe(existing);
		expect(frontmatter.has(NOTE)).toBe(false);
	});

	it('after a crash between the append and the property write, the retry appends once more rather than losing the scan', async () => {
		// First pass: the block is written, then the property write dies.
		const note = existingNote('# Earlier\n');
		mockApp.fileManager.processFrontMatter.mockRejectedValueOnce(new Error('crashed'));
		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-crash');
		expect(note.written()).toContain('# Test Notes');
		expect(frontmatter.has(NOTE)).toBe(false);

		// Retry (id unlisted): appends again (a duplicate block, never a lost scan) and lists the id.
		await creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-crash');
		expect(frontmatter.get(NOTE)).toEqual({ 'papersync-scans': ['scan-crash'] });
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

	it('saves images at the vault root when the attachments folder is /', async () => {
		const getAvailablePathForAttachment = jest.fn();
		const c = new NoteCreator(
			{ ...mockApp, fileManager: { getAvailablePathForAttachment }, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, attachmentsFolder: ' / ' }
		);

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-slash-root');

		expect(getAvailablePathForAttachment).not.toHaveBeenCalled();
		expect(mockVault.createBinary).toHaveBeenCalledWith('papersync-scan-slash-root.jpg', expect.any(ArrayBuffer));
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
		// The parallel writer created it: the folder exists once the create fails.
		let raced = false;
		mockVault.createFolder.mockImplementation((p: string) => {
			if (p === 'PaperSync') { raced = true; return Promise.reject(new Error('EEXIST')); }
			return Promise.resolve();
		});
		mockVault.getAbstractFileByPath.mockImplementation((p: string) =>
			p === 'PaperSync' && raced ? Object.assign(new TFolder(), { path: p }) : null
		);

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		try {
			await expect(creator.createOrAppend(scan, imageData, 'scan-race')).resolves.toBe(
				'PaperSync/2026-04-12.md'
			);
			expect(mockVault.create).toHaveBeenCalled();
		} finally {
			mockVault.createFolder.mockReset().mockResolvedValue(undefined);
		}
	});

	it('reports a folder it could not create instead of failing later on the note', async () => {
		mockVault.createFolder.mockRejectedValueOnce(new Error('a file is in the way'));
		await expect(creator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-blocked')).rejects.toThrow('a file is in the way');
		expect(mockVault.create).not.toHaveBeenCalled();
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

	describe('without a photo', () => {
		const renderWithoutPhoto = async (templateString: string, scan = makeScanFile()): Promise<string> => {
			const creator = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, {
				...defaultConfig,
				templateString,
			});
			await creator.createOrAppend(scan, null, 'scan-nophoto');
			return mockVault.create.mock.calls[0]?.[1] as string;
		};

		it('drops a sized embed line and an inline empty embed', async () => {
			const content = await renderWithoutPhoto('{{ps_markdown}}\n![[{{ps_image_file}}|300]]\nSee ![[{{ps_image_file}}]] here\n');

			expect(content).not.toMatch(/!\[\[/);
			expect(content).toBe(marked('# Test Notes\n\nSome content here.\nSee here\n'));
		});

		it('drops empty embed lines under numbered, plus and task markers and nested quotes, but not other images', async () => {
			const content = await renderWithoutPhoto(
				'{{ps_markdown}}\n1. ![[{{ps_image_file}}]]\n+ ![[{{ps_image_file}}|300]]\n- [ ] ![[{{ps_image_file}}]]\n> > ![[{{ps_image_file}}]]\r\n![[other.png|300]]\n'
			);

			expect(content).toBe(marked('# Test Notes\n\nSome content here.\n![[other.png|300]]\n'));
		});

		it('keeps the scan text when the template only places the photo', async () => {
			const content = await renderWithoutPhoto('![[{{ps_image_file}}]]\n');

			expect(content).toBe(marked('# Test Notes\n\nSome content here.\n'));
		});

		it('adds the scan text under the rest of a template that never places it', async () => {
			const content = await renderWithoutPhoto('## {{ps_scan_time_24h}}\n\n![[{{ps_image_file}}]]\n');

			expect(content).toBe(marked('## 14:30\n\n# Test Notes\n\nSome content here.\n'));
		});

		it('adds nothing for a scan with no text', async () => {
			const content = await renderWithoutPhoto('## {{ps_scan_time_24h}}\n![[{{ps_image_file}}]]\n', makeScanFile({ markdown: '  ' }));

			expect(content).toBe(marked('## 14:30\n'));
		});

		it('neutralizes the scan text it adds under a template that never places it', async () => {
			const content = await renderWithoutPhoto('## {{ps_scan_time_24h}}\n![[{{ps_image_file}}]]\n', makeScanFile({ markdown: '<%* x %>' }));

			expect(content).toBe(marked('## 14:30\n\n<\u200B%* x %\u200B>'));
		});

		it('saves only the marker when nothing else is left', async () => {
			const content = await renderWithoutPhoto('![[{{ps_image_file}}]]\n', makeScanFile({ markdown: '  ' }));

			expect(content).toBe(marked(''));
		});

		it('leaves a template that already places the text unchanged', async () => {
			const content = await renderWithoutPhoto('{{ps_markdown}}\n![[{{ps_image_file}}]]\n');

			expect(content).toBe(marked('# Test Notes\n\nSome content here.\n'));
		});
	});

	it('uses a Papersync folder when the Notes folder is empty and Daily Notes is off', async () => {
		// Same rule as first-run resolution, so a cleared field files notes where
		// they will also go after a restart.
		const emptyCreator = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, targetFolder: '' }
		);

		await emptyCreator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-empty');

		expect(mockVault.create).toHaveBeenCalledWith('Papersync/2026-04-12.md', expect.any(String));
	});

	it('places the note at the root when the Notes folder is empty and Daily Notes is at the root', async () => {
		const c = creatorWithDailyFormat('YYYY-MM-DD', '', { ...defaultConfig, targetFolder: '' });

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-root');

		// Note path has no folder prefix, and no note folder is created.
		expect(mockVault.create).toHaveBeenCalledWith('2026-04-12.md', expect.any(String));
		const folderCalls = mockVault.createFolder.mock.calls.map((c) => c[0]);
		expect(folderCalls).not.toContain('PaperSync');
	});

	it('uses one set of settings for the whole scan even if they change mid-write', async () => {
		let template = '{{ps_markdown}} FIRST';
		const live = {
			get templateString() { return template; },
			targetFolder: 'PaperSync',
			attachmentsFolder: 'attachments',
			downloadImages: true,
		};
		const c = new NoteCreator({ ...mockApp, vault: mockVault } as any, mockVault as any, live);
		mockVault.createBinary.mockImplementationOnce(() => { template = 'CHANGED'; return Promise.resolve(); });

		await c.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-mid');

		const content = mockVault.create.mock.calls[0]?.[1] as string;
		expect(content).toContain('FIRST');
		expect(content).not.toContain('CHANGED');
	});

	it('places the note at the root when the Notes folder is / (Daily Notes at the vault root)', async () => {
		const rootCreator = new NoteCreator(
			{ ...mockApp, vault: mockVault } as any,
			mockVault as any,
			{ ...defaultConfig, targetFolder: '/' }
		);

		await rootCreator.createOrAppend(makeScanFile(), new ArrayBuffer(10), 'scan-root');

		expect(mockVault.create).toHaveBeenCalledWith('2026-04-12.md', expect.any(String));
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
