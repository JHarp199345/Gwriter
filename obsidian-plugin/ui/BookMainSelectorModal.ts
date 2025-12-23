import WritingDashboardPlugin from '../main';
import { FileTreePickerModal } from './FileTreePickerModal';

export class BookMainSelectorModal extends FileTreePickerModal {
	constructor(plugin: WritingDashboardPlugin) {
		super(plugin, {
			currentPath: plugin.settings.book2Path,
			onPick: async (filePath) => {
				plugin.settings.book2Path = filePath;
				plugin.settings.setupCompleted = true;
				await plugin.saveSettings();
			}
		});
		this.titleEl.setText('Select your manuscript file');
	}
}


