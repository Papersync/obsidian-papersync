import { App, Vault, moment, normalizePath } from 'obsidian';
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

		// The daily-note filename must match Obsidian's own, which is moment-formatted
		// (arbitrary format string incl. month names, time tokens, escaped literals, '/').
		// A hand-rolled Y/M/D replacer diverges (e.g. `MMMM D, YYYY` -> "0707 5, 2026")
		// and writes a garbage parallel note instead of appending to the real one.
		const dateShort = moment(createdDate).format(dailyConfig.format);
		const h24 = createdDate.getHours();
		const minutes = String(createdDate.getMinutes()).padStart(2, '0');
		const time24 = `${String(h24).padStart(2, '0')}:${minutes}`;
		const h12 = h24 % 12 || 12;
		const ampm = h24 < 12 ? 'AM' : 'PM';
		const time12 = `${h12}:${minutes} ${ampm}`;
		// The folder pattern keeps the Y/M/D replacer: it can contain literal folder names
		// (e.g. "Journal") that moment would mangle. Strip a trailing slash so it never
		// produces a "//" path. normalizePath keeps the existence check and create in sync.
		const rawFolder = (this.config.targetFolder || dailyConfig.folder).replace(/\/+$/, '');
		const noteFolder = rawFolder ? formatDateWithPattern(createdDate, rawFolder) : '';

		const notePath = normalizePath(noteFolder ? `${noteFolder}/${dateShort}.md` : `${dateShort}.md`);

		// Ensure the FULL parent path — dateShort itself can contain '/' (e.g. a
		// `YYYY/MM/DD` daily format), and vault.create does not create missing parents.
		const parentFolder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
		if (parentFolder) {
			await this.ensureFolderExists(parentFolder);
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

		let rendered = renderTemplate(this.config.templateString, context);

		if (imagePath === '') {
			// No image was saved (saving off, or none attached), so {{ps_image_file}}
			// expanded to '' and the embed line is a broken `![[]]`. Drop that whole line
			// (with any callout/list marker) rather than shipping an empty embed.
			rendered = rendered.replace(/^[ \t]*(?:>[ \t]*)?(?:[-*][ \t]*)?!\[\[\]\][ \t]*(?:\r?\n|$)/gm, '');
		}

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
