import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperSyncedPlugin from '@/main';
import { detectSyncLocations } from '@/utils/platform';
import type { SyncLocation } from '@/utils/platform';
import { STRINGS } from '@/utils/strings';

type WizardStep = 'welcome' | 'backend-pick' | 'auth-or-folder' | 'template' | 'target-folder';

const STEP_ORDER: WizardStep[] = ['welcome', 'backend-pick', 'auth-or-folder', 'template', 'target-folder'];

export class FirstRunModal extends Modal {
	private plugin: PaperSyncedPlugin;
	private currentStepIndex = 0;
	private stepState: {
		backendChoice: 'drive' | 'folder' | null;
		folderPath: string;
		folderType: string;
		templateString: string;
		targetFolder: string;
		oauthComplete: boolean;
	};

	constructor(app: App, plugin: PaperSyncedPlugin) {
		super(app);
		this.plugin = plugin;
		this.stepState = {
			backendChoice: null,
			folderPath: '',
			folderType: '',
			templateString: plugin.settings.templateString,
			targetFolder: plugin.settings.targetFolder || 'PaperSynced',
			oauthComplete: false,
		};
	}

	onOpen(): void {
		this.renderCurrentStep();
	}

	onClose(): void {
		// Dismissal without completion does NOT set setupComplete
	}

	private get currentStep(): WizardStep {
		return STEP_ORDER[this.currentStepIndex] ?? 'welcome';
	}

	private renderCurrentStep(): void {
		const { contentEl } = this;
		contentEl.empty();

		const stepNum = this.currentStepIndex + 1;
		const totalSteps = STEP_ORDER.length;
		contentEl.createEl('div', {
			text: `Step ${stepNum} of ${totalSteps}`,
			cls: 'papersynced-wizard-step-indicator',
		});

		switch (this.currentStep) {
			case 'welcome': this.renderWelcome(contentEl); break;
			case 'backend-pick': this.renderBackendPick(contentEl); break;
			case 'auth-or-folder': this.renderAuthOrFolder(contentEl); break;
			case 'template': this.renderTemplate(contentEl); break;
			case 'target-folder': this.renderTargetFolder(contentEl); break;
		}
	}

	private renderNavButtons(containerEl: HTMLElement, nextEnabled: boolean, isDone = false): void {
		const nav = new Setting(containerEl).setClass('papersynced-wizard-nav');

		if (this.currentStepIndex > 0) {
			nav.addButton(btn =>
				btn.setButtonText('Back').onClick(() => {
					this.currentStepIndex--;
					this.renderCurrentStep();
				})
			);
		}

		nav.addButton(btn => {
			btn.setButtonText(isDone ? 'Done' : 'Next')
				.setCta()
				.setDisabled(!nextEnabled)
				.onClick(async () => {
					if (isDone) {
						await this.completeWizard();
					} else {
						this.currentStepIndex++;
						this.renderCurrentStep();
					}
				});
		});
	}

	private renderWelcome(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Welcome to PaperSynced' });
		containerEl.createEl('p', {
			text: 'PaperSynced syncs handwritten scans from your phone into your Obsidian vault as markdown notes. Let\'s set it up.',
		});
		this.renderNavButtons(containerEl, true);
	}

	private renderBackendPick(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Choose your sync source' });
		containerEl.createEl('p', {
			text: 'How does the PaperSynced mobile app save your scans?',
		});

		const choices: Array<{ label: string; value: 'drive' | 'folder' }> = [
			{ label: 'Google Drive', value: 'drive' },
			{ label: 'Folder (iCloud, Dropbox, OneDrive, Syncthing, Obsidian Sync, or custom)', value: 'folder' },
		];

		for (const choice of choices) {
			const isSelected = this.stepState.backendChoice === choice.value;
			new Setting(containerEl)
				.setName(`${isSelected ? '\u2713 ' : ''}${choice.label}`)
				.addButton(btn =>
					btn.setButtonText(isSelected ? 'Selected' : 'Select').onClick(() => {
						this.stepState.backendChoice = choice.value;
						this.renderCurrentStep();
					})
				);
		}

		this.renderNavButtons(containerEl, this.stepState.backendChoice !== null);
	}

	private renderAuthOrFolder(containerEl: HTMLElement): void {
		if (this.stepState.backendChoice === 'drive') {
			this.renderDriveAuth(containerEl);
		} else {
			this.renderFolderPick(containerEl);
		}
	}

