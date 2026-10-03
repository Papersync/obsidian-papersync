import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { App } from 'obsidian';
import { FolderBackend } from '@/sync/folder-backend';
import { SyncEngine } from '@/sync/sync-engine';
import { SyncState } from '@/sync/sync-state';
import { ErrorHandler } from '@/errors/error-handler';

const config = {
	templateString: '{{ps_markdown}}\n![[{{ps_image_file}}]]',
	targetFolder: 'Notes',
	attachmentsFolder: 'Attachments',
	downloadImages: true,
};
const vault = {
	getAbstractFileByPath: jest.fn().mockReturnValue(null),
	create: jest.fn().mockResolvedValue(undefined),
	createBinary: jest.fn().mockResolvedValue(undefined),
	createFolder: jest.fn().mockResolvedValue(undefined),
	adapter: { read: jest.fn().mockResolvedValue(''), write: jest.fn().mockResolvedValue(undefined) },
};

describe('missing companion through real filesystem and sync engine', () => {
	let dir: string;
	let backend: FolderBackend;
	let engine: SyncEngine;
	let state: SyncState;
	function write(createdAt = '2026-01-01T12:00:00Z'): void {
		fs.writeFileSync(
			path.join(dir, 'scan.json'),
			JSON.stringify({
				version: 1,
				createdAt,
				markdown: '# Kept handwriting',
				confidence: 95,
				provider: 'test',
				model: 'test',
				imageFileName: 'scan.jpg',
			})
		);
	}
	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papersync-companion-'));
		backend = new FolderBackend(dir);
		state = new SyncState('');
		engine = new SyncEngine(
			backend,
			{ vault } as unknown as App,
			config,
			new ErrorHandler(state),
			state
		);
	});
	afterEach(() => {
		engine.stop();
		fs.rmSync(dir, { recursive: true, force: true });
		jest.useRealTimers();
	});

	it.each(['delete', 'move'])('imports JSON exactly once after photo %s', async (action) => {
		write();
		fs.writeFileSync(path.join(dir, 'scan.jpg'), 'photo');
		if (action === 'delete') {
			fs.unlinkSync(path.join(dir, 'scan.jpg'));
		} else {
			fs.renameSync(path.join(dir, 'scan.jpg'), path.join(dir, 'moved.jpg'));
		}
		await engine.forceSyncNow();
		jest.setSystemTime(Date.now()+60_000);
		await engine.forceSyncNow();
		await engine.forceSyncNow();
		expect(vault.create).toHaveBeenCalledTimes(1);
		expect(vault.create.mock.calls[0][1]).toContain('# Kept handwriting');
		expect(vault.create.mock.calls[0][1]).not.toContain('![[');
		expect(vault.createBinary).not.toHaveBeenCalled();
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')).synced).toBe(true);
	});

	it('keeps a newly uploaded JSON pending and imports an arriving photo on recheck', async () => {
		jest.useFakeTimers();
		write(new Date().toISOString());
		await engine.forceSyncNow();
		expect(vault.create).not.toHaveBeenCalled();
		expect(state.pendingCount).toBe(1);
		fs.writeFileSync(path.join(dir, 'scan.jpg'), 'photo');
		jest.setSystemTime(Date.now() + 60_000);
		await engine.forceSyncNow();
		expect(vault.createBinary).toHaveBeenCalledTimes(1);
		expect(vault.create.mock.calls[0][1]).toContain('![[Attachments/');
	});

	it('falls back after the bounded upload grace without holding the batch open', async () => {
		jest.useFakeTimers();
		write(new Date().toISOString());
		await engine.forceSyncNow();
		jest.setSystemTime(Date.now() + 60_000);
		await engine.forceSyncNow();
		expect(state.isSyncing).toBe(false);
		expect(vault.create).toHaveBeenCalledTimes(1);
	});

	it('surfaces image permission errors and does not mark JSON as synced', async () => {
		write();
		fs.writeFileSync(path.join(dir, 'scan.jpg'), 'photo');
		const original = fs.promises.readFile;
		const spy = jest
			.spyOn(fs.promises, 'readFile')
			.mockImplementation((...args: Parameters<typeof original>) => {
				if (String(args[0]).endsWith('scan.jpg')) {
					return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
				}
				return original(...args);
			});
		try {
			await engine.forceSyncNow();
		} finally {
			spy.mockRestore();
		}
		expect(vault.create).not.toHaveBeenCalled();
		expect(JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8')).synced).toBeUndefined();
	});
});

it('reports a missing companion without attempting to read an empty path', async () => {
	const backend = new FolderBackend('/unused');
	await expect(
		backend.fetchImage({ id: 'orphan', jsonPath: '/unused/orphan.json', imagePath: '' })
	).resolves.toBeNull();
});
