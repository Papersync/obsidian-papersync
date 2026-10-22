import * as fs from 'fs';

// True only for a path that exists AND is a directory. A folder backend whose
// folder fails this is "missing": deleted, renamed, or on a drive that is not
// mounted right now.
export function isExistingDirectory(folderPath: string): boolean {
	try {
		return fs.statSync(folderPath).isDirectory();
	} catch {
		return false;
	}
}
