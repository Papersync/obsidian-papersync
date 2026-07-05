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
	downloadImages: boolean;
}

export class NoteCreator {
	private app: App;
	private vault: Vault;
	readonly config: NoteCreatorConfig;

	constructor(app: App, vault: Vault, config: NoteCreatorConfig) {
		this.app = app;
		this.vault = vault;
		this.config = config;
	}

	async createOrAppend(
		scanFile: ScanFile,
		imageData: ArrayBuffer | null,
		scanId: string
	): Promise<string> {
		let imagePath = '';
		if (this.config.downloadImages && imageData) {
			imagePath = await saveImageToVault(
				this.vault,
				imageData,
				this.config.attachmentsFolder,
				scanId
			);
		}

		const createdDate = new Date(scanFile.createdAt);
		const dailyConfig = getDailyNotesConfig(this.app);

		const dateShort = formatDateWithPattern(createdDate, dailyConfig.format);
		const h24 = createdDate.getHours();
		const minutes = String(createdDate.getMinutes()).padStart(2, '0');
		const time24 = `${String(h24).padStart(2, '0')}:${minutes}`;
		const h12 = h24 % 12 || 12;
		const ampm = h24 < 12 ? 'AM' : 'PM';
		const time12 = `${h12}:${minutes} ${ampm}`;
		const rawFolder = this.config.targetFolder || dailyConfig.folder;
		const noteFolder = rawFolder ? formatDateWithPattern(createdDate, rawFolder) : '';

		const notePath = noteFolder ? `${noteFolder}/${dateShort}.md` : `${dateShort}.md`;

		if (noteFolder) {
			await this.ensureFolderExists(noteFolder);
		}

		const existingFile = this.vault.getAbstractFileByPath(notePath);
		const isAppend = !!existingFile;

		const context: TemplateContext = {
			ps_scan_date: scanFile.createdAt,
			ps_scan_date_short: dateShort,
			ps_scan_time: time12,
			ps_scan_time_24h: time24,
			ps_confidence: scanFile.confidence,
			ps_provider: scanFile.provider,
			ps_model: scanFile.model,
			ps_image_file: imagePath,
			ps_markdown: scanFile.markdown,
			// '***' (not '---') as the divider: it renders as the same horizontal rule but
			// is never parsed as a setext heading underline or YAML frontmatter fence, so it
			// stays safe wherever the user places {{ps_separator}} in their template.
			ps_separator: isAppend ? '***' : '',
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