	private renderDriveAuth(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Connect Google Drive' });

		if (this.stepState.oauthComplete) {
			containerEl.createEl('p', { text: 'Connected to Google Drive.' });
			this.renderNavButtons(containerEl, true);
			return;
		}

		// Unverified app warning (Story 3.2)
		containerEl.createEl('h3', { text: STRINGS.UNVERIFIED_APP_TITLE });
		containerEl.createEl('p', { text: STRINGS.UNVERIFIED_APP_WHY });
		containerEl.createEl('p', { text: STRINGS.UNVERIFIED_APP_SAFE });
		containerEl.createEl('p', { text: STRINGS.UNVERIFIED_APP_CLICK_PATH });

		new Setting(containerEl).addButton(btn =>
			btn.setButtonText(STRINGS.UNVERIFIED_APP_CONFIRM).setCta().onClick(async () => {
				try {
					this.plugin.settings.backendType = 'drive';
					await this.plugin.saveSettings();
					await this.plugin.oauthManager?.startAuthFlow();
					this.plugin.settings.setupComplete = true;
					await this.plugin.saveSettings();
					this.stepState.oauthComplete = true;
					this.renderCurrentStep();
				} catch (err) {
					this.plugin.settings.backendType = 'none';
					await this.plugin.saveSettings();
					new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			})
		);

		this.renderNavButtons(containerEl, false);
	}

	private renderFolderPick(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Choose your sync folder' });

		const vaultPath = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
		const detected = detectSyncLocations(vaultPath);

		if (detected.length === 0) {
			containerEl.createEl('p', {
				text: 'Dropbox, OneDrive, iCloud, Syncthing, or Obsidian Sync were not found at their default locations.',
				cls: 'setting-item-description',
			});
		}

		for (const loc of detected) {
			const isSelected = this.stepState.folderPath === loc.path;
			new Setting(containerEl)
				.setName(`${isSelected ? '\u2713 ' : ''}${loc.displayName}`)
				.setDesc(loc.path)
				.addButton(btn =>
					btn.setButtonText(isSelected ? 'Selected' : 'Select').onClick(() => {
						this.stepState.folderPath = loc.path;
						this.stepState.folderType = loc.type;
						this.renderCurrentStep();
					})
				);
		}

		new Setting(containerEl)
			.setName('Pick another folder...')
			.addText(text =>
				text
					.setPlaceholder('/path/to/PaperSynced/scans')
					.setValue(this.stepState.folderPath && !detected.find(d => d.path === this.stepState.folderPath) ? this.stepState.folderPath : '')
					.onChange(value => {
						if (value.trim()) {
							this.stepState.folderPath = value.trim();
							this.stepState.folderType = 'custom';
						}
					})
			);

		this.renderNavButtons(containerEl, this.stepState.folderPath !== '');
	}

	private renderTemplate(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Note template' });
		containerEl.createEl('p', {
			text: 'This template determines how each scan appears in your vault. You can change it later in settings.',
		});

		new Setting(containerEl)
			.setName('Template')
			.addTextArea(text =>
				text
					.setValue(this.stepState.templateString)
					.onChange(value => { this.stepState.templateString = value; })
			);

		this.renderNavButtons(containerEl, true);
	}

	private renderTargetFolder(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Notes folder' });
		containerEl.createEl('p', {
			text: 'Where should synced notes be created in your vault?',
		});

		new Setting(containerEl)
			.setName('Target folder')
			.addText(text =>
				text
					.setValue(this.stepState.targetFolder)
					.onChange(value => { this.stepState.targetFolder = value; })
			);

		this.renderNavButtons(containerEl, this.stepState.targetFolder.trim() !== '', true);
	}

	private async completeWizard(): Promise<void> {
		// Persist all wizard state to settings
		if (this.stepState.backendChoice === 'folder') {
			this.plugin.settings.backendType = 'folder';
			this.plugin.settings.folderPath = this.stepState.folderPath;
			this.plugin.settings.folderType = this.stepState.folderType;
		}
		this.plugin.settings.templateString = this.stepState.templateString;
		this.plugin.settings.targetFolder = this.stepState.targetFolder;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();

		this.close();
		await this.plugin.startSync();
		new Notice('PaperSynced is syncing now');
	}
}
