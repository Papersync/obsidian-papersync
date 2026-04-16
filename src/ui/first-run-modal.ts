import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperSyncedPlugin from '@/main';
import { detectSyncLocations } from '@/utils/platform';


type WizardStep = 'welcome' | 'storage' | 'folder-pick' | 'template' | 'target-folder';

const STEP_ORDER: WizardStep[] = ['welcome', 'storage', 'template', 'target-folder'];
const STEP_ORDER_FOLDER: WizardStep[] = ['welcome', 'storage', 'folder-pick', 'template', 'target-folder'];

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

	private get stepOrder(): WizardStep[] {
		return this.stepState.backendChoice === 'folder' ? STEP_ORDER_FOLDER : STEP_ORDER;
	}

	private get currentStep(): WizardStep {
		return this.stepOrder[this.currentStepIndex] ?? 'welcome';
	}

	private renderCurrentStep(): void {
		const { contentEl } = this;
		contentEl.empty();

		const stepNum = this.currentStepIndex + 1;
		const totalSteps = this.stepOrder.length;
		contentEl.createEl('div', {
			text: `Step ${stepNum} of ${totalSteps}`,
			cls: 'papersynced-wizard-step-indicator',
		});

		switch (this.currentStep) {
			case 'welcome': this.renderWelcome(contentEl); break;
			case 'storage': this.renderStorage(contentEl); break;
			case 'folder-pick': this.renderFolderPick(contentEl); break;
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

	private renderStorage(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Choose your storage' });
		containerEl.createEl('p', {
			text: 'How does the PaperSynced mobile app save your scans?',
		});

		// Google Drive — "Connect" triggers OAuth directly
		if (this.stepState.oauthComplete) {
			new Setting(containerEl)
				.setName('\u2713 Google Drive')
				.setDesc('Connected');
		} else {
			new Setting(containerEl)
				.setName('Google Drive')
				.setDesc('Sign in with your Google account')
				.addButton(btn =>
					btn.setButtonText('Connect').setCta().onClick(async () => {
						try {
							this.plugin.settings.backendType = 'drive';
							await this.plugin.saveSettings();
							await this.plugin.oauthManager?.startAuthFlow();
							this.plugin.settings.setupComplete = true;
							await this.plugin.saveSettings();
							this.stepState.backendChoice = 'drive';
							this.stepState.oauthComplete = true;
							this.renderCurrentStep();
						} catch (err) {
							this.plugin.settings.backendType = 'none';
							await this.plugin.saveSettings();
							new Notice(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
						}
					})
				);
		}

		// Folder — "Select" advances to folder pick step
		const isFolderSelected = this.stepState.backendChoice === 'folder';
		new Setting(containerEl)
			.setName(`${isFolderSelected ? '\u2713 ' : ''}A folder on this device`)
			.setDesc('iCloud, Dropbox, Syncthing, or any synced folder')
			.addButton(btn =>
				btn.setButtonText(isFolderSelected ? 'Selected' : 'Select').onClick(() => {
					this.stepState.backendChoice = 'folder';
					this.stepState.oauthComplete = false;
					this.renderCurrentStep();
				})
			);

		const storageChosen = this.stepState.oauthComplete || isFolderSelected;
		this.renderNavButtons(containerEl, storageChosen);
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
			.setName('Browse for another folder...')
			.addButton(btn =>
				btn.setButtonText('Browse').onClick(async () => {
					const electron = (window as unknown as { require?: (mod: string) => { remote?: { dialog: { showOpenDialog: (opts: { properties: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }> } } } }).require?.('electron');
					const dialog = electron?.remote?.dialog;
					if (dialog) {
						const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
						if (!result.canceled && result.filePaths[0]) {
							this.stepState.folderPath = result.filePaths[0];
							this.stepState.folderType = 'custom';
							this.renderCurrentStep();
						}
					} else {
						new Notice('Folder browser not available — use a detected location above');
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
