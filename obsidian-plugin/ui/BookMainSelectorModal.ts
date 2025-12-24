import { Modal } from 'obsidian';
import WritingDashboardPlugin from '../main';
import { FileTreePickerModal } from './FileTreePickerModal';

export class BookMainSelectorModal extends Modal {
	private plugin: WritingDashboardPlugin;

	constructor(plugin: WritingDashboardPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onOpen() {
		// Delegate to FileTreePickerModal
		const modal = new FileTreePickerModal(this.plugin, {
			currentPath: this.plugin.settings.book2Path,
			title: 'Select your main book file',
			onPick: async (filePath: string) => {
				this.plugin.settings.book2Path = filePath;
				this.plugin.settings.setupCompleted = true;
				await this.plugin.saveSettings();
				this.close();
			}
		});
		modal.open();
		// Close this modal immediately since FileTreePickerModal handles its own UI
		this.close();
	}
}


