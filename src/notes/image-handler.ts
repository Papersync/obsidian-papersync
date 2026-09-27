import { Vault, normalizePath } from 'obsidian';
import { ensureFolderExists } from '@/utils/vault';
import { logger } from '@/utils/logger';

// Scans are JPEG except older archives, which can be PNG. Naming a PNG ".jpg" breaks
// its type for other tools and exports, so the extension follows the bytes: the PNG
// signature below, else .jpg.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imageExtension(data: ArrayBuffer): 'png' | 'jpg' {
	const head = new Uint8Array(data, 0, Math.min(PNG_SIGNATURE.length, data.byteLength));
	const isPng = head.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => head[i] === byte);
	return isPng ? 'png' : 'jpg';
}

export async function saveImageToVault(
	vault: Vault,
	imageData: ArrayBuffer,
	attachmentsFolder: string,
	scanId: string
): Promise<string> {
	const folderPath = attachmentsFolder;
	const fileName = `papersync-${scanId}.${imageExtension(imageData)}`;
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
