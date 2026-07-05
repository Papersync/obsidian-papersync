// Covers the String(err) branch of FolderBackend.start()'s catch, where fs.watch
// throws a NON-Error value. `import * as fs` yields a non-configurable namespace,
// so jest.spyOn(fs, 'watch') can't redefine it — we mock the module instead,
// keeping fs.promises real (FolderBackend uses it elsewhere) via requireActual.

jest.mock('fs', () => {
	const actual = jest.requireActual('fs');
	return {
		...actual,
		watch: jest.fn(() => {
			throw 'watcher-blew-up'; // not an Error instance → forces String(err)
		}),
	};
});

import { FolderBackend } from '@/sync/folder-backend';

describe('FolderBackend.start — fs.watch throws a non-Error', () => {
	it('logs and recovers without throwing (String(err) branch)', () => {
		const backend = new FolderBackend('/whatever');
		expect(() => backend.start()).not.toThrow();
		backend.stop();
	});
});
