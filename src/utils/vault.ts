import { Vault } from 'obsidian';

// Create every missing segment of a vault-relative folder path. vault.createFolder
// does not create missing parents, so walk the path and create each level. A
// concurrent operation may create a segment between the existence check and the
// create call, so swallow the resulting "already exists" throw.
export async function ensureFolderExists(vault: Vault, folderPath: string): Promise<void> {
	const parts = folderPath.split('/');
	let current = '';

	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = vault.getAbstractFileByPath(current);
		if (!existing) {
			try {
				await vault.createFolder(current);
			} catch {
				// Folder may already exist (created by another operation).
			}
		}
	}
}
