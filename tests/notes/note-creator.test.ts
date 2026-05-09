import { NoteCreator } from '@/notes/note-creator';
import type { ScanFile } from '@/validation/scan-file-schema';

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
		expect(content).not.toContain('---');
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
			if (path === 'PaperSync/2026-04-12.md') return { path };
			return null;
		});
		mockVault.adapter.read.mockResolvedValue('# Existing content\n\nPrevious notes.');

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-002');

		const written = mockVault.adapter.write.mock.calls[0]?.[1] as string;
		expect(written).toContain('# Existing content');
		expect(written).toContain('---');
		expect(written).toContain('# Test Notes');
	});

	it('preserves existing content when appending', async () => {
		const existingContent = '# Morning scan\n\nFirst notes of the day.\n\nEdited by user.';
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'PaperSync/2026-04-12.md') return { path };
			return null;
		});
		mockVault.adapter.read.mockResolvedValue(existingContent);

		const scan = makeScanFile();
		const imageData = new ArrayBuffer(10);

		await creator.createOrAppend(scan, imageData, 'scan-003');

		const written = mockVault.adapter.write.mock.calls[0]?.[1] as string;
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
});
