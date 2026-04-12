import { App, Vault } from 'obsidian';
import { renderTemplate } from '@/notes/template-engine';
import type { TemplateContext } from '@/notes/template-engine';
import { saveImageToVault } from '@/notes/image-handler';
import type { ScanFile } from '@/validation/scan-file-schema';
import { getDailyNotesConfig, formatDateWithPattern } from '@/utils/daily-notes';
import { logger } from '@/utils/logger';

export interface NoteCreatorConfig {
	templateString: string;
	targetFolder: string;
	attachmentsFolder: string;
}

export class NoteCreator {
	private app: App;
	private vault: Vault;
	private config: NoteCreatorConfig;

	constructor(app: App, vault: Vault, config: NoteCreatorConfig) {
		this.app = app;
		this.vault = vault;
		this.config = config;
	}

	async createOrAppend(
		scanFile: ScanFile,
		imageData: ArrayBuffer,
		scanId: string
	): Promise<string> {
		const imagePath = await saveImageToVault(
			this.vault,
			imageData,
			this.config.attachmentsFolder,
			scanId
		);

		const createdDate = new Date(scanFile.createdAt);
		const dailyConfig = getDailyNotesConfig(this.app);

		const dateShort = formatDateWithPattern(createdDate, dailyConfig.format);
		const hours = String(createdDate.getUTCHours()).padStart(2, '0');
		const minutes = String(createdDate.getUTCMinutes()).padStart(2, '0');
		const time = `${hours}:${minutes}`;
		const rawFolder = this.config.targetFolder || dailyConfig.folder;
		const noteFolder = rawFolder ? formatDateWithPattern(createdDate, rawFolder) : '';

		const notePath = noteFolder ? `${noteFolder}/${dateShort}.md` : `${dateShort}.md`;

		if (noteFolder) {
			await this.ensureFolderExists(noteFolder);
		}

		const existingFile = this.vault.getAbstractFileByPath(notePath);
		const isAppend = !!existingFile;

		const context: TemplateContext = {
			date: scanFile.createdAt,
			date_short: dateShort,
			time,
			confidence: scanFile.confidence,
			provider: scanFile.provider,
			model: scanFile.model,
			image_file: imagePath,
			markdown: scanFile.markdown,
			separator: isAppend ? '---' : '',
		};

		const rendered = renderTemplate(this.config.templateString, context);

		if (isAppend) {
			const existingContent = await this.vault.adapter.read(notePath);
			const trimmed = existingContent.trimEnd();
			const newContent = trimmed.length > 0
				? trimmed + '\n\n' + rendered
				: rendered;
			await this.vault.adapter.write(notePath, newContent);
			logger.info(`Appended scan ${scanId} to ${notePath}`);
		} else {
			await this.vault.create(notePath, rendered);
			logger.info(`Created new note ${notePath} for scan ${scanId}`);
		}

		return notePath;
	}

	private async ensureFolderExists(folderPath: string): Promise<void> {
		const parts = folderPath.split('/');
		let current = '';

		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.vault.getAbstractFileByPath(current);
			if (!existing) {
				try {
					await this.vault.createFolder(current);
				} catch {
					// May already exist
				}
			}
		}
	}
}
