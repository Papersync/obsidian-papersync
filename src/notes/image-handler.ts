import { TFile, Vault, normalizePath } from 'obsidian';
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

// The vault file name for a scan's photo, without extension. The scan id comes
// from a file name in the synced folder or on Drive, where it can hold '/', '..'
// or characters Obsidian rejects; Obsidian's path check does not stop '..', so a
// crafted id could otherwise write outside the attachments folder (or the vault).
// Wikilink characters are replaced too, so the embed always resolves.
export function attachmentBaseName(scanId: string): string {
	const safe = scanId
		.replace(/[\\/:*?"<>|#^[\]\p{Cc}]/gu, '_')
		.replace(/\.{2,}/g, '_')
		.replace(/^[.\s]+|[.\s]+$/g, '');
	return `papersync-${safe || 'scan'}`;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	const left = new Uint8Array(a);
	const right = new Uint8Array(b);
	return left.length === right.length && left.every((byte, i) => byte === right[i]);
}

// Distinct ids can sanitize to one name ('a#b' and 'a_b'), so a file already at the
// path is reused only when it holds these exact bytes: a retry of this scan. Else
// the next free '-2', '-3'... name is taken, so a note never embeds another scan's
// photo, and a folder at the path is never mistaken for one. Names stay as before
// whenever the path is free.
const MAX_NAME_TRIES = 100;

export async function saveImageToVault(
	vault: Vault,
	imageData: ArrayBuffer,
	attachmentsFolder: string,
	scanId: string
): Promise<string> {
	const folderPath = attachmentsFolder;
	const baseName = attachmentBaseName(scanId);
	const extension = imageExtension(imageData);

	if (folderPath) {
		await ensureFolderExists(vault, folderPath);
	}

	for (let n = 1; n <= MAX_NAME_TRIES; n++) {
		const fileName = `${baseName}${n === 1 ? '' : `-${n}`}.${extension}`;
		// An empty folder means the vault root: save the file there with no leading slash
		// and no folder to create. normalizePath collapses any stray '//' so the embed
		// never breaks.
		const filePath = normalizePath(folderPath ? `${folderPath}/${fileName}` : fileName);
		const existing = vault.getAbstractFileByPath(filePath);
		if (existing === null) {
			await vault.createBinary(filePath, imageData);
			logger.info(`Saved image to ${filePath}`);
			return filePath;
		}
		if (existing instanceof TFile && sameBytes(await vault.readBinary(existing), imageData)) {
			logger.info(`Image already exists at ${filePath}, skipping`);
			return filePath;
		}
	}
	throw new Error(`No free file name for ${baseName}.${extension} in ${folderPath || 'the vault root'}`);
}
