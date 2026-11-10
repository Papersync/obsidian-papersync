import { TFile, TFolder } from 'obsidian';
import { attachmentBaseName, saveImageToVault } from '@/notes/image-handler';

const mockVault = {
	getAbstractFileByPath: jest.fn(),
	createBinary: jest.fn().mockResolvedValue(undefined),
	createFolder: jest.fn().mockResolvedValue(undefined),
	readBinary: jest.fn(),
};

describe('saveImageToVault', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockVault.getAbstractFileByPath.mockReturnValue(null);
	});

	it('saves image and returns obsidian embed syntax', async () => {
		const imageData = new ArrayBuffer(100);

		const embed = await saveImageToVault(
			mockVault as any,
			imageData,
			'attachments/papersync',
			'scan-001'
		);

		expect(embed).toBe('attachments/papersync/papersync-scan-001.jpg');
	});

	it('saves a PNG scan with a .png extension', async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).buffer;

		const embed = await saveImageToVault(mockVault as any, png, 'attachments', 'scan-png');

		expect(embed).toBe('attachments/papersync-scan-png.png');
		expect(mockVault.createBinary).toHaveBeenCalledWith('attachments/papersync-scan-png.png', png);
	});

	it('saves JPEG bytes and data too short to sniff as .jpg', async () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).buffer;
		const short = new Uint8Array([0x89, 0x50, 0x4e]).buffer;

		expect(await saveImageToVault(mockVault as any, jpeg, '', 'scan-jpeg')).toBe('papersync-scan-jpeg.jpg');
		expect(await saveImageToVault(mockVault as any, short, '', 'scan-short')).toBe('papersync-scan-short.jpg');
	});

	it('creates the image file in the vault', async () => {
		const imageData = new ArrayBuffer(100);

		await saveImageToVault(mockVault as any, imageData, 'attachments/papersync', 'scan-001');

		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'attachments/papersync/papersync-scan-001.jpg',
			imageData
		);
	});

	it('skips creation if the same image already exists', async () => {
		const imageData = new ArrayBuffer(100);
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'attachments/papersync/papersync-scan-001.jpg') return Object.assign(new TFile(), { path });
			return null;
		});
		mockVault.readBinary.mockResolvedValue(new ArrayBuffer(100));

		await saveImageToVault(mockVault as any, imageData, 'attachments/papersync', 'scan-001');

		expect(mockVault.createBinary).not.toHaveBeenCalled();
	});

	it('creates nested folder structure', async () => {
		const imageData = new ArrayBuffer(100);

		await saveImageToVault(mockVault as any, imageData, 'attachments/papersync', 'scan-001');

		expect(mockVault.createFolder).toHaveBeenCalledWith('attachments');
		expect(mockVault.createFolder).toHaveBeenCalledWith('attachments/papersync');
	});

	it('tolerates createFolder rejecting (folder already created by a parallel write)', async () => {
		// Race condition: another concurrent operation created the same folder
		// between the getAbstractFileByPath check and our createFolder call.
		// The image-handler swallows the error and proceeds to createBinary.
		mockVault.createFolder.mockRejectedValueOnce(new Error('EEXIST'));
		// The parallel write's folder is there by the time the create fails.
		mockVault.getAbstractFileByPath
			.mockReturnValueOnce(null)
			.mockReturnValueOnce(Object.assign(new TFolder(), { path: 'attachments' }));
		const imageData = new ArrayBuffer(100);

		await expect(
			saveImageToVault(mockVault as any, imageData, 'attachments/papersync', 'scan-race')
		).resolves.toBe('attachments/papersync/papersync-scan-race.jpg');
		expect(mockVault.createBinary).toHaveBeenCalled();
	});
});

describe('attachmentBaseName', () => {
	it.each([
		['2026-04-12-143000', 'papersync-2026-04-12-143000'],
		['x/../../../../tmp/evil', 'papersync-x_________tmp_evil'],
		['..', 'papersync-_'],
		['...hidden', 'papersync-_hidden'],
		['a\\b:c|d#e^f[g]', 'papersync-a_b_c_d_e_f_g_'],
		['  .  ', 'papersync-scan'],
		['line\nbreak', 'papersync-line_break'],
		['Notes from café', 'papersync-Notes from café'],
	])('makes %j safe as %j', (id, expected) => {
		expect(attachmentBaseName(id)).toBe(expected);
	});
});

describe('saveImageToVault with a name another file already holds', () => {
	const asFile = (path: string): TFile => Object.assign(new TFile(), { path });
	const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;
	const vault = {
		getAbstractFileByPath: jest.fn(),
		createBinary: jest.fn().mockResolvedValue(undefined),
		createFolder: jest.fn().mockResolvedValue(undefined),
		readBinary: jest.fn(),
	};
	let files: Map<string, ArrayBuffer | 'folder'>;

	beforeEach(() => {
		jest.clearAllMocks();
		files = new Map();
		vault.getAbstractFileByPath.mockImplementation((path: string) => {
			const entry = files.get(path);
			if (entry === undefined) return null;
			return entry === 'folder' ? Object.assign(new TFolder(), { path }) : asFile(path);
		});
		vault.readBinary.mockImplementation(async (file: TFile) => files.get(file.path));
	});

	it('does not reuse another scan\'s photo when two ids sanitize to the same name', async () => {
		files.set('att/papersync-a_b.jpg', bytes(1, 2, 3));

		const path = await saveImageToVault(vault as any, bytes(9, 9), 'att', 'a#b');

		expect(path).toBe('att/papersync-a_b-2.jpg');
		expect(vault.createBinary).toHaveBeenCalledWith('att/papersync-a_b-2.jpg', bytes(9, 9));
	});

	it('reuses the file a retry of the same scan saved, wherever it landed', async () => {
		files.set('att/papersync-a_b.jpg', bytes(1, 2, 3));
		files.set('att/papersync-a_b-2.jpg', bytes(9, 9));

		expect(await saveImageToVault(vault as any, bytes(9, 9), 'att', 'a#b')).toBe('att/papersync-a_b-2.jpg');
		expect(await saveImageToVault(vault as any, bytes(1, 2, 3), 'att', 'a_b')).toBe('att/papersync-a_b.jpg');
		expect(vault.createBinary).not.toHaveBeenCalled();
	});

	it('never treats a folder at the path as the photo', async () => {
		files.set('papersync-scan-1.jpg', 'folder');

		expect(await saveImageToVault(vault as any, bytes(5), '', 'scan-1')).toBe('papersync-scan-1-2.jpg');
	});

	it('gives up after many taken names rather than looping', async () => {
		for (let n = 1; n <= 100; n++) {
			files.set(n === 1 ? 'papersync-s.jpg' : `papersync-s-${n}.jpg`, bytes(n % 250, 7));
		}

		await expect(saveImageToVault(vault as any, bytes(255), '', 's')).rejects.toThrow('papersync-s');
	});
});
