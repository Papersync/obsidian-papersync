import { Vault, normalizePath } from 'obsidian';
import { logger } from '@/utils/logger';

export async function saveImageToVault(
	vault: Vault,
	imageData: ArrayBuffer,
	attachmentsFolder: string,
	scanId: string
): Promise<string> {
	const folderPath = attachmentsFolder;
	const fileName = `papersync-${scanId}.jpg`;
	// An empty folder means the vault root: save the file there with no leading slash and
	// no folder to create. normalizePath collapses any stray '//' so the embed never breaks.
	const filePath = normalizePath(folderPath ? `${folderPath}/${fileName}` : fileName);

	if (folderPath) {
		await ensureFolderExists(vault, folderPath);
	}

	const existing = vault.getAbstractFileByPath(filePath);
	if (existing) {
		logger.info(`Image already exists at ${filePath}, skipping`);
	} else {
		await vault.createBinary(filePath, imageData);
		logger.info(`Saved image to ${filePath}`);
	}

	return filePath;
}

async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
	const parts = folderPath.split('/');
	let current = '';

	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = vault.getAbstractFileByPath(current);
		if (!existing) {
			try {
				await vault.createFolder(current);
			} catch {
				// Folder may have been created by another operation
			}
		}
	}
}
