import { saveImageToVault } from '@/notes/image-handler';

const mockVault = {
	getAbstractFileByPath: jest.fn(),
	createBinary: jest.fn().mockResolvedValue(undefined),
	createFolder: jest.fn().mockResolvedValue(undefined),
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

	it('skips creation if image already exists', async () => {
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'attachments/papersync/papersync-scan-001.jpg') return { path };
			return null;
		});

		const imageData = new ArrayBuffer(100);
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
		const imageData = new ArrayBuffer(100);

		await expect(
			saveImageToVault(mockVault as any, imageData, 'attachments/papersync', 'scan-race')
		).resolves.toBe('attachments/papersync/papersync-scan-race.jpg');
		expect(mockVault.createBinary).toHaveBeenCalled();
	});
});
