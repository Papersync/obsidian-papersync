import { App, Vault, TFile, moment, normalizePath } from 'obsidian';
import { scanTitle } from '@papersync/scan-format';
import { renderTemplate } from '@/notes/template-engine';
import { MAX_SUMMARY_CHARS, MAX_TITLE_CHARS, clampLength, neutralizeMarkdown } from '@/notes/untrusted-text';
import type { TemplateContext } from '@/notes/template-engine';
import { attachmentBaseName, saveImageToVault } from '@/notes/image-handler';
import type { ScanFile } from '@/validation/scan-file-schema';
import { getDailyNotesConfig, formatDateWithPattern, defaultNotesFolder } from '@/utils/daily-notes';
import { ensureFolderExists } from '@/utils/vault';
import { logger } from '@/utils/logger';

// obsidian.d.ts types its `moment` export as `typeof Moment` from
// `import * as Moment from 'moment'`. Under esModuleInterop (TypeScript 6's
// default) a namespace import of an `export =` module is not callable, although
// the runtime value is the moment function. Describe the one call made here
// rather than depend on moment's typings directly (it is only a transitive dep).
const momentOf = moment as unknown as (date: Date) => { format(pattern: string): string };

// The plugin-owned frontmatter list of scan ids already written into a note. The
// import checks it before appending, so a scan whose "synced" flag could not be
// written back (a failed Drive PATCH, a read-only JSON) is never appended twice when
// it is retried or rediscovered. Ids are stored raw.
//
// Write order (append first, id second): the append and the property update are two
// writes, and a crash can fall between them. With the id written first, a crash would
// leave the id listed with no block, and the scan would be skipped forever (silent
// data loss). With the block written first, a crash leaves a block with no id, and the
// retry appends it once more (a visible duplicate the user can delete). A duplicate is
// recoverable, a lost scan is not, so the block goes first. The window is two adjacent
// local writes. The id is added with processFrontMatter, never by editing YAML by hand.
export const SCANS_PROPERTY = 'papersync-scans';

