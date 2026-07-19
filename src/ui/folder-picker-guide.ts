import { App, Modal, Setting } from 'obsidian';

/**
 * Shown before the OS folder dialog, because that dialog gives us no way to
 * label anything: once it is open the user is on their own, and picking one
 * level too deep leaves the plugin watching a folder that never receives scans.
 * The failure is silent (sync simply finds nothing), so the guidance has to come
 * first rather than as an error afterwards.
 *
 * The tree is drawn as themed DOM rather than a bundled image so it stays sharp
 * at any zoom, adapts to light and dark, and can be read by a screen reader.
 */
export class FolderPickerGuideModal extends Modal {
	private readonly onConfirm: () => void;

	constructor(app: App, onConfirm: () => void) {
		super(app);
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('Choose your Papersync folder');

		contentEl.createEl('p', {
			cls: 'papersync-guide-lead',
			text: 'Pick the Papersync folder itself, the one your phone writes scans into. Picking the folder above it, or a folder inside it, leaves nothing to sync.',
		});

		const tree = contentEl.createDiv({ cls: 'papersync-guide-tree' });

		const row = (
			depth: number,
			name: string,
			verdict: 'yes' | 'no' | 'none',
			note: string
		): void => {
			const line = tree.createDiv({ cls: `papersync-guide-row is-${verdict}` });
			line.style.setProperty('--depth', String(depth));
			line.createSpan({ cls: 'papersync-guide-folder', text: name });
			if (verdict !== 'none') {
				line.createSpan({
					cls: 'papersync-guide-badge',
					text: verdict === 'yes' ? '✓' : '✕',
					attr: { 'aria-hidden': 'true' },
				});
			}
			// Carries the same meaning as the badge for anyone not seeing colour.
			line.createSpan({ cls: 'papersync-guide-note', text: note });
		};

		row(0, 'iCloud Drive, Dropbox, OneDrive...', 'no', 'too high up, no scans here');
		row(1, 'Papersync', 'yes', 'choose this one');
		row(2, 'scans', 'no', 'too deep, older layouts only');

		contentEl.createEl('p', {
			cls: 'papersync-guide-foot',
			text: 'If you land on the wrong level, Papersync corrects it where it can. The names above are the ones to look for.',
		});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((b) =>
				b
					.setCta()
					.setButtonText('Choose folder')
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
