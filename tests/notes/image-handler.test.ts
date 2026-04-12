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
			'attachments/papersynced',
			'scan-001'
		);

		expect(embed).toBe('attachments/papersynced/papersynced-scan-001.jpg');
	});

	it('creates the image file in the vault', async () => {
		const imageData = new ArrayBuffer(100);

		await saveImageToVault(mockVault as any, imageData, 'attachments/papersynced', 'scan-001');

		expect(mockVault.createBinary).toHaveBeenCalledWith(
			'attachments/papersynced/papersynced-scan-001.jpg',
			imageData
		);
	});

	it('skips creation if image already exists', async () => {
		mockVault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'attachments/papersynced/papersynced-scan-001.jpg') return { path };
			return null;
		});

		const imageData = new ArrayBuffer(100);
		await saveImageToVault(mockVault as any, imageData, 'attachments/papersynced', 'scan-001');

		expect(mockVault.createBinary).not.toHaveBeenCalled();
	});

	it('creates nested folder structure', async () => {
		const imageData = new ArrayBuffer(100);

		await saveImageToVault(mockVault as any, imageData, 'attachments/papersynced', 'scan-001');

		expect(mockVault.createFolder).toHaveBeenCalledWith('attachments');
		expect(mockVault.createFolder).toHaveBeenCalledWith('attachments/papersynced');
	});
});