// Closed-test notes carry `%% papersync:<id> %% ` comments from the earlier scheme.
// They still count as "already imported" (matched in their URI-encoded form); the
// plugin never writes them any more.
function legacyMarker(scanId: string): string {
	return `%% papersync:${encodeURIComponent(scanId)} %%`;
}

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
		// One set of values for the whole scan, even if Settings commits an edit
		// while this note is being written.
		const config = { ...this.config };
		const createdDate = new Date(scanFile.createdAt);
		const dailyConfig = getDailyNotesConfig(this.app);

		// The daily-note filename must match Obsidian's own, which is moment-formatted
		// (arbitrary format string incl. month names, time tokens, escaped literals, '/').
		// A hand-rolled Y/M/D replacer diverges (e.g. `MMMM D, YYYY` -> "0707 5, 2026")
		// and writes a garbage parallel note instead of appending to the real one.
		const dateShort = momentOf(createdDate).format(dailyConfig.format);
		const h24 = createdDate.getHours();
		const minutes = String(createdDate.getMinutes()).padStart(2, '0');
		const time24 = `${String(h24).padStart(2, '0')}:${minutes}`;
		const h12 = h24 % 12 || 12;
		const ampm = h24 < 12 ? 'AM' : 'PM';
		const time12 = `${h12}:${minutes} ${ampm}`;
		// The folder pattern keeps the Y/M/D replacer: it can contain literal folder names
		// (e.g. "Journal") that moment would mangle. Strip a trailing slash so it never
		// produces a "//" path. normalizePath keeps the existence check and create in sync.
		const rawFolder = (config.targetFolder || defaultNotesFolder(dailyConfig)).replace(/\/+$/, '');
		const noteFolder = rawFolder ? formatDateWithPattern(createdDate, rawFolder) : '';

		const notePath = normalizePath(noteFolder ? `${noteFolder}/${dateShort}.md` : `${dateShort}.md`);

		// Ensure the FULL parent path — dateShort itself can contain '/' (e.g. a
		// `YYYY/MM/DD` daily format), and vault.create does not create missing parents.
		const parentFolder = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
		if (parentFolder) {
			await ensureFolderExists(this.vault, parentFolder);
		}

		const existingFile = this.vault.getAbstractFileByPath(notePath);
		// Only a file (not a folder) at this path counts as an append target.
		const isAppend = existingFile instanceof TFile;

		// Save the scan image now that notePath is known (Obsidian's note-relative
		// attachment mode needs it). Empty imagePath => no embed (stripped below).
		let imagePath = '';
		if (config.downloadImages && imageData) {
			const attachmentsFolder = await this.resolveAttachmentsFolder(config.attachmentsFolder, scanId, notePath);
			imagePath = await saveImageToVault(this.vault, imageData, attachmentsFolder, scanId);
		}

		const context: TemplateContext = {
			ps_scan_date: scanFile.createdAt,
			ps_scan_date_short: dateShort,
			ps_scan_time: time12,
			ps_scan_time_24h: time24,
			ps_confidence: scanFile.confidence,
			ps_provider: scanFile.provider,
			ps_model: scanFile.model,
			// Clamped on read too: only the app's writer clamps them, and a hand-made
			// scan with a 1 MB title would become a 1 MB heading.
			ps_title: clampLength(scanTitle(scanFile, time12), MAX_TITLE_CHARS),
			ps_summary: clampLength(scanFile.summary ?? '', MAX_SUMMARY_CHARS),
			ps_image_file: imagePath,
			ps_markdown: scanFile.markdown,
			// '***' (not '---') as the divider: it renders as the same horizontal rule but
			// is never parsed as a setext heading underline or YAML frontmatter fence, so it
			// stays safe wherever the user places {{ps_separator}} in their template.
			ps_separator: isAppend ? '***' : '',
		};

		let rendered = renderTemplate(config.templateString, context);

		if (imagePath === '') {
			// No image was saved (saving off, or none attached), so {{ps_image_file}}
			// expanded to '' and the embed line is a broken `![[]]`. Drop that whole line
			// (with any callout/list marker) rather than shipping an empty embed.
			// A sized or aliased embed (`![[|300]]`) is just as empty, nested quotes,
			// numbered lists and task boxes go with it, and one placed inline goes on
			// its own.
			rendered = rendered
				.replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]*(?:\[.\][ \t]*)?)?!\[\[(?:\|[^\]\n]*)?\]\][ \t]*(?:\r?\n|$)/gm, '')
				.replace(/[ \t]*!\[\[(?:\|[^\]\n]*)?\]\]/g, '');

			// A template that only places the photo would import nothing for this scan
			// and still mark it imported, so keep its text instead.
			const textSentinel = '\u0000papersync-text\u0000';
			const placesText = renderTemplate(config.templateString, { ...context, ps_markdown: textSentinel }).includes(textSentinel);
			if (!placesText && scanFile.markdown.trim() !== '') {
				rendered = `${rendered.trimEnd()}${rendered.trim() === '' ? '' : '\n\n'}${neutralizeMarkdown(scanFile.markdown)}\n`;
			}
		}

		rendered = `${rendered.trimEnd()}\n`;

		let target: TFile;
		if (existingFile instanceof TFile) {
			target = existingFile;
			const listed = this.app.metadataCache.getFileCache(existingFile)?.frontmatter?.[SCANS_PROPERTY];
			if ([listed].flat().map(String).includes(scanId)) {
				logger.info(`Scan ${scanId} is already listed in ${notePath}, not appending it again`);
				return notePath;
			}
			// vault.process is an atomic read-modify-write that goes through Obsidian's
			// cache and fires modify events, unlike adapter.read/write which bypasses both.
			// The legacy marker check runs inside it, on the content it is about to change.
			const marker = legacyMarker(scanId);
			let alreadyImported = false;
			await this.vault.process(existingFile, (existingContent) => {
				if (existingContent.includes(marker)) {
					alreadyImported = true;
					return existingContent;
				}
				const trimmed = existingContent.trimEnd();
				return trimmed.length > 0
					? trimmed + '\n\n' + rendered
					: rendered;
			});
			if (alreadyImported) {
				logger.info(`Scan ${scanId} is already in ${notePath} (legacy marker), not appending it again`);
				return notePath;
			}
			logger.info(`Appended scan ${scanId} to ${notePath}`);
		} else {
			target = await this.vault.create(notePath, rendered);
			logger.info(`Created new note ${notePath} for scan ${scanId}`);
		}

		await this.listScan(target, scanId);

		return notePath;
	}

	// Adds the id to the note's papersync-scans list: every other property is kept,
	// the frontmatter is created when absent, and an id is never listed twice. A
	// failure (e.g. unparseable YAML) must not fail the import: the block is already
	// written, and throwing would make the retry append it again.
	private async listScan(file: TFile, scanId: string): Promise<void> {
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				const current = [frontmatter[SCANS_PROPERTY]].flat().filter((id) => id != null);
				if (!current.map(String).includes(scanId)) {
					frontmatter[SCANS_PROPERTY] = [...current, scanId];
				}
			});
		} catch (err) {
			logger.warn(`Could not record scan ${scanId} in ${file.path} frontmatter: ${String(err)}`);
		}
	}

	// Where scan images are saved. A user override is used verbatim; otherwise mirror
	// Obsidian's own attachment location (via the public FileManager API — sanitized and
	// cross-platform). We reuse our own stable filename below, so take only the directory;
	// '' means the vault root.
	private async resolveAttachmentsFolder(setting: string, scanId: string, notePath: string): Promise<string> {
		// '/' is the vault root, as in the Notes folder (empty means Obsidian's own folder).
		if (/^\s*\/+\s*$/.test(setting)) {
			return '';
		}
		// Strip a trailing slash for parity with targetFolder, so 'Attachments/' does not
		// become 'Attachments//papersync-<id>.jpg' and a broken embed.
		const override = setting.trim().replace(/\/+$/, '');
		if (override) {
			return override;
		}
		const obsidianPath = await this.app.fileManager.getAvailablePathForAttachment(
			`${attachmentBaseName(scanId)}.jpg`,
			notePath
		);
		const dir = obsidianPath.includes('/')
			? obsidianPath.slice(0, obsidianPath.lastIndexOf('/'))
			: '';
		return dir ? normalizePath(dir) : '';
	}
}
