import { App, Modal, Notice, Setting } from 'obsidian';
import type PaperSyncedPlugin from '@/main';


type WizardStep = 'welcome' | 'storage' | 'target-folder';

const STEP_ORDER: WizardStep[] = ['welcome', 'storage', 'target-folder'];

export class FirstRunModal extends Modal {
	private plugin: PaperSyncedPlugin;
	private currentStepIndex = 0;
	private stepState: {
		backendChoice: 'drive' | 'folder' | null;
		folderPath: string;
		folderType: string;
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
			case 'storage': this.renderStorage(contentEl); break;
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

		// Folder — "Browse" opens native folder dialog directly
		const isFolderSelected = this.stepState.backendChoice === 'folder' && this.stepState.folderPath !== '';
		new Setting(containerEl)
			.setName(`${isFolderSelected ? '\u2713 ' : ''}A folder on this device`)
			.setDesc(isFolderSelected ? this.stepState.folderPath : 'iCloud, Dropbox, Syncthing, or any synced folder')
			.addButton(btn =>
				btn.setButtonText('Browse').onClick(async () => {
					const electron = (window as unknown as { require?: (mod: string) => { remote?: { dialog: { showOpenDialog: (opts: { properties: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }> } } } }).require?.('electron');
					const dialog = electron?.remote?.dialog;
					if (dialog) {
						const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
						if (!result.canceled && result.filePaths[0]) {
							this.stepState.backendChoice = 'folder';
							this.stepState.folderPath = result.filePaths[0];
							this.stepState.folderType = 'custom';
							this.stepState.oauthComplete = false;
							this.renderCurrentStep();
						}
					} else {
						new Notice('Folder browser not available');
					}
				})
			);

		const storageChosen = this.stepState.oauthComplete || isFolderSelected;
		this.renderNavButtons(containerEl, storageChosen);
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
		this.plugin.settings.targetFolder = this.stepState.targetFolder;
		this.plugin.settings.setupComplete = true;
		await this.plugin.saveSettings();

		this.close();
		await this.plugin.startSync();
		new Notice('PaperSynced is syncing now');
	}
}
